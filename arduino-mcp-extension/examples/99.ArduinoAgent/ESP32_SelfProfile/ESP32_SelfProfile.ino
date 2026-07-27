// ESP32-S3 self-profile — the board measures its own silicon.
//
// Needs nothing connected but USB. Written, compiled, flashed and read back
// entirely through the Arduino Agent MCP server.
//
// Emits JSON lines so an agent can parse the results directly:
//   {"section":"chip"|"memory"|"cpu", ...}
//   {"t":<sec>,"phase":"idle"|"load"|"cool","tempC":<float>,"mhz":<int>}
//
// The radios stay off for the whole run: WiFi/BLE would add their own heat and
// contaminate the thermal curve.

#include <Arduino.h>
#include <esp_heap_caps.h>
#include <esp_system.h>

#ifndef LED_BUILTIN
#define LED_BUILTIN 2
#endif

// ---- dual-core load control -------------------------------------------------
volatile bool burning = false;
volatile double sinkA = 0.0;   // volatile sinks stop the optimiser deleting the work
volatile double sinkB = 0.0;

static void burnTask(void* arg) {
  (void)arg;
  double acc = 1.0;
  uint32_t lastYield = millis();
  for (;;) {
    if (burning) {
      for (int i = 0; i < 50000; i++) {
        acc = acc * 1.0000001 + 0.0000001;
      }
      sinkB = acc;
      if (acc > 1e30) acc = 1.0;
      // A tight loop at priority 1 starves FreeRTOS' IDLE0 task, which is what
      // feeds the task watchdog - core 0 panics and the chip reboots mid-run.
      // Yield ~1ms every 200ms: enough for IDLE to run, still >99% duty cycle
      // so the thermal measurement is unaffected.
      if (millis() - lastYield >= 200) {
        lastYield = millis();
        vTaskDelay(1);
      }
    } else {
      acc = 1.0;
      vTaskDelay(20 / portTICK_PERIOD_MS);
    }
  }
}

// ---- helpers ---------------------------------------------------------------
static const char* resetReasonName(esp_reset_reason_t r) {
  switch (r) {
    case ESP_RST_POWERON:  return "power-on";
    case ESP_RST_EXT:      return "external";
    case ESP_RST_SW:       return "software";
    case ESP_RST_PANIC:    return "panic";
    case ESP_RST_INT_WDT:  return "int-watchdog";
    case ESP_RST_TASK_WDT: return "task-watchdog";
    case ESP_RST_WDT:      return "other-watchdog";
    case ESP_RST_DEEPSLEEP:return "deep-sleep-wake";
    case ESP_RST_BROWNOUT: return "brownout";
    case ESP_RST_SDIO:     return "sdio";
    default:               return "unknown";
  }
}

// Integer throughput: millions of add/xor ops per second.
static double benchInt() {
  const uint32_t ITER = 4000000;
  volatile uint32_t acc = 0;
  uint32_t t0 = micros();
  for (uint32_t i = 0; i < ITER; i++) {
    acc += i ^ (acc >> 3);
  }
  uint32_t dt = micros() - t0;
  sinkA = (double)acc;
  return (double)ITER / (double)dt;   // ops per microsecond == Mops/s
}

// Float throughput: millions of multiply-adds per second.
static double benchFloat() {
  const uint32_t ITER = 2000000;
  volatile float acc = 1.0f;
  float a = 1.0000001f;
  uint32_t t0 = micros();
  for (uint32_t i = 0; i < ITER; i++) {
    acc = acc * a + 0.0000001f;
  }
  uint32_t dt = micros() - t0;
  sinkA = (double)acc;
  return (double)ITER / (double)dt;
}

// memcpy bandwidth in MB/s for a given heap capability.
static double benchBandwidth(uint32_t caps, size_t bytes, int reps) {
  uint8_t* src = (uint8_t*)heap_caps_malloc(bytes, caps | MALLOC_CAP_8BIT);
  uint8_t* dst = (uint8_t*)heap_caps_malloc(bytes, caps | MALLOC_CAP_8BIT);
  if (!src || !dst) {
    if (src) heap_caps_free(src);
    if (dst) heap_caps_free(dst);
    return -1.0;
  }
  memset(src, 0xA5, bytes);
  uint32_t t0 = micros();
  for (int i = 0; i < reps; i++) {
    memcpy(dst, src, bytes);
  }
  uint32_t dt = micros() - t0;
  heap_caps_free(src);
  heap_caps_free(dst);
  if (dt == 0) return -1.0;
  double totalMB = ((double)bytes * reps) / (1024.0 * 1024.0);
  return totalMB / ((double)dt / 1e6);
}

static void sampleTemp(int tsec, const char* phase) {
  Serial.print("{\"t\":");
  Serial.print(tsec);
  Serial.print(",\"phase\":\"");
  Serial.print(phase);
  Serial.print("\",\"tempC\":");
  Serial.print(temperatureRead(), 2);
  Serial.print(",\"mhz\":");
  Serial.print(getCpuFrequencyMhz());
  Serial.println("}");
}

// Busy-waits ~1s on this core while the pinned task loads the other one.
static void burnOneSecond() {
  uint32_t t0 = millis();
  uint32_t lastYield = t0;
  double acc = 1.0;
  while (millis() - t0 < 1000) {
    for (int i = 0; i < 20000; i++) {
      acc = acc * 1.0000001 + 0.0000001;
    }
    if (acc > 1e30) acc = 1.0;
    if (millis() - lastYield >= 200) {   // same watchdog courtesy on core 1
      lastYield = millis();
      vTaskDelay(1);
    }
  }
  sinkA = acc;
}

void setup() {
  Serial.begin(115200);
  delay(1200);
  pinMode(LED_BUILTIN, OUTPUT);

  xTaskCreatePinnedToCore(burnTask, "burn", 4096, nullptr, 1, nullptr, 0);

  Serial.println();
  Serial.println("PROFILE_START");

  // ---- chip identity ----
  uint64_t mac = ESP.getEfuseMac();
  char macStr[18];
  snprintf(macStr, sizeof(macStr), "%02X:%02X:%02X:%02X:%02X:%02X",
           (uint8_t)(mac >> 0), (uint8_t)(mac >> 8), (uint8_t)(mac >> 16),
           (uint8_t)(mac >> 24), (uint8_t)(mac >> 32), (uint8_t)(mac >> 40));

  Serial.print("{\"section\":\"chip\",\"model\":\"");
  Serial.print(ESP.getChipModel());
  Serial.print("\",\"revision\":");
  Serial.print(ESP.getChipRevision());
  Serial.print(",\"cores\":");
  Serial.print(ESP.getChipCores());
  Serial.print(",\"mhz\":");
  Serial.print(getCpuFrequencyMhz());
  Serial.print(",\"mac\":\"");
  Serial.print(macStr);
  Serial.print("\",\"sdk\":\"");
  Serial.print(ESP.getSdkVersion());
  Serial.print("\",\"resetReason\":\"");
  Serial.print(resetReasonName(esp_reset_reason()));
  Serial.println("\"}");

  // ---- memory ----
  Serial.print("{\"section\":\"memory\",\"flashBytes\":");
  Serial.print(ESP.getFlashChipSize());
  Serial.print(",\"flashMhz\":");
  Serial.print(ESP.getFlashChipSpeed() / 1000000);
  Serial.print(",\"heapBytes\":");
  Serial.print(ESP.getHeapSize());
  Serial.print(",\"freeHeap\":");
  Serial.print(ESP.getFreeHeap());
  Serial.print(",\"psramBytes\":");
  Serial.print(ESP.getPsramSize());
  Serial.print(",\"freePsram\":");
  Serial.print(ESP.getFreePsram());
  Serial.println("}");

  // ---- bandwidth: internal SRAM vs external PSRAM ----
  double bwInternal = benchBandwidth(MALLOC_CAP_INTERNAL, 64 * 1024, 64);
  double bwPsram    = benchBandwidth(MALLOC_CAP_SPIRAM,   64 * 1024, 64);

  // ---- cpu throughput at full clock, then throttled ----
  int fullMhz = getCpuFrequencyMhz();
  double intFull = benchInt();
  double fltFull = benchFloat();

  setCpuFrequencyMhz(80);
  delay(50);
  int lowMhz = getCpuFrequencyMhz();
  double intLow = benchInt();
  double fltLow = benchFloat();

  setCpuFrequencyMhz(fullMhz);
  delay(50);

  Serial.print("{\"section\":\"cpu\",\"fullMhz\":");
  Serial.print(fullMhz);
  Serial.print(",\"lowMhz\":");
  Serial.print(lowMhz);
  Serial.print(",\"intMopsFull\":");
  Serial.print(intFull, 2);
  Serial.print(",\"intMopsLow\":");
  Serial.print(intLow, 2);
  Serial.print(",\"floatMopsFull\":");
  Serial.print(fltFull, 2);
  Serial.print(",\"floatMopsLow\":");
  Serial.print(fltLow, 2);
  Serial.print(",\"sramMBs\":");
  Serial.print(bwInternal, 1);
  Serial.print(",\"psramMBs\":");
  Serial.print(bwPsram, 1);
  Serial.println("}");

  // ---- thermal response: idle -> both cores 100% -> cooldown ----
  Serial.println("THERMAL_START");
  int t = 0;

  for (int i = 0; i < 8; i++, t++) {      // idle baseline
    sampleTemp(t, "idle");
    delay(1000);
  }

  burning = true;                          // core 0 task starts working
  digitalWrite(LED_BUILTIN, HIGH);
  for (int i = 0; i < 30; i++, t++) {      // both cores pinned at 100%
    burnOneSecond();                       // core 1 busy-waits ~1s
    sampleTemp(t, "load");
  }
  burning = false;
  digitalWrite(LED_BUILTIN, LOW);

  for (int i = 0; i < 30; i++, t++) {      // cooldown
    sampleTemp(t, "cool");
    delay(1000);
  }

  Serial.println("THERMAL_END");
  Serial.println("PROFILE_END");
}

void loop() {
  digitalWrite(LED_BUILTIN, HIGH);
  delay(100);
  digitalWrite(LED_BUILTIN, LOW);
  delay(1900);
  Serial.print("idle tempC=");
  Serial.println(temperatureRead(), 2);
}
