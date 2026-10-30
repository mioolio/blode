# 平台包与宿主架构

设备实现按平台归属。`extensions/boards/<platform>/` 组合该平台的配置、检测、工具链、构建、烧录、布局、语言和驱动描述；`src/core` 提供宿主服务及可复用调试后端。当前内置检测配置 `auto` 和具体平台 `Esp32_S3_CAM`、`STM32F103C8T6`。

## 目录责任

| 位置                                   | 责任                                                              |
| -------------------------------------- | ----------------------------------------------------------------- |
| `src/shared/contracts.ts`              | 跨进程数据、CoreApi、构建与检测结果类型                           |
| `extensions/types.ts`                  | 纯配置 BoardAdapter：设备事实、默认值与校验                       |
| `extensions/runtime.ts`                | RuntimeHost、PlatformRuntime 与工厂 SDK                           |
| `extensions/boards/<platform>/`        | 平台 adapter/runtime/toolchain/programmer/layout/driver，按需拆分 |
| `extensions/registry.ts`               | 板卡配置和元数据的可信静态注册                                    |
| `extensions/runtime-registry.ts`       | 具体平台 runtime 工厂的可信静态注册                               |
| `extensions/plugins.ts`                | API v2 原生插件的 SDK 和模块契约                                  |
| `src/core/runtime-plugins.ts`          | 动态插件声明、包授权、编译及设备／调试路由                        |
| `src/core/general-extensions/`         | 通用扩展安装、权限、指纹授权、独立视图与 ZIP 分享                 |
| `src/renderer/extensions/`             | 扩展管理、隔离页面桥与可恢复的外观贡献                            |
| `extensions/plugins/Personalization/`  | 自包含通用扩展示例，供源码及二进制宿主安装                        |
| `src/shared/runtime-views.ts`          | 声明式视图注册，供窗口与底部面板使用                              |
| `src/shared/workspace-surfaces.ts`     | 文件、工具、底部页与面板的统一同步标识和校验                      |
| `src/core/shared-tab-authority.ts`     | 跨端关闭事务、成员确认、版本记录和状态回放                        |
| `src/renderer/workspace/sharedTabs.ts` | 界面同步入口、关闭协调和断线状态发送队列                          |
| `src/core/vscode.ts`                   | 生成工程工作区配置、查找及启动宿主 VS Code                        |
| `src/core/desktop-lifecycle.ts`        | 退出保存事务、托盘偏好与窗口关闭策略                              |
| `src/renderer/workspace/attention.ts`  | 浏览器／桌面共用注意力来源注册                                    |
| `extensions/drivers/`                  | 驱动类型与注册，厂商事实来自平台目录                              |
| `src/core/`                            | 通用锁、工程路径、配置、进程宿主、哈希、缓存、串口                |
| `src/renderer/`                        | 编辑器、设备能力显示、菜单、首选项、国际化                        |
| `src/automation/`                      | 认证传输、schema 路由、客户端与 MCP                               |

平台 runtime 不导入 core 或另一个平台实现；类型来自 shared，宿主契约来自 `extensions/runtime.ts`。平台内部使用相对导入，复制完整目录即可保留内部依赖。纯 adapter 定义配置，有状态的工具与设备操作由 runtime 组织。

宿主还包含 Electron IPC、网页服务、日志导出和通用驱动安装执行器。平台模块负责 FQBN、编译与烧录布局及识别规则；共享调试层通过显式架构 profile 管理寄存器、调试服务参数和地址区域，第三方可扩展或替换该后端。

## 调用流

```mermaid
flowchart LR
    UI[React / Monaco] --> IPC[preload 与 IPC 白名单]
    AI[JSON-RPC / MCP] --> Routes[统一 schema 路由]
    IPC --> Core[通用 CoreApi service]
    Routes --> Core
    Core --> Registry[runtime-registry]
    Registry --> S3[Esp32_S3_CAM 平台包]
    Registry --> STM32[STM32F103C8T6 平台包]
    S3 --> Host[RuntimeHost SDK]
    STM32 --> Host
    Host --> OS[工程路径 / 进程 / 串口 / 事件]
```

核心维护工程选择、互斥与取消、文件保存、配置落盘、输入指纹、产物哈希和成功构建缓存，按 registry 分派平台。平台决定如何扫描、识别、安装、构建和烧录，返回统一结果。

## 宿主 SDK 与检测

RuntimeHost 提供带超时/取消的参数数组进程执行、受控工程路径解析、构建目录重建、源码读取、串口选择、事件、网络和取消信号。平台解析厂商输出；工程输入与可清理路径先经过宿主边界。平台内部归档可使用 Node 文件 API，但不得导入核心实现。

PlatformRuntime 包含 `status/install/discover/probe/build/flash/invalidate`；`sourceInputs` 声明源码编辑索引之外的固定输入，可选 buildInputs 返回编译器额外读取的源码、头文件与链接输入，用于完整指纹校验。`auto` 没有具体 runtime，而是汇总已注册平台候选：

- USB 串口只是候选，平台 probe 必须验证真实芯片。
- 多候选不默认取第一项；缺工具与没有设备分别报告。
- 未识别时容量为 0、分区为空，不开放构建、烧录和布局。
- 识别成功后平台产生配置，由核心校验、保存和清理缓存。

## 复制与注册

两个标准平台分为 `support/device/runtime/constraints/ui/compiler/debugger/layout/languages/tools` 十个职责目录，入口为 `device/adapter.ts` 和 `runtime/index.ts`。清单声明 `entry`、`runtime`、`apiVersion` 和 `runtimeApiVersion`，当前标准模块使用 API v2；`auto` 只提供中性配置。

下列静态注册步骤适用于修改宿主源码。第三方独立分发使用 `package:runtime`，不编辑 registry：生成 `.mjs` 与资源后安装到宿主数据目录 `plugins/<id>/`，经授权加载。编译后的桌面主程序无需源码即可使用兼容包，详见[运行时插件指南](RUNTIME-PLUGINS.md)。

1. 复制完整平台目录，包含工具链、协议、布局、驱动事实和说明。
2. 在 `extensions/registry.ts` 显式注册 adapter。
3. 在 `extensions/runtime-registry.ts` 显式注册 runtime 工厂；auto 只注册配置。
4. 需要驱动时，在 `extensions/drivers/index.ts` 注册平台导出的描述，补齐语言资源。
5. 执行类型、边界和隔离 bundle 检查，再单独记录硬件验证。

S3 与 STM32 已做单目录复制后的隔离打包检查，不依赖 core 或彼此目录。检查证明源码依赖边界，不能替代工具环境、接线、链接地址和硬件烧录验证。

内置平台随应用静态编译。API v2 插件从宿主插件目录发现声明，经过包指纹对应的用户授权后加载原生业务模块；插件变更需要重启并重新检查授权。原生模块在宿主进程中执行，HTML 视图则使用独立文档、受限消息桥和隔离 iframe。工程目录中的任意脚本不会因此自动加载。

语言数据归模块所有：内置适配器静态导入其 JSON，二进制宿主不反查源码路径；外部模块通过清单加载包内 `languages/`。`AppState.language` 向编辑器提供解析结果，编译前检查使用同一声明；有模块声明时不混入宿主 C/Arduino 默认目录。项目规则、工作区索引和用户 AI 条目保留各自作用域，见[模块语言适配](MODULE-LANGUAGES.md)。

## 构建、缓存与能力

`be.build` 保存输入。右键“设为编译入口”只更新 `build.entry`，可选文件或目录，不立即编译；平台解释入口。构建使用已保存文件，输入、构建配置或产物变化会使缓存过期。串口号和传输速率不作为固件源码变化。

S3 平台生成、校验 ESP 布局与 CSV；STM32 不套用 ESP 分区，烧录模式限制从 Flash 起点写入单一固件，布局页因此只分配应用区，剩余 Flash 保留。`layout` 能力开放布局页，`partitions` 能力允许任意分区编辑；界面以 capabilities 决定编译、验证和布局动作，不以默认容量代替实测值。平台通过 `BoardDefinition.layout` 提供 Flash 起始地址，renderer 不按板卡 ID 分支。`flashSizeOverride` 表示用户手动修正容量，平台重新识别时不得覆盖；STM32 只接受不大于探测值的覆盖。STM32 链接以物理 Flash 生成完整镜像，但编译结果按应用区与数据/系统保留区逐段检查；越界会产生警告，烧录确认仍允许用户二次确认，超出物理 Flash 或 RAM 则拒绝。

STM32 源码构建仍需要匹配芯片的启动文件、链接脚本、架构选项和构建配置；不能从单个 main.c 推导全部板卡信息，具体范围以平台说明为准。

## 前端、驱动与协议

renderer 不导入 Node 或直接启动编译器，preload 只公开能力白名单。桌面通过原生对话框选择工程和保存文件，Web 通过目标机器文件选择器与下载响应完成对应操作；Windows 驱动安装在宿主上处理提权。首选项按常规、工具链和驱动定位，语言与驱动操作无需工程。

终端进程由 `HostTerminal` 统一持有，前端 xterm 按需加载并通过会话／序号游标读取原始 ANSI 增量。Windows 使用 ConPTY，其他宿主使用系统 PTY；界面销毁不结束 Shell，显式关闭终端或退出宿主才释放进程。协作、原生窗口注意力与退出控制的边界见[交互更新](internal/workbench-interaction.md)。

主工作台的共享界面状态走 `workspace-surfaces` 注册表。组件通过统一入口发布打开、关闭和显隐意图；服务维护版本与关闭记录，接收端执行准备、提交或取消。共享文件关闭需各持有者确认同一版本；源码和配置保存携带起始工程根目录，在宿主锁内再次校验。具体交互和新增功能页接入方法见[多人协作](COLLABORATION.md)。

VS Code 连接使用标准工作区文件，不修改项目原有 `.vscode`。外部编辑器保存由工程文件监听接入同一缓存失效、草稿冲突和界面刷新流程；实现与验证范围见[VS Code 连接](vscode.md)。

ST-Link 的 INF、USB ID 和归档描述位于 STM32 平台 driver.ts，通用执行器完成 PnP 查询、解压与显式提权安装。驱动可用不等于命令行工具已安装，调试器也不等于 COM 串口。

补全与资源管理器菜单是显式注册的纯数据。renderer 使用 zh-CN.json/en.json，automation 使用 zh-CN.json/en-US.json，外部工具输出保留原文。JSON-RPC routes.ts 是方法 schema 唯一映射，MCP 从同一表生成工具，不复制平台逻辑。详见 [AI-PIPE.md](AI-PIPE.md)。
