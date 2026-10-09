/**
 * "Connect an AI Agent": the in-IDE way to hook up OpenCode, Claude Code,
 * Claude Desktop or any MCP client.
 *
 * - Help > Connect an AI Agent... opens a dialog with copy-ready setups for this
 *   installation (real paths of the bundled bridge and of the app, the token).
 * - A status bar item shows whether the MCP server is up and whether an agent
 *   has used it recently; clicking it opens the same dialog.
 * - The first time the server is running, a notification points at the dialog.
 */

import { AbstractDialog } from '@theia/core/lib/browser/dialogs';
import { ClipboardService } from '@theia/core/lib/browser/clipboard-service';
import { FrontendApplicationContribution } from '@theia/core/lib/browser/frontend-application-contribution';
import { CommonMenus } from '@theia/core/lib/browser/common-frontend-contribution';
import { StatusBar, StatusBarAlignment } from '@theia/core/lib/browser/status-bar/status-bar';
import { StorageService } from '@theia/core/lib/browser/storage-service';
import { Command, CommandContribution, CommandRegistry } from '@theia/core/lib/common/command';
import { MenuContribution, MenuModelRegistry } from '@theia/core/lib/common/menu';
import { MessageService } from '@theia/core/lib/common/message-service';
import { inject, injectable } from '@theia/core/shared/inversify';
import { TerminalService } from '@theia/terminal/lib/browser/base/terminal-service';
import URI from '@theia/core/lib/common/uri';
import {
  CurrentSketch,
  SketchesServiceClientImpl,
} from 'arduino-ide-extension/lib/browser/sketches-service-client-impl';
import {
  MCPConnectionGuide,
  MCPConnectionSnippet,
  MCPService,
  MCPStatus,
} from '../common/mcp-service';
import { MCPFrontendContribution } from './mcp-frontend-contribution';

export namespace ConnectAgentCommands {
  export const OPEN: Command = {
    id: 'arduino-agent.connect-ai-agent',
    label: 'Connect an AI Agent...',
    category: 'Open Duino',
  };
  export const OPEN_OPENCODE: Command = {
    id: 'open-duino.open-opencode-chat',
    label: 'OpenCode Chat',
    category: 'Open Duino',
  };
}

const STATUS_BAR_ID = 'arduino-agent-mcp-status';
const STATUS_POLL_MS = 20_000;
const HINT_SHOWN_KEY = 'arduino-agent.connect-hint-shown';

@injectable()
export class ConnectAgentContribution
  implements CommandContribution, MenuContribution, FrontendApplicationContribution
{
  @inject(MCPService)
  private readonly mcpService!: MCPService;

  @inject(MCPFrontendContribution)
  private readonly mcpFrontend!: MCPFrontendContribution;

  @inject(StatusBar)
  private readonly statusBar!: StatusBar;

  @inject(ClipboardService)
  private readonly clipboard!: ClipboardService;

  @inject(MessageService)
  private readonly messageService!: MessageService;

  @inject(StorageService)
  private readonly storage!: StorageService;

  @inject(TerminalService)
  private readonly terminalService!: TerminalService;

  @inject(SketchesServiceClientImpl)
  private readonly sketchesServiceClient!: SketchesServiceClientImpl;

  registerCommands(registry: CommandRegistry): void {
    registry.registerCommand(ConnectAgentCommands.OPEN, {
      execute: () => this.openDialog(),
    });
    registry.registerCommand(ConnectAgentCommands.OPEN_OPENCODE, {
      execute: () => this.openOpenCodeChat(),
    });
  }

  registerMenus(registry: MenuModelRegistry): void {
    // Its own group, sorted ahead of Arduino's '0_main' (Getting Started, ...).
    registry.registerMenuAction([...CommonMenus.HELP, '0_agent'], {
      commandId: ConnectAgentCommands.OPEN.id,
      label: ConnectAgentCommands.OPEN.label,
      order: '0',
    });
    registry.registerMenuAction([...CommonMenus.HELP, '0_agent'], {
      commandId: ConnectAgentCommands.OPEN_OPENCODE.id,
      label: ConnectAgentCommands.OPEN_OPENCODE.label,
      order: '1',
    });
  }

  onStart(): void {
    this.mcpFrontend.onDidChangeStatus((status) => this.showStatus(status));
    void this.refreshStatus().then((status) => this.maybeShowFirstRunHint(status));
    // Activity expires without any event, so re-read it now and then.
    setInterval(() => void this.refreshStatus(), STATUS_POLL_MS);
  }

  private async refreshStatus(): Promise<MCPStatus | undefined> {
    try {
      const status = await this.mcpService.getStatus();
      this.showStatus(status);
      return status;
    } catch {
      return undefined; // backend restarting; the next poll catches up
    }
  }

  private showStatus(status: MCPStatus): void {
    const url = `http://127.0.0.1:${status.port}/mcp`;
    let text: string;
    let tooltip: string;
    if (!status.running && status.error) {
      text = '$(warning) MCP unavailable';
      tooltip = status.error;
    } else if (!status.running) {
      text = '$(debug-disconnect) MCP off';
      tooltip = 'The MCP server is off (Preferences > MCP). Click for connection setup.';
    } else if (status.activeClients > 0) {
      const n = status.activeClients;
      // "Active", not "connected": this counts clients that made a request in the
      // last 5 minutes (each Claude session's bridge counts once it fetches tools).
      text = n === 1 ? '$(hubot) Agent active' : `$(hubot) ${n} agents active`;
      tooltip =
        `${n} MCP client${n === 1 ? '' : 's'} used Open Duino in the last 5 minutes ` +
        `(each AI session with Open Duino configured counts once) on ${url}. Click for connection setup.`;
    } else {
      text = '$(hubot) MCP ready';
      tooltip = `MCP server listening on ${url}. Click to connect an AI agent.`;
    }
    this.statusBar.setElement(STATUS_BAR_ID, {
      alignment: StatusBarAlignment.LEFT,
      priority: 100,
      text,
      tooltip,
      command: ConnectAgentCommands.OPEN.id,
      className: 'arduino-agent-mcp-status',
    });
  }

  private async maybeShowFirstRunHint(status: MCPStatus | undefined): Promise<void> {
    if (!status?.running || (await this.storage.getData<boolean>(HINT_SHOWN_KEY))) {
      return;
    }
    await this.storage.setData(HINT_SHOWN_KEY, true);
    const show = 'Show me how';
    const choice = await this.messageService.info(
      'Open Duino is ready for your AI assistant. Connect OpenCode, Claude Code or another MCP client in one step.',
      show
    );
    if (choice === show) {
      await this.openDialog();
    }
  }

  private async openDialog(): Promise<void> {
    const guide = await this.mcpService.getConnectionGuide();
    this.showStatus(guide.status);
    await new ConnectAgentDialog(guide, this.clipboard).open();
  }

  /** Opens OpenCode's TUI in the integrated terminal beside the sketch. */
  private async openOpenCodeChat(): Promise<void> {
    try {
      const sketch = this.sketchesServiceClient.tryGetCurrentSketch();
      const sketchDir = CurrentSketch.isValid(sketch)
        ? new URI(sketch.uri).parent
        : undefined;
      const isWindows = /^win/i.test(navigator.platform);
      const windowsCwd = sketchDir ? windowsPathFromFileUri(sketchDir.toString()) : undefined;
      const terminal = await this.terminalService.newTerminal({
        title: 'OpenCode · Open Duino',
        ...(isWindows
          ? { shellPath: 'cmd.exe', shellArgs: ['/d', '/k'] }
          : { cwd: sketchDir?.toString() }),
      });
      await terminal.start();
      this.terminalService.open(terminal);
      terminal.sendText(
        isWindows
          ? `cd /d "${windowsCwd ?? '%USERPROFILE%'}" && opencode\r`
          : 'opencode\r'
      );
    } catch (error) {
      this.messageService.error(`No se pudo iniciar OpenCode en la terminal integrada: ${String(error)}`);
    }
  }

}

/** OpenCode's core/instructions source recurses when Windows path casing
 * differs from Git's project root. Start cmd explicitly and `cd /d` using the
 * canonical uppercase drive before launching OpenCode. */
function windowsPathFromFileUri(uri: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(uri);
  } catch {
    return undefined;
  }
  const match = decoded.match(/^file:\/\/\/([a-z]):\/(.*)$/i);
  if (!match) {
    return undefined;
  }
  return `${match[1].toUpperCase()}:\\${match[2].replace(/\//g, '\\')}`;
}

class ConnectAgentDialog extends AbstractDialog<void> {
  constructor(
    private readonly guide: MCPConnectionGuide,
    private readonly clipboard: ClipboardService
  ) {
    super({ title: 'Connect an AI Agent', maxWidth: 760, wordWrap: 'break-word' });
    ensureStyles();
    this.contentNode.classList.add('arduino-agent-connect');
    this.contentNode.appendChild(this.renderStatus());
    for (const snippet of guide.snippets) {
      this.contentNode.appendChild(this.renderSnippet(snippet));
    }
    this.appendAcceptButton('Done');
  }

  get value(): void {
    return undefined;
  }

  private renderStatus(): HTMLElement {
    const { status, url } = this.guide;
    const node = element('div', 'arduino-agent-connect-status');
    const dot = element('span', `arduino-agent-connect-dot ${status.running ? 'on' : 'off'}`);
    node.appendChild(dot);
    node.appendChild(
      document.createTextNode(
        status.running
          ? `MCP server running on ${url}` +
              (status.activeClients
                ? ` - ${status.activeClients} client${status.activeClients === 1 ? '' : 's'} active in the last 5 minutes`
                : '')
          : status.error ??
              'The MCP server is off. Turn it on in Preferences > MCP, then come back here.'
      )
    );
    return node;
  }

  private renderSnippet(snippet: MCPConnectionSnippet): HTMLElement {
    const section = element('div', 'arduino-agent-connect-section');
    const header = element('div', 'arduino-agent-connect-header');
    header.appendChild(element('div', 'arduino-agent-connect-title', snippet.title));
    const copy = element('button', 'theia-button secondary arduino-agent-connect-copy', 'Copy') as HTMLButtonElement;
    copy.addEventListener('click', async () => {
      await this.clipboard.writeText(snippet.text);
      copy.textContent = 'Copied';
      setTimeout(() => (copy.textContent = 'Copy'), 1500);
    });
    header.appendChild(copy);
    section.appendChild(header);
    section.appendChild(element('div', 'arduino-agent-connect-description', snippet.description));
    section.appendChild(element('pre', 'arduino-agent-connect-code', snippet.text));
    return section;
  }
}

function element(tag: string, className: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
}

let stylesInstalled = false;
function ensureStyles(): void {
  if (stylesInstalled) {
    return;
  }
  stylesInstalled = true;
  const style = document.createElement('style');
  style.textContent = `
.arduino-agent-connect { display: flex; flex-direction: column; gap: 14px; min-width: 560px; }
.arduino-agent-connect-status { display: flex; align-items: center; gap: 8px; }
.arduino-agent-connect-dot { width: 9px; height: 9px; border-radius: 50%; flex: none; }
.arduino-agent-connect-dot.on { background: var(--theia-testing-iconPassed, #3fb950); }
.arduino-agent-connect-dot.off { background: var(--theia-errorForeground, #f85149); }
.arduino-agent-connect-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.arduino-agent-connect-title { font-weight: 600; }
.arduino-agent-connect-copy { min-width: 72px; margin: 0; }
.arduino-agent-connect-description { opacity: 0.8; margin: 4px 0 6px; }
.arduino-agent-connect-code {
  margin: 0; padding: 8px 10px; border-radius: 4px; max-height: 180px; overflow: auto;
  white-space: pre-wrap; word-break: break-all; user-select: text;
  font-family: var(--theia-code-font-family, monospace); font-size: var(--theia-code-font-size, 12px);
  background: var(--theia-textCodeBlock-background, rgba(127, 127, 127, 0.12));
  border: 1px solid var(--theia-editorWidget-border, rgba(127, 127, 127, 0.3));
}
`;
  document.head.appendChild(style);
}
