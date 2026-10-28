# 默认通用 ESP 烧录器

适用于 esptool 支持的 Espressif 芯片。芯片型号由 ROM 自动识别，避免把其他 ESP 型号强制当作 ESP32-S3。

将用户自行构建的 `firmware.bin` 放入工作区。默认应用分区 offset 为 `0x0`，适用于从地址零开始的 **合并固件**。如果只有应用镜像，必须先把应用分区起点改为构建工具要求的地址，并保证设备上已有匹配的 bootloader 和分区表。

此适配器没有默认编译器，不宣称支持任意 MCU 架构。要编译其他板卡，可配置自定义 Arduino CLI/FQBN，或新建对应板卡与烧录协议适配器。

烧录参数通过数组交给 `spawn(..., { shell: false })`。不使用 `--force` 或全片擦除，不绕过设备的 Secure Boot / Flash Encryption 保护。每个段的边界和大小仍应在核心中读取真实文件后验证。
