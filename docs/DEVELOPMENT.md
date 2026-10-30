# 开发约定

最新开发源码位于 `main`，包含从 `codex/runtime-plugins-internal` 合入的内部预览更新。0.2.3.6 发行包仍对应此前构建；本次源码合并不生成新发行包。克隆与启动命令见 [README](../README.md#快速开始)。

## 本地循环与运行数据

执行 npm ci 后使用 npm run dev。启动脚本先构建 main、preload 与 MCP 桥，再启动 Vite 和 Electron。renderer 可热更新；core、shared、automation、preload、平台包或构建脚本修改后需重启开发进程，当前没有主进程自动重启 watch。

启动准备阶段合并 Electron 与旧 Vite 孤儿进程查询。进程恢复与关键运行时权限检查并行；权限检查完成后再并行构建和创建 Vite，避免低完整性 esbuild 在修复完成前执行。开发启动只检查实际使用的 Electron 与 esbuild 可执行文件，不递归 SDK/tools；`postinstall` 和 `npm run repair:permissions` 仍执行完整工具目录检查，并覆盖 esbuild。全部准备成功后才启动 Electron，原有孤儿进程恢复与单实例保护保持有效。

Vite 依赖扫描入口固定为 `index.html`，文件监听忽略 `.tools/`、`tools/`、`dist/`、`release/` 和 `.git/`。工具目录里的 HTML 文档不属于前端入口，新增工具链不应增加开发服务器的扫描范围。

模块语言校验使用的 `zod` 与编辑器依赖一同显式预优化，避免首次请求语言规则时追加依赖优化并刷新页面。冷缓存测试通过真实 Vite HTTP 请求检查首页、语言规则和延迟编辑器，验证加载过程中依赖 hash 稳定、没有优化触发的整页刷新。

终端逐项显示权限检查、进程恢复、构建、Vite 初始化与监听、Electron 尝试的耗时；超过 5 秒会继续报告等待阶段。启动器记录位于 `.tools/dev-launcher.log`，每次 Electron 尝试退出后另存主进程日志为 `.tools/dev-main.log.attempt-N.log`，重试不会覆盖前次失败证据。GPU overlay 警告本身不代表窗口启动失败，仍以界面就绪及退出状态判定。

可运行 `npm run dev -- --diagnose-startup` 检查实际启动准备路径。诊断使用独立 profile、临时端口和全新依赖缓存，不启动 Electron，也不结束已有进程；结果保存在 `.tools/startup-diagnostics/`。该结果包含首个 HTML 响应，不代表完整桌面冷启动时间。权限检查仍可修复开发运行时的 Low 标签。

桌面窗口提前加载静态主题首屏，同时初始化服务；业务 IPC 等待路由准备完成，窗口控制无需等待后台服务。React 首次挂载通过专用 IPC 报告就绪，不再每 250 毫秒执行 DOM 查询。`.tools/dev-main.log` 记录各阶段累计耗时，`window first paint`、`window ready interface=mounted` 和 `bootstrap services ready` 分别代表首次绘制、界面挂载和服务就绪，不能把三者当作同一个指标。服务初始化的 fatal 错误仍使启动器以失败退出。

桌面使用 `progressiveStartup` 返回首份界面快照，工具链与设备在后台检查一次，期间 `AppState.initializing` 为 true；界面显示“正在检查”，不根据尚为空的结果提示未安装或清除用户选择。完成后通过设备状态事件更新，不新增周期轮询。编辑器及首选项、布局、AI、硬件调试等界面按需载入；Monaco 初始化期间显示当前文件的真实源码预览。首次安装依赖后仍可能需要 Vite 预构建；资源体积和局部耗时测试不能代替桌面端冷启动测量。

开发模式用户数据位于 .tools/dev-user-data，与安装版和其他 checkout 分开；该目录已被 Git 和 Vite 忽略。主进程在申请单实例锁前验证目录写入与删除，启动日志写入 .tools/dev-main.log。开发工具链默认使用仓库 tools/，不与项目 .blode/ 混放。

### 独立 Node.js Web 版

Web 宿主不导入 Electron，与桌面版共用工程、协作、Git、工具版本、串口和硬件调试服务。要求 Node.js 24 或以上版本；打开工程与文件时选择服务所在电脑上的路径。

| 命令                  | 用途                                                                               |
| --------------------- | ---------------------------------------------------------------------------------- |
| `npm run web:dev`     | 用 tsx 启动 TypeScript Web 宿主；前端需先构建，UI 修改后重新构建                   |
| `npm run web:build`   | 构建独立 Node 服务与 renderer，并检查宿主 bundle 不含 Electron 导入                |
| `npm run web:start`   | 运行 `dist/web-server.cjs`，默认仅监听 `127.0.0.1:47821`                           |
| `npm run package:web` | 构建并生成 Web 发行 ZIP；只包含宿主、前端、serialport 运行时清单与锁文件、说明文档 |

例如 `npm run web:start -- --host 0.0.0.0 --port 47821 --project "D:\\firmware\\my-device" --data-root ".tools/web-data"`。启动后打开终端一次性输出的私密链接；本机回环 API 同样需要令牌。Web 的默认数据目录独立于桌面开发版，可使用 `--data-root` 覆盖；不把该目录、令牌或用户工程加入发行 ZIP。`package:web -- --skip-build --output "release/review.zip"` 可归档刚刚构建的 Web 产物，已有 ZIP 不会被覆盖。

Web ZIP 解压后执行 `npm ci --omit=dev` 安装目标平台的 serialport 依赖，再执行 `npm start`。生成发行锁文件只发生在临时目录，使用 `--package-lock-only --ignore-scripts`；不在打包时下载大型编译工具，也不内置 Electron、Chromium 或本机凭据。详细部署说明见 [WEB-HOST.md](WEB-HOST.md)。

| 环境变量             | 用途                                           |
| -------------------- | ---------------------------------------------- |
| BLODE_DEV_USER_DATA  | 覆盖开发模式的 Electron 用户数据目录           |
| BLODE_DATA_ROOT      | 覆盖核心应用数据目录，如管道凭据和驱动解压目录 |
| BLODE_TOOLCHAIN_ROOT | 覆盖平台工具链根目录                           |
| BLODE_DRIVER_ROOT    | 覆盖 Windows 驱动归档目录                      |
| BLODE_PROJECT_ROOT   | 显式指定用户工程；硬件脚本要求为仓库外已有工程 |
| BLODE_PORT           | 仅在显式指定时覆盖硬件脚本使用的串口           |

Windows 工作区文件可能继承 Low 完整性标签，使可执行文件以低完整性运行而不能写桌面、下载或 AppData。依赖安装及开发启动前检查已知本地运行时，必要时将低于 Medium 的可执行文件标签恢复为 Medium；也可执行 npm run repair:permissions。该修复保留 DACL 和更高的完整性级别。普通权限、锁或初始化错误不触发 sandbox 降级；仅已知的 Windows 断点启动/渲染崩溃允许一次兼容重试。

### Windows 开发启动兼容

当沙箱中的渲染进程以 `0x80000003` 崩溃时，Electron 主进程可能在处理加载失败后以 `0` 退出。启动器同时检查主进程与渲染器日志，区分正常关闭和真实的启动崩溃。AMD `GetGpuDriverOverlayInfo` 诊断不单独触发重试。

默认 `BLODE_DEV_SANDBOX=auto`。首次发生已知沙箱崩溃后，启动器尝试一次 `--no-sandbox`；只有兼容尝试收到主进程的界面挂载标记，才把结果保存在 `.tools/dev-sandbox-<profile-hash>.json`。之后相同 Electron 版本、程序路径和配置目录直接采用已经成功的模式，减少每次启动前的失败与清理。普通关闭、超时、软件渲染回退或没有显示界面的尝试不生成记录。

| 设置              | 行为                                            |
| ----------------- | ----------------------------------------------- |
| `auto` 或未设置   | 首次使用沙箱，复用已验证的 Windows 开发兼容记录 |
| `1` 或 `required` | 强制使用沙箱，不自动追加 `--no-sandbox`         |
| `0` 或 `disabled` | 显式使用 `--no-sandbox`                         |

记录只影响开发启动器，不改变发行应用的设置。更换 Electron 版本、程序路径或配置目录后重新检测；删除对应记录可重新尝试默认模式。记录损坏或不可写时，启动流程继续。

开发服务器现在通过 Vite API 在启动器进程内运行。按 profile 获取操作系统级独占会话后，启动器只回收精确匹配本机 Electron 路径和 user-data-dir 的孤儿进程树；仍有活启动器的窗口和其他 profile 不被清理。旧 Vite 子进程也仅在 Node 路径、脚本路径精确匹配且父进程已消失时回收，不全局终止 Electron 或 Node。

每次 Electron 尝试有独立启动日志和 30 秒可见窗口期限；重试前停止本次拥有的进程树。主进程通过 IPC/父进程存活检查随开发启动器退出，关闭资源有 5 秒期限，避免不可见实例长期占用 profile。开发模式禁用有争用风险的 GPU 持久缓存/Graphite 路径，必要时再尝试软件渲染；不删除用户数据、Local Storage 或工程。AMD 视频处理器等 GPU 警告不能单独视为启动失败，最终以窗口就绪和进程状态验证。

## 主进程打包体积

普通 `Ctrl+R` 继续使用缓存刷新，强制刷新仍可用 `Ctrl+Shift+R`。Monaco 与其语言 worker 按需加载；主进程保留工程资源索引和工具状态，合并并行读取，文件／配置变化时失效。构建新鲜度及保存前磁盘冲突检查仍读取真实输入，不依赖界面索引的防抖缓存。打包网页对静态资源提供 ETag，带内容哈希的资源启用长期缓存；HTML 每次重新验证。

主进程中的 Zod 使用 `import * as z from 'zod'`，让打包器按实际调用裁剪导出，避免引入未使用的语言包和 JSON Schema 转换功能。不要为缩小单个文件而把 Zod 整体外置；发布包应继续包含所需校验逻辑。

`npm run dev` 压缩空白和语法、保留标识符及函数名，并生成引用本地源码的 `.map`，不重复嵌入源码内容。`npm run build` 或直接运行 `node scripts/build.mjs` 默认生成完整压缩的主进程、preload 和 MCP 桥，保留函数／类名用于诊断；发布模式不生成这三个文件的源码映射，并清理上次开发构建遗留的对应 `.map`。需要单独构建可调试产物时，可先设置 `BLODE_BUILD_MODE=development`；显式设置为 `production` 可强制发布模式。这些设置不改变 Vite 的前端打包配置。

## 平台边界

当前只有 auto、Esp32_S3_CAM、stm32。auto 是中性检测配置，容量为 0、分区为空；不显示某厂商编译目标、分区或虚构资源。候选连接和已识别芯片分开，多候选需明确选择。

厂商的默认配置、识别、工具链、构建、烧录、布局和驱动事实放在 extensions/boards/<platform>/。核心保留通用锁、工程路径、配置、输入/产物哈希、构建缓存、串口及进程宿主，不增加厂商分支。平台 runtime 只依赖本目录、公共类型和 extensions/runtime.ts 宿主 SDK，不导入 core 或另一平台。

具体平台需在 extensions/registry.ts 与 extensions/runtime-registry.ts 双显式注册。manifest 的 runtimeApiVersion 必须与目标宿主 SDK 相容；复制文件夹不会自动执行代码。当前是随应用构建的可信模块，不提供任意 JS 的热安装或隔离运行。

## 工程与入口

应用仓库不包含随启动创建的固件工程。打开用户文件夹后，通过根目录 be 保存配置，旧 .blode/project.json 仍可读取。be.build 保存构建选择，保存配置必须保留这一段。

文件树右键“设为编译入口”仅更新 be.build.entry，值为工程相对文件或目录，不立即编译。入口解释属于平台：S3 仍需完整 Arduino sketch；STM32 仍需匹配目标的启动、链接和构建配置，不能从 main.c 推导整板环境。

S3 建议根目录主 .ino 与 src/<module>/ 下的 C/C++ 组织。Arduino 的子目录构建规则由其工具链决定；平台 runtime 将授权源码复制到 .blode/staging 并生成分区 CSV。STM32 不套用 Arduino 或 ESP 的 staging/布局规则。

STM32 的 build.entry 可为文件、目录或点号；有入口才请求 Arm Compiler 6 源码构建，无入口保留 firmware.bin 验证。项目 Arm 启动与 scatter 优先；内置启动/链接模板仅用于已知 0x410 STM32F1 中容量目标，未知芯片拒绝猜 CPU 与内存。GNU .ld 不能直接交给 armlink，完整限制见 [STM32](STM32.md)。

本机 Arm Compiler 6.22 已从 E 盘迁入 tools/armclang，原 license_terms 保留，源码仓库不跟踪工具二进制。平台目录可单独分享，但不因此获得编译器重分发或本机 Community 授权的转授。

.blode/ 是项目私有构建与缓存区，不用于公共头文件或扩展代码。工程路径拒绝穿越和不安全的符号链接/目录联接；源码编辑索引有深度、数量与单文件大小限制，不能将资源树中出现的所有文件都视为已参与构建。

## 界面与能力

文件、布局和自动化以可关闭编辑页签呈现，按工程保存会话；点击“文件 → 首选项”直接打开宽矩形弹窗，左侧导航切换常规、工具链、驱动、AI、状态与安装输出，右侧显示详细配置。语言和驱动状态查看无需打开工程。

构建/固件验证、布局与烧录按平台 capabilities 开放。`layout` 提供布局页，`partitions` 允许任意分区编辑；auto 不显示布局，STM32 在固定布局中调整容量与应用区，剩余 Flash 保留。旧会话中的不可用布局页只显示说明，不产生可编辑的 ESP 默认分区。

Monaco 本地打包。补全位于 extensions/completions，当前有 Arduino API 提示、片段、成员与悬停；未实现完整 clangd 语义服务。资源树菜单位于 extensions/menus，纯数据条目与 renderer 处理器分离。

日志桌面导出由主进程原生另存为并实际写入，完成后才提示保存；取消不提示成功。网页端只发起 Blob 下载并提示已发起。导出文本有编码后大小限制，IPC 不接受任意输出路径。

## 构建与验证

npm run typecheck 检查跨模块契约，npm test 覆盖协议与边界，npm run build 完成类型与生产构建。平台目录还需做复制后隔离 bundle 检查；这只验证不依赖 core/其他平台，不能当作真实板卡测试。

本轮轻量验证可分别执行：

```sh
npm run typecheck
npx tsx --test tests/tool-versions.test.ts tests/git.test.ts tests/project-package.test.ts tests/web-host.test.ts
npm run web:build
node dist/web-server.cjs --help
```

测试使用小型下载响应、临时工程和临时 Git 仓库。Git 推送／拉取在本地临时 bare 远端中验证，不向当前源码仓库或真实远端提交；Web 测试使用临时端口、替换平台运行时，覆盖令牌鉴权、目标机目录打开、工程 ZIP 下载、工具版本清单与临时目录内的终端输出。测试不连接／烧录单片机；宿主初次读取状态仍可枚举只读串口／驱动信息。

这些结果证明服务与协议路径能运行，不等同于跨电脑工程编译、完整工具链下载、长时间多人浏览器操作或 Linux 认证。Linux x64／ARM64 的下载与路径适配尚未实机安装、编译或连接硬件验证。验收范围见 [PLATFORM-SUPPORT.md](PLATFORM-SUPPORT.md)，后续计划见 [ROADMAP.md](ROADMAP.md)。

构建容量来自编译工具或实际二进制。Flash 总容量、可写区域、链接后的 RAM 预算与运行时空闲内存分别显示，不能以源码字符数推算固件大小。STM32 默认模板的 RAM 占用包含静态数据及链接器保留的 1 KiB 栈，不代表运行时峰值；启动使用 AC6 标准 __main 完成运行库初始化。成功记录位于 .blode/build-state.json，输入或产物改动使 buildStale，失败构建不伪造成功数据。

硬件脚本要求先指定仓库外已有、含有效描述符的工程：

```powershell
$env:BLODE_PROJECT_ROOT = 'D:\\firmware\\my-device'
npx tsx scripts/verify-hardware.ts
# 安装工具需要显式参数：
npx tsx scripts/verify-hardware.ts --install
# 核对设备和固件后，显式允许写入：
npx tsx scripts/verify-hardware.ts --flash
```

脚本尊重工程板卡、容量、布局与工具路径，不自动建例程、不默认 COM3、不覆盖成 16 MiB，也不自动打开心跳串口。默认执行识别与构建/验证，--install 才安装，--flash 才烧录。日志写入仓库 .tools/hardware-run.log。不要将该脚本作为无硬件副作用的单元测试运行。

历史硬件数据见 [HARDWARE-VALIDATION.md](HARDWARE-VALIDATION.md)，结果必须分别说明识别、构建、烧录和运行验证。

## 国际化与自动化

renderer 使用 zh-CN.json/en.json，automation 使用 zh-CN.json/en-US.json；新增文案同时维护键集合，厂商输出保留原文。修改 ProjectConfig 时同步 shared 类型、schema、默认配置、平台、UI 和路由。

系统管道与 MCP 共用 routes.ts schema 和 CoreApi，新增设备或入口能力先实现核心契约再接传输，不在桥接层复制平台逻辑。说明见 [AI-PIPE.md](AI-PIPE.md)。

Windows 开发版默认使用软件渲染以兼容显卡驱动；设置 BLODE_DISABLE_GPU=0 可显式测试硬件加速。Electron 主窗口以交互程序方式启动，不能使用后台辅助进程的隐藏启动选项。启动就绪须确认 React 工作区已经挂载，不能仅依赖 ready-to-show；页面初始加载期间显示启动提示。截图诊断仅在 BLODE_RENDER_DIAGNOSTICS=1 时生成。
