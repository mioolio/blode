# Blode Studio

简体中文 | [English](docs/README.en.md)

Blode Studio 是模块化嵌入式开发工作台，覆盖源码编辑、多人协作、离线编译、固件导出、串口通信与硬件调试。当前开发分支内置 `Esp32_S3_CAM` 与 `STM32F103C8T6` 两个具体运行时配置。

**当前发行：0.2.3.6** · [版本说明](docs/releases/0.2.3.6.md) · [变更记录](CHANGELOG.md) · [GitHub Releases](https://github.com/mioolio/blode/releases)

## 内部开发预览：运行时插件

`codex/runtime-plugins-internal` 是基于 0.2.3.6 的内部开发分支，包含运行时命名迁移、API v2 插件声明、执行确认、可替换编译器与定制设备／调试界面。本次不生成新的正式发行版，`main` 保留稳定代码；验证记录和人工验收清单见[内部更新说明](docs/internal/runtime-plugins.md)。

希望尝鲜的开发者可从源码运行：

```sh
git clone --branch codex/runtime-plugins-internal --single-branch https://github.com/mioolio/blode.git
cd blode
npm ci
npm run dev
```

启动独立 Web 宿主时，在同一源码目录执行 `npm run web:build`，再执行 `npm run web:start`。扩展作者从[运行时插件开发指南](docs/RUNTIME-PLUGINS.md)开始；旧工程的 `esp32-s3`、`stm32` 标识和编译器版本配置会在读取时迁移。

## 选择发行版

两个发行版共用工程格式、编辑器和目标机器服务。选择取决于工作方式：

| 发行版      | 适用场景                             | 运行环境                                  | 发行文件                                   |
| ----------- | ------------------------------------ | ----------------------------------------- | ------------------------------------------ |
| 桌面便携版  | 在本机直接编辑、编译、连接硬件和调试 | Windows x64；内含 Electron 桌面运行时     | `Blode.Studio-0.2.3.6-desktop-win-x64.exe` |
| 独立 Web 版 | 目标电脑运行服务，多人通过浏览器访问 | 服务端 Node.js 24+、npm；客户端使用浏览器 | `Blode.Studio-0.2.3.6-web.zip`             |

本次桌面包采用轻量便携模式；两个发行版均通过首选项安装工具链，或使用已安装的自定义工具路径。Git 功能使用目标电脑上的 Git。发行产物生成在 `release/0.2.3.6/`，校验与升级步骤见[发行说明](docs/releases/0.2.3.6.md)。

## 0.2.3.6 新特性

| 能力               | 使用方式                                                                                            |
| ------------------ | --------------------------------------------------------------------------------------------------- |
| 定义与头文件导航   | 右键或 `F12` 查看 C/C++ 定义、声明和引用，打开关联头文件；重名结果在候选列表中切换，`Alt+←` 返回    |
| 分版本语言规则     | C99、C11、C17、C23 各自使用独立 JSON 目录；函数按 a–z 分类，控制流、类型和检查规则分文件维护        |
| 工作区增量索引     | 函数、宏、类型和变量参与补全；草稿实时更新，保存源码的派生缓存位于 `.blode/index/`                  |
| 工程高级设置       | 右键根目录 `be` → **高级设置**，编辑名称、平台、入口、文件清单和 C 标准，并预览 JSON                |
| 分层编译设置       | **运行 → 编译设置**，配置调试／发布、体积优化以及通用、STM32、ESP32-S3 的 C/C++ 本机工具版本        |
| 独立 Git 管理      | 默认创建 `.blode/git`；支持差异、暂存、提交、分支、远端、停用和移除独立历史，共享已有仓库需主动开启 |
| 多人协作           | 浏览器身份、颜色、共享标签、阅读范围和最新编译日志同步；独立修改合并，重叠修改提示冲突              |
| 稳定阅读与撤销     | 远端修改尽量保持阅读锚点；网页撤销只处理自己的修改，关闭标签与离开页面释放协作状态                  |
| 外部 AI 补全       | 用户和外部 AI 维护补全清单；预测提示默认关闭，启用后按 Tab 接受版本匹配的建议                       |
| 启动与安装可观测性 | 启动器逐阶段计时，长等待持续提示；首选项显示下载、解压、安装和第三方程序输出                        |

完整变化、兼容性调整和验证范围见 [0.2.3.6 发行说明](docs/releases/0.2.3.6.md)。

## 核心工作流

- **编辑与工程管理**：首页最近工程、预览／固定标签、横向滚动、拆分编辑器、草稿恢复，以及保存并关闭工程返回首页。
- **编译与烧录**：文件或目录可设置为编译入口；编译可离线执行，烧录前识别连接设备。STM32 支持受支持的 Keil `.uvprojx` 工程信息。
- **布局与产物**：可视化 Flash 布局、ELF 资源测量、BIN／Intel HEX／S-record 导出、STM32 ELF 导出，以及无工程预备固件烧录。
- **串口通信**：实时 UTF-8／HEX 收发，自选换行、波特率、数据位、校验、停止位和流控。
- **硬件调试**：独立桌面窗口或浏览器标签页查看 STM32／ST-Link 的寄存器、反汇编、调用栈、断点、内存和本地 ELF 段。
- **工程交付**：导出标准 ZIP，收集受支持的工程外依赖并改写归档副本中的路径，附带依赖清单。
- **自动化**：JSON-RPC 与 MCP 共用经过校验的接口，覆盖工程、Git、编译、固件、调试、语言索引、补全和界面操作。

## 安装与启动

### Windows 桌面便携版

1. 将 `Blode.Studio-0.2.3.6-desktop-win-x64.exe` 放到可写目录，运行应用。
2. 打开工程目录或其中的 `be` 文件。
3. 在首选项选择或安装工具链。使用 Git 时，先在目标电脑安装 Git。
4. 右键源码文件或文件夹设置编译入口，通过 `be` 高级设置配置工程；在 **运行 → 编译设置** 选择构建模式和已安装工具版本。
5. 保存并编译；烧录和硬件调试时连接、识别目标设备。

便携版使用操作系统的应用数据目录保存设置、历史和工具，不要求工程与程序放在同一目录。

### 独立 Web 版

在拥有工程和硬件的目标电脑解压 Web ZIP，然后执行：

```sh
npm ci --omit=dev
npm start
```

浏览器打开终端输出的私密链接。文件选择器浏览的是**服务所在电脑**；编译器、Git 和 USB 设备也由该电脑提供。

多人通过可信局域网访问时，在服务电脑执行：

```sh
npm start -- --host 0.0.0.0 --port 47821
```

链接中的令牌授权访问目标机器的工程与操作能力，应按工作区凭据管理。按 `Ctrl+C` 停止服务。详细部署与参数说明见 [Web 服务指南](docs/WEB-HOST.md)。

### 从源码运行

开发环境需要 Node.js 24+、npm，以及用于版本管理和相应测试的 Git：

```sh
npm ci
npm run dev
```

独立 Web 宿主：

```sh
npm run web:build
npm run web:start
```

修改主进程、平台包或 preload 后重新启动开发版；界面源码支持热更新。启动排查、权限修复和日志位置见[开发说明](docs/DEVELOPMENT.md)。

## 语言规则与工程格式

语言数据和解析器分开维护：

```text
extensions/completions/
├─ C/
│  ├─ c99/
│  ├─ c11/
│  ├─ c17/
│  └─ c23/
│     ├─ a.json ... z.json
│     ├─ keywords.json
│     ├─ control-flow.json
│     ├─ types.json
│     └─ rules.json
└─ C++/
   └─ arduino/
```

工程可在 `languages/C/<标准>/` 下维护自定义规则。JSON 结构和标准配置错误会显示文件、行列；源码规则可设置为 warning 或 error，error 会阻止构建。当前规则支持词法模式和函数调用检查，完整预处理与类型分析由编译工具链执行。

`be` 的 `build` 字段示例：

```json
{
  "entry": "src/main.c",
  "files": ["src/main.c", "src/driver.c", "startup/startup_stm32f10x_md.s"],
  "cStandard": "c17"
}
```

C 标准默认采用 C17；选择其他版本前，核对工具链支持范围。旧 `blode.completions.json` 和 `.blode/project.json` 工程仍保留兼容入口。详见[语言规则](docs/LANGUAGE-RULES.md)与[工程架构](docs/ARCHITECTURE.md)。

编译设置保存在 `be.build.settings`，依次支持通用、平台和 C/C++ 层级。跟随选项沿用上级配置，自动选项在本机查找兼容工具，明确的版本从已安装清单选择；下载与安装在首选项完成。STM32 同次构建使用同一编译器系列，ESP32-S3 使用一致的 Arduino CLI 与 core。调试和发布选项、JSON 示例及可迁移打包行为见[工程与编译设置](docs/PROJECTS.md)。

## 平台支持

| 目标平台 | 编译                                                  | 烧录／调试                           |
| -------- | ----------------------------------------------------- | ------------------------------------ |
| ESP32-S3 | Arduino CLI + Arduino-ESP32                           | esptool 串口烧录、串口通信           |
| STM32F1  | GNU Arm GCC 或已授权的 Arm Compiler 6；受支持工程导入 | ST-Link／SWD 烧录，ST-Link／GDB 调试 |
| 自动检测 | 从受支持的工程数据确定平台，或手动选择                | 连接设备识别目标                     |

Windows x64 是本次桌面产物和当前主要开发环境。Linux x64／ARM64 已提供 Node 宿主路径及部分 GNU／Arduino 下载适配，**尚未在 Linux 实机验证安装、编译、USB 访问或桌面打包**。macOS 自定义工具路径也未验证。详细矩阵见[平台支持](docs/PLATFORM-SUPPORT.md)，历史硬件记录见[硬件验证](docs/HARDWARE-VALIDATION.md)。

硬件工作台读取已连接目标的实际调试数据。CPU 结构图配合暂停采样展示寄存器与指令，完整的周期级芯片仿真不在本版范围内。

## 构建与验证

```sh
npm run typecheck
npm test
npm run build
npm run package:desktop
npm run package:web
```

桌面发行使用现有 `package:lite` 流程的 `package:desktop` 别名。独立 Web 构建检查宿主包中的 Electron 导入。测试包含临时 Git 仓库、规则诊断、索引、协作、工程打包和带模拟硬件边界的 HTTP 服务；实际设备、跨机器和持续协作的结果单独记录。

## 文档导航

| 面向         | 文档                                                                                                                                                                                  |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 发行与升级   | [0.2.3.6 发行说明](docs/releases/0.2.3.6.md) · [CHANGELOG](CHANGELOG.md)                                                                                                              |
| 语言与编辑器 | [语言规则](docs/LANGUAGE-RULES.md) · [AI 补全与预测](docs/AI-COMPLETIONS.md)                                                                                                          |
| 团队工作     | [多人协作](docs/COLLABORATION.md) · [Git 管理](docs/GIT.md) · [工程打包](docs/PROJECT-PACKAGING.md)                                                                                   |
| 编译与硬件   | [工程与编译设置](docs/PROJECTS.md) · [STM32](docs/STM32.md) · [ESP32-S3](extensions/boards/Esp32_S3_CAM/README.md) · [工具链](docs/TOOLCHAINS.md) · [工具版本](docs/TOOL-VERSIONS.md) |
| 部署与开发   | [Web 宿主](docs/WEB-HOST.md) · [开发约定](docs/DEVELOPMENT.md) · [架构](docs/ARCHITECTURE.md) · [扩展](extensions/README.md)                                                          |
| 状态与计划   | [平台支持](docs/PLATFORM-SUPPORT.md) · [路线图](docs/ROADMAP.md) · [功能指南](docs/NEW-FEATURES.md) · [实机案例](SHOWCASE.md)                                                         |
| 社区与安全   | [贡献指南](CONTRIBUTING.md) · [安全政策](SECURITY.md) · [许可证](LICENSE)                                                                                                             |

## 贡献与许可证

通过 [GitHub Issues](https://github.com/mioolio/blode/issues) 报告问题和讨论需求，通过 Pull Request 提交改进。问题报告请附版本、发行版、目标系统、工程类型和脱敏日志；源码、日志和硬件结果的提交约定见[贡献指南](CONTRIBUTING.md)。

Blode Studio 采用 [Apache License 2.0](LICENSE)，随发行包提供[第三方依赖许可声明](docs/THIRD-PARTY-NOTICES.md)。下载的编译器、驱动和其他第三方工具遵循各自的许可证。
