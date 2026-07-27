/**
 * Server instructions sent to every MCP client in the initialize response.
 *
 * This is the one guidance channel that reaches ALL clients regardless of
 * vendor, so it carries the workflow knowledge an agent needs to drive real
 * hardware well. Learned from driving a physical ESP32-S3 through these
 * tools; keep it short - it lands in the client's context on every session.
 *
 * KEEP IN SYNC with the copy embedded in bridge/arduino-agent-bridge.js
 * (the stdio bridge must answer initialize locally when the IDE is closed).
 * The manual smoke test asserts the two stay identical.
 */
export const MCP_SERVER_INSTRUCTIONS = `Arduino Agent - an Arduino IDE with this MCP server embedded. You share one editor, one board and one serial monitor with the user; prefer these tools over asking the user to click in the IDE.

Recommended workflow:
1. arduino_context for current state (open sketch, selected board/port, connected boards with USB vid/pid).
2. If the board shows identified:false, run arduino_board suggest_fqbn (uses USB identity + name matching; tells you which core to install if missing). ALWAYS pass an explicit fqbn to compile/upload/serial connect for such boards - they can never be auto-identified.
3. Write code with arduino_sketch (set_content writes to disk AND live-reloads the user's editor).
4. Compile/upload with wait:true - one call returns the final result. A timed_out:true response is NOT an error: call arduino_task_status {task_id, wait:true} to keep waiting (first builds for a new core can take minutes).
5. arduino_upload compiles first automatically - no separate compile needed.
6. After upload, connect serial at the baud rate in the sketch's Serial.begin(). Reads are cursor-based: keep the returned cursor and pass it as since to page output losslessly. Use wait_for {pattern} to block until expected output arrives.
7. Crash/reset detection is automatic: read/wait_for responses carry events (reset/panic/watchdog/brownout/abort, with reset reasons and backtraces). A crash ends a pending wait_for early. "No output" plus reset events means the board is crash-looping, not quiet.

Failure handling:
- Failed compile/upload tasks carry result.explained - read it before retrying; it names the cause and the fix (port busy, bootloader mode, wrong FQBN, power).
- Native-USB boards (ESP32-S2/S3/C3) re-enumerate after reset: the port can change or vanish; re-run arduino_board list_connected. Uploads are far more reliable via a board's UART/bridge port; native-USB uploads can require holding BOOT while pressing RESET.
- Serial port busy on upload usually means this server's own monitor is connected: arduino_serial disconnect first.

Firmware rules of thumb:
- Never busy-loop without delay()/vTaskDelay() on ESP32 - a starved idle task trips the task watchdog and reboots the chip.
- Serial.begin(115200) is the conventional rate; after flashing over native USB, wait ~1s for CDC re-enumeration before expecting output.`;
