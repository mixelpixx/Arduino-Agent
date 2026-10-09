/**
 * Arduino MCP Extension - Frontend Module
 *
 * This module provides:
 * - MCP Enable/Disable setting in preferences
 * - MCP service proxy for controlling the backend
 * - Preference change listeners
 */

import { ContainerModule } from '@theia/core/shared/inversify';
import { WebSocketConnectionProvider } from '@theia/core/lib/browser/messaging/ws-connection-provider';
import { FrontendApplicationContribution } from '@theia/core/lib/browser/frontend-application-contribution';
import { ColorContribution } from '@theia/core/lib/browser/color-application-contribution';
import { CommandContribution } from '@theia/core/lib/common/command';
import { MenuContribution } from '@theia/core/lib/common/menu';
import { About } from 'arduino-ide-extension/lib/browser/contributions/about';
import { CheckForIDEUpdates } from 'arduino-ide-extension/lib/browser/contributions/check-for-ide-updates';
import { MonacoThemingService } from 'arduino-ide-extension/lib/browser/theia/monaco/monaco-theming-service';
import { bindMCPPreferences, MCPPreferences } from './mcp-preferences';
import { MCPService, MCPServicePath } from '../common/mcp-service';
import { MCPFrontendContribution } from './mcp-frontend-contribution';
import { AgentAbout, DisabledIDEUpdateCheck, RemoveIDEUpdaterCommand } from './agent-branding';
import { ConnectAgentContribution } from './connect-agent';
import { AgentMonacoThemingService, AgentThemeStyles } from './agent-theme';

export default new ContainerModule((bind, unbind, isBound, rebind) => {
  // Bind MCP preferences to add settings to the IDE preferences panel
  bindMCPPreferences(bind);

  // Open Duino identity: no Arduino IDE updater, fork-specific About dialog
  rebind(CheckForIDEUpdates).to(DisabledIDEUpdateCheck).inSingletonScope();
  rebind(About).to(AgentAbout).inSingletonScope();
  bind(RemoveIDEUpdaterCommand).toSelf().inSingletonScope();
  bind(CommandContribution).toService(RemoveIDEUpdaterCommand);
  bind(MenuContribution).toService(RemoveIDEUpdaterCommand);

  // Open Duino colors: adapted light and dark themes (agent-theme.ts)
  rebind(MonacoThemingService).to(AgentMonacoThemingService).inSingletonScope();
  bind(AgentThemeStyles).toSelf().inSingletonScope();
  bind(FrontendApplicationContribution).toService(AgentThemeStyles);
  bind(ColorContribution).toService(AgentThemeStyles);

  // Bind the MCP service proxy to communicate with backend
  bind(MCPService).toDynamicValue(ctx => {
    const connection = ctx.container.get(WebSocketConnectionProvider);
    return connection.createProxy<MCPService>(MCPServicePath);
  }).inSingletonScope();

  // Bind frontend contribution to handle preference changes
  bind(MCPFrontendContribution).toSelf().inSingletonScope();
  bind(FrontendApplicationContribution).toService(MCPFrontendContribution);

  // Help > Connect an AI Agent..., the MCP status bar item, first-run hint
  bind(ConnectAgentContribution).toSelf().inSingletonScope();
  bind(CommandContribution).toService(ConnectAgentContribution);
  bind(MenuContribution).toService(ConnectAgentContribution);
  bind(FrontendApplicationContribution).toService(ConnectAgentContribution);

  console.log('[arduino-mcp] Frontend module loaded with MCP preferences and service proxy');
});
