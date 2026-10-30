# 硬件调试

`manifest.debugger.mode` 为 `builtin`，使用宿主的 GDB/MI 会话引擎和 ESP32-S3 调试配置。原生 USB-JTAG 连接使用 Espressif OpenOCD 与 Xtensa GDB；**烧录底座调试**使用 UART runtime GDB stub 与 Xtensa GDB，不依赖 OpenOCD。

底座串口调试需要固件启用 runtime stub。独立 ESP-IDF v5.1.4 参考工程、构建产物及 Arduino 3.0.7 工程迁移步骤见 [firmware/uart-gdb](firmware/uart-gdb/README.md)。模板位于模块内，并随独立模块资源打包；4 MiB／无 PSRAM 的计数器配置不替代相机工程自己的配置。

本目录目前没有替换宿主调试器的业务入口；第三方实现通过运行时插件 `debugger` 接口注册。官方连接说明：[ESP32-S3 JTAG 调试](https://docs.espressif.com/projects/esp-idf/en/stable/esp32s3/api-guides/jtag-debugging/index.html)。
