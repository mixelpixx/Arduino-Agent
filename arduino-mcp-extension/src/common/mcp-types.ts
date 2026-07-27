/**
 * MCP Types for Arduino IDE Extension
 *
 * Shared types used by the MCP server and related components.
 */

/**
 * Task status for async operations (MCP 2025 spec)
 */
export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

/**
 * Task for async operations like compile and upload
 */
export interface Task {
  id: string;
  status: TaskStatus;
  tool: string;
  arguments: Record<string, unknown>;
  result?: unknown;
  error?: string;
  progress?: number;
  progressMessage?: string;
  /** Date.now() when the task was created. */
  createdAt: number;
  /** Date.now() when the runner started executing. */
  startedAt?: number;
  /** Date.now() when the task reached a terminal status. */
  finishedAt?: number;
}

/**
 * Root for workspace security (MCP 2025 spec)
 */
export interface Root {
  uri: string;
  name: string;
  isReadOnly: boolean;
}

/**
 * Progress notification for Tasks capability
 */
export interface ProgressNotification {
  taskId: string;
  progress: number;
  total: number;
  message: string;
}

/**
 * MCP Server configuration
 */
export interface MCPServerConfig {
  enabled: boolean;
  port: number;
  logLevel: 'none' | 'error' | 'info' | 'debug';
}

/**
 * Default MCP server configuration
 */
export const DEFAULT_MCP_CONFIG: MCPServerConfig = {
  enabled: true,
  port: 3847,
  logLevel: 'info',
};
