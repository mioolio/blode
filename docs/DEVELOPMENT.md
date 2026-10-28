# 开发约定与现有能力

## 本地开发循环

执行 `npm ci` 后使用 `npm run dev`。脚本先通过 esbuild 编译主进程、preload 与 MCP 桥，再启动 Vite 和 Electron。renderer 源码可热更新；core、automation、shared 运行时代码、preload、extensions 或构建脚本变化后，必须关闭开发进程并重新启动。当前没有主进程自动重启 watch。

`npm run typecheck` 检查 TypeScript 跨模块契约；`npm test` 使用 Node test runner 与 tsx，覆盖有实际边界意义的逻辑；`npm run build` 完成类型检查与主进程/前端生产构建。`npm start` 运行已有的 `dist/`，不会替代构建。

开发环境可通过 `BLODE_PROJECT_ROOT` 指定工程目录、`BLODE_DATA_ROOT` 指定应用数据目录。两者不同：前者保存源码及 `.blode/project.json`，后者保存托管工具链与系统管道连接信息。硬件验证脚本额外支持 `BLODE_PORT`；端口必须在当前电脑上实际存在。

## 软件模块边界

只把设备专属参数放入 `extensions/boards/<型号>/`。串口枚举、文件访问、操作锁、命令执行由 core 负责；UI 通过 preload 能力白名单调用核心；AI 通过同一 CoreApi 调用核心。不要从 React 组件导入 Node API，也不要在型号适配器中复制编译进程管理。

`ProjectConfig` 是版本化配置，当前 `version: 1`。修改其字段时必须同时检查 shared 类型、Zod schema、默认配置、renderer 编辑表单、管道路由与文档示例。稳定机器标识如 `esp32-s3`、FQBN 和分区名不是翻译后的展示文案。

插件清单用于描述随程序编译的可信适配器；registry 显式注册。当前没有读取工程目录任意 JS 并执行的扩展机制。第三方编译器配置代表用户选择的可执行程序与包索引，应使用可信来源。所有命令参数以数组传给 `spawn`，不能改为拼接 shell 字符串。

## 工程代码布局

应用本身采用 Node/TypeScript；ESP32-S3 固件使用官方 Arduino-ESP32 支持的 C/C++。最薄入口保存在工程根目录 `.ino`，功能模块推荐放在 `src/<功能>/`，例如：

```text
sensor-node/
  sensor-node.ino
  include/
    settings.h
  src/
    sensors/
      temperature.h
      temperature.cpp
    transport/
      telemetry.h
      telemetry.cpp
  .blode/
    project.json
```

Arduino CLI 递归编译 `src/` 下的 C/C++ 文件，不会递归编译任意命名的根目录子文件夹；不要把需要单独编译的 `.cpp` 仅放在根目录的 `modules/`，也不要把 `.ino` 放进 `src/`。[Arduino Sketch 规范](https://arduino.github.io/arduino-cli/1.5/sketch-specification/) 定义了这些规则。主服务将已保存文件放入受控 staging 目录，必要时将主 `.ino` 名称匹配 staging 工程目录。

`.blode/` 是本地配置和构建区，不能作为公共头文件目录或插件目录。运行时限制与忽略目录由 `workspace.ts` 定义；超出边界的工程应明确调整限制后再接入，不能把 UI 中未显示的文件当作已纳入构建的证明。

## 编辑器、可读性与容量

Monaco 本地打包，不依赖 CDN。当前提供语法高亮、括号匹配、缩进与代码折叠、搜索，以及来自 `extensions/completions/` 的声明式补全：Arduino 常用 API 带签名与说明、代码片段、`Serial.`/`Wire.`/`ESP.` 成员补全和符号悬停。新增或修改补全时只改该目录的纯数据并在 `index.ts` 注册，不要在 `CodeEditor` 中堆叠语言专用逻辑。C/C++ 补全仍不是完整的编译器语义服务；尚未集成 clangd 的头文件索引、类型推断、跨文件跳转或实时编译诊断。

编辑器标签、工作区视图和哈希路由共同决定当前界面：`/workspace/editor/<文件路径>`、`/workspace/layout`、`/workspace/automation`、`/workspace/settings`。布局和自动化以可关闭的编辑器标签呈现，刷新会按完整路由恢复。浏览器工作台通过 `src/core/web.ts` 提供本机 HTTP + SSE，渲染层在缺少 preload 时由 `web-bridge.ts` 接入同一 `CoreApi`；默认只监听 `127.0.0.1:47821`。

后续接入 LSP 时应新增独立语言服务模块，管理 language server 进程、文档版本、诊断事件与 Monaco provider 生命周期；复用核心路径边界。不能让每个板卡文件夹各启动一套 UI 编辑器。

可读性面板展示行数、注释行比例、超过 100 字符的行等启发式指标；这些不是代码质量评分，也不能证明程序正确。构建输出和错误面板保留编译器原始诊断。

固件 Flash 用量取自实际构建报告，缺少报告时使用生成应用镜像的字节数；静态 RAM 来自编译输出，不包含运行时堆峰值、任务栈或外部 PSRAM。`ESP.getFreeHeap()` 等运行输出与静态 RAM 预算是不同指标。尚未编译时显示等待；编辑后提示需重新编译，不以源码字符数伪装固件大小。

## 图形分区与烧录约束

图形编辑控制保存后的配置，核心校验容量、地址范围、对齐和重叠，再生成 `partitions.csv`。ESP32-S3 的 bootloader 在 `0x0`，partition table 在 `0x8000`，系统保留区固定；应用按 64 KiB 对齐，数据按 Flash sector 对齐。当前适配器仅支持一个 factory 应用分区。

OTA 需要显式 subtype、otadata、应用选择与一致的启动策略，目前未实现。不要仅增加第二个 app 块就声称实现了 OTA。ESP32-S3 烧录由核心将实际 bootloader、分区表、应用镜像映射到明确地址，避免默认 Arduino 上传配方中的固定地址与用户图形布局不一致。

烧录前要求当前源码/配置有成功构建、构建镜像未被修改、串口存在、实际芯片与 Flash 容量相容。与串口监视器共享设备时，应先由核心关闭监视连接。通用烧录器当前适用于 esptool 支持的 ESP 芯片；其他厂商应添加对应 programmer 协议。

## 工具链版本与网络

应用依赖以 `package-lock.json` 固定，托管工具链在用户主动安装/更新时解析官方稳定版本，CLI 压缩包使用官方 SHA-256 校验，实际版本写入应用数据目录的 lock 记录。安装后的工具链不会在每次编译时自动更新。自定义模式使用用户选择的 CLI、Python 与 FQBN，但当前编译核心仍以 Arduino-ESP32 为实现范围。

首次安装需要访问 Arduino、Espressif 与 GitHub 的官方服务；不随仓库分发所有架构的大型编译器包，也没有下载 Python 解释器。使用自定义 Python 时，应在该解释器环境准备 esptool；托管模式优先使用项目或应用专用虚拟环境。

## 国际化与 AI 接口

界面默认 `zh-CN`；renderer 英文资源文件为 `en.json`，状态值为 `en`。AI 描述英文资源为 `src/automation/locales/en-US.json`。添加界面文案时同步维护两种 JSON 的键集合，组件只引用键；外部编译器日志保持原始内容。

JSON-RPC 系统管道与 MCP stdio 桥共用路由 schema，而不是另写一套构建/烧录代码。接口映射、认证、消息边界、超时行为及调用示例详见 [AI-PIPE.md](AI-PIPE.md)。新增 AI 能力时先扩展 CoreApi，再补充路由、MCP 描述和协议往返测试。

## 实机验证

`scripts/verify-hardware.ts` 面向本次连接的 16MB ESP32-S3：设置配置、只读探测后进行实际构建；传入 `--install` 才安装工具链，传入 `--flash` 才向设备写入并读取串口心跳。其他板卡或容量须先修改验证配置。运行前关闭占用同一串口的监视器；不要把该脚本当作通用无副作用测试。

```powershell
npx tsx scripts/verify-hardware.ts --install
# 确认目标设备与固件后，下面的命令会写入设备：
npx tsx scripts/verify-hardware.ts --flash
```

真实结果保存在 [HARDWARE-VALIDATION.md](HARDWARE-VALIDATION.md)。文档必须区分探测成功、构建成功、Flash 写入验证与程序运行验证，不能用其中一个替代另一个。
