# ESP32-S3 适配

此目录只负责 ESP32-S3 设备参数与编译配置。烧录与串口生命周期由核心服务负责。

- Arduino FQBN：`esp32:esp32:esp32s3`；使用 Espressif 官方稳定索引。
- 支持配置 4 / 8 / 16 / 32 MiB Flash；默认配置为 8 MiB，不能据此推断实际硬件容量。
- `getFqbn()` 将 FlashSize 与界面配置保持一致，保留用户明确填写的 PSRAM、USB 等编译选项。上传波特率由实际烧录器设置，不写入 FQBN，避免不同核心版本的 UploadSpeed 菜单差异导致编译失败。
- PSRAM 默认为 `disabled`，因为不同模块的封装/总线不一致。确定硬件型号后可在 FQBN 添加 `:PSRAM=opi` 或对应选项。
- 静态 RAM 预算按 Arduino 默认 `upload.maximum_data_size=327680` 字节展示，它不是芯片总 SRAM，也不包含外部 PSRAM。
- 默认单 factory 应用布局：bootloader `0x0`、partition table `0x8000`、NVS `0x9000`、PHY `0xf000`、应用 `0x10000`（3 MiB）、core dump `0x310000`（64 KiB）、SPIFFS `0x320000` 至 Flash 末端；不默认启用 OTA。core dump 预留区供官方核心保存崩溃信息，避免新核心启动时报告缺少该分区。旧配置仍然有效，不自动重排已保存的用户分区。
- ESP32-S3 的 bootloader 与 partition table 保留区位置/大小固定；适配器会拒绝移动、删除或新增 system 区。当前版本仅接受一个 factory 应用分区；多应用/OTA 需要扩展契约加入明确 subtype 与启动选择后再实现。
- 托管模式的 Python 路径默认为空，由核心选择项目/应用专用虚拟环境；自定义模式可显式指定 Python 可执行文件。

`createDefaultPartitions(flashSize)` 返回新数组。切换容量时必须重新生成布局或显式调整现有分区，否则核心校验会拒绝越界布局。

官方参考：[Arduino-ESP32 安装与稳定索引](https://docs.espressif.com/projects/arduino-esp32/en/latest/installing.html)、[ESP32-S3 分区表](https://docs.espressif.com/projects/esp-idf/en/stable/esp32s3/api-guides/partition-tables.html)、[板卡选项定义](https://github.com/espressif/arduino-esp32/blob/master/boards.txt)。本机检测结果见 [硬件验证记录](../../../docs/HARDWARE-VALIDATION.md)。
