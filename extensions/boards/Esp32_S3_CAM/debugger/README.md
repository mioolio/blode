# 硬件调试

`manifest.debugger.mode` 为 `builtin`，使用宿主的 GDB/MI 会话引擎和 ESP32-S3 调试配置。连接通过芯片内置 USB JTAG；工具为 Espressif OpenOCD 与 Xtensa GDB。USB 转串口连接用于烧录或串口通信，不提供 JTAG。

本目录目前没有替换宿主调试器的业务入口；第三方实现通过运行时插件 `debugger` 接口注册。官方连接说明：[ESP32-S3 JTAG 调试](https://docs.espressif.com/projects/esp-idf/en/stable/esp32s3/api-guides/jtag-debugging/index.html)。
