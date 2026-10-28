# Blode Studio

面向单片机开发的模块化桌面工作台。采用 Electron、TypeScript、React 19 和本地打包的 Monaco 编辑器，以 vs code 风格组织项目、代码、设备检查器和底部控制台。界面默认中文，可切换英文；界面文字通过 JSON 语言资源引用。

## 启动

需要 Node.js 24 或更高版本、npm，以及可运行 `venv` 的 。开发环境建议使用仓库锁文件安装依赖：

```powershell
npm ci
npm run dev
```

启动后默认不打开工作区。点击“选择 be 项目文件”选中工程目录中的 `be` 引导文件，或直接打开文件夹；`be` 中保存工程配置、分区和编译文件列表。仓库 `examples/` 内的示例可直接打开。修改前端后由 Vite 热更新；修改主进程、preload、管道、板卡适配器后，须退出并重新运行 `npm run dev`。

构建并启动生产模式：

```powershell
npm run build
npm start
```

Windows 便携版打包：`npm run package`，输出至 `release/`。构建命令成功与实际设备验证是不同检查，设备验证记录见下方文档。

## 从代码到设备

1. 选择 `ESP32-S3` 与对应串口，点击“识别芯片”核对硬件型号和实际 Flash 容量。
2. 在设置页选择托管工具链，点击“安装 / 更新工具链”。它解析官方最新稳定 Arduino CLI 与 Arduino-ESP32，校验 CLI 下载包的 SHA-256，并记录实际安装版本；后续更新由用户主动触发。首次下载体积较大，需要网络。
3. 在分区布局页选择实际 Flash 容量，调整应用/数据区后保存配置。ESP32-S3 系统区地址固定，当前使用单一 factory 应用布局。
4. 编辑源代码并编译。右下资源区展示实际编译得到的程序 Flash、静态 RAM 用量和剩余预算；编辑后标记结果过期，重新编译即可更新。
5. 点击烧录并核对所选端口。核心会检查构建与源码/配置一致、镜像未被修改，探测实际芯片和容量，再写入固件。底部串口监视器可查看运行输出。

本机已识别的开发板是 COM3 上的 ESP32-S3，Flash 16MB、内置 PSRAM 8MB。串口编号仅是这台电脑的探测结果，不是产品固定配置。最新实测步骤、成功项与未完成项以 [硬件验证记录](docs/HARDWARE-VALIDATION.md) 为准。

也可以选择自定义 Arduino CLI/Python 可执行文件、FQBN 和第三方 HTTPS 包索引。自定义路径填写可执行文件本身，不填写整条 shell 命令。当前编译核心支持 Arduino-ESP32；接入其他厂商 MCU 需新增对应型号/编译协议适配，不能仅修改一个显示名称。

`generic` 是默认通用 **Espressif** 二进制烧录适配：在工作区放置 `firmware.bin`，编译按钮先校验二进制大小，再按应用分区起点烧录。默认地址零用于合并镜像；只有应用镜像时必须配置其真实偏移并具备匹配的 bootloader/分区表。

## 目录与职责

| 目录                          | 负责内容                                       |
| ----------------------------- | ---------------------------------------------- |
| `src/core/`                   | 主进程、工程、配置、工具链、编译与串口生命周期 |
| `src/shared/`                 | UI、核心与 AI 共用的数据和能力契约             |
| `src/renderer/`               | 多面板工作台、Monaco、容量与图形分区界面       |
| `src/renderer/locales/`       | 中文与英文界面 JSON                            |
| `extensions/boards/esp32-s3/` | ESP32-S3 参数、分区与编译选项                  |
| `extensions/boards/generic/`  | 通用 ESP 二进制烧录配置                        |
| `extensions/programmers/`     | 烧录协议参数生成                               |
| `extensions/completions/`     | 按语言声明的补全、成员补全与悬停数据           |
| `extensions/menus/`           | 资源管理器右键菜单的声明式注册                 |
| `src/automation/`             | JSON-RPC 系统管道、统一方法映射与 MCP 适配     |
| `examples/blink/`             | 串口心跳示例，不依赖板载 LED 引脚              |
| `tests/`                      | 关键协议、路径、配置、分区与设备参数测试       |

工程配置保存在工程根的 `be` 引导文件（旧工程继续兼容 `.blode/project.json`），构建文件存于 `.blode/build/`。应用工具链与管道认证信息存于用户数据目录；开发模式下仓库根目录的 `tools/` 会作为本地工具链根目录优先使用。应用默认配置不固定 COM3 或某台电脑的 Python 路径；本次实机验证脚本使用 COM3 作为可覆盖的测试参数。

## AI 与自动化

Windows 使用命名管道，macOS/Linux 使用 Unix socket，传输为带认证的 JSON-RPC 2.0 换行帧；MCP stdio 桥将相同方法映射为 MCP 工具。界面与 AI 共用核心服务、路径检查、配置校验和操作锁。

开发模式还会启动浏览器工作台（默认 `http://127.0.0.1:47821`），浏览器与桌面端共享同一工程和保存状态；桌面端未保存内容默认同步到网页端，可在自动化页关闭。默认只监听本机，外部访问需在 `config/application.json` 中设置 `web.allowExternal`，并使用 `web-token.txt` 中的令牌。

任意 AI 可读取状态/源文件、写入工程、编译、选择配置、识别芯片及请求烧录。接入示例、发现文件、方法 schema 与各语言调用方式见 [AI 系统管道说明](docs/AI-PIPE.md)。通过界面的“AI 工作区”可以查看当前管道端点与本地认证文件位置。

## 开发与扩展

```powershell
npm run typecheck
npm test
npm run build
```

新增型号需创建独立 `extensions/boards/<型号>/` 并在 registry 显式注册。编辑器补全来自 `extensions/completions/` 的声明式数据（Arduino API、片段、成员与悬停说明），新增语言或补充条目只需修改该目录，无需改动编辑器组件。Monaco 仍提供语法高亮、括号匹配、缩进、代码折叠与搜索；尚未内置 clangd/LSP 全工程语义分析，准确容量需真实编译后获得。OTA、多固件启动选择、任意 JS 插件热安装及离线预装全部 MCU 工具链不在当前实现范围。

详细说明：[架构与模块边界](docs/ARCHITECTURE.md)、[开发约定与现有能力](docs/DEVELOPMENT.md)、[扩展开发](extensions/README.md)、[ESP32-S3 适配](extensions/boards/esp32-s3/README.md)。
