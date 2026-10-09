/**
 * MCP Frontend Contribution
 *
 * Handles frontend lifecycle and preference synchronization with backend.
 * When user changes MCP settings in preferences, this updates the backend.
 * Pushes the IDE's actual state (current sketch, board/port selection) to
 * the MCP server so AI clients see what the user sees.
 * Also handles real-time file change notifications from MCP tools.
 */

import { injectable, inject, postConstruct } from '@theia/core/shared/inversify';
import { FrontendApplicationContribution } from '@theia/core/lib/browser/frontend-application-contribution';
import { FrontendApplication } from '@theia/core/lib/browser/frontend-application';
import { PreferenceService } from '@theia/core/lib/browser/preferences';
import { MessageService } from '@theia/core/lib/common/message-service';
import { Emitter, Event } from '@theia/core/lib/common/event';
import { EditorManager } from '@theia/editor/lib/browser/editor-manager';
import URI from '@theia/core/lib/common/uri';
import {
  SketchesServiceClientImpl,
  CurrentSketch,
} from 'arduino-ide-extension/lib/browser/sketches-service-client-impl';
import { BoardsServiceProvider } from 'arduino-ide-extension/lib/browser/boards/boards-service-provider';
import {
  MCPService,
  MCPServiceClient,
  MCPFileChangeEvent,
  MCPIDEState,
  MCPStatus,
} from '../common/mcp-service';

@injectable()
export class MCPFrontendContribution
  implements FrontendApplicationContribution, MCPServiceClient
{
  @inject(MCPService)
  private readonly mcpService!: MCPService;

  @inject(PreferenceService)
  private readonly preferenceService!: PreferenceService;

  @inject(MessageService)
  private readonly messageService!: MessageService;

  @inject(EditorManager)
  private readonly editorManager!: EditorManager;

  @inject(SketchesServiceClientImpl)
  private readonly sketchesServiceClient!: SketchesServiceClientImpl;

  @inject(BoardsServiceProvider)
  private readonly boardsServiceProvider!: BoardsServiceProvider;

  // Track recent file changes to avoid notification spam
  private recentFileChanges = new Map<string, number>();
  private readonly NOTIFICATION_DEBOUNCE_MS = 2000;

  private readonly onDidChangeStatusEmitter = new Emitter<MCPStatus>();
  /** Server status pushed by the backend (start/stop, sessions opening or closing). */
  readonly onDidChangeStatus: Event<MCPStatus> = this.onDidChangeStatusEmitter.event;

  @postConstruct()
  protected init(): void {
    // Listen for preference changes
    this.preferenceService.onPreferenceChanged(event => {
      switch (event.preferenceName) {
        case 'arduino.mcp.enabled':
          this.handleMCPEnabledChange(event.newValue as boolean);
          break;
        case 'arduino.mcp.toolMode':
          this.handleToolModeChange(event.newValue as 'router' | 'direct');
          break;
        case 'arduino.mcp.port':
          this.handlePortChange(event.newValue as number);
          break;
        case 'arduino.mcp.requireAuth':
          this.messageService.info(
            'The MCP authentication setting takes effect after restarting Open Duino.',
            { timeout: 8000 }
          );
          break;
      }
    });
  }

  async onStart(app: FrontendApplication): Promise<void> {
    console.log('[arduino-mcp] Frontend contribution started');

    // Register this as the MCP service client to receive notifications
    try {
      this.mcpService.setClient(this);
    } catch (error) {
      console.error('[arduino-mcp] Error registering as client:', error);
    }

    // Keep the MCP server in sync with the IDE state.
    this.sketchesServiceClient.onCurrentSketchDidChange(() =>
      this.pushIDEState()
    );
    this.boardsServiceProvider.onBoardsConfigDidChange(() =>
      this.pushIDEState()
    );
    void this.pushIDEState();

    // Log initial MCP status and the ready-to-paste client configuration.
    try {
      const status = await this.mcpService.getStatus();
      console.log('[arduino-mcp] Initial MCP status:', status);
      if (status.running) {
        const config = await this.mcpService.getClientConfig();
        console.log(`[arduino-mcp] MCP client configuration:\n${config}`);
      }
    } catch (error) {
      console.error('[arduino-mcp] Error getting initial status:', error);
    }
  }

  onStop(app: FrontendApplication): void {
    // Unregister as client
    try {
      this.mcpService.setClient(undefined);
    } catch (error) {
      // Ignore errors during shutdown
    }
  }

  // ============================================================
  // IDE state synchronization
  // ============================================================

  private async pushIDEState(): Promise<void> {
    try {
      const state: MCPIDEState = {};

      const currentSketch = this.sketchesServiceClient.tryGetCurrentSketch();
      if (CurrentSketch.isValid(currentSketch)) {
        state.sketchUri = currentSketch.uri;
        state.sketchName = currentSketch.name;
      }

      const { selectedBoard, selectedPort } =
        this.boardsServiceProvider.boardsConfig;
      if (selectedBoard) {
        state.boardFqbn = selectedBoard.fqbn ?? undefined;
        state.boardName = selectedBoard.name;
      }
      if (selectedPort) {
        state.portAddress = selectedPort.address;
        state.portProtocol = selectedPort.protocol;
      }

      await this.mcpService.updateIDEState(state);
    } catch (error) {
      console.error('[arduino-mcp] Error pushing IDE state:', error);
    }
  }

  // ============================================================
  // MCPServiceClient Implementation
  // ============================================================

  /**
   * Called when a file is changed via MCP tools (real-time sync)
   */
  onFileChanged(event: MCPFileChangeEvent): void {
    console.log(`[arduino-mcp] File changed via MCP: ${event.type} ${event.uri}`);

    // Always reflect the change in the editor. We deliberately do NOT gate this
    // on the notification debounce: when a sketch is created and written in quick
    // succession, the content write must still reload. And we must not rely on the
    // filesystem watcher - sketchbooks often live under OneDrive/synced folders
    // where native watchers miss events - so we force a reload from disk here.
    this.focusAndReloadEditor(event.uri);

    // Debounce only the toast notification to avoid spam on rapid writes.
    const now = Date.now();
    const lastChange = this.recentFileChanges.get(event.uri);
    const recentlyNotified =
      lastChange !== undefined && now - lastChange < this.NOTIFICATION_DEBOUNCE_MS;
    this.recentFileChanges.set(event.uri, now);

    // Clean up old entries
    for (const [uri, timestamp] of this.recentFileChanges.entries()) {
      if (now - timestamp > this.NOTIFICATION_DEBOUNCE_MS * 2) {
        this.recentFileChanges.delete(uri);
      }
    }

    if (recentlyNotified) {
      return;
    }

    const fileName = event.uri.split('/').pop() || event.uri;
    const action = event.type === 'created' ? 'Created' : 'Updated';
    this.messageService.info(
      `${action} by an AI agent: ${fileName}`,
      { timeout: 3000 }
    );
  }

  /**
   * Called when MCP server status changes
   */
  onStatusChanged(status: MCPStatus): void {
    console.log('[arduino-mcp] MCP status changed:', status);
    this.onDidChangeStatusEmitter.fire(status);
  }

  // ============================================================
  // Private Methods
  // ============================================================

  /**
   * Open (or focus) the changed file and force its editor model to reload from
   * disk. `editorManager.open` with `activate` opens the file if it is closed and
   * focuses it if it is already open; the subsequent `revert({ soft: false })`
   * discards the in-memory model and re-reads the file, so the editor reflects
   * exactly what MCP wrote even when the filesystem watcher never fires.
   */
  private async focusAndReloadEditor(uriString: string): Promise<void> {
    try {
      const uri = new URI(uriString);
      const widget = await this.editorManager.open(uri, { mode: 'activate' });
      const document = widget?.editor?.document as
        | { revert?: (options?: { soft?: boolean }) => Promise<void> }
        | undefined;
      if (document && typeof document.revert === 'function') {
        await document.revert({ soft: false });
      }
    } catch (error) {
      console.error('[arduino-mcp] Error reloading file in editor:', error);
    }
  }

  private async handleMCPEnabledChange(enabled: boolean): Promise<void> {
    try {
      await this.mcpService.setEnabled(enabled);

      if (enabled) {
        this.messageService.info(
          'MCP server enabled. Use Help > Connect an AI Agent to link a client.',
          { timeout: 15000 }
        );
      } else {
        this.messageService.info('MCP server disabled.', { timeout: 5000 });
      }
    } catch (error) {
      console.error('[arduino-mcp] Error changing MCP enabled state:', error);
      this.messageService.error(
        `Failed to ${enabled ? 'enable' : 'disable'} MCP server: ${error}`
      );
    }
  }

  private async handleToolModeChange(mode: 'router' | 'direct'): Promise<void> {
    try {
      await this.mcpService.setToolMode(mode);
      const modeDesc = mode === 'router'
        ? 'Router mode (4 meta-tools)'
        : 'Direct mode (all tools)';
      this.messageService.info(
        `MCP tool mode changed to: ${modeDesc}. Reconnect your AI client to apply.`,
        { timeout: 5000 }
      );
    } catch (error) {
      console.error('[arduino-mcp] Error changing tool mode:', error);
      this.messageService.error(`Failed to change tool mode: ${error}`);
    }
  }

  private async handlePortChange(port: number): Promise<void> {
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
      return;
    }
    try {
      await this.mcpService.setPort(port);
      this.messageService.info(
        `MCP server moved to port ${port}. Refresh the client setup from Help > Connect an AI Agent.`,
        { timeout: 15000 }
      );
    } catch (error) {
      console.error('[arduino-mcp] Error changing MCP port:', error);
      this.messageService.error(`Failed to change MCP port: ${error}`);
    }
  }

  /**
   * Get the current MCP server URL for display
   */
  async getMCPServerUrl(): Promise<string | null> {
    try {
      const status = await this.mcpService.getStatus();
      if (status.running) {
        return this.mcpService.getServerUrl();
      }
      return null;
    } catch {
      return null;
    }
  }
}
