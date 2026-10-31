# 运行时插件开发指南

本文介绍 API v2 设备模块的声明、开发、打包与宿主集成。用户可以在 **组件库 → 设备模块** 查看已安装模块，并导出独立 ZIP；编译器的下载和导出分别位于 **编译与工具链**、**工具链与导出**。设备模块与宿主工具链分开交付，包结构和安装步骤见下文。

## 设计边界

运行时包负责自己声明的设备范围、连接方式和业务流程；内核提供工程、进程、配置、事件、取消及窗口服务。设备发现、编译、烧录与调试按所选运行时分派，不要求所有设备都以串口或 ST-Link 的形式出现。

内置 `Esp32_S3_CAM` 和 `STM32F103C8T6` 的 TypeScript 实现随宿主构建。第三方包通过 `manifest.json` 声明 API v2，并提供可直接加载的 JavaScript `.mjs` 或 `.cjs`；宿主不会在用户工程中自动执行任意 TypeScript 文件。

原生插件与宿主拥有相同的系统权限。执行确认是用户授权，既不是代码审计，也不是原生代码沙盒。自定义 HTML 视图另在隔离 iframe 中运行；该视图的限制不会把其对应的原生运行时变成沙盒。

## 阅读路径与兼容版本

- **使用现成模块**：直接阅读下文“安装到桌面二进制与 Web 宿主”，不需要克隆或编译 Blode Studio。
- **改造现有平台**：从 `Esp32_S3_CAM` 或 `STM32F103C8T6` 的十个职责目录开始，按“开发与打包流程”生成独立包。
- **开发新平台**：实现清单、运行时方法和实际硬件协议，分别声明语言、编译、调试与界面能力。

本文的 `languages`、`compiler.mode: runtime` 和独立模块打包器属于 2026-10-30 的内部开发更新。使用这些字段需要包含本次更新的宿主；旧版 `0.2.3.6` 正式二进制采用严格清单校验，不包含新契约。更新宿主后，安装模块无需重新编译主程序。内部便携验证及模块分发结果见[工作台验收记录](internal/workspace-improvements.md)。

API v2 仍在内部预览期，包作者应在 README 记录验证过的宿主版本或提交、操作系统、架构及工具版本。不要只凭 `apiVersion: 2` 推断所有历史预览构建都能读取新字段。

## 包目录与命名

源码开发时，包放在 `extensions/boards/<id>/`；宿主应用数据目录下的 `plugins/<id>/` 也可安装第三方包。完整目录可复制分享，也可通过组件库加载文件夹或 ZIP。新增模块立即注册；已执行模块的代码更新在重启后生效。

```text
Acme_F103_USB/
  manifest.json
  support/                   # 芯片范围、版本与兼容记录
  device/                    # 设备配置、发现与协议
  runtime/
    index.mjs                # 发行包执行入口
  constraints/               # 校验规则及边界说明
  ui/                        # 字段、动作及 HTML 视图
  compiler/                  # 构建流程、启动和链接配置
  debugger/                  # 调试提供者或宿主集成声明
  layout/                    # 存储与资源布局
  languages/                 # 模块自己的语言目录和规则
  tools/                     # 工具发现、下载或再分发的程序
  README.md
  LICENSE
  .uel                       # 由本机用户永久授权后生成，不随包分发
```

两个内置平台已采用上述十目录规范。源码入口为 `device/adapter.ts` 和 `runtime/index.ts`；独立发行包使用 `runtime/index.mjs`。目录按责任划分，清单是配置的单一来源，不要求为每个目录额外复制一份 JSON。只有声明或复用宿主的职责可以包含 README，明确指向对应字段；不要用空实现冒充功能。

| 目录           | 应放置的内容                               | 与其他层的边界                                     |
| -------------- | ------------------------------------------ | -------------------------------------------------- |
| `support/`     | 支持芯片、实验状态、接线及验证矩阵         | 范围由 `manifest.support` 注册，不能靠名称推断支持 |
| `device/`      | 纯配置适配器、设备标识、传输协议、烧录参数 | USB、探针、串口各自保留真实身份，不互相伪装        |
| `runtime/`     | `createRuntime`、操作分派、状态和资源清理  | 通过宿主 SDK 访问工程、进程、取消与事件            |
| `constraints/` | 芯片、地址、输入及配置的验证约束           | 在执行前检查；UI 隐藏不是后端约束                  |
| `ui/`          | 动态表单、自定义动作、窗口和底部面板文档   | 用声明和消息桥集成，不导入宿主 React 组件          |
| `compiler/`    | 构建配置、源码收集、链接、产物解析         | 工具路径来自配置或受管工具，不硬编码开发者电脑路径 |
| `debugger/`    | 调试方法、配置或内置调试后端说明           | `builtin` 复用宿主；`replace` 需提供完整功能       |
| `layout/`      | Flash/RAM 事实、容量、分区算法             | 推荐容量与用户明确配置分开处理                     |
| `languages/`   | 语言列表或固定语言、版本化 JSON 补全与规则 | 不写宿主 `extensions/completions/`，不更改其他模块 |
| `tools/`       | 工具发现、版本、安装、驱动事实及许可证     | 可下载管理或携带合法再分发文件，区分 OS/CPU 架构   |

例如 STM32 的 Keil 解析、CMSIS 兼容和链接模板已集中到 `compiler/`，XML 解析依赖及许可证放在其 `vendor/`；ESP32 的烧录命令位于 `device/`，Arduino 工具管理位于 `tools/`。运行时不导入另一个平台目录，也不导入 `src/core`。公共 SDK 的类型可在开发时引用，发行包中只保留编译后的实现及实际资源。

目录名必须与 `manifest.id` 一致。标识以字母开头，可包含大小写字母、数字、`_`、`-`，长度不超过 80；内置标识和旧别名不能被第三方包覆盖。

名称应准确表达范围：

| 名称            | 含义与当前状态                                                                                                 |
| --------------- | -------------------------------------------------------------------------------------------------------------- |
| `Esp32_S3_CAM`  | 当前内置 ESP32-S3 配置；沿用 `esp32:esp32:esp32s3`，摄像头引脚、时钟和初始化由工程决定                         |
| `STM32F103C8T6` | 当前内置 C8T6 配置；Keil 器件名称可为 `STM32F103C8` 或 `STM32F103C8T6`                                         |
| `Esp32_auto`    | 未来广泛兼容包的命名示例；名称本身不授予所有 ESP 型号的支持能力                                                |
| `Esp32_auto_Sx` | 未来 S 系列范围包的命名示例；仍须在 `support.chips` 列出实际支持的器件，不能凭通配名称推导未验证或不存在的型号 |

`support.chips` 是责任范围，`support.status` 区分 `experimental` 和 `supported`。具体封装、板载外设与接线限制写在 `support.notes` 和包内 README。ST-Link `0x410` 只能说明 F1 中容量识别组，不能独立证明完整 C8T6 料号。

## 声明清单

权威类型与校验器分别为 [RuntimePluginManifest](../src/shared/plugins.ts) 和 [runtime-plugin-schema.ts](../src/core/runtime-plugin-schema.ts)。宿主先校验 JSON 和文件边界，发现阶段不导入业务模块。

| 责任               | 字段                                                                                     | 实现要求                                                                                      |
| ------------------ | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| 支持哪些器件       | `support`                                                                                | 明确芯片清单、系列、成熟度和已知限制                                                          |
| 默认设备配置与能力 | `defaultConfig`、`transport`、`capabilities`                                             | `defaultConfig.boardId` 等于插件 ID；连接可为 `serial`、`stlink`、`usb`、`physical`、`custom` |
| 业务代码入口       | `runtime`、`sourceInputs`                                                                | 入口为包内 `.mjs`／`.cjs`；额外构建输入为工程相对路径                                         |
| 约束               | `constraints`                                                                            | 芯片 ID 与说明；插件业务代码仍负责协议、实际器件、地址和操作前检查                            |
| 目标设备界面       | `ui.fields`、`ui.actions`、`ui.hiddenCapabilities`、`ui.view`                            | 声明动态表单、动作、隐藏项和可选 HTML 视图；配置保存在 `config.runtime`                       |
| 编译所有权         | `compiler.mode`、`compiler.baseRuntime`、`compiler.defaultTool`、`compiler.managedTools` | 区分复用宿主、包内默认工具和模块自行管理工具三种流程                                          |
| 硬件仿真与调试     | `debugger.mode`、`debugger.view`                                                         | 声明不提供、使用内置、扩展或替换调试器；可选定制视图                                          |
| 资源布局           | `layout`                                                                                 | 声明 Flash 基址、推荐／可能容量与 RAM；推荐列表不限制用户显式设置的容量                       |
| 编译替换流程       | 运行时 `build()` 与 `config.runtime.forceCompiler`                                       | 用户主动启用替换，错误输出应说明失败阶段并允许修改配置后重试                                  |
| 强制编译组件       | `compiler.forceComponent`                                                                | 默认跟随包的编译组件；仍允许用户明确尝试替换                                                  |
| 模块语言           | `languages.mode`、`languages.entries`、`languages.default`                               | 声明固定语言或按后缀区分的语言目录，按标准版本选择规则                                        |

### 清单示例

下面是复用内置 F103C8 编译器、由插件实现 USB 编程流程的声明。它说明文件格式，不包含某种 USB 编程协议的实现。

```json
{
  "apiVersion": 2,
  "runtimeApiVersion": 2,
  "kind": "board",
  "id": "Acme_F103_USB",
  "name": "Acme F103 USB",
  "version": "0.1.0",
  "runtime": "runtime/index.mjs",
  "transport": "usb",
  "capabilities": ["compile", "flash", "probe", "layout"],
  "support": {
    "chips": ["STM32F103C8T6"],
    "families": ["STM32F1"],
    "status": "experimental",
    "notes": "Requires the package author's documented USB programmer protocol."
  },
  "defaultConfig": {
    "version": 1,
    "name": "firmware",
    "boardId": "Acme_F103_USB",
    "port": "",
    "baudRate": 115200,
    "flashSize": 65536,
    "partitions": [{ "id": "firmware", "name": "firmware", "type": "app", "offset": 0, "size": 65536 }],
    "toolchain": {
      "mode": "managed",
      "arduinoCli": "",
      "python": "",
      "additionalUrls": [],
      "fqbn": ""
    },
    "runtime": { "deviceId": "", "values": { "interface": "usb0" } }
  },
  "compiler": { "mode": "host", "baseRuntime": "STM32F103C8T6" },
  "debugger": { "mode": "none" },
  "layout": {
    "flashBaseAddress": 134217728,
    "recommendedFlashSizes": [65536],
    "possibleFlashSizes": [65536, 131072],
    "ramSize": 20480
  },
  "constraints": { "chipIds": ["0x410"], "notes": ["Confirm the complete device part number."] },
  "ui": {
    "fields": [{ "id": "interface", "label": "USB interface", "type": "text", "default": "usb0" }],
    "hiddenCapabilities": ["serial"]
  }
}
```

保留字段由严格 schema 校验；额外字段、错误类型、重复 UI 字段和非法入口路径会使包无法注册。相对文件路径使用 `/`，不允许绝对路径、`..` 或逃出包目录的符号链接。

包内最多 20,000 个文件，总大小不超过 4 GiB，单文件不超过 2 GiB。工具文件计入包内容指纹，二进制使用流式摘要；状态刷新复用缓存，执行前重新核验授权。声明应与实际工具分发的大小和许可一致。

## 业务模块与宿主 SDK

模块导出 `createRuntime(host, manifest)`，同步或异步返回 [PluginPlatformRuntime](../extensions/plugins.ts)。基础方法沿用 [PlatformRuntime](../extensions/runtime.ts)：

| 方法                           | 责任                                                                    |
| ------------------------------ | ----------------------------------------------------------------------- |
| `status`、`install`            | 工具状态和显式安装；通过事件和进度回调报告过程                          |
| `discover`、`probe`            | 列举候选与识别所选设备；候选的 `platformId`、`transport` 必须与声明一致 |
| `build`                        | 执行所需编译流程，返回容量、时间、工具输出及工程相对产物路径            |
| `buildInputs`、`projectConfig` | 可选的额外构建输入与工程识别                                            |
| `flash`、`flashPrepared`       | 根据实际设备和镜像地址编程；无工程镜像烧录由可选 `flashPrepared` 实现   |
| `invalidate`、`dispose`        | 使内部缓存失效，以及释放设备、子进程、监听器和文件句柄                  |

`PluginRuntimeHost` 提供 `pluginRoot`、工程路径解析、源码读取、输出目录、取消信号、进程执行、事件、工具安装进度和 `runDefaultTool()`。使用参数数组调用 `host.runCommand()`；编译输出经 `host.emit()` 发布，不能只把失败吞成一个空结果。

USB 或物理设备用 `DetectionCandidate.deviceId` 和 `config.runtime.deviceId` 表达选中对象，额外设置放在 `config.runtime.values`。串口仍使用 `port`，ST-Link 仍使用探针序列号。包内代码负责把这些值转换为本设备协议，不依赖内核为所有设备猜测串口。

`constraints.chipIds` 存在时，探测返回的明确芯片 ID 必须落在声明清单中。该检查也适用于启用编译器替换的配置；替换编译器不会取消设备身份约束。完整料号、板级接线和自定义协议仍由插件代码核对。

## 编译工具与用户替换

| 模式      | 实际构建方法                  | 必需声明            | 典型用途                                                        |
| --------- | ----------------------------- | ------------------- | --------------------------------------------------------------- |
| `host`    | 内置 `baseRuntime` 的构建流程 | `baseRuntime`       | 只定制传输协议，沿用宿主编译器                                  |
| `plugin`  | 插件的 `build()`              | 包内 `defaultTool`  | 随包提供默认编译组件或 Node 驱动                                |
| `runtime` | 插件的 `build()`              | 非空 `managedTools` | 模块自行发现、安装和使用默认工具，例如 Arduino CLI + ESP32 core |

`compiler.mode: "host"` 需要 `baseRuntime`，复用该内置运行时的编译流程。基底必须与实际 CPU、文件格式和布局一致；宿主不会自动转换任意体系结构。

`compiler.mode: "plugin"` 或 `forceComponent: true` 必须声明 `defaultTool`，且工具文件确实位于包内，例如：

```json
{
  "mode": "plugin",
  "baseRuntime": "STM32F103C8T6",
  "forceComponent": true,
  "defaultTool": {
    "id": "AcmeCompiler",
    "executable": "tools/compiler-driver.mjs",
    "runner": "node",
    "version": "1.0.0",
    "args": ["--build"]
  }
}
```

`runner: "native"` 直接运行文件；`runner: "node"` 使用宿主 Node 运行包内脚本。跨操作系统工具可由自己的 Node 驱动选择适当平台文件，并在 README 写明操作系统、架构和再分发许可证。仅填写一个下载链接不能代替包内默认工具。`build()` 可调用 `host.runDefaultTool(extraArgs)` 并解析产物。

`runtime` 模式的 `managedTools` 每项包含 `id`、`name` 和可选 `version`。清单列明默认工具，模块的 `status()`、`install()` 和 `build()` 实现实际发现、安装和使用流程；清单自身不会下载工具。安装要报告进度、验证归档、支持取消，并输出可定位的失败信息。内置 ESP32/STM32 打包成独立模块时使用此模式，执行包中的构建实现；`baseRuntime` 保留调试复用和用户强制切换所需的架构基底，不把默认编译重新交回宿主。

`forceComponent: true` 仍要求 `defaultTool`，不能用只有名称的 `managedTools` 代替强制组件。模块作者应保证强制组件文件、入口与许可随包存在。

在 Electron 二进制中，`runner: node` 通过宿主可执行文件的 Node 模式启动，不要求用户另装 Node；独立 Web 宿主使用其 Node 可执行文件。调用 `host.runDefaultTool()` 可复用该行为。直接把 `process.execPath` 当普通 Node 启动会受到 Electron 环境差异影响。

用户可在编译设置启用强制替换，保存为 `config.runtime.forceCompiler: true`。插件目标默认复用其 `baseRuntime`；用户也可通过 `config.runtime.compilerRuntime` 明确选择另一个内置构建后端进行兼容实验，即使作者没有声明该组合。宿主把该工程的语言版本配置交给所选后端，不根据工具名称猜测 CPU 架构。尝试另一插件的整工程编译组件时，选择 `family: "plugin"` 并给出 `pluginId`。

强制替换保留显式确认、包信任和设备约束检查，不代表宿主保证交叉工具的 ABI、标准库或链接布局兼容。最终结果以实际构建和目标验证为准。

插件编译组件作用于整项构建。C/C++ 配置需使用同一插件提供者，不能一边明确选择插件、另一边选择 GNU 或另一插件而让其中一项被静默忽略。

遇到问题时，查看输出中的命令阶段和诊断，调整工程 `be.build.settings` 或插件 `manifest.json` 的工具参数。修改插件自身文件后须重启，并重新完成包内容对应的执行确认。不要在工程 ZIP 中分发本机绝对工具路径或 `.uel`。

### 项目组件构建输入

**运行 → 组件库**管理工程源码依赖。Arduino 库写入 `libraries/<name>/`，原生组件写入 `components/<name>/`，工程根目录的 `blode.components.json` 保存元数据与文件摘要。宿主在调用 `build(config, build)` 前派生可选的 `build.components`：

| 字段                 | 含义                                                                  |
| -------------------- | --------------------------------------------------------------------- |
| `roots`              | 受管组件的工程相对根目录                                              |
| `sources`            | 原生组件需要编译的工程相对源文件路径                                  |
| `includeDirectories` | 原生组件的工程相对头文件搜索目录                                      |
| `arduinoLibraries`   | 交给 Arduino CLI `--libraries` 的工程相对库容器目录，例如 `libraries` |
| `inputs`             | 参与构建指纹的清单和实际组件文件，用于识别编译结果是否过期            |

这些字段由宿主根据清单、文件和路径检查生成，**不能写入 `be.build.components`**，也不是插件清单里的编译 hook。插件应通过 `host.resolveWorkspacePath()` 解析路径，用参数数组调用工具，并将需要的原生源码加入自己的构建流程。未实现 Arduino 框架兼容的编译器应对非空 `arduinoLibraries` 返回明确错误。

内置 ESP32 后端把原生组件复制到临时 sketch 的 `src/blode_components/`，添加头文件目录，并将 Arduino 工程库交给 CLI。内置 STM32 后端加入原生源码和头文件目录，排除组件目录的重复扫描；它不接受 Arduino 框架库。第三方 `plugin`／`runtime` 编译实现需要自行消费这些输入，复用 `host` 基底的模块沿用基底处理。

组件管理只复制和索引库文件，不执行库中的脚本。AI 或宿主 UI 使用 `components.install/import/remove` 时仍需 `expectedProjectRoot` 与 `confirm: true`；组件并不替代运行时插件的代码授权和编译工具声明。操作与接口见[组件库](COMPONENT-LIBRARIES.md)和[AI 接口](AI-PIPE.md#组件库接口)。

ESP32 模块维护者追加优化或语言选项时，应读取平台展开的编译属性，保留配方中的 `compiler.c.flags`／`compiler.cpp.flags` 及 `-c` 等参数，向对应 `extra_flags` 追加内容。标准 ESP32 模块已修复覆盖基础 flags 导致的编译问题。

## 调试与自定义界面

内置 ESP32-S3 通过 USB-JTAG、Xtensa GDB 和 Espressif OpenOCD 提供调试；STM32F103C8T6 使用 ST-Link/SWD 和 Arm GDB。模块可通过 `baseRuntime` 复用这些架构，也可实现自己的后端。功能矩阵和实机验证状态见[硬件调试指南](HARDWARE-DEBUGGING.md)。

`debugger.mode` 可为 `none`、`builtin`、`extend`、`replace`。扩展或替换时在运行时返回 `debugger` 方法表，使用宿主调试 API 的状态、连接、执行控制、内存、断点、符号及存储约定。完整替换者应提供自己需要的全部方法；扩展者可以补充内置调试器的方法。

`ui.fields` 支持 `text`、`number`、`boolean`、`select`，用于目标设备面板中的动态设置。选择字段需要不重复的选项，数值边界应与协议一致。`ui.hiddenCapabilities` 控制被隐藏的设备能力区域。

### 独立窗口与底部功能区

当前源码通过 `ui.views` 统一注册额外视图。每个 `id` 在插件内唯一，HTML 必须位于插件目录：

```json
{
  "ui": {
    "fields": [],
    "views": [
      {
        "id": "logic",
        "label": "逻辑分析",
        "file": "views/logic.html",
        "location": "window",
        "width": 1100,
        "height": 760
      },
      {
        "id": "trace",
        "label": "跟踪输出",
        "file": "views/trace.html",
        "location": "panel"
      }
    ]
  }
}
```

`location` 只接受 `window` 或 `panel`。每包最多 32 个视图，ID 为字母开头的字母、数字、下划线或连字符，最长 80 字符。宽度允许 320–3840、高度允许 240–2160，单位为像素。界面中的 **视图 → 扩展视图** 列出已发现的声明；打开时检查包授权。

原生业务代码可调用 `await host.openView('logic')`，HTML 使用 `await window.blodeRuntime.openView('logic')`。两个入口都只允许打开所属包已经声明的视图。原生 SDK 请求由宿主递交到一个工作台；Web 窗口请求会显示打开按钮，用户点击后创建标签。Promise 完成表示请求已递交，不表示浏览器标签已经打开。

桌面创建无边框独立窗口，同一插件／视图重复打开会恢复已有窗口，最多同时八个扩展窗口。Web 打开服务宿主的浏览器页面，仍通过受限票据加载包 HTML。`panel` 在底部组件注册自定义标签，随整个底部面板显示和隐藏。视图内容由 HTML 自行绘制；宿主进程、配置和调试调用通过既有消息桥。

### HTML 消息桥

用户禁用的能力保存在 `config.runtime.disabledCapabilities`；宿主相应操作会检查该配置，隐藏界面本身不构成权限限制。

`ui.view` 和 `debugger.view` 指向包内 HTML。宿主以 `sandbox="allow-scripts"` 的不透明来源 iframe 加载**独立文档 URL**，不使用继承主页面脚本策略的 `srcdoc`。桌面端使用 `blode-runtime-ui:` 协议，Web 端通过认证接口申请有效期 15 秒、只可消费一次的随机视图票据；视图 URL 不携带宿主访问 token，取文档时再次核验插件授权。

独立文档使用自己的内容安全策略，允许本包内联脚本和样式，并禁止网络、嵌套框架、表单提交和对象加载；主工作台的脚本策略保持独立，不为第三方界面开放内联脚本。页面不能直接访问宿主 DOM、文件或原生 Node，图片使用 data URL。交互通过受控消息桥，例如请求调试状态：

```js
parent.postMessage({ channel: 'blode-runtime-ui', id: 'sample-1', method: 'state', args: [] }, '*');
```

回复使用相同 `channel` 和 `id`，并包含 `result` 或 `error`。页面应检查 `event.source === parent`，并用安全 DOM API 显示返回数据。可调用的方法由桥接白名单和宿主调试接口共同限制，不能以任意方法名执行主进程代码。设备表单是通用配置入口；HTML 视图不会自动获得未声明的硬件操作方法。

宿主也为 HTML 视图注入 `window.blodeRuntime`。`context()` 读取所选设备 ID、字段值、能力与声明；`configure({ deviceId, values, disabledCapabilities })` 更新并保存当前工程配置。自定义设备动作先在 `ui.actions` 声明 ID、标题和可选 `confirm: true`，再由运行时的 `device` 方法表实现相同 ID：

```js
const context = await window.blodeRuntime.context();
await window.blodeRuntime.configure({ values: { interface: 'usb1' } });
// 前提：ui.actions 声明 identify，且 runtime.device 实现 identify。
await window.blodeRuntime.device('identify', [], true);
```

动作仅发送给当前所选运行时，使用宿主设备互斥锁；要求确认的动作必须显式携带 `true`。配置桥不允许更改插件授权或开启强制编译器替换。设备协议的额外动作不需要借用调试器的方法名。

## 信任与更新

发现清单、列出运行时或显示未经批准插件的存在，不会导入其 JavaScript。用户第一次执行第三方流程前出现二级确认窗口，可取消、仅本次会话允许或永久不再提示。

永久选择在插件根目录创建 `.uel`。该声明关联本机、包目录和包内容；它不是作者可以随包预授权的通行证。删除声明、换机器、移动包或修改包内容后，应重新确认。发布包不包含 `.uel`，更新说明应列出业务代码、工具、访问设备及配置变化。

根目录 `.uel` 是保留的授权文件，不能作为业务入口、工具或视图。子目录中的同名文件仍纳入业务内容摘要。已加载包或清单发生变化时，宿主要求重启，避免重新授权后仍使用旧的 Node 传递模块缓存。

修改已加载模块时重启宿主，避免 Node 的传递模块缓存与新清单混用。原生插件执行后有能力调用操作系统 API；用户应在授权前审查来源、代码及默认工具。软件作者不为第三方业务代码导致的入侵承担责任。

## 模块自己的语言适配

`manifest.languages` 支持两种声明方式：`fixed` 只声明一种语言；`declared` 提供语言列表，通过文件后缀选择。默认语言必须在列表内，同一后缀只能归属一个条目。例如 ESP32 将 `.ino`、`.cpp`、`.h` 归入 C++，将 `.c` 归入 C；STM32 的 `.h` 默认归入 C。

每个条目通过 `catalogs` 加载通用 JSON，通过 `standards` 分别指向 `c99`、`c11`、`c17`、`c23` 目录。构建配置的 `be.build.cStandard` 决定所选标准，不合并其他版本。补全、悬停、片段及构建前规则来自同一模块声明。规则错误保留文件和字段诊断。

模块声明语言后，不再继承宿主全局 C/Arduino 补全或默认规则。工作区源码索引、用户 AI 补全和显式工程级规则仍可以叠加；未声明语言的旧包保持原有行为。模块自己的列表不改写主程序的 JSON，也不会污染另一个目标模块。

内置模块通过静态 JSON 导入将语言资源带入宿主编译结果；第三方发行包从自己的 `languages/` 读取 JSON，发现时无需执行业务代码。作者可以把函数拆成 `a.json`、`b.json` 等目录清单，但必须逐项声明路径，不依赖隐式目录扫描。完整字段、固定语言示例、规则和错误处理见[模块语言适配指南](MODULE-LANGUAGES.md)。

## 开发与打包流程

### 1. 从标准模块开始

作者环境需要 Node.js 24+，在源码仓库执行 `npm ci`。先阅读两个标准模块的 README，再选择与设备实际架构相符的模板：

- [Esp32_S3_CAM](../extensions/boards/Esp32_S3_CAM/README.md)：Arduino-ESP32 构建、esptool 烧录、USB-JTAG 调试集成、独立 C/C++ 语言数据。
- [STM32F103C8T6](../extensions/boards/STM32F103C8T6/README.md)：Arm/GNU 编译、Keil 项目解析、ST-Link、Cortex-M3 调试集成和独立语言数据。

改造时依次完成支持范围、默认配置、设备识别、编译、烧录、资源、语言和界面声明。未知设备应返回可操作的诊断；编译流程可以离线执行，烧录和调试才要求真实连接。日志通过宿主事件发送，设备探测由首次初始化、用户刷新或实际硬件变更触发。

### 2. 生成可复制的发行目录

以下命令仅构建模块，不构建或打包桌面主程序：

```sh
npm run package:runtime -- extensions/boards/Esp32_S3_CAM --output ./release/modules --zip
npm run package:runtime -- extensions/boards/STM32F103C8T6 --output ./release/modules --zip
```

默认生成 `Esp32_S3_CAM_Module` 和 `STM32F103C8T6_Module`，避免覆盖宿主内置 ID。可通过 `--id Acme_S3_CAM` 指定新的唯一 ID。第三方模块默认导出 `createRuntime`，自定义工厂名通过 `--factory createAcmeRuntime` 指定。

输出目录包含严格校验后的 `manifest.json`、`runtime/index.mjs`、包内语言 JSON、视图、工具资源、README、许可证和文件摘要清单。`--zip` 另外生成便于分享的 ZIP。已有目标目录和 ZIP 不会被覆盖；升级时选择新输出位置，确认后再替换安装目录。

打包器将 TypeScript 与模块实现编译为 JavaScript，并内联需要的实现依赖，运行时保留 Node 内置模块导入。它拒绝宿主核心代码及跨平台实现依赖；SDK 类型引用会被编译消除。内置模板输出还会转换 ID、候选设备和分平台构建配置，使复制出的模块具有独立身份。

`.git`、`.blode`、`.tools`、`.uel`、隐藏文件、TypeScript 源文件、source map 和开发依赖目录不进入标准输出。发布前仍应核对文件摘要清单和许可证，不把个人凭据或无权再分发的工具放入模块目录。

### 3. 处理运行时路径与资源

| 内容                        | 正确的引用方式                                                                            |
| --------------------------- | ----------------------------------------------------------------------------------------- |
| 包内 JSON、模板、二进制工具 | 使用 `host.pluginRoot` 拼接包内相对路径                                                   |
| 工程文件                    | 使用 `host.projectRoot()` 或 `host.resolveWorkspacePath()`                                |
| 工程构建输出                | 使用宿主工程路径服务，通常放入 `.blode/build/`                                            |
| 下载工具与可写缓存          | 使用 `host.toolchainRoot` 或 `host.dataRoot` 下的专用目录                                 |
| Node 标准库                 | 使用 `node:fs`、`node:path` 等内置导入                                                    |
| SDK 类型                    | 开发时 `import type`；发布后不依赖对应 `.ts` 文件                                         |
| 原生 Node 扩展              | 按宿主操作系统、架构和 Node/Electron ABI 单独处理并验证，不能仅靠 JavaScript 打包获得兼容 |

例如，包内配置可通过 `readFile(path.join(host.pluginRoot, 'device', 'defaults.json'), 'utf8')` 读取。不要把 `process.cwd()` 当作模块根目录，不依赖 `../../src/core`、主程序安装位置、开发机绝对路径或 `app.asar` 内部布局。应用资源可能只读；下载与状态写入宿主数据目录。

打包会合并源码，`import.meta.url` 的位置也会改变。优先使用 `host.pluginRoot`；打包器处理可静态确定的本地 URL，不能确定的动态相对资源引用应改成显式包根路径。模块 HTML 采用内联 JavaScript/CSS，图片使用 data URL；宿主目前不提供插件静态资源网站，不能直接引用旁边的 `script.js` 或 `style.css`。打包器会检查常见外部视图资源引用并给出错误。

### 4. 在干净宿主中验收

把发行目录复制到独立宿主数据目录，在没有仓库源码的环境中完成安装、授权、发现、离线编译和资源加载。可用模拟运行时测试取消、缺工具、错误输入和无设备路径；真实烧录、调试、驱动与平台兼容需另记实机结果。修改后重新生成完整包，避免只替换一个清单而留下旧 JavaScript。

## 安装到桌面二进制与 Web 宿主

模块使用者只需要兼容宿主和已打包的模块。**不要把源码目录直接放入二进制应用，也不要修改 `app.asar` 或内置注册表。**

| 宿主                                      | 默认第三方模块目录                                                |
| ----------------------------------------- | ----------------------------------------------------------------- |
| Windows 桌面正式/便携应用                 | `%APPDATA%\Blode Studio\plugins\<id>\`                            |
| 使用 `BLODE_DEV_USER_DATA` 的桌面开发环境 | 对应 userData 目录下的 `plugins/<id>/`                            |
| Windows Web 宿主                          | `%LOCALAPPDATA%\Blode Studio Web\plugins\<id>\`                   |
| Linux Web 宿主                            | `${XDG_DATA_HOME:-~/.local/share}/blode-studio-web/plugins/<id>/` |
| 指定 `BLODE_DATA_ROOT` 的宿主             | `<BLODE_DATA_ROOT>/plugins/<id>/`                                 |
| Web CLI 指定 `--data-root`                | `<指定目录>/plugins/<id>/`，优先于环境变量                        |

默认位置以实际启动日志的 dataRoot/Host data 为准。桌面便携版的可执行文件位置不等于可写数据位置；希望数据随目录移动时，可以显式设置 `BLODE_DATA_ROOT`。桌面 Linux/macOS 的默认数据位置由 Electron `userData` 决定，本轮未实际验证。

安装步骤：

1. 关闭宿主，将 ZIP 解压为一个完整模块目录。检查 `<id>/manifest.json` 是否直接存在，避免多嵌套一层目录。
2. 把该目录放入宿主数据目录的 `plugins/`。目录名必须与清单 `id` 一致。
3. 启动宿主，在目标设备的运行时选择中找到新模块。清单错误会出现在插件状态诊断中。
4. 首次执行前审查并确认插件。需要的工具通过模块安装流程下载，或配置现有工具路径。
5. Web 客户端刷新状态后选择该模块。模块安装在**目标机器的 Web 宿主**，不是每个浏览器用户的电脑。

更新时停止宿主，保留用户工程，完整替换同一 ID 的模块目录，然后重启并重新授权。卸载时停止宿主，移走该模块目录；对应工程保留其运行时 ID，下次打开应选择可用模块。不要随包复制 `.uel`。二进制宿主加载的是普通外部 JavaScript 和包资源，用户端无需 TypeScript、esbuild 或主程序源码。

## 常见问题

| 现象                             | 检查项                                                                        |
| -------------------------------- | ----------------------------------------------------------------------------- |
| 模块未出现                       | 宿主是否包含本次内部契约；目录名是否等于 ID；清单是否直接位于包根；是否已重启 |
| TypeScript 入口被拒绝            | 安装了源码目录；使用 `package:runtime` 生成 `.mjs` 包                         |
| 更换目录后需要再次确认           | 授权绑定本机、目录和内容；在新位置重新确认                                    |
| 语言补全缺失                     | `languages` 后缀与默认语言、JSON 的 `language`、所选 C 标准、包内目录是否匹配 |
| 规则文件报错                     | 根据文件/字段诊断修改，使用严格 JSON；不要混用其他标准版本                    |
| 编译没有使用模块实现             | 检查 `compiler.mode`；`host` 会调用内置基底，独立管理工具应选 `runtime`       |
| 二进制应用中找不到资源           | 用 `host.pluginRoot` 解析包资源，检查摘要清单是否包含文件                     |
| Windows 可用、Linux 无法运行工具 | 检查 OS/CPU 架构、执行权限、动态库和 USB 权限；不能复用 `.exe`                |
| 自定义窗口为空                   | 查看视图诊断；使用内联脚本/样式和允许的消息桥，不引用宿主网页或外部资源       |

## 验证与提交

提交前至少覆盖以下场景：

1. 有效／无效清单、缺文件、错误工具路径及重复运行时 ID。
2. 未授权状态不执行代码；取消、会话授权、永久授权、删除 `.uel`、包更新和重启。
3. 未连接硬件编译，USB／物理设备选择，明确的芯片与地址边界。
4. 默认编译组件、强制替换、失败诊断和修改配置后的重试。
5. 调试接口、取消、断开与清理，自定义视图的来源与方法限制。
6. 自定义资源容量、旧工程迁移，以及另一个干净目录中打开分享工程。

验证记录应分别注明宿主系统、工具版本、设备型号、自动化结果和实机结果。视图脚本、消息桥、桌面窗口及浏览器交互需要独立验收，Linux 尚未实测。历史宿主结果见[内部更新说明](internal/runtime-plugins.md)，本次模块拆分、语言隔离与发行包验证见[模块更新记录](internal/module-packaging.md)。
