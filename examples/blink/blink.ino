#include <Arduino.h>
#include "src/config/settings.h"

// Keep hardware setup separate from application behavior.
// This example prints a heartbeat without assuming the board's LED pin.
void setup() {
  Serial.begin(SERIAL_BAUD);
  delay(300);
  Serial.println("Blode Studio / ESP32-S3 ready");
}

void loop() {
  static uint32_t heartbeat = 0;
  Serial.printf("heartbeat=%lu; free_heap=%lu bytes\n",
                static_cast<unsigned long>(heartbeat++),
                static_cast<unsigned long>(ESP.getFreeHeap()));
  delay(HEARTBEAT_INTERVAL_MS);
}
