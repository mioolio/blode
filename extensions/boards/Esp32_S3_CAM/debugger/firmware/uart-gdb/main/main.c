// SPDX-License-Identifier: Apache-2.0
#include <stdint.h>
#include <stdio.h>
#include "sdkconfig.h"
#include "esp_idf_version.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#if ESP_IDF_VERSION != ESP_IDF_VERSION_VAL(5, 1, 4)
#error "Use ESP-IDF v5.1.4 for this reference firmware"
#endif
#if !CONFIG_IDF_TARGET_ESP32S3 || !CONFIG_ESP_SYSTEM_GDBSTUB_RUNTIME
#error "ESP32-S3 runtime GDB stub must be enabled in sdkconfig"
#endif
#if CONFIG_ESP_GDBSTUB_SUPPORT_TASKS
#error "This reference firmware uses the stopped CPU context; disable ESP_GDBSTUB_SUPPORT_TASKS"
#endif
#if CONFIG_ESP_CONSOLE_UART_NUM != 0 || CONFIG_ESP_CONSOLE_UART_BAUDRATE != 115200 || \
    CONFIG_ESP_CONSOLE_UART_TX_GPIO != 43 || CONFIG_ESP_CONSOLE_UART_RX_GPIO != 44
#error "The reference transport is UART0 TX=43 RX=44 at 115200 baud"
#endif

volatile uint32_t blode_debug_counter;
volatile uint32_t blode_debug_values[4] = {0x12345678, 0xabcdef01, 0, 0};

__attribute__((noinline)) void blode_debug_tick(void)
{
    blode_debug_counter++;
    blode_debug_values[2] = blode_debug_counter;
    blode_debug_values[3] = blode_debug_counter ^ 0x55aa55aa;
}

void app_main(void)
{
    // IDF v5.1.4 freertos/app_startup.c calls esp_gdbstub_init() before app_main.
    // UART0 belongs to the stub; do not install a second UART RX driver here.
    puts("Blode UART GDB ready: UART0 TX=43 RX=44 baud=115200");
    while (1) {
        blode_debug_tick();
        vTaskDelay(pdMS_TO_TICKS(100));
    }
}
