/**
 * MCP Preferences
 *
 * Defines the MCP-related settings that appear in Arduino IDE preferences.
 * These settings control the embedded MCP server behavior.
 */

import {
  PreferenceContribution,
  PreferenceProxy,
  PreferenceSchema,
  PreferenceService,
  createPreferenceProxy,
} from '@theia/core/lib/browser/preferences';
import { nls } from '@theia/core/lib/common/nls';
import { interfaces } from '@theia/core/shared/inversify';

/**
 * MCP Configuration interface
 */
export interface MCPConfiguration {
  'arduino.mcp.enabled': boolean;
  'arduino.mcp.autoConnect': boolean;
  'arduino.mcp.port': number;
  'arduino.mcp.requireAuth': boolean;
  'arduino.mcp.logLevel': 'none' | 'error' | 'info' | 'debug';
  'arduino.mcp.toolMode': 'router' | 'direct';
}

/**
 * Default values for MCP configuration
 */
export const MCPConfigurationDefaults: MCPConfiguration = {
  'arduino.mcp.enabled': true,
  'arduino.mcp.autoConnect': true,
  'arduino.mcp.port': 3847,
  'arduino.mcp.requireAuth': true,
  'arduino.mcp.logLevel': 'info',
  'arduino.mcp.toolMode': 'router',
};

/**
 * Preference schema for MCP settings
 */
export const mcpPreferenceSchema: PreferenceSchema = {
  type: 'object',
  scope: 'application',
  properties: {
    'arduino.mcp.enabled': {
      type: 'boolean',
      description: nls.localize(
        'arduino/mcp/preferences.enabled',
        'Enable MCP (Model Context Protocol) server integration. When enabled, AI assistants like OpenCode can interact with Open Duino - compiling, uploading, managing libraries, and more.'
      ),
      default: MCPConfigurationDefaults['arduino.mcp.enabled'],
      order: 1,
    },
    'arduino.mcp.autoConnect': {
      type: 'boolean',
      description: nls.localize(
        'arduino/mcp/preferences.autoConnect',
        'Automatically start the MCP server when Open Duino launches. Disable this if you want to manually control when the MCP server is available.'
      ),
      default: MCPConfigurationDefaults['arduino.mcp.autoConnect'],
      order: 2,
    },
    'arduino.mcp.port': {
      type: 'number',
      description: nls.localize(
        'arduino/mcp/preferences.port',
        'HTTP port for the MCP server. MCP clients connect to http://127.0.0.1:{port}/mcp. Change this if port 3847 is already in use. The server restarts on the new port immediately.'
      ),
      default: MCPConfigurationDefaults['arduino.mcp.port'],
      minimum: 1024,
      maximum: 65535,
      order: 3,
    },
    'arduino.mcp.requireAuth': {
      type: 'boolean',
      description: nls.localize(
        'arduino/mcp/preferences.requireAuth',
        'Require an authentication token for MCP connections (recommended). The token is stored in ~/.arduinoIDE/mcp-token and included in the connection snippet shown by the IDE. Only disable this on fully trusted machines. Takes effect after restarting the IDE.'
      ),
      default: MCPConfigurationDefaults['arduino.mcp.requireAuth'],
      order: 4,
    },
    'arduino.mcp.logLevel': {
      type: 'string',
      enum: ['none', 'error', 'info', 'debug'],
      enumDescriptions: [
        nls.localize('arduino/mcp/preferences.logLevel.none', 'No logging'),
        nls.localize('arduino/mcp/preferences.logLevel.error', 'Errors only'),
        nls.localize('arduino/mcp/preferences.logLevel.info', 'General information'),
        nls.localize('arduino/mcp/preferences.logLevel.debug', 'Detailed debug output'),
      ],
      description: nls.localize(
        'arduino/mcp/preferences.logLevel',
        'Log level for MCP server messages. Check the Developer Tools console (View > Toggle Developer Tools) to see logs.'
      ),
      default: MCPConfigurationDefaults['arduino.mcp.logLevel'],
      order: 5,
    },
    'arduino.mcp.toolMode': {
      type: 'string',
      enum: ['router', 'direct'],
      enumDescriptions: [
        nls.localize('arduino/mcp/preferences.toolMode.router', 'Router mode - 4 meta-tools for minimal context usage (recommended)'),
        nls.localize('arduino/mcp/preferences.toolMode.direct', 'Direct mode - all 11+ tools exposed individually'),
      ],
      description: nls.localize(
        'arduino/mcp/preferences.toolMode',
        'Tool exposure mode. Router mode (recommended) exposes 4 meta-tools to minimize LLM context window usage. Direct mode exposes all individual tools for simpler prompting. Requires MCP reconnection to take effect.'
      ),
      default: MCPConfigurationDefaults['arduino.mcp.toolMode'],
      order: 6,
    },
  },
};

export const MCPPreferences = Symbol('MCPPreferences');
export type MCPPreferences = PreferenceProxy<MCPConfiguration>;

/**
 * Create the preference proxy for MCP settings
 */
export function createMCPPreferences(
  preferences: PreferenceService,
  schema: PreferenceSchema = mcpPreferenceSchema
): MCPPreferences {
  return createPreferenceProxy(preferences, schema);
}

/**
 * Bind MCP preferences to the DI container
 */
export function bindMCPPreferences(bind: interfaces.Bind): void {
  // Bind preferences proxy
  bind(MCPPreferences).toDynamicValue((ctx) => {
    const preferences = ctx.container.get<PreferenceService>(PreferenceService);
    return createMCPPreferences(preferences, mcpPreferenceSchema);
  }).inSingletonScope();

  // Register the preference schema contribution
  bind(PreferenceContribution).toConstantValue({
    schema: mcpPreferenceSchema,
  });
}
