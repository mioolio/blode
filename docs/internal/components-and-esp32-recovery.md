# 组件库与 ESP32 编译、连接修复

日期：2026-10-30。分支：`codex/runtime-plugins-internal`。本次更新随源码提供，未构建应用或发布新的桌面、Web 发行包。

## 变更

- **运行 → 组件库**：项目依赖、平台内置库、Arduino 在线搜索与版本选择、本地目录和 ZIP 导入。
- 工程使用 `blode.components.json`、`libraries/`、`components/` 保存依赖。安装支持递归版本约束、下载校验、失败回滚；移除保护已修改的文件。
- 桌面、Web、AI 使用同一宿主服务。变更请求要求 `confirm: true` 和 `expectedProjectRoot`，避免窗口切换后写入另一工程。
- 导入的原生源码和 Arduino 库参与编译，清单、源码、资源和二进制文件参与构建指纹。原生组件的预编译 `.a` / `.lib` 不自动加入链接；Arduino 库的预编译规则由 Arduino CLI 处理。

使用方式和平台范围见[组件库指南](../COMPONENT-LIBRARIES.md)，扩展接口见[运行时插件指南](../RUNTIME-PLUGINS.md#项目组件构建输入)。

## 编译问题

用户的 ESP32 Arduino 3.0.7 工程出现 `undefined reference to main`，并同时缺少 `String`、`Serial` 和 ESP-IDF 符号。原因是工程优化配置覆盖了平台的 `compiler.c.extra_flags` 和 `compiler.cpp.extra_flags`；该平台将必需的 `-c` 放在这两个属性中，覆盖后编译单个源文件便提前进入链接。

构建现在先读取展开后的平台属性，再追加工程参数，保留编译、链接和平台目录参数。原生组件的头文件路径按 Arduino CLI 的参数解析方式引用，支持 Windows 含空格路径。测试中仍保留用户源码的格式化输出警告，未修改原工程。

## 连接问题

ESP32-S3 USB 序列号留空时不传入 `adapter serial`，由 OpenOCD 自动选择。OpenOCD 或 GDB 退出时先收集进程输出，再报告具体错误；启动失败不再被通用的“调试会话已改变”覆盖。

GDB 连接后延迟到达的停止通知会重新采样，不再误判为会话被替换。插件连接中的状态轮询不能改变目标；主动取消后，晚到的连接结果会释放连接。

### 原生 USB-JTAG 现场诊断

2026-10-30 后续排查确认，当前宿主连接的是 `USB-SERIAL CH340 (COM3)`，硬件标识为 `VID_1A86&PID_7523`；未枚举到原生 ESP USB Serial/JTAG 的 `VID_303A&PID_1001`。CH340 提供串口烧录和通信，不提供当前调试后端所需的 USB-JTAG 接口。

现有 Espressif OpenOCD `0.12.0-esp32-20250707` 单独加载 `interface/esp_usb_jtag.cfg` 并执行 `init; shutdown`，同样报告 `esp_usb_jtag: could not find or open device!`。这次复现没有加载 target 配置，没有复位、暂停或写入芯片，也未安装驱动。

需要将数据线连接到板上的 ESP32-S3 原生 USB 接口；未引出该接口的板卡，可按板卡原理图与 [Espressif 官方接线说明](https://docs.espressif.com/projects/esp-idf/en/stable/esp32s3/api-guides/jtag-debugging/configure-builtin-jtag.html)连接 GPIO19（D−）、GPIO20（D+）及相应电源、地线。Windows 驱动应针对原生 JTAG 接口配置。

### Windows 连接预检

ESP32-S3 模块在显式连接时执行一次只读 USB 枚举，按复合设备与 `MI_02` JTAG 接口关联目标，区分缺少设备、PnP 状态异常、序列号不匹配和多目标。断开的历史设备不参与选择；无法关联的多个接口保持独立，同一序列号匹配多个目标时要求消除歧义。

枚举失败、超时或信息不足时，记录诊断并继续使用 OpenOCD；Linux 也由 OpenOCD 报告实际连接结果。预检不根据驱动服务名称排除 `libusbK`、`libusb0` 等配置。取消连接会终止本次枚举，过期响应与日志不写入新会话，也不会晚启动 OpenOCD。

## 验证记录

环境：Windows x64、现有 Arduino CLI 1.5.2-rc.1、ESP32 Arduino 3.0.7。固件构建使用隔离工程，没有烧录或连接物理 JTAG。

收尾检查：`npm run typecheck`、全量测试 **572/572**、`npm run format:check` 和 `git diff --check` 全部通过，无跳过测试。另在含空格的 Windows 工程路径中实编译原生 C 与 Arduino 混合组件，生成三个 BIN。

| 验证                           | 结果                                                                                                                                 |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| 用户 `esp32fff` 工程的源码副本 | 编译成功；Flash 354,765 B，静态 RAM 22,860 B；生成应用、引导程序和分区表三个 BIN                                                     |
| 自编原生 C 与 Arduino 混合组件 | 显式单文件入口下编译成功；Flash 277,981 B，静态 RAM 17,896 B；示例中的 `#error` 未进入编译                                           |
| Arduino 官方索引与归档         | 实际读取当前索引，校验并递归导入 SSD1306 2.5.17 → GFX 1.13.0 → BusIO 1.17.4，共 118 个指纹文件                                       |
| 三个第三方库参与固件构建       | 编译成功；Flash 326,529 B，静态 RAM 18,872 B；生成三个 BIN                                                                           |
| Electron 组件库界面            | 10 个隔离场景通过：空工程、项目与内置库、版本依赖、进度、目录与 ZIP 选择、重复导入、关闭后响应及工程切换；无横向布局溢出或运行时异常 |
| 调试连接                       | 本地测试子进程验证空序列号、延迟停止、OpenOCD USB 错误、GDB 启动错误及主动取消；插件连接另有竞态测试                                 |

本机详细报告保存在 `.tools/firmware-validation/`、`.tools/component-firmware-validation/`、`.tools/component-validation/` 和 `.tools/components-ui-validation/`，不随源码发布。

USB-JTAG 失败复现的原始输出保存在 `.tools/usb-jtag-validation/1793317512230-33124/openocd.log`。后续预检在同一宿主返回 `error.debuggerUsbJtagMissing`，日志记录原生接口缺失及已发现的 CH340 标识，未启动 OpenOCD 或 GDB；记录见 `.tools/usb-jtag-validation/1793317978916-66920/preflight.json`。实机 USB-JTAG 会话验收仍待完成。

USB-JTAG 后续修复完成后，全量测试 **587/587**、类型检查、格式检查及差异空白检查通过，无跳过测试。后台 Electron 另验证 6 个错误界面场景：旧 OpenOCD 长日志仅显示一条摘要、完整日志可查看、缺少设备预检、成功重试清除提示，以及其他错误的摘要和完整日志。无运行时异常，测试未连接芯片；报告位于 `.tools/debugger-error-ui-validation/1793317969993-41068/result.json`。

ESP32-S3 实机 USB-JTAG 连接及 Linux 硬件运行仍待验证；适配范围见[硬件调试](../HARDWARE-DEBUGGING.md)和[平台支持](../PLATFORM-SUPPORT.md)。
