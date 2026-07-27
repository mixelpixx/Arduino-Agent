---
name: arduino-agent
description: Drive Arduino-compatible hardware through the Arduino Agent MCP server - identify boards, write sketches, compile, flash, and debug over serial. Use when working with Arduino, ESP32, or embedded boards via the arduino MCP tools.
---

# Driving hardware with Arduino Agent

Arduino Agent is an Arduino IDE with an MCP server embedded in it. You share
one editor, one board and one serial monitor with the user: when you write a
sketch, their editor live-reloads; when they select a board, your tools see it.

The server's own instructions (sent at connect) cover the core workflow. This
skill adds the judgment that comes from real hardware sessions.

## Install the bridge, not the URL

If the MCP config points at `http://127.0.0.1:3847/mcp` directly, the whole
server shows "failed to connect" whenever the IDE is closed. Prefer the stdio
bridge (`arduino-mcp-extension/bridge/arduino-agent-bridge.js` in the repo or
install): it always connects, returns "launch the IDE" as a normal tool error,
and recovers without a client restart.

## Identifying boards: the decision tree

1. `arduino_board list_connected` → each port has `identified`, `vid`, `pid`.
2. `identified: true` → use the reported fqbn. Done.
3. `identified: false` → `arduino_board suggest_fqbn {port}`:
   - **Native VID** (Espressif 0x303A, Arduino 0x2341, RasPi 0x2E8A): family
     candidates come back; PID cannot distinguish S2/S3/C3 variants, so ask
     the user or check the silkscreen if more than one fits.
   - **Bridge VID** (CH34x 0x1A86, CP210x 0x10C4, FTDI 0x0403): the VID names
     the *adapter*, not the MCU. Re-run with `name:` from the user/silkscreen.
   - `core_to_install` set → run `install_core` (esp32 core ≈ minutes and GBs;
     warn the user), then re-run suggest_fqbn if the fqbn was hidden.
4. From then on pass the fqbn EXPLICITLY to compile/upload/serial connect.
   Never retry auto-identification hoping it changes - it cannot.

## Flashing: which USB port matters more than anything

Many dev boards have two USB-C ports. **Uploads via the UART/bridge port just
work** (esptool toggles DTR/RTS). Uploads via the **native USB port** often
fail with "No serial data received" and may need the user to hold BOOT, tap
RESET, release BOOT - and after flashing, the port re-enumerates and can
change its number. If an upload fails, read `result.explained` first; it
distinguishes these cases. When the user reports a two-port board, recommend
the UART port.

Match `CDCOnBoot` to the cable: on the UART port use `CDCOnBoot=default`
(Serial → UART0); `CDCOnBoot=cdc` sends Serial to the native port and the
UART port goes silent while the sketch runs fine.

## Serial: capture without loss, diagnose crashes

- Keep the `cursor` from every read; pass it as `since` next time. `dropped`
  > 0 means the 512KB buffer overflowed between reads - read more often.
- `wait_for {pattern, timeout_seconds}` beats polling. A crash/reset resolves
  it early with the `event` attached - that is a feature, not a failure.
- `events` tell you what a raw stream cannot: repeated `reset` events =
  crash loop (compare `detail` reasons); `panic` carries the Guru Meditation
  cause and backtrace; `brownout` = power supply, not code; `watchdog` =
  something starved an idle task.
- Garbage output = baud mismatch. The monitor's reported baudRate is always
  the true wire rate; match the sketch's `Serial.begin()`.

## Firmware the hardware will accept

- Never busy-loop: `while(true){}` or a tight compute loop starves FreeRTOS'
  idle task → task watchdog → reboot. Yield ~1ms every ≤200ms
  (`vTaskDelay(1)`) - >99% duty cycle, no watchdog.
- ESP32 PSRAM is ~17x slower than internal SRAM (measured); keep hot buffers
  internal, bulk data in PSRAM.
- After `esp_restart()` or a panic, boot-ROM lines appear on UART (not always
  on native USB). Wait ~1s after CDC re-enumeration before expecting output.

## Recipes (also available as MCP prompts)

- **/bringup** — detect → suggest_fqbn → install core → heartbeat blink →
  upload wait:true → wait_for the heartbeat.
- **/debug-serial** — connect → cursor reads → interpret events → concrete fix.
- **/profile-board** — from_example 99.ArduinoAgent/ESP32_SelfProfile →
  upload → parse the JSON it streams (chip, memory bandwidth, thermal curve).
  Needs nothing but USB; good demo and good smoke test of a board.

## No board? Simulate

Wokwi's CLI ships an experimental MCP server that runs firmware on simulated
boards (ESP32, Uno, ...) - virtual buttons, sensors, serial assertions. Use it
alongside Arduino Agent when no hardware is attached: develop and logic-test
in the simulator, then flash the real board with these tools. See
https://docs.wokwi.com/wokwi-ci/mcp-support (needs a Wokwi CLI token).

## Timeouts

Task waits: default 60s, max 600. Serial wait_for: default 30s, max 120. Both
return progress/cursor on timeout instead of erroring - re-issue to keep
waiting. Keep requested timeouts under your client's per-call MCP timeout.
