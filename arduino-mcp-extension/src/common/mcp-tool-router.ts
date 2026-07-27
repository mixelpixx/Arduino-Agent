/**
 * MCP Tool Router
 *
 * Implements the tool router pattern to minimize context window usage.
 * Instead of exposing 11+ individual tools, we expose 4 meta-tools:
 * - list_tool_categories: List available tool categories
 * - get_category_tools: Get detailed info about tools in a category
 * - execute_tool: Execute a specific tool by name
 * - search_tools: Search for tools by keyword
 *
 * This pattern allows Claude Code to discover and use tools on-demand
 * without loading all tool definitions into context upfront.
 */

import { ToolDefinition, ARDUINO_TOOLS } from './mcp-tools';

// ============================================================
// TOOL CATEGORIES
// ============================================================

export interface ToolCategory {
  name: string;
  description: string;
  toolNames: string[];
  /** Quick example of when to use this category */
  useWhen: string;
}

export const TOOL_CATEGORIES: ToolCategory[] = [
  {
    name: 'sketch',
    description: 'Create, open, edit, and manage Arduino sketch files. Read and write code content.',
    toolNames: ['arduino_sketch'],
    useWhen: 'Working with .ino files, reading/writing code, creating new projects',
  },
  {
    name: 'build',
    description: 'Compile sketches, upload to boards, check build output and errors.',
    toolNames: ['arduino_compile', 'arduino_upload', 'arduino_build_output', 'arduino_task_status'],
    useWhen:
      'Building, uploading, checking compilation errors. Pass wait:true to compile/upload to block until done instead of polling task status',
  },
  {
    name: 'board',
    description: 'Manage Arduino boards - list connected, select board/port, install cores.',
    toolNames: ['arduino_board'],
    useWhen:
      'Connecting boards, selecting board type, installing board support, identifying unknown boards / picking an FQBN (suggest_fqbn)',
  },
  {
    name: 'serial',
    description: 'Serial monitor operations - connect, read output, send data to devices.',
    toolNames: ['arduino_serial'],
    useWhen:
      'Debugging via serial output, sending commands to device, waiting for specific output (wait_for), following logs losslessly with cursor-based reads, diagnosing crashes/resets via auto-detected events',
  },
  {
    name: 'library',
    description: 'Search, install, remove, and manage Arduino libraries.',
    toolNames: ['arduino_library'],
    useWhen: 'Adding libraries, finding library examples, managing dependencies',
  },
  {
    name: 'ide',
    description: 'IDE state, configuration, and code formatting.',
    toolNames: ['arduino_context', 'arduino_format', 'arduino_config'],
    useWhen: 'Getting IDE state, formatting code, configuring sketchbook/board URLs',
  },
];

// ============================================================
// ROUTER META-TOOLS
// ============================================================

export const ROUTER_TOOLS: ToolDefinition[] = [
  {
    name: 'list_tool_categories',
    description: 'List all available Arduino IDE tool categories. Start here to discover what operations are available.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    annotations: {
      readOnlyHint: true,
    },
  },
  {
    name: 'get_category_tools',
    description: 'Get detailed information about all tools in a specific category including parameters and examples.',
    inputSchema: {
      type: 'object',
      properties: {
        category: {
          type: 'string',
          enum: TOOL_CATEGORIES.map(c => c.name),
          description: 'Category name from list_tool_categories',
        },
      },
      required: ['category'],
    },
    annotations: {
      readOnlyHint: true,
    },
  },
  {
    name: 'execute_tool',
    description: 'Execute an Arduino IDE tool by name with the specified parameters. Use get_category_tools first to see available tools and their parameters.',
    inputSchema: {
      type: 'object',
      properties: {
        tool_name: {
          type: 'string',
          description: 'Tool name (e.g., arduino_sketch, arduino_compile)',
        },
        params: {
          type: 'object',
          description: 'Tool parameters - see get_category_tools for schema',
        },
      },
      required: ['tool_name', 'params'],
    },
    annotations: {
      // Effective safety depends on the tool being executed; assume the worst.
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: true,
    },
  },
  {
    name: 'search_tools',
    description: 'Search for Arduino IDE tools by keyword. Searches tool names, descriptions, and parameter names.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search term (e.g., "upload", "serial", "library")',
        },
      },
      required: ['query'],
    },
    annotations: {
      readOnlyHint: true,
    },
  },
];

// ============================================================
// ROUTER IMPLEMENTATION
// ============================================================

/**
 * Get all tool categories with summary info
 */
export function listToolCategories(): CategorySummary[] {
  return TOOL_CATEGORIES.map(cat => ({
    name: cat.name,
    description: cat.description,
    toolCount: cat.toolNames.length,
    useWhen: cat.useWhen,
  }));
}

export interface CategorySummary {
  name: string;
  description: string;
  toolCount: number;
  useWhen: string;
}

/**
 * Get detailed tool information for a category
 */
export function getCategoryTools(categoryName: string): ToolDefinition[] | null {
  const category = TOOL_CATEGORIES.find(c => c.name === categoryName);
  if (!category) {
    return null;
  }

  return category.toolNames
    .map(name => ARDUINO_TOOLS.find(t => t.name === name))
    .filter((t): t is ToolDefinition => t !== undefined);
}

/**
 * Search for tools by keyword
 */
export function searchTools(query: string): SearchResult[] {
  const lowerQuery = query.toLowerCase();
  const results: SearchResult[] = [];

  for (const tool of ARDUINO_TOOLS) {
    const score = calculateRelevance(tool, lowerQuery);
    if (score > 0) {
      const category = TOOL_CATEGORIES.find(c => c.toolNames.includes(tool.name));
      results.push({
        toolName: tool.name,
        category: category?.name || 'unknown',
        description: tool.description,
        relevanceScore: score,
      });
    }
  }

  return results.sort((a, b) => b.relevanceScore - a.relevanceScore);
}

export interface SearchResult {
  toolName: string;
  category: string;
  description: string;
  relevanceScore: number;
}

/**
 * Calculate relevance score for search
 */
function calculateRelevance(tool: ToolDefinition, query: string): number {
  let score = 0;

  // Name match (highest priority)
  if (tool.name.toLowerCase().includes(query)) {
    score += 10;
  }

  // Description match
  if (tool.description.toLowerCase().includes(query)) {
    score += 5;
  }

  // Property name match
  const props = Object.keys(tool.inputSchema.properties || {});
  for (const prop of props) {
    if (prop.toLowerCase().includes(query)) {
      score += 3;
    }
  }

  // Enum value match
  for (const prop of Object.values(tool.inputSchema.properties || {})) {
    const propDef = prop as Record<string, unknown>;
    if (Array.isArray(propDef.enum)) {
      for (const val of propDef.enum) {
        if (String(val).toLowerCase().includes(query)) {
          score += 2;
        }
      }
    }
  }

  return score;
}

/**
 * Get a tool definition by name (for execute_tool validation)
 */
export function getToolByName(name: string): ToolDefinition | undefined {
  return ARDUINO_TOOLS.find(t => t.name === name);
}

/**
 * Check if a tool exists
 */
export function toolExists(name: string): boolean {
  return ARDUINO_TOOLS.some(t => t.name === name);
}
