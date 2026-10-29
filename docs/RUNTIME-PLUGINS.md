# 运行时插件开发指南

状态：内部开发预览，API v2，显示版本为 `0.2.3.6-internal`。源码分支为 `codex/runtime-plugins-internal`，`developmentChannel` 为 `internal-runtime-plugins`；稳定基线和 npm 包版本仍分别为 `0.2.3.6`、`0.2.3-6`。本次不发布新的正式版。验证记录及人工验收步骤见[内部更新说明](internal/runtime-plugins.md)。

## 设计边界

运行时包负责自己声明的设备范围、连接方式和业务流程；内核提供工程、进程、配置、事件、取消及窗口服务。设备发现、编译、烧录与调试按所选运行时分派，不要求所有设备都以串口或 ST-Link 的形式出现。

内置 `Esp32_S3_CAM` 和 `STM32F103C8T6` 的 TypeScript 实现随宿主构建。第三方包通过 `manifest.json` 声明 API v2，并提供可直接加载的 JavaScript `.mjs` 或 `.cjs`；宿主不会在用户工程中自动执行任意 TypeScript 文件。

原生插件与宿主拥有相同的系统权限。执行确认是用户授权，既不是代码审计，也不是原生代码沙盒。自定义 HTML 视图另在隔离 iframe 中运行；该视图的限制不会把其对应的原生运行时变成沙盒。

## 包目录与命名

源码开发时，包放在 `extensions/boards/<id>/`；宿主应用数据目录下的 `plugins/<id>/` 也可安装第三方包。完整目录可复制分享。安装或修改包后重启宿主，让声明与模块重新加载。

```text
Acme_F103_USB/
  manifest.json
  runtime.mjs
  tools/
    compiler-driver.mjs       # 仅插件自己编译时必需
  views/
    device.html              # 可选
    debugger.html            # 可选
  README.md
  LICENSE
  .uel                       # 由本机用户永久授权后生成，不随包分发
```

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

| 责任               | 字段                                                            | 实现要求                                                                                      |
| ------------------ | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| 支持哪些器件       | `support`                                                       | 明确芯片清单、系列、成熟度和已知限制                                                          |
| 默认设备配置与能力 | `defaultConfig`、`transport`、`capabilities`                    | `defaultConfig.boardId` 等于插件 ID；连接可为 `serial`、`stlink`、`usb`、`physical`、`custom` |
| 业务代码入口       | `runtime`、`sourceInputs`                                       | 入口为包内 `.mjs`／`.cjs`；额外构建输入为工程相对路径                                         |
| 约束               | `constraints`                                                   | 芯片 ID 与说明；插件业务代码仍负责协议、实际器件、地址和操作前检查                            |
| 目标设备界面       | `ui.fields`、`ui.actions`、`ui.hiddenCapabilities`、`ui.view`   | 声明动态表单、动作、隐藏项和可选 HTML 视图；配置保存在 `config.runtime`                       |
| 编译所有权         | `compiler.mode`、`compiler.baseRuntime`、`compiler.defaultTool` | 选择宿主编译或插件编译；插件编译必须提供包内默认工具                                          |
| 硬件仿真与调试     | `debugger.mode`、`debugger.view`                                | 声明不提供、使用内置、扩展或替换调试器；可选定制视图                                          |
| 资源布局           | `layout`                                                        | 声明 Flash 基址、推荐／可能容量与 RAM；推荐列表不限制用户显式设置的容量                       |
| 编译替换流程       | 运行时 `build()` 与 `config.runtime.forceCompiler`              | 用户主动启用替换，错误输出应说明失败阶段并允许修改配置后重试                                  |
| 强制编译组件       | `compiler.forceComponent`                                       | 默认跟随包的编译组件；仍允许用户明确尝试替换                                                  |

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
  "runtime": "runtime.mjs",
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

用户可在编译设置启用强制替换，保存为 `config.runtime.forceCompiler: true`。插件目标默认复用其 `baseRuntime`；用户也可通过 `config.runtime.compilerRuntime` 明确选择另一个内置构建后端进行兼容实验，即使作者没有声明该组合。宿主把该工程的语言版本配置交给所选后端，不根据工具名称猜测 CPU 架构。尝试另一插件的整工程编译组件时，选择 `family: "plugin"` 并给出 `pluginId`。

强制替换保留显式确认、包信任和设备约束检查，不代表宿主保证交叉工具的 ABI、标准库或链接布局兼容。最终结果以实际构建和目标验证为准。

插件编译组件作用于整项构建。C/C++ 配置需使用同一插件提供者，不能一边明确选择插件、另一边选择 GNU 或另一插件而让其中一项被静默忽略。

遇到问题时，查看输出中的命令阶段和诊断，调整工程 `be.build.settings` 或插件 `manifest.json` 的工具参数。修改插件自身文件后须重启，并重新完成包内容对应的执行确认。不要在工程 ZIP 中分发本机绝对工具路径或 `.uel`。

## 调试与自定义界面

`debugger.mode` 可为 `none`、`builtin`、`extend`、`replace`。扩展或替换时在运行时返回 `debugger` 方法表，使用宿主调试 API 的状态、连接、执行控制、内存、断点、符号及存储约定。完整替换者应提供自己需要的全部方法；扩展者可以补充内置调试器的方法。

`ui.fields` 支持 `text`、`number`、`boolean`、`select`，用于目标设备面板中的动态设置。选择字段需要不重复的选项，数值边界应与协议一致。`ui.hiddenCapabilities` 控制被隐藏的设备能力区域。

### 独立窗口与底部功能区

内部开发分支通过 `ui.views` 统一注册额外视图。每个 `id` 在插件内唯一，HTML 必须位于插件目录：

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

## 验证与提交

提交前至少覆盖以下场景：

1. 有效／无效清单、缺文件、错误工具路径及重复运行时 ID。
2. 未授权状态不执行代码；取消、会话授权、永久授权、删除 `.uel`、包更新和重启。
3. 未连接硬件编译，USB／物理设备选择，明确的芯片与地址边界。
4. 默认编译组件、强制替换、失败诊断和修改配置后的重试。
5. 调试接口、取消、断开与清理，自定义视图的来源与方法限制。
6. 自定义资源容量、旧工程迁移，以及另一个干净目录中打开分享工程。

本轮自动化与审查不代替真实设备验收。实际设备、Windows／Linux 平台、工具版本及已验证结果应随包记录，尚未测试的组合明确列为未验证。此次浏览器 UI 自动验收未执行：自动审批以无法可靠确定 Windows 测试页面 URL 为由拒绝了操作，未进行浏览器点击。视图脚本、消息桥和选择器的真实交互需按验收清单人工确认；服务级测试不等于完整浏览器验收。宿主本轮结果统一维护在[内部更新说明](internal/runtime-plugins.md)。
