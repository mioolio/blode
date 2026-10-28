# 开发约定

## 本地循环与运行数据

执行 npm ci 后使用 npm run dev。启动脚本先构建 main、preload 与 MCP 桥，再启动 Vite 和 Electron。renderer 可热更新；core、shared、automation、preload、平台包或构建脚本修改后需重启开发进程，当前没有主进程自动重启 watch。

开发模式用户数据位于 .tools/dev-user-data，与安装版和其他 checkout 分开；该目录已被 Git 和 Vite 忽略。主进程在申请单实例锁前验证目录写入与删除，启动日志写入 .tools/dev-main.log。开发工具链默认使用仓库 tools/，不与项目 .blode/ 混放。

| 环境变量             | 用途                                           |
| -------------------- | ---------------------------------------------- |
| BLODE_DEV_USER_DATA  | 覆盖开发模式的 Electron 用户数据目录           |
| BLODE_DATA_ROOT      | 覆盖核心应用数据目录，如管道凭据和驱动解压目录 |
| BLODE_TOOLCHAIN_ROOT | 覆盖平台工具链根目录                           |
| BLODE_DRIVER_ROOT    | 覆盖 Windows 驱动归档目录                      |
| BLODE_PROJECT_ROOT   | 显式指定用户工程；硬件脚本要求为仓库外已有工程 |
| BLODE_PORT           | 仅在显式指定时覆盖硬件脚本使用的串口           |

Windows 工作区文件可能继承 Low 完整性标签，使可执行文件以低完整性运行而不能写桌面、下载或 AppData。依赖安装及开发启动前检查已知本地运行时，必要时将低于 Medium 的可执行文件标签恢复为 Medium；也可执行 npm run repair:permissions。该修复保留 DACL 和更高的完整性级别。普通权限、锁或初始化错误不触发 sandbox 降级；仅已知的 Windows 断点启动/渲染崩溃允许一次兼容重试。

开发服务器现在通过 Vite API 在启动器进程内运行。按 profile 获取操作系统级独占会话后，启动器只回收精确匹配本机 Electron 路径和 user-data-dir 的孤儿进程树；仍有活启动器的窗口和其他 profile 不被清理。旧 Vite 子进程也仅在 Node 路径、脚本路径精确匹配且父进程已消失时回收，不全局终止 Electron 或 Node。

每次 Electron 尝试有独立启动日志和 30 秒可见窗口期限；重试前停止本次拥有的进程树。主进程通过 IPC/父进程存活检查随开发启动器退出，关闭资源有 5 秒期限，避免不可见实例长期占用 profile。开发模式禁用有争用风险的 GPU 持久缓存/Graphite 路径，必要时再尝试软件渲染；不删除用户数据、Local Storage 或工程。AMD 视频处理器等 GPU 警告不能单独视为启动失败，最终以窗口就绪和进程状态验证。

## 平台边界

当前只有 auto、esp32-s3、stm32。auto 是中性检测配置，容量为 0、分区为空；不显示某厂商编译目标、分区或虚构资源。候选连接和已识别芯片分开，多候选需明确选择。

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

文件、布局和自动化以可关闭编辑页签呈现，按工程保存会话；首选项由顶栏齿轮打开“常规/工具链/驱动”二级菜单并以弹窗呈现，不再占用编辑页签。语言和驱动操作无需打开工程。

构建/固件验证、布局与烧录按平台 capabilities 开放。`layout` 提供布局页，`partitions` 允许任意分区编辑；auto 不显示布局，STM32 在固定布局中调整容量与应用区，剩余 Flash 保留。旧会话中的不可用布局页只显示说明，不产生可编辑的 ESP 默认分区。

Monaco 本地打包。补全位于 extensions/completions，当前有 Arduino API 提示、片段、成员与悬停；未实现完整 clangd 语义服务。资源树菜单位于 extensions/menus，纯数据条目与 renderer 处理器分离。

日志桌面导出由主进程原生另存为并实际写入，完成后才提示保存；取消不提示成功。网页端只发起 Blob 下载并提示已发起。导出文本有编码后大小限制，IPC 不接受任意输出路径。

## 构建与验证

npm run typecheck 检查跨模块契约，npm test 覆盖协议与边界，npm run build 完成类型与生产构建。平台目录还需做复制后隔离 bundle 检查；这只验证不依赖 core/其他平台，不能当作真实板卡测试。

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
