# Blode Studio

简体中文 | [English](docs/README.en.md)

面向 多硬件 的模块化开发工作台，集成代码编辑、编译烧录、串口通信、硬件调试、Git 和多人协作。可作为 Windows 桌面应用使用，也可在目标电脑运行独立 Node.js 服务，通过浏览器访问工程与硬件。

[已完成](#已完成) · [正在进行](#正在进行) · [计划](#计划) · [支持平台](#支持平台) · [快速开始](#快速开始) · [文档导航](#文档导航) · [更新记录](CHANGELOG.md) · [下载](https://github.com/mioolio/blode/releases)

## 已完成

| 领域       | 现有能力                                                                                              |
| ---------- | ----------------------------------------------------------------------------------------------------- |
| 编辑器     | C/C++ 定义、声明、引用和头文件跳转；预览标签、拆分编辑、草稿恢复；工作区增量索引                      |
| VS Code    | 编辑区一键生成工作区并在服务端打开 VS Code；磁盘保存同步，外部改动冲突合并                            |
| 资源预览   | 图片缩放；音频与视频播放；二进制文件属性和十六进制预览，桌面与 Web 共用                               |
| 语言配置   | C99／C11／C17／C23 分目录 JSON 规则；可编辑补全清单与诊断规则；模块独立声明语言                       |
| 编译       | 离线编译；文件或文件夹入口；通用、平台和语言三级工具版本；调试／发布模式与固件体积优化                |
| 固件交付   | BIN／HEX／S-record／ELF 导出；预编译固件烧录；收集外部依赖的可迁移工程 ZIP                            |
| 组件库     | Arduino 库搜索、版本选择与依赖安装；从服务端目录或 ZIP 导入；工程内组件清单                           |
| 硬件调试   | 寄存器、反汇编、调用栈、内存、单步和批量断点；STM32 SRAM 指令修改；ESP32-S3 UART GDB 和 USB-JTAG 接入 |
| 团队协作   | 共享文件与工具标签、跨端关闭确认、断线状态回放、用户颜色和阅读范围、最新日志；修改合并及按用户撤销    |
| Git 与终端 | 工程独立 Git 历史、图形化差异／暂存／提交／分支／远端操作；PowerShell 和系统 Shell 交互终端           |
| 串口监视   | 紧凑连接与发送栏、UTF-8／HEX 发送、独立日志滚动与阅读位置恢复、按需打开高级参数                       |
| 工作区     | 最近工程、保存后关闭、返回首页、可选托盘；左下目标设备折叠区、底部资源与工程文件占用、独立调试窗口    |
| AI 接口    | JSON-RPC／MCP 工作台操作；外部 AI 维护补全和提供预测建议，预测功能默认关闭                            |
| 插件       | 运行时、连接、编译、调试与布局声明；自定义窗口和底部功能区；供二进制宿主安装的独立模块包              |

ESP32-S3 + CH340 烧录底座已在 Windows 参考固件上完成断点、单步、内存读取和断开重连验证。其他硬件组合的状态见[支持平台](#支持平台)与[硬件验证记录](docs/HARDWARE-VALIDATION.md)。

## 正在进行

- **协作验收**：扩展跨机器、高延迟网络和长时间协作场景。
- **硬件验收**：ESP32-S3 原生 USB-JTAG、现有相机工程的 UART GDB 迁移，以及 STM32 指令修改的实机覆盖。

验证范围与操作方式见[多人协作](docs/COLLABORATION.md)和[VS Code 连接](docs/vscode.md)。

## 计划

- 验证 Linux x64／ARM64 的安装、编译、USB 权限与桌面打包。
- 在第二台电脑上验证复杂 STM32 工程、组件与外部依赖的完整迁移。
- 扩展多用户长时间协作、高延迟网络、冲突审阅与权限场景。
- 完善插件安装更新、故障隔离和大型工程后台索引。
- 按独立模块增加目标平台、编译工具版本和调试器适配。

优先级与验收条件见[路线图](docs/ROADMAP.md)。

## 支持平台

### 目标设备

| 运行时          | 芯片范围          | 编译                                  | 烧录          | 硬件调试                                               |
| --------------- | ----------------- | ------------------------------------- | ------------- | ------------------------------------------------------ |
| `Esp32_S3_CAM`  | ESP32-S3          | Arduino CLI + Arduino-ESP32           | esptool／串口 | UART GDB：Windows 参考固件已验证；USB-JTAG：待实机验收 |
| `STM32F103C8T6` | STM32F103C8／C8T6 | GNU Arm GCC 或已授权的 Arm Compiler 6 | ST-Link／SWD  | ST-Link + GDB；指令修改待实机验收                      |

ESP32-S3 摄像头引脚由工程配置。旧工程的 `esp32-s3`、`stm32` 标识在读取时迁移；扩展包自行声明芯片范围、连接协议和工具要求。详见[平台支持](docs/PLATFORM-SUPPORT.md)与[硬件调试](docs/HARDWARE-DEBUGGING.md)。

### 宿主系统

| 方式               | 环境                   | 验证状态                                          |
| ------------------ | ---------------------- | ------------------------------------------------- |
| Windows x64 桌面版 | Electron 便携应用      | 主要开发与测试环境                                |
| 独立 Web 宿主      | Node.js 24+ + 浏览器   | 共用服务端工程、Git、编译器、串口和调试服务       |
| Linux x64／ARM64   | Node.js 宿主与平台工具 | 已做代码适配；安装、USB、编译和桌面打包待实机验证 |
| macOS              | 自定义工具路径         | 未验证                                            |

发行包、校验和与安装步骤见[下载](https://github.com/mioolio/blode/releases)和[发行说明](docs/releases/0.2.3.6.md)。

## 快速开始

开发环境：**Node.js 24+、npm、Git**。

```sh
git clone --single-branch https://github.com/mioolio/blode.git
cd blode
npm ci
npm run dev
```

运行独立 Web 宿主：

```sh
npm run web:build
npm run web:start
```

浏览器打开终端输出的链接。工程、编译器和 USB 设备来自服务端电脑；网页文件选择器浏览该电脑的目录。局域网部署见 [Web 宿主](docs/WEB-HOST.md)。

### 打开并编译工程

1. 打开工程文件夹或其中的 `be` 文件。
2. 在 **运行 → 编译设置** 选择平台、工具版本和调试／发布模式。
3. 右键文件或文件夹设置编译入口，保存并编译。
4. 连接设备后烧录；从 **视图 → 硬件仿真** 打开调试工作区。

通过 **运行 → 组件库** 安装 Arduino 库或导入源码组件。主进程、平台包或 preload 修改后重启开发版；界面源码支持热更新。启动诊断见[开发说明](docs/DEVELOPMENT.md)。

## 工程与扩展

`be` 保存工程配置。右键 **高级设置** 可编辑入口、文件清单和语言标准；`be.build.settings` 保存通用、平台和语言层级的编译选项。格式与迁移规则见[工程配置](docs/PROJECTS.md)。

`blode.components.json` 管理工程组件，源码保存在 `libraries/` 或 `components/`，随工程复制与提交。宿主在编译时解析组件路径。

```text
extensions/
├─ boards/
│  ├─ Esp32_S3_CAM/
│  └─ STM32F103C8T6/
│     ├─ support/       # 支持范围
│     ├─ device/        # 设备配置与协议
│     ├─ runtime/       # 执行入口
│     ├─ constraints/   # 操作约束
│     ├─ ui/            # 界面集成
│     ├─ compiler/      # 构建流程
│     ├─ debugger/      # 调试集成
│     ├─ layout/        # 存储与资源
│     ├─ languages/     # 模块语言及版本目录
│     └─ tools/         # 工具管理
└─ completions/         # 宿主语言基础与旧模块默认数据
```

两个平台均采用十目录结构，各自维护语言声明。工程规则位于 `languages/C/<标准>/`，索引缓存在 `.blode/index/`。

模块作者可生成独立包：

```sh
npm run package:runtime -- extensions/boards/Esp32_S3_CAM --output ./release/modules --zip
```

模块安装到兼容宿主数据目录的 `plugins/<id>/` 后重启即可加载。包内包含运行所需的 JavaScript、声明和资源，可用于已编译的桌面应用或 Web 宿主。目录职责、契约与部署见[模块开发指南](docs/RUNTIME-PLUGINS.md)和[模块语言适配](docs/MODULE-LANGUAGES.md)。

## 开发与验证

```sh
npm run typecheck
npm test
npm run format:check
```

生成桌面与 Web 产物：

```sh
npm run build
npm run package:desktop
npm run package:web
```

自动化测试覆盖服务接口、协作、Git、工程打包、工具安装和模拟调试协议。实机与跨平台结果见[硬件验证记录](docs/HARDWARE-VALIDATION.md)。

## 文档导航

| 任务       | 文档                                                                                                                                                                                                     |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 安装与开发 | [Web 宿主](docs/WEB-HOST.md) · [开发说明](docs/DEVELOPMENT.md) · [发行说明](docs/releases/0.2.3.6.md)                                                                                                    |
| 编译与硬件 | [工程配置](docs/PROJECTS.md) · [组件库](docs/COMPONENT-LIBRARIES.md) · [硬件调试](docs/HARDWARE-DEBUGGING.md) · [工具版本](docs/TOOL-VERSIONS.md) · [STM32](docs/STM32.md)                               |
| 编辑与团队 | [资源预览](docs/ASSET-PREVIEW.md) · [语言规则](docs/LANGUAGE-RULES.md) · [多人协作](docs/COLLABORATION.md) · [VS Code 连接](docs/vscode.md) · [Git](docs/GIT.md) · [工程打包](docs/PROJECT-PACKAGING.md) |
| AI 与插件  | [AI 接口](docs/AI-PIPE.md) · [AI 补全](docs/AI-COMPLETIONS.md) · [运行时插件](docs/RUNTIME-PLUGINS.md) · [模块语言](docs/MODULE-LANGUAGES.md) · [架构](docs/ARCHITECTURE.md)                             |
| 支持与计划 | [平台支持](docs/PLATFORM-SUPPORT.md) · [硬件验证](docs/HARDWARE-VALIDATION.md) · [路线图](docs/ROADMAP.md) · [更新记录](CHANGELOG.md)                                                                    |

## 参与贡献

通过 [Issues](https://github.com/mioolio/blode/issues) 报告问题或提出建议，通过 Pull Request 提交改进。问题报告包含宿主系统、目标芯片、复现步骤和脱敏日志。提交约定见[贡献指南](CONTRIBUTING.md)，漏洞报告见[安全政策](SECURITY.md)。

## 许可证

本项目采用 [Apache License 2.0](LICENSE)。发行包附带[第三方依赖许可](docs/THIRD-PARTY-NOTICES.md)；下载的编译器和驱动遵循各自许可证。
