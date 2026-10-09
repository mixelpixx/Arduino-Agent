/**
 * MCP Service Implementation
 *
 * Backend implementation of MCPService that bridges frontend preferences
 * to the embedded MCP server control. Also handles real-time notifications
 * for file changes made via MCP tools, and receives IDE state (current
 * sketch, board/port selection) pushed from the frontend.
 */

import * as fs from 'fs';
import * as path from 'path';
import { injectable, inject } from '@theia/core/shared/inversify';
import {
  MCPService,
  MCPStatus,
  MCPServiceClient,
  MCPFileChangeEvent,
  MCPIDEState,
  MCPConnectionGuide,
  MCPConnectionSnippet,
  ToolMode,
} from '../common/mcp-service';
import { ArduinoMCPServer } from './mcp-server';
import { mcpLog } from './mcp-logger';

const BRIDGE_IN_RESOURCES = path.join('mcp-bridge', 'bridge', 'arduino-agent-bridge.js');

/**
 * The stdio bridge shipped with this build: `resources/mcp-bridge/` in a
 * release (see electron-app's extraResources), or the extension's own
 * `bridge/` in a source checkout.
 */
function findBridge(): string | null {
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  const candidates = [
    resourcesPath && path.join(resourcesPath, BRIDGE_IN_RESOURCES),
    // Bundled backend: resources/app/lib/backend -> resources
    path.resolve(__dirname, '..', '..', '..', BRIDGE_IN_RESOURCES),
    // Unbundled: arduino-mcp-extension/lib/node -> arduino-mcp-extension/bridge
    path.resolve(__dirname, '..', '..', 'bridge', 'arduino-agent-bridge.js'),
    // Bundled in a checkout: electron-app/lib/backend -> repo root
    path.resolve(__dirname, '..', '..', '..', 'arduino-mcp-extension', 'bridge', 'arduino-agent-bridge.js'),
  ];
  return candidates.find((p): p is string => !!p && fs.existsSync(p)) ?? null;
}

/** The app executable (for ARDUINO_AGENT_PATH), or null when running from a dev Electron. */
function findAppExecutable(): string | null {
  const executableName = path.basename(process.execPath);
  return /^(?:arduino[ -](?:agent|ide)|open[ -]?duino)(?:\.exe)?$/i.test(executableName)
    ? process.execPath
    : null;
}

@injectable()
export class MCPServiceImpl implements MCPService {
  @inject(ArduinoMCPServer)
  private readonly mcpServer!: ArduinoMCPServer;

  private client: MCPServiceClient | undefined;

  async getStatus(): Promise<MCPStatus> {
    return this.mcpServer.getStatus();
  }

  async setEnabled(enabled: boolean): Promise<void> {
    if (enabled) {
      if (!this.mcpServer.isServerRunning()) {
        await this.mcpServer.start();
        mcpLog.info('MCP server enabled via preferences');
        this.notifyStatusChanged();
      }
    } else {
      if (this.mcpServer.isServerRunning()) {
        await this.mcpServer.stop();
        mcpLog.info('MCP server disabled via preferences');
        this.notifyStatusChanged();
      }
    }
  }

  async restart(): Promise<void> {
    if (this.mcpServer.isServerRunning()) {
      await this.mcpServer.stop();
    }
    await this.mcpServer.start();
    mcpLog.info('MCP server restarted');
    this.notifyStatusChanged();
  }

  async setPort(port: number): Promise<void> {
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
      throw new Error(`Invalid port: ${port}`);
    }
    if (this.mcpServer.getPort() === port && this.mcpServer.isServerRunning()) {
      return;
    }
    if (this.mcpServer.isServerRunning()) {
      await this.mcpServer.stop();
    }
    await this.mcpServer.start(port);
    mcpLog.info(`MCP server moved to port ${port}`);
    this.notifyStatusChanged();
  }

  async getServerUrl(): Promise<string> {
    const port = this.mcpServer.getPort();
    return `http://127.0.0.1:${port}/mcp`;
  }

  async getClientConfig(): Promise<string> {
    return this.mcpServer.buildClientConfig();
  }

  async getConnectionGuide(): Promise<MCPConnectionGuide> {
    const url = await this.getServerUrl();
    const token = this.mcpServer.getAuthToken();
    const bridgePath = findBridge();
    const appExecutable = findAppExecutable();
    const quote = (s: string) => `"${s}"`;
    const snippets: MCPConnectionSnippet[] = [];

    if (bridgePath) {
      const env = appExecutable ? ` --env ARDUINO_AGENT_PATH=${quote(appExecutable)}` : '';
      const openCodeEnvironment = appExecutable ? { ARDUINO_AGENT_PATH: appExecutable } : undefined;
      const openCodeServer: Record<string, unknown> = {
        type: 'local',
        command: ['node', bridgePath],
      };
      if (openCodeEnvironment) {
        openCodeServer.environment = openCodeEnvironment;
      }
      snippets.push({
        id: 'opencode-cli',
        title: 'OpenCode command',
        description:
          'Run this in a terminal to add Open Duino to your global OpenCode MCP configuration. ' +
          'The bundled bridge can start the IDE when a tool is called (requires Node.js 18 or newer).',
        text: `opencode mcp add open-duino --global${env} -- node ${quote(bridgePath)}`,
      });
      snippets.push({
        id: 'opencode-config',
        title: 'OpenCode configuration',
        description:
          'Merge this MCP entry into opencode.json or opencode.jsonc. The bridge keeps Open Duino and OpenCode connected.',
        text: JSON.stringify(
          { mcp: { servers: { 'open-duino': openCodeServer } } },
          null,
          2
        ),
      });
      snippets.push({
        id: 'claude-code',
        title: 'Claude Code',
        description:
          'Run this in a terminal. It adds Open Duino to Claude Code for all your projects, ' +
          'through the bundled bridge (needs Node.js 18 or newer).',
        text: `claude mcp add arduino --scope user${env} -- node ${quote(bridgePath)}`,
      });
      const server: Record<string, unknown> = { command: 'node', args: [bridgePath] };
      if (appExecutable) {
        server.env = { ARDUINO_AGENT_PATH: appExecutable };
      }
      snippets.push({
        id: 'bridge-config',
        title: 'Claude Desktop, Cursor and other MCP clients',
        description:
          'Add this to the client\'s MCP configuration (claude_desktop_config.json, .mcp.json, ...). ' +
          'The bundled bridge stays connected while Open Duino is closed and starts it when a ' +
          'tool needs it. Needs Node.js 18 or newer.',
        text: JSON.stringify({ mcpServers: { arduino: server } }, null, 2),
      });

    } else {
      const header = token ? ` --header ${quote(`Authorization: Bearer ${token}`)}` : '';
      snippets.push({
        id: 'claude-code',
        title: 'Claude Code',
        description: 'Run this in a terminal. It connects while Open Duino is running.',
        text: `claude mcp add arduino --scope user --transport http ${url}${header}`,
      });
      snippets.push({
        id: 'opencode-cli',
        title: 'OpenCode command',
        description: 'Run this in a terminal to add the running Open Duino MCP server to OpenCode globally.',
        text:
          `opencode mcp add open-duino --global --url ${url}` +
          (token ? ` --header ${quote(`Authorization=Bearer ${token}`)}` : ''),
      });
      snippets.push({
        id: 'opencode-config',
        title: 'OpenCode configuration',
        description: 'Merge this entry under mcp.servers in opencode.json or opencode.jsonc.',
        text: JSON.stringify(
          {
            mcp: {
              servers: {
                'open-duino': {
                  type: 'remote',
                  url,
                  ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
                },
              },
            },
          },
          null,
          2
        ),
      });
    }
    snippets.push({
      id: 'http-config',
      title: 'Direct HTTP',
      description:
        'For clients that speak Streamable HTTP. Only connects while Open Duino is running' +
        (token ? '; the token is stored in ~/.arduinoIDE/mcp-token.' : '.'),
      text: this.mcpServer.buildClientConfig(),
    });

    return { status: this.mcpServer.getStatus(), url, bridgePath, appExecutable, snippets };
  }

  async healthCheck(): Promise<boolean> {
    return this.mcpServer.isServerRunning();
  }

  async setToolMode(mode: ToolMode): Promise<void> {
    this.mcpServer.setToolMode(mode);
  }

  async updateIDEState(state: MCPIDEState): Promise<void> {
    this.mcpServer.setIDEState(state);
  }

  setClient(client: MCPServiceClient | undefined): void {
    this.client = client;
    // Register this service with the MCP server for file change notifications
    this.mcpServer.setFileChangeCallback((event) =>
      this.notifyFileChanged(event)
    );
    this.mcpServer.setSessionsChangedListener(() => this.notifyStatusChanged());
  }

  /**
   * Notify the frontend client of a file change
   */
  notifyFileChanged(event: MCPFileChangeEvent): void {
    if (this.client) {
      try {
        this.client.onFileChanged(event);
      } catch (error) {
        mcpLog.error('Error notifying client of file change:', error);
      }
    }
  }

  /**
   * Notify the frontend client of a status change
   */
  private notifyStatusChanged(): void {
    if (this.client) {
      try {
        this.client.onStatusChanged(this.mcpServer.getStatus());
      } catch (error) {
        mcpLog.error('Error notifying client of status change:', error);
      }
    }
  }
}
