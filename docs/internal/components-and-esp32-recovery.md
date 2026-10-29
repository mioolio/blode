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

ESP32-S3 实机 USB-JTAG 连接及 Linux 硬件运行仍待验证；适配范围见[硬件调试](../HARDWARE-DEBUGGING.md)和[平台支持](../PLATFORM-SUPPORT.md)。
