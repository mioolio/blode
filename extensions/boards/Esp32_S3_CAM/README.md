# Esp32_S3_CAM 运行时包

当前声明范围为 ESP32-S3，沿用 `esp32:esp32:esp32s3` 参数。摄像头型号、引脚、时钟和外设初始化由用户工程配置；目录名不表示软件预设了特定摄像头模组接线，也不声明 ESP32、S2、C3 等其他系列可用。第三方插件接口见[开发指南](../../../docs/RUNTIME-PLUGINS.md)。

此目录拥有 S3 的配置、工具链、运行时、烧录和布局实现。它通过 ../../runtime.ts 的 RuntimeHost 使用通用宿主服务，不导入 src/core 或 STM32 平台实现。

| 文件                      | 责任                                                  |
| ------------------------- | ----------------------------------------------------- |
| adapter.ts、manifest.json | 设备事实、默认配置、能力及校验                        |
| runtime.ts                | 扫描、识别、安装、构建和烧录生命周期                  |
| toolchain.ts              | Arduino CLI、Arduino-ESP32、Python/esptool 检测与安装 |
| programmer.ts             | S3 esptool 参数，不声明其他 ESP 型号支持              |
| layout.ts、partitions.ts  | S3 几何约束、默认分区与 CSV                           |

Arduino FQBN 为 esp32:esp32:esp32s3，Flash 配置支持 4/8/16/32 MiB。默认容量不代表硬件实测，识别结果必须匹配本平台。PSRAM 默认关闭，用户根据模块总线显式配置；运行时上传速率不塞入编译菜单。

布局固定 bootloader 0x0、分区表 0x8000；默认单 factory 应用位于 0x10000，另有 NVS、PHY、core dump 和文件系统区。默认布局调整不自动重排已保存用户分区。系统保留区不能移动/删除，当前不开放多应用 OTA。

构建使用完整 Arduino sketch 和 src/ 下模块，平台生成 staging 及 partitions.csv，真实工具输出决定容量。设置 be.build.entry 只是选定文件/目录，不立即编译，也不把任意 C 文件自动转换为 Arduino 程序。显式 build.sketch/build.files 继续由 runtime 解释。

默认开发工具在应用 tools/，用户工程与构建缓存在仓库外；Python 优先用专用环境。串口与取消、通用锁由 host 提供，芯片输出判断、FQBN、工具下载与烧录地址归本目录。

内置 TypeScript runtime 随宿主编译，声明与实现必须匹配宿主 SDK；修改内置平台时仍需维护静态 registry 和驱动描述。第三方可复制分享的 API v2 包使用自己的 JavaScript 入口和声明，由宿主发现并在用户确认后加载，见[运行时插件指南](../../../docs/RUNTIME-PLUGINS.md)。平台目录的隔离复制 bundle 检查只验证模块边界；历史实机数据见[硬件记录](../../../docs/HARDWARE-VALIDATION.md)。
