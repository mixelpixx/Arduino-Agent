/**
 * MCP Tool Definitions for Arduino IDE
 *
 * - Spec-compliant tool annotations (readOnlyHint, destructiveHint,
 *   idempotentHint, openWorldHint) that are sent to clients in tools/list.
 * - Task-enabled tools for async operations (compile/upload).
 * - Grouped tools with action parameters to minimize tool count.
 */

/**
 * Tool annotations as defined by the MCP specification.
 * https://modelcontextprotocol.io/docs/concepts/tools#tool-annotations
 */
export interface ToolAnnotations {
  /** Human-readable title for the tool */
  title?: string;
  /** Tool only reads data, doesn't modify anything */
  readOnlyHint?: boolean;
  /** Tool may make destructive/irreversible changes */
  destructiveHint?: boolean;
  /** Repeated calls with the same arguments have no additional effect */
  idempotentHint?: boolean;
  /** Tool interacts with the outside world (network, hardware, ...) */
  openWorldHint?: boolean;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
  annotations?: ToolAnnotations;
}

export const SERIAL_BAUD_RATES = [
  300, 600, 750, 1200, 2400, 4800, 9600, 19200, 31250, 38400, 57600, 74880,
  115200, 230400, 250000, 460800, 500000, 921600, 1000000, 2000000,
];

// ============================================================
// TOOL DEFINITIONS
// ============================================================

export const ARDUINO_TOOLS: ToolDefinition[] = [
  // ----------------------------------------------------------
  // SKETCH MANAGEMENT
  // ----------------------------------------------------------
  {
    name: 'arduino_sketch',
    description:
      'Manage Arduino sketches - create, open, and edit sketch files. Use get_content to read code, set_content to write code (changes are written to disk immediately and shown in the IDE). Use list_examples to find built-in examples, from_example to create a sketch from an example. File access is restricted to the sketchbook, built-in examples, and temporary sketches.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [
            'create',
            'open',
            'list',
            'get_content',
            'set_content',
            'get_files',
            'get_current',
            'list_examples',
            'from_example',
          ],
          description: 'The sketch operation to perform',
        },
        path: {
          type: 'string',
          description:
            'Path or file:// URI of a sketch folder or file (for open, get_content, set_content)',
        },
        name: {
          type: 'string',
          description:
            'Name for the new sketch (for create). Letters, digits, "_" and "-" only. Created in the sketchbook. Omit to create a temporary sketch.',
        },
        content: {
          type: 'string',
          description: 'Sketch content (for set_content action)',
        },
        example_path: {
          type: 'string',
          description:
            'Path to example (for from_example). Use list_examples to find available examples.',
        },
        category: {
          type: 'string',
          description:
            'Filter examples by category: "01.Basics", "02.Digital", "03.Analog", etc. (for list_examples)',
        },
      },
      required: ['action'],
    },
    annotations: {
      title: 'Arduino sketches',
      readOnlyHint: false,
      destructiveHint: false,
    },
  },

  // ----------------------------------------------------------
  // BUILD OPERATIONS (Task-enabled for async)
  // ----------------------------------------------------------
  {
    name: 'arduino_compile',
    description:
      'Compile a sketch. Recommended: pass wait:true to block until the build finishes and get the result in one call. Without wait it returns a task ID immediately; use arduino_task_status to poll and arduino_build_output for the compiler output. Compiles the sketch open in the IDE unless sketch_path is given; uses the board selected in the IDE unless fqbn is given.',
    inputSchema: {
      type: 'object',
      properties: {
        sketch_path: {
          type: 'string',
          description:
            'Path or file:// URI of the sketch to compile (defaults to the sketch currently open)',
        },
        fqbn: {
          type: 'string',
          description:
            'Fully Qualified Board Name (e.g., arduino:avr:uno). Defaults to the board selected in the IDE.',
        },
        verbose: {
          type: 'boolean',
          description: 'Show verbose compilation output (default: false)',
        },
        wait: {
          type: 'boolean',
          description:
            'Block until the build finishes or timeout_seconds elapses (default: false). On timeout you get the taskId and current progress back - not an error - and can keep waiting with arduino_task_status wait:true.',
        },
        timeout_seconds: {
          type: 'number',
          description:
            'Max seconds to block when wait=true (default 60, clamp 5-600). Keep below your MCP client per-call timeout; a first build for a new core can take 2-3 minutes.',
        },
      },
    },
    annotations: {
      title: 'Compile sketch',
      readOnlyHint: false, // writes build artifacts
      destructiveHint: false,
      idempotentHint: true,
    },
  },

  {
    name: 'arduino_upload',
    description:
      '[CAUTION] Compile and upload a sketch to an Arduino board. This OVERWRITES the firmware on the device. Recommended: pass wait:true to block until the flash finishes. Without wait it returns a task ID for progress tracking via arduino_task_status.',
    inputSchema: {
      type: 'object',
      properties: {
        sketch_path: {
          type: 'string',
          description:
            'Path or file:// URI of the sketch (defaults to the sketch currently open)',
        },
        fqbn: {
          type: 'string',
          description:
            'Fully Qualified Board Name. Defaults to the board selected in the IDE.',
        },
        port: {
          type: 'string',
          description:
            'Serial port (e.g., /dev/ttyUSB0, COM3). Defaults to the port selected in the IDE.',
        },
        verify: {
          type: 'boolean',
          description: 'Verify upload after completion (default: true)',
        },
        wait: {
          type: 'boolean',
          description:
            'Block until compile+flash finishes or timeout_seconds elapses (default: false). A timeout returns current progress, not an error.',
        },
        timeout_seconds: {
          type: 'number',
          description:
            'Max seconds to block when wait=true (default 60, clamp 5-600).',
        },
      },
    },
    annotations: {
      title: 'Upload to board',
      readOnlyHint: false,
      destructiveHint: true, // overwrites firmware
      openWorldHint: true, // talks to external hardware
    },
  },

  {
    name: 'arduino_build_output',
    description:
      'Get the output of the most recent compile/upload, including errors and warnings. Use format=explained for beginner-friendly error descriptions with fix suggestions.',
    inputSchema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: ['output', 'errors', 'warnings', 'all'],
          description: 'What to retrieve (default: all)',
        },
        format: {
          type: 'string',
          enum: ['raw', 'explained'],
          description:
            'Output format. "explained" adds beginner-friendly descriptions and fix suggestions (default: raw)',
        },
      },
    },
    annotations: {
      title: 'Build output',
      readOnlyHint: true,
    },
  },

  // ----------------------------------------------------------
  // BOARD MANAGEMENT
  // ----------------------------------------------------------
  {
    name: 'arduino_board',
    description:
      'Manage Arduino boards - list connected devices (with USB vid/pid), get the IDE board selection, choose a default board/port for this MCP session, get board details including pin capabilities, search boards, install cores. When a connected port shows identified:false, use suggest_fqbn to get FQBN candidates from the USB identity and board name.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [
            'list_connected',
            'list_available',
            'select',
            'get_selected',
            'get_info',
            'search',
            'suggest_fqbn',
            'install_core',
          ],
          description:
            'The board operation to perform. "select" sets the default board/port used by compile/upload for this MCP session (it does not change the IDE UI selection). "get_selected" returns the IDE selection and the MCP session override. "suggest_fqbn" proposes FQBNs for an unidentified board from its USB vid/pid and/or a name.',
        },
        fqbn: {
          type: 'string',
          description:
            'Fully Qualified Board Name (for select, get_info). Example: arduino:avr:uno',
        },
        port: {
          type: 'string',
          description:
            'Serial port to associate with the board (for select), or the port to identify (for suggest_fqbn; defaults to the selected port)',
        },
        query: {
          type: 'string',
          description: 'Search query (for search action)',
        },
        name: {
          type: 'string',
          description:
            'Board/product name to match, e.g. "esp32 s3" or the name on the silkscreen (for suggest_fqbn)',
        },
        core: {
          type: 'string',
          description: 'Core to install (e.g., arduino:avr, esp32:esp32)',
        },
      },
      required: ['action'],
    },
    annotations: {
      title: 'Arduino boards',
      readOnlyHint: false, // install_core modifies the system
      openWorldHint: true, // install_core downloads from the internet
    },
  },

  // ----------------------------------------------------------
  // SERIAL MONITOR
  // ----------------------------------------------------------
  {
    name: 'arduino_serial',
    description:
      'Serial monitor operations - connect to a board, read its output, send data, change the baud rate. Reads are cursor-based: every read returns a `cursor`; pass it back as `since` to page through output losslessly. wait_for blocks until a line matching a pattern arrives. Crash/reset signatures in the output (ESP32 panics, watchdog, brownout, reset reasons) are detected automatically and returned as `events` - a reset or crash also ends a pending wait_for early. The connection is shared with the IDE serial monitor.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [
            'connect',
            'disconnect',
            'read',
            'wait_for',
            'write',
            'clear',
            'get_config',
            'set_config',
            'list_ports',
          ],
          description: 'The serial operation to perform',
        },
        port: {
          type: 'string',
          description: 'Serial port (e.g., /dev/ttyUSB0, COM3)',
        },
        baud_rate: {
          type: 'number',
          description: 'Baud rate (default: 9600)',
          enum: SERIAL_BAUD_RATES,
        },
        fqbn: {
          type: 'string',
          description:
            'Board FQBN for the monitor (for connect; only needed when the board on the port cannot be auto-detected)',
        },
        data: {
          type: 'string',
          description: 'Data to send (for write action)',
        },
        line_ending: {
          type: 'string',
          enum: ['none', 'newline', 'carriage', 'both'],
          description: 'Line ending for write operations (default: newline)',
        },
        max_lines: {
          type: 'number',
          description: 'Maximum lines to return for read (default: 100)',
        },
        since: {
          type: 'number',
          description:
            'Cursor from a previous read/wait_for response (for read, wait_for). Returns only output at or after that offset, with `dropped` counting anything lost to buffer overflow - lossless paging instead of an overlapping tail.',
        },
        pattern: {
          type: 'string',
          description:
            'Substring (or regex when is_regex=true) to wait for (for wait_for). Blocks until a matching line arrives.',
        },
        is_regex: {
          type: 'boolean',
          description:
            'Treat pattern as a regular expression (for wait_for; default: false)',
        },
        timeout_seconds: {
          type: 'number',
          description:
            'Max seconds wait_for blocks (default 30, clamp 1-120). A timeout returns matched:false with a cursor - not an error.',
        },
      },
      required: ['action'],
    },
    annotations: {
      title: 'Serial monitor',
      readOnlyHint: false, // write sends data to device
      openWorldHint: true, // communicates with external hardware
    },
  },

  // ----------------------------------------------------------
  // LIBRARY MANAGEMENT
  // ----------------------------------------------------------
  {
    name: 'arduino_library',
    description:
      'Manage Arduino libraries - search the library registry, install/remove libraries, list installed libraries, get library details and examples.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['search', 'install', 'remove', 'list', 'get_info', 'get_examples'],
          description: 'The library operation to perform',
        },
        query: {
          type: 'string',
          description: 'Search query',
        },
        name: {
          type: 'string',
          description: 'Library name (for install, remove, get_info, get_examples)',
        },
        version: {
          type: 'string',
          description: 'Specific version to install (defaults to latest)',
        },
      },
      required: ['action'],
    },
    annotations: {
      title: 'Arduino libraries',
      readOnlyHint: false,
      openWorldHint: true, // install downloads from the internet
    },
  },

  // ----------------------------------------------------------
  // CONTEXT & STATE
  // ----------------------------------------------------------
  {
    name: 'arduino_context',
    description:
      'Get current IDE state including open sketch, selected board/port, connected devices, serial monitor status.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    annotations: {
      title: 'IDE context',
      readOnlyHint: true,
    },
  },

  // ----------------------------------------------------------
  // TASK STATUS (for async operations)
  // ----------------------------------------------------------
  {
    name: 'arduino_task_status',
    description:
      'Check status of async operations (compile, upload). Returns pending/running/completed/failed status, progress, and result. Pass wait:true to block until the task finishes instead of polling.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
          description: 'Task ID returned from arduino_compile or arduino_upload',
        },
        wait: {
          type: 'boolean',
          description:
            'Block until the task reaches a terminal status or timeout_seconds elapses (default: false). A timeout returns current progress with timed_out:true - just call again to keep waiting.',
        },
        timeout_seconds: {
          type: 'number',
          description:
            'Max seconds to block when wait=true (default 60, clamp 5-600).',
        },
      },
      required: ['task_id'],
    },
    annotations: {
      title: 'Task status',
      readOnlyHint: true,
    },
  },

  // ----------------------------------------------------------
  // CODE FORMATTING
  // ----------------------------------------------------------
  {
    name: 'arduino_format',
    description:
      'Format Arduino/C++ code using clang-format. Returns the formatted code string.',
    inputSchema: {
      type: 'object',
      properties: {
        content: {
          type: 'string',
          description: 'The code content to format',
        },
        tab_size: {
          type: 'number',
          description: 'Number of spaces per tab (default: 2)',
        },
        insert_spaces: {
          type: 'boolean',
          description: 'Use spaces instead of tabs (default: true)',
        },
      },
      required: ['content'],
    },
    annotations: {
      title: 'Format code',
      readOnlyHint: true,
      idempotentHint: true,
    },
  },

  // ----------------------------------------------------------
  // IDE CONFIGURATION
  // ----------------------------------------------------------
  {
    name: 'arduino_config',
    description:
      'Manage Arduino IDE configuration - get/set sketchbook location, additional board manager URLs, data directory.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['get', 'set', 'add_board_url'],
          description: 'The configuration operation to perform',
        },
        sketch_dir: {
          type: 'string',
          description: 'Sketchbook directory path (for set action)',
        },
        additional_urls: {
          type: 'array',
          items: { type: 'string' },
          description: 'Additional board manager URLs (for set action)',
        },
        url: {
          type: 'string',
          description: 'Board manager URL to add (for add_board_url action)',
        },
      },
      required: ['action'],
    },
    annotations: {
      title: 'IDE configuration',
      readOnlyHint: false,
    },
  },
];

// ============================================================
// TOOL SAFETY REFERENCE TABLE
// ============================================================
/**
 * Quick reference for tool safety levels (also sent to clients as annotations):
 *
 * | Tool                 | Read-Only | Destructive | Open World | Idempotent |
 * |----------------------|-----------|-------------|------------|------------|
 * | arduino_sketch       | No        | No          | No         | No         |
 * | arduino_compile      | No        | No          | No         | Yes        |
 * | arduino_upload       | No        | YES*        | Yes        | No         |
 * | arduino_build_output | Yes       | No          | No         | -          |
 * | arduino_board        | No        | No          | Yes        | No         |
 * | arduino_serial       | No        | No          | Yes        | No         |
 * | arduino_library      | No        | No          | Yes        | No         |
 * | arduino_context      | Yes       | No          | No         | -          |
 * | arduino_task_status  | Yes       | No          | No         | -          |
 * | arduino_format       | Yes       | No          | No         | Yes        |
 * | arduino_config       | No        | No          | No         | No         |
 *
 * * arduino_upload overwrites device firmware - use caution
 */
