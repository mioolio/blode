# Blode Studio

简体中文 | [English](docs/README.en.md)

> [!IMPORTANT]
> **声明**
>
> - 针对不同单片机，如需支持，请向作者提交 [Issues](https://github.com/mioolio/blode/issues) 反馈；也可自行完成适配并贡献代码。
> - 目前仅完成了 **两个** 单片机的可用性适配，其余单片机的适配程度未知。
> - 本项目采用 **模块化插件** 方式编写。

面向 多硬件 的模块化开发工作台，集成代码编辑、编译烧录、串口通信、硬件调试、Git 和多人协作。可作为 Windows 桌面应用使用，也可在目标电脑运行独立 Node.js 服务，通过浏览器访问工程与硬件。

[已完成](#已完成) · [正在进行](#正在进行) · [计划](#计划) · [支持平台](#支持平台) · [快速开始](#快速开始) · [文档导航](#文档导航) · [更新记录](CHANGELOG.md) · [下载](https://github.com/mioolio/blode/releases)

## 已完成

| 领域       | 现有能力                                                                                                                                                                                                     |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 编辑器     | C/C++ 补全、悬停、定义、引用、诊断、格式化与代码操作优先由 clangd 提供；`Ctrl+T` 工程符号搜索、`Ctrl+Shift+O` 文件大纲；未安装时回退宿主索引；实际工具链包含目录、只读外部源码；预览标签、拆分编辑与草稿恢复 |
| VS Code    | 编辑区一键生成工作区并在服务端打开 VS Code；磁盘保存同步，外部改动冲突合并                                                                                                                                   |
| 资源预览   | 图片缩放；音频与视频播放；二进制文件属性和十六进制预览，桌面与 Web 共用                                                                                                                                      |
| 语言配置   | C99／C11／C17／C23 分目录 JSON 规则；可编辑用户补全条目与诊断规则；模块独立声明语言                                                                                                                          |
| 编译       | 离线编译；命名的独立子工程入口；通用、平台和语言三级工具版本；调试／发布模式与固件体积优化                                                                                                                   |
| 固件交付   | BIN／HEX／S-record／ELF 导出；预编译固件烧录；按实际构建依赖迁移工程 ZIP                                                                                                                                     |
| 组件库     | Arduino 库搜索与依赖安装；目录／ZIP 导入；组件配置、源码与递归依赖的独立 ZIP 分享                                                                                                                            |
| 离线工具   | 下载、安装和工程选择分别管理；工具离线包导出／导入、校验、取消与安装回滚                                                                                                                                     |
| 硬件调试   | 寄存器、反汇编、调用栈、内存、单步和批量断点；STM32 SRAM 指令修改；ESP32-S3 UART GDB 和 USB-JTAG 接入                                                                                                        |
| 团队协作   | 共享文件与工具标签、跨端关闭确认、断线状态回放、用户颜色和阅读范围、最新日志；修改合并及按用户撤销                                                                                                           |
| Git 与终端 | 工程独立 Git 历史、图形化差异／暂存／提交／分支／远端操作；多个独立 PowerShell／系统 Shell 会话                                                                                                              |
| 串口监视   | 紧凑连接与发送栏、UTF-8／HEX 发送、独立日志滚动与阅读位置恢复、按需打开高级参数                                                                                                                              |
| 工作区     | 最近工程、保存后关闭、返回首页、默认关闭到托盘；资源树展开状态随工程保存；左下运行时折叠区、合并资源面板、独立调试窗口                                                                                       |
| AI         | 模型服务、选区／文件／工程问答与修改、授权的宿主操作；右键／快捷键补全，可配置全输入自动预测，默认关闭                                                                                                       |
| 插件       | 设备运行时与通用扩展独立管理；权限审查、菜单、窗口和底部页；官方个性化示例及可分享的独立模块包                                                                                                               |

ESP32-S3 + CH340 烧录底座已在 Windows 参考固件上完成断点、单步、内存读取和断开重连验证。其他硬件组合的状态见[支持平台](#支持平台)与[硬件验证记录](docs/HARDWARE-VALIDATION.md)。

新增交付功能的自动化与真实编译范围见[离线交付](docs/OFFLINE-DELIVERY.md)和[命名编译入口](docs/BUILD_TARGETS.md)。Windows 临时工程已完成 GNU Arm 编译、ZIP 迁移、移走原外部头文件后重新编译，并核对二进制一致。

## 正在进行

- **AI 使用验收**：手动／自动补全、中文注释与全输入触发、间隔设置和错误反馈已有 46 项相关测试及 18 个真实编辑器场景通过；继续评估不同模型的建议质量、输入法体验、长会话及大型工程修改。
- **通用扩展生态**：管理、权限审查和个性化示例已通过二进制宿主验证；持续完善更多第三方扩展的适配。见[通用扩展开发](docs/GENERAL-EXTENSIONS.md)。
- **界面验收**：Git 差异与组件库布局已重排，大列表使用有界渲染；本轮实际视觉与滚动帧率待人工验收。
- **本地发行准备**：0.3.5.2 桌面便携版、Web 单文件 EXE 与 Web Node.js ZIP 已构建，均附 `.sha256` 和[发行说明](docs/releases/0.3.5.2.md)，由发布者手动创建 GitHub 发行版。Web 版不再以源码 ZIP 交付，目标电脑无需 Node.js；构建范围、体积与验证见[更新记录](CHANGELOG.md)。
- **协作验收**：外部只读标签共享与恢复已补充自动化覆盖；继续扩展跨机器、高延迟网络和长时间场景。
- **硬件验收**：ESP32-S3 原生 USB-JTAG、现有相机工程的 UART GDB 迁移，以及 STM32 指令修改的实机覆盖。

验证范围与操作方式见[多人协作](docs/COLLABORATION.md)和[VS Code 连接](docs/vscode.md)。

## 计划

- 验证 Linux x64／ARM64 的安装、编译、USB 权限与桌面打包。
- 在第二台电脑上验证复杂 STM32 工程、组件与外部依赖的完整迁移。
- 扩展多用户长时间协作、高延迟网络、冲突审阅与权限场景。
- 完善扩展升级、原生扩展的进程隔离和大型工程后台索引。
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

| 方式               | 环境                           | 验证状态                                                      |
| ------------------ | ------------------------------ | ------------------------------------------------------------- |
| Windows x64 桌面版 | Electron 便携应用              | 主要开发与测试环境                                            |
| 独立 Web 宿主      | 单文件 EXE 或 Node.js 24+ 源码 | 同一服务端工程、Git、编译器、串口和调试服务；EXE 无需 Node.js |
| Linux x64／ARM64   | Node.js 宿主与平台工具         | 已做代码适配；安装、USB、编译和桌面打包待实机验证             |
| macOS              | 自定义工具路径                 | 未验证                                                        |

发行包、校验和与安装步骤见[下载](https://github.com/mioolio/blode/releases)和[发行说明](docs/releases/0.3.5.2.md)。

## 快速开始

开发环境：**Node.js 24+、npm、Git**。

```sh
git clone --single-branch https://github.com/mioolio/blode.git
cd blode
npm ci
npm run dev
```

开发端口默认使用 `5173`，占用时自动选择后续空闲端口。

运行独立 Web 宿主。发行版直接运行 `Blode.Studio-0.3.5.2-web-win-x64.exe`：首次启动解压运行时并自动打开浏览器，目标电脑无需安装 Node.js。源码运行方式：

```sh
npm run web:build
npm run web:start
```

浏览器打开终端输出的链接。工程、编译器和 USB 设备来自服务端电脑；网页文件选择器浏览该电脑的目录。局域网部署见 [Web 宿主](docs/WEB-HOST.md)。

### 打开并编译工程

1. 打开工程文件夹或其中的 `be` 文件。
2. 在 **生成 → 编译设置** 选择运行时、工具版本和调试／发布模式；可为多个子工程分别命名与配置。
3. 右键文件或文件夹设置编译入口，保存并编译。
4. 连接设备后烧录；从 **调试 → 硬件仿真** 打开调试工作区。

通过 **生成 → 组件库** 安装 Arduino 库、导入源码组件或分享组件 ZIP。首选项的工具版本区域可下载离线包、导入并安装。主进程、平台包或 preload 修改后重启开发版；界面源码支持热更新。启动诊断见[开发说明](docs/DEVELOPMENT.md)。

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
├─ completions/         # 宿主语言基础与旧模块默认数据
└─ plugins/
   └─ Personalization/  # 通用扩展示例：ESM、界面、语言、设置和资源独立分发
```

两个平台均采用十目录结构，各自维护语言声明。工程规则位于 `languages/C/<标准>/`，索引缓存在 `.blode/index/`。

模块作者可生成独立包：

```sh
npm run package:runtime -- extensions/boards/Esp32_S3_CAM --output ./release/modules --zip
```

模块安装到兼容宿主数据目录的 `plugins/<id>/` 后重启即可加载。包内包含运行所需的 JavaScript、声明和资源，可用于已编译的桌面应用或 Web 宿主。目录职责、契约与部署见[模块开发指南](docs/RUNTIME-PLUGINS.md)和[模块语言适配](docs/MODULE-LANGUAGES.md)。

不需要设备或编译功能时，使用 `kind: "extension"`。通用扩展由管理器安装到应用数据目录的 `extensions/<id>/`，不占用目标设备列表；源码与二进制宿主读取同一份声明和资源。官方示例包含八个职责目录，可直接复制或导出 ZIP。详见[通用扩展开发](docs/GENERAL-EXTENSIONS.md)。

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
npm run package:web:node
```

`package:web` 输出单文件 Web EXE（内嵌宿主、浏览器资源与原生运行时）及 `.sha256`，不再生成需要 `npm ci` 的源码 ZIP。

`package:web:node` 输出更小的 Web ZIP，目标电脑需 Node.js 24+ x64。解压后运行 `start-web.cmd` 或 `node launch-web.cjs`；已包含运行依赖，无需 `npm install`。

自动化测试覆盖服务接口、协作、Git、工程打包、工具安装和模拟调试协议。实机与跨平台结果见[硬件验证记录](docs/HARDWARE-VALIDATION.md)。

## 文档导航

| 任务       | 文档                                                                                                                                                                                                                                                                                 |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 安装与开发 | [Web 宿主](docs/WEB-HOST.md) · [开发说明](docs/DEVELOPMENT.md) · [发行说明](docs/releases/0.3.5.2.md)                                                                                                                                                                                |
| 编译与硬件 | [工程配置](docs/PROJECTS.md) · [命名编译入口](docs/BUILD_TARGETS.md) · [组件库](docs/COMPONENT-LIBRARIES.md) · [硬件调试](docs/HARDWARE-DEBUGGING.md) · [工具版本](docs/TOOL-VERSIONS.md) · [离线交付](docs/OFFLINE-DELIVERY.md)                                                     |
| 编辑与团队 | [资源预览](docs/ASSET-PREVIEW.md) · [源码定位](docs/SOURCE-NAVIGATION.md) · [clangd 语言服务](docs/CLANGD.md) · [语言规则](docs/LANGUAGE-RULES.md) · [多人协作](docs/COLLABORATION.md) · [VS Code 连接](docs/vscode.md) · [Git](docs/GIT.md) · [工程打包](docs/PROJECT-PACKAGING.md) |
| AI 与插件  | [AI 接口](docs/AI-PIPE.md) · [AI 补全与模型服务](docs/AI-COMPLETIONS.md) · [通用扩展](docs/GENERAL-EXTENSIONS.md) · [运行时插件](docs/RUNTIME-PLUGINS.md) · [模块语言](docs/MODULE-LANGUAGES.md) · [架构](docs/ARCHITECTURE.md)                                                      |
| 支持与计划 | [平台支持](docs/PLATFORM-SUPPORT.md) · [硬件验证](docs/HARDWARE-VALIDATION.md) · [路线图](docs/ROADMAP.md) · [更新记录](CHANGELOG.md)                                                                                                                                                |

## 参与贡献

通过 [Issues](https://github.com/mioolio/blode/issues) 报告问题或提出建议，通过 Pull Request 提交改进。问题报告包含宿主系统、目标芯片、复现步骤和脱敏日志。提交约定见[贡献指南](CONTRIBUTING.md)，漏洞报告见[安全政策](SECURITY.md)。

## 许可证

本项目采用 [Apache License 2.0](LICENSE)。发行包附带[第三方依赖许可](docs/THIRD-PARTY-NOTICES.md)；下载的编译器和驱动遵循各自许可证。
