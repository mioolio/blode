# Blode Studio

简体中文 | [English](docs/README.en.md)

Blode Studio 是一个面向单片机开发的模块化桌面工作台。它把芯片识别、资源分配、编译检查、烧录确认和真实回读串成一条可验证的链路，覆盖从打开工程到固件运行的完整流程。基于 Electron、React、TypeScript 与 Monaco 编辑器构建，界面、浏览器工作台与 AI 接入共用同一套工程校验与构建记录。

> 一次真实的硬件验证：一颗标称 64 KiB 的 STM32F103C8T6 实测 128 KiB Flash，75,888 字节固件写入后回读校验通过。完整记录见 [功能展示与真实硬件案例](SHOWCASE.md)。

## 功能亮点

- **自动识别芯片**：选择串口后一键识别，自动匹配已注册的平台并生成配置；识别失败时提供手动选择与日志导出。
- **可视化 Flash 布局**：以图形方式分配应用区、数据区与系统区，支持滚轮缩放、自定义名称与颜色、重叠检测；芯片误报容量时可手动纠偏。
- **编译边界检查**：以真实 ELF 装载范围与 SRAM 段检查资源占用，固件越界时给出警告，烧录前二次确认。
- **多平台支持**：ESP32-S3（Arduino CLI 构建、esptool 烧录）与 STM32（ST-Link 识别、Arm Compiler 6 或 GNU Arm GCC 构建，可编译受支持的 Keil `.uvprojx` 工程）；编译无需连接硬件。
- **现代编辑器**：语法高亮、C/C++ 符号补全、拆分编辑器与草稿恢复；查看文件使用预览标签，编辑或按 `Ctrl+S` 固定标签，标签过多时可横向滚动。
- **工程管理**：首页显示最近工程，可移除记录、返回当前工程，或保存并关闭工程回到首页；文件树右键设置文件或文件夹为编译入口。
- **固件导出与独立烧录**：导出 BIN、Intel HEX、S-record，STM32 可导出对应 ELF；不打开工程也能选择已有 BIN／HEX／S-record 固件，在核对设备和地址后烧录。
- **串口通信**：实时 UTF-8／HEX 收发，自选换行符、波特率、数据位、校验、停止位与流控。
- **独立硬件调试窗口**：从“视图 → 硬件仿真”打开，查看 STM32／ST-Link 的 CPU 寄存器、反汇编、调用栈、内存和本地 ELF 段信息。
- **安装与设备状态**：首选项显示工具下载量、百分比、安装阶段及第三方输出；设备首次初始化后使用缓存，通过手动刷新或 Windows 设备变更通知更新。
- **浏览器工作台**：桌面与网页端草稿同步，局域网内可经令牌认证访问。
- **AI 与自动化**：带认证的 JSON-RPC 系统管道与 MCP 桥接，AI 助手可调用与界面一致的完整 API。
- **主题**：跟随系统深浅色，界面文案提供中英文。

## 快速开始

需要 Node.js 24 或更高版本和 npm：

```powershell
npm ci
npm run dev
```

1. 打开工程目录或其中的 `be` 引导文件。
2. 选择编译平台、配置工具链，并右键设置编译入口；受支持的 STM32 Keil 工程可从工程信息确定平台。
3. 保存源码并编译，无需连接设备。烧录前连接设备、识别并核对目标。

本次新增功能的入口、操作步骤与限制见 [桌面工作台新功能](docs/NEW-FEATURES.md)。

`npm run build` 构建产物，`npm start` 运行已有产物。打包分两种模式：`npm run package:lite` 生成体积较小的 Windows 便携版，缺少的工具在首次使用时下载；`npm run package:full` 生成内置 `tools/` 工具链的完整版，可直接编译 STM32（Arm Compiler 6 或 GNU Arm GCC）与 ESP32-S3，无需另装编译器；个别组件缺失时仍可按原有流程安装或指定本机路径。开发环境配置见 [开发说明](docs/DEVELOPMENT.md)。

## 支持的硬件

| 平台     | 构建方式                                       | 烧录方式        |
| -------- | ---------------------------------------------- | --------------- |
| ESP32-S3 | Arduino CLI + Arduino-ESP32                    | esptool（串口） |
| STM32F1  | Arm Compiler 6／GNU Arm GCC，或验证已有固件    | ST-Link（SWD）  |
| 自动检测 | 支持从工程信息确定编译平台；无法确定时手动选择 | —               |

平台细节与硬件限制：[ESP32-S3](extensions/boards/esp32-s3/README.md) · [STM32](docs/STM32.md) · [通用烧录说明](extensions/boards/stm32/README.md)

## 工程描述符 `be`

工程根目录的 `be` 是一个 JSON 引导文件，保存工程配置、分区布局与构建入口。应用读取它即可还原完整工程上下文；旧的 `.blode/project.json` 工程继续兼容。格式说明见 [架构文档](docs/ARCHITECTURE.md)。

## 文档

| 文档                                     | 内容                                   |
| ---------------------------------------- | -------------------------------------- |
| [功能展示与真实硬件案例](SHOWCASE.md)    | 实机识别、烧录与回读记录               |
| [STM32 使用说明](docs/STM32.md)          | 连接、构建与固件限制                   |
| [工具链说明](docs/TOOLCHAINS.md)         | 工具目录与离线配置                     |
| [桌面工作台新功能](docs/NEW-FEATURES.md) | 首页、标签、固件、串口、调试与安装进度 |
| [AI 管道](docs/AI-PIPE.md)               | JSON-RPC 与 MCP 接入                   |
| [开发说明](docs/DEVELOPMENT.md)          | 构建、脚本与环境变量                   |
| [架构说明](docs/ARCHITECTURE.md)         | 模块划分与扩展约定                     |
| [扩展约定](extensions/README.md)         | 平台包结构与注册方式                   |
| [硬件记录](docs/HARDWARE-VALIDATION.md)  | 历史验证数据                           |

## 贡献

欢迎在 [项目仓库](https://github.com/mioolio/blode) 提交平台包、编辑器改进和文档修正。新增平台应附 README、契约与边界测试，并说明硬件验证范围。源码保持单文件不超过 1000 行，界面与协议文案同时维护中英文资源。

不提交依赖、打包产物、`tools/`、`.tools/`、工程缓存或本机凭据。项目采用 Apache License 2.0，见 [LICENSE](LICENSE)。
