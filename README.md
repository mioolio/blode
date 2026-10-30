# Blode Studio

简体中文 | [English](docs/README.en.md)

面向 ESP32-S3 与 STM32 的模块化开发工作台。集成代码编辑、团队协作、编译烧录、串口通信、硬件调试和 Git，提供 Windows 桌面版与独立 Web 宿主。

[快速开始](#快速开始) · [支持范围](#支持范围) · [功能](#功能概览) · [文档](#文档导航) · [更新记录](CHANGELOG.md) · [下载](https://github.com/mioolio/blode/releases)

## 版本与状态

| 通道     | 版本／分支                    | 使用方式                                                          |
| -------- | ----------------------------- | ----------------------------------------------------------------- |
| 稳定版   | **0.2.3.6** · 已发布发行包    | 下载桌面便携包或 Web 包，参阅[发行说明](docs/releases/0.2.3.6.md) |
| 内部预览 | **0.2.3.6-internal** · `main` | 从最新源码运行；新功能验证后再进入稳定版                          |

内部开发更新已从 `codex/runtime-plugins-internal` 合入 `main`。0.2.3.6 发行包仍为此前构建，本次合并不生成新的桌面或 Web 发行包。

### 本次内部更新

- **组件库**：运行菜单管理工程依赖；搜索 Arduino 库并选择版本，递归安装依赖，或从目标电脑文件夹／ZIP 导入。组件随工程保存，详见[组件库指南](docs/COMPONENT-LIBRARIES.md)。
- **ESP32 修复**：调试允许留空 USB 序列号自动选择；编译选项追加到平台 `extra_flags`，保留 `-c` 等原有参数。
- **ESP32-S3 硬件调试**：通过 USB-JTAG、Espressif OpenOCD 和 Xtensa GDB 查看寄存器、反汇编、调用栈与内存，支持暂停、单步及断点。
- **调试工作区**：顶部连接／调试／视图／工具菜单，批量断点，醒目的内存读取入口；STM32 支持汇编预览及 SRAM 指令修改。
- **退出修复**：正常关闭不再触发开发启动器的沙箱重试，关闭期间的已销毁帧与预期取消不再输出多余错误。
- **工作台与扩展**：PowerShell 交互终端、插件独立窗口和底部面板、保存后退出与可选托盘、前后台协作状态同步。
- **标准模块**：两个平台统一拆成 10 个职责目录；模块自行声明语言列表或固定语言，C 标准目录隔离；新增独立模块打包，供二进制宿主安装。

ESP32-S3 调试与 Linux 适配尚待实机验收。功能范围、准备步骤及测试记录见[硬件调试指南](docs/HARDWARE-DEBUGGING.md)、[调试更新](docs/internal/debugger-editing.md)和[工作台更新](docs/internal/workbench-interaction.md)。本次仅更新源码，不生成新的发行包。

## 快速开始

开发环境：**Node.js 24+、npm、Git**。

```sh
git clone --branch main --single-branch https://github.com/mioolio/blode.git
cd blode
npm ci
npm run dev
```

独立 Web 宿主：

```sh
npm run web:build
npm run web:start
```

浏览器打开终端输出的访问链接。工程、编译器和 USB 设备均由宿主电脑提供；网页中的文件选择器浏览宿主目录。部署与局域网访问见 [Web 宿主](docs/WEB-HOST.md)。

### 开始一个工程

1. 打开工程文件夹，或打开其中的 `be` 工程文件。
2. 在 **运行 → 编译设置** 选择平台、工具版本和调试／发布模式。
3. 右键文件或文件夹设置编译入口，保存并编译。
4. 连接设备后烧录；从 **视图 → 硬件仿真** 打开独立调试工作区。

主进程、平台包或 preload 修改后需要重启开发版；界面源码支持热更新。启动诊断见[开发说明](docs/DEVELOPMENT.md)。

需要第三方源码时，从 **运行 → 组件库** 安装或导入。项目依赖与平台内置库分开显示；桌面版和 Web 版都读取目标电脑的目录与 ZIP。

## 支持范围

### 目标芯片

下表描述 `main` 中的内部预览实现。运行时名称对应明确的芯片范围。

| 运行时          | 芯片              | 编译                                  | 烧录          | 硬件调试                                              |
| --------------- | ----------------- | ------------------------------------- | ------------- | ----------------------------------------------------- |
| `Esp32_S3_CAM`  | ESP32-S3          | Arduino CLI + Arduino-ESP32           | esptool／串口 | USB-JTAG + Espressif OpenOCD + Xtensa GDB；待实机验收 |
| `STM32F103C8T6` | STM32F103C8／C8T6 | GNU Arm GCC 或已授权的 Arm Compiler 6 | ST-Link／SWD  | ST-Link + GDB；新增指令修改待实机验收                 |

ESP32-S3 摄像头接线由工程配置。旧工程的 `esp32-s3`、`stm32` 标识在读取时迁移；其他 ESP32／STM32 型号由独立运行时包声明支持范围。详细能力与验证状态见[平台支持](docs/PLATFORM-SUPPORT.md)。

### 宿主版本

| 版本               | 运行方式                   | 当前状态                                                   |
| ------------------ | -------------------------- | ---------------------------------------------------------- |
| Windows x64 桌面版 | Electron 便携应用          | 主要开发与测试环境                                         |
| 独立 Web 版        | Node.js 24+ 服务 + 浏览器  | 共用宿主编译、Git、串口和调试服务                          |
| Linux x64／ARM64   | Node.js 宿主及平台工具路径 | 已做代码适配；安装、USB、编译与桌面打包未在 Linux 实机验证 |
| macOS              | 自定义工具路径             | 未验证                                                     |

稳定版下载文件为 `Blode.Studio-0.2.3.6-desktop-win-x64.exe` 和 `Blode.Studio-0.2.3.6-web.zip`。安装、校验与升级步骤见[发行说明](docs/releases/0.2.3.6.md)。

## 功能概览

| 领域       | 功能                                                                                             |
| ---------- | ------------------------------------------------------------------------------------------------ |
| 编辑器     | C/C++ 定义、声明、引用和头文件跳转；多标签、预览标签、拆分编辑、草稿恢复                         |
| 语言扩展   | C99／C11／C17／C23 独立 JSON 规则；工作区增量索引；自定义补全与诊断                              |
| 编译与交付 | 分平台／语言工具版本；调试与发布模式；固件体积优化；BIN／HEX／S-record／ELF 导出；可迁移工程 ZIP |
| 组件库     | Arduino 在线索引与版本依赖；目标电脑目录／ZIP 导入；工程内源码与清单；修改和依赖删除保护         |
| 硬件       | 串口 UTF-8／HEX 收发；预备固件烧录；寄存器、指令、内存、调用栈及断点调试                         |
| 团队协作   | 共享标签、用户颜色、阅读范围、最新日志；独立修改合并、冲突提示及按用户撤销                       |
| Git 与终端 | 图形化差异、暂存、提交、分支和远端操作；持久 PowerShell／系统 Shell                              |
| AI 接口    | JSON-RPC／MCP 控制工作台；维护补全清单；外部 AI 预测建议，默认关闭                               |
| 插件       | API v2 运行时包；设备连接、编译、调试、布局声明；自定义窗口和底部功能区                          |

## 工程与扩展

`be` 保存工程配置。右键 **高级设置** 可编辑入口、文件清单和语言标准；`be.build.settings` 维护通用、平台与语言层级的编译选项。工程示例和迁移规则见[工程与编译设置](docs/PROJECTS.md)。

`blode.components.json` 管理工程组件，源码保存在 `libraries/` 或 `components/`，可随工程复制与提交。编译时宿主派生组件路径，不需要在 `be` 中填写 `build.components`。

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

两个平台均采用上面的十目录结构。模块语言不改写宿主清单；工程可通过 `languages/C/<标准>/` 叠加自己的规则，索引缓存在 `.blode/index/`。

模块作者使用 `npm run package:runtime -- extensions/boards/Esp32_S3_CAM --output ./release/modules --zip` 生成独立包。使用者将包安装到兼容宿主数据目录的 `plugins/<id>/` 后重启，无需主程序源码或 TypeScript。新契约需要包含本次内部更新的宿主，旧正式版二进制需先升级。

目录职责、构建与二进制部署见[模块开发指南](docs/RUNTIME-PLUGINS.md)，JSON 格式与版本隔离见[模块语言适配](docs/MODULE-LANGUAGES.md)。

## 开发与验证

```sh
npm run typecheck
npm test
npm run format:check
```

需要生成产物时：

```sh
npm run build
npm run package:desktop
npm run package:web
```

自动化测试覆盖服务接口、协作、Git、工程打包、工具安装及模拟调试协议。物理设备、跨机器协作与各操作系统的结果单独记录；详见[验证记录](docs/HARDWARE-VALIDATION.md)和[路线图](docs/ROADMAP.md)。

## 文档导航

| 任务          | 文档                                                                                                                                                                         |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 安装与升级    | [发行说明](docs/releases/0.2.3.6.md) · [Web 宿主](docs/WEB-HOST.md) · [开发说明](docs/DEVELOPMENT.md)                                                                        |
| 编译与硬件    | [工程配置](docs/PROJECTS.md) · [组件库](docs/COMPONENT-LIBRARIES.md) · [硬件调试](docs/HARDWARE-DEBUGGING.md) · [工具版本](docs/TOOL-VERSIONS.md) · [STM32](docs/STM32.md)   |
| 编辑与团队    | [语言规则](docs/LANGUAGE-RULES.md) · [多人协作](docs/COLLABORATION.md) · [Git](docs/GIT.md) · [工程打包](docs/PROJECT-PACKAGING.md)                                          |
| AI 与插件开发 | [AI 接口](docs/AI-PIPE.md) · [AI 补全](docs/AI-COMPLETIONS.md) · [运行时插件](docs/RUNTIME-PLUGINS.md) · [模块语言](docs/MODULE-LANGUAGES.md) · [架构](docs/ARCHITECTURE.md) |
| 支持与计划    | [平台支持](docs/PLATFORM-SUPPORT.md) · [硬件验证](docs/HARDWARE-VALIDATION.md) · [路线图](docs/ROADMAP.md) · [更新记录](CHANGELOG.md)                                        |

## 参与贡献

通过 [Issues](https://github.com/mioolio/blode/issues) 报告问题或提出建议，通过 Pull Request 提交改进。报告请包含应用版本、宿主系统、目标芯片、复现步骤和脱敏日志。提交约定见[贡献指南](CONTRIBUTING.md)，漏洞报告见[安全政策](SECURITY.md)。

## 许可证

本项目采用 [Apache License 2.0](LICENSE)。发行包附带[第三方依赖许可](docs/THIRD-PARTY-NOTICES.md)；编译器、驱动和其他下载工具遵循各自许可证。
