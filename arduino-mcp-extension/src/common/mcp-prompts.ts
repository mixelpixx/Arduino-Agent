/**
 * MCP prompts - reusable workflows surfaced by clients as slash commands
 * (Claude Code shows them as /arduino:bringup etc.). Each returns messages
 * that put the agent on the proven path for a common hardware task.
 */

export interface MCPPromptArgument {
  name: string;
  description: string;
  required: boolean;
}

export interface MCPPromptDefinition {
  name: string;
  description: string;
  arguments: MCPPromptArgument[];
  /** Builds the prompt messages from the (string) arguments. */
  build(args: Record<string, string>): string;
}

export const MCP_PROMPTS: MCPPromptDefinition[] = [
  {
    name: 'bringup',
    description:
      'Bring up a connected board from scratch: identify it, install its core if needed, flash a minimal sketch and prove it runs.',
    arguments: [
      {
        name: 'port',
        description: 'Serial port to use (omit to auto-detect)',
        required: false,
      },
    ],
    build: (args) => `Bring up the Arduino-compatible board${
      args.port ? ` on port ${args.port}` : ''
    } end to end:

1. arduino_board list_connected - find the board${
      args.port ? ` on ${args.port}` : ' (pick the most likely port)'
    }. Note identified and the USB vid/pid.
2. If identified:false, arduino_board suggest_fqbn with the port (add a name if the user gave one). Install the suggested core with install_core if core_to_install is set - this can take minutes for large cores like esp32.
3. Create a minimal heartbeat sketch: blink LED_BUILTIN and Serial.println a counter once per second at 115200 baud. No busy-loops without delay().
4. arduino_upload with wait:true and the explicit fqbn. If it fails, read result.explained and follow the suggestion (bridge port vs native USB, BOOT button, port busy).
5. arduino_serial connect at 115200 (pass the fqbn), then wait_for the heartbeat. Report the board model, chosen FQBN, and proof of life. If events show resets, diagnose before declaring success.`,
  },
  {
    name: 'debug-serial',
    description:
      'Capture and diagnose what a board is doing over serial - including crashes, reboots and watchdogs.',
    arguments: [
      {
        name: 'port',
        description: 'Serial port (omit to use the selected one)',
        required: false,
      },
      {
        name: 'baud',
        description: 'Baud rate (default 115200)',
        required: false,
      },
    ],
    build: (args) => `Diagnose the board's serial output${
      args.port ? ` on ${args.port}` : ''
    }:

1. arduino_serial connect at ${
      args.baud || '115200'
    } (pass an explicit fqbn if the board is unidentified). If output is garbage, the sketch's Serial.begin() rate differs - try common rates (9600, 115200).
2. Capture with cursor-based reads: read, keep the cursor, pass it as since on the next read - never lose lines. For expected output use wait_for {pattern}.
3. Watch the events field on every response. reset events carry the reason (POWERON, RTC_SW_CPU_RST, TG1WDT_SYS_RST...); panic events carry the Guru Meditation cause and the backtrace as detail. Repeated resets = crash loop.
4. For a panic backtrace, map addresses to the sketch: recompile with wait:true, and reason about which function likely faulted from the sketch source.
5. Report: what the board prints, any crash/reset events with their causes, and a concrete fix (watchdog-starving loop, null pointer, brownout = power supply, wrong baud).`,
  },
  {
    name: 'profile-board',
    description:
      'Run the bundled self-profile example: the board measures its own CPU, memory bandwidth and thermal response, no wiring needed.',
    arguments: [],
    build: () => `Profile the connected ESP32-class board using the bundled example (needs nothing but USB):

1. arduino_sketch list_examples with category "99.ArduinoAgent", then from_example on ESP32_SelfProfile.
2. arduino_upload with wait:true (explicit fqbn if unidentified; the example targets ESP32-family boards).
3. arduino_serial connect at 115200, then wait_for "PROFILE_START". Page output with cursor-based reads until "PROFILE_END" (~80s: chip/memory/cpu JSON, then a 68-sample thermal curve across idle -> both-cores-100% -> cooldown).
4. Parse the JSON lines and report: chip model/revision, flash/PSRAM sizes, internal-SRAM vs PSRAM bandwidth ratio, integer/float Mops at both clock speeds, and the thermal delta under load with recovery time. Watch events for watchdog/resets - the load phase is watchdog-safe by design, so any crash is a real finding.`,
  },
];

export function findPrompt(name: string): MCPPromptDefinition | undefined {
  return MCP_PROMPTS.find((p) => p.name === name);
}
