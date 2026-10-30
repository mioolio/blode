# Esp32_S3_CAM 运行时包

当前声明范围为 ESP32-S3，沿用 `esp32:esp32:esp32s3` 参数。摄像头型号、引脚、时钟和外设初始化由用户工程配置；目录名不表示软件预设了特定摄像头模组接线，也不声明 ESP32、S2、C3 等其他系列可用。第三方插件接口见[开发指南](../../../docs/RUNTIME-PLUGINS.md)。

此目录拥有 S3 的配置、工具链、运行时、烧录和布局实现。它通过宿主 SDK 的 `RuntimeHost` 使用通用服务，不导入 `src/core` 或 STM32 平台实现。

| 目录           | 职责                                                                 |
| -------------- | -------------------------------------------------------------------- |
| `support/`     | ESP32-S3 支持范围与发布状态说明                                      |
| `device/`      | `adapter.ts` 设备配置；`programmer.ts` esptool 参数                  |
| `runtime/`     | `index.ts` 扫描、构建、安装与烧录分派                                |
| `constraints/` | 芯片、分区与操作约束说明                                             |
| `ui/`          | 界面字段及扩展入口说明                                               |
| `compiler/`    | `build-settings.ts` 编译配置与工具版本选择                           |
| `debugger/`    | ESP32-S3 JTAG 调试能力与集成说明                                     |
| `layout/`      | `index.ts` 布局检查与 CSV；`partitions.ts` 默认分区                  |
| `languages/`   | 本模块的语言规则与补全目录                                           |
| `tools/`       | `toolchain.ts` Arduino CLI、Arduino-ESP32、Python/esptool 检测与安装 |

源码入口为 `device/adapter.ts` 和 `runtime/index.ts`。目录职责固定，声明以根目录 `manifest.json` 为准，避免维护多份默认配置。

Arduino FQBN 为 esp32:esp32:esp32s3，Flash 配置支持 4/8/16/32 MiB。默认容量不代表硬件实测，识别结果必须匹配本平台。PSRAM 默认关闭，用户根据模块总线显式配置；运行时上传速率不塞入编译菜单。

布局固定 bootloader 0x0、分区表 0x8000；默认单 factory 应用位于 0x10000，另有 NVS、PHY、core dump 和文件系统区。默认布局调整不自动重排已保存用户分区。系统保留区不能移动/删除，当前不开放多应用 OTA。

构建使用完整 Arduino sketch 和 src/ 下模块，平台生成 staging 及 partitions.csv，真实工具输出决定容量。设置 be.build.entry 只是选定文件/目录，不立即编译，也不把任意 C 文件自动转换为 Arduino 程序。显式 build.sketch/build.files 继续由 runtime 解释。

默认开发工具在应用 tools/，用户工程与构建缓存在仓库外；Python 优先用专用环境。串口与取消、通用锁由 host 提供，芯片输出判断、FQBN、工具下载与烧录地址归本目录。

内置 TypeScript runtime 随宿主编译，声明与实现必须匹配宿主 SDK；修改内置平台时仍需维护静态 registry 和驱动描述。第三方可复制分享的 API v2 包使用自己的 JavaScript 入口和声明，由宿主发现并在用户确认后加载，见[运行时插件指南](../../../docs/RUNTIME-PLUGINS.md)。平台目录的隔离复制 bundle 检查只验证模块边界；历史实机数据见[硬件记录](../../../docs/HARDWARE-VALIDATION.md)。

## 语言与调试

语言清单由本模块 `manifest.languages` 声明，C99/C11/C17/C23 分别位于 `languages/C/` 下，C++ 和 Arduino 位于 `languages/C++/`。`.c` 使用 C，`.ino`、`.cpp` 和 `.h` 使用 C++；不会修改或继承宿主默认的 C/Arduino 数据。工程索引、AI 自定义条目和显式工程规则仍可叠加。格式见[模块语言适配](../../../docs/MODULE-LANGUAGES.md)。

调试复用宿主 ESP32-S3 USB-JTAG 后端，使用 Xtensa GDB 和 Espressif OpenOCD，支持执行控制、反汇编、寄存器、内存和批量硬件断点。尚未支持 Xtensa 指令修改；原生 USB 接线、驱动、安装和实机验证边界见[硬件调试](../../../docs/HARDWARE-DEBUGGING.md)。

## 独立模块分发

在仓库根目录执行：

```sh
npm run package:runtime -- extensions/boards/Esp32_S3_CAM --output ./release/modules --zip
```

生成 `Esp32_S3_CAM_Module`，运行时和语言资源随包分发，编译由包内代码与受管工具执行。安装到兼容宿主数据目录 `plugins/Esp32_S3_CAM_Module/`，重启并完成执行确认即可。用户无需主程序源码；开发者不要直接分发本目录的 TypeScript 作为可安装包。详细契约与宿主版本要求见[模块开发指南](../../../docs/RUNTIME-PLUGINS.md)。
