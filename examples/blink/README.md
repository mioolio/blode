# ESP32-S3 heartbeat

此示例通过 UART 串口每秒输出心跳及可用堆内存，不依赖开发板 LED 引脚。

在 Blode Studio 中选择此目录，选择 ESP32-S3 和实际端口，读取芯片信息，确认实际 Flash 容量后配置分区。点击构建，再点击烧录。串口监视器使用 115200 波特率。

`blink.ino` 只处理应用逻辑，`src/config/settings.h` 集中保存应用参数。板卡优化、编译选项和烧录地址由 `extensions/boards/esp32-s3` 管理。

English: open this folder, select the ESP32-S3 adapter and serial port, probe the chip, set its actual flash capacity, build, then flash. Use the serial monitor at 115200 baud. No on-board LED pin is assumed.
