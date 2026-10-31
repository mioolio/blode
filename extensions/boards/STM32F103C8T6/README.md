# STM32F103C8T6 运行时包

当前声明范围为 STM32F103C8T6；Keil 工程可写 `STM32F103C8` 或 `STM32F103C8T6`。默认 Flash 为 64 KiB，SRAM 为 20 KiB，用户仍可显式调整 Flash 分配。ST-Link 的 `0x410` 标识属于 F1 中容量组，不能单独证明具体封装或完整料号；该包不据此宣称支持所有 STM32 型号。第三方插件接口见[开发指南](../../../docs/RUNTIME-PLUGINS.md)。

此目录拥有 STM32 / ST-Link 的配置、运行时、协议、工具和驱动事实。它使用宿主 SDK 的 `RuntimeHost`，不导入 core 或 ESP32-S3 平台实现。

| 目录           | 职责                                                                                       |
| -------------- | ------------------------------------------------------------------------------------------ |
| `support/`     | 支持范围与发布状态说明；声明位于 `manifest.support`                                        |
| `device/`      | `adapter.ts` 设备配置；`programmer.ts`、`protocol.ts` 探针与烧录协议                       |
| `runtime/`     | `index.ts` 注册运行时、分派构建与设备操作                                                  |
| `constraints/` | 芯片、地址与操作约束说明                                                                   |
| `ui/`          | 界面字段及扩展入口说明                                                                     |
| `compiler/`    | 编译器选择、Keil 工程解析、CMSIS 兼容、启动与链接模板；`vendor/` 包含 XML 解析依赖及许可证 |
| `debugger/`    | 硬件调试能力与宿主调试器的集成说明                                                         |
| `layout/`      | `index.ts` 应用区大小和资源布局计算                                                        |
| `languages/`   | 本模块的语言规则与补全目录                                                                 |
| `tools/`       | `gnu.ts` GNU Arm 工具下载；`driver.ts` ST-Link 驱动声明                                    |

源码入口为 `device/adapter.ts` 和 `runtime/index.ts`。目录职责固定，声明以根目录 `manifest.json` 为准，避免维护多份默认配置。

SWD 调试与 UART 串口分开；ST-Link 不需要出现在 COM 列表。平台识别必须确认选定探针、芯片 ID 和物理容量，不能从一个 COM 号或默认容量推断 STM32 型号。

完整二进制烧录输入为项目 firmware.bin，固件需为实际芯片生成并链接到 0x08000000。先识别和构建/验证，再按用户确认执行写入与回读校验。目标 ID/容量变化、输入或产物过期会拒绝烧录。

当前固件映射只允许一个 offset=0、size≤flashSize 的 app 区；应用区按 1 KiB 对齐，可以小于物理 Flash，尾部作为保留区。STM32 擦除粒度随芯片变化，因此禁用 ESP 任意分区编辑，不支持用任意 4 字节偏移声明独立 bootloader/数据区并承诺保留相邻页。界面通过 `layout` 能力从 0x08000000 起调整应用区，`partitions` 能力保持关闭；`BoardDefinition.layout` 只提供 Flash 起始地址，地址段仍来自 ProjectConfig。layout.ts 的 appRegionSize 统一给 BuildResult 和区域检查使用；链接仍以物理 Flash 生成镜像，固件超出应用区或覆盖数据/系统保留区时输出 WARNING，界面和烧录确认弹窗提示，用户可二次确认后继续烧录；超过物理 Flash 或 RAM 越界仍拒绝。数据/系统区可设置名称和颜色，但没有写入路径。RAM 沿用 F1 中容量目标固定的 20 KiB 与 1 KiB 栈，暂不提供任意 RAM 分配。布局页可按 KiB 手动修正被克隆芯片误报的容量，保存时写入 `flashSizeOverride`，重新识别不会覆盖；手动容量不得大于探测值。

设置 `be.build.entry` 后可使用 Arm Compiler 5（armcc）、Arm Compiler 6（armclang）或 GNU Arm GCC。入口可为文件、目录或点号；输出位于 `.blode/build/`，目标为 STM32F103C8T6／Cortex-M3。没有源码入口时验证根目录的 `firmware.bin`。

AC5 工具放在 `tools/armcc/`、`tools/versions/armcc/<版本>/`，也可在编译设置中指定自定义目录。使用 `family: "armcc"` 选择，版本号包含 update/build，例如 `5.06-u5-b528`。本后端使用 C99／C++03，保留原工程的 ARMCC 内联汇编；配置为 C11、C17 或 C23 时会提示选择 C99。Debug／Release、原生启动汇编、scatter、依赖文件、ELF 及固件导出均沿用统一构建接口。详见 [AC5 接入说明](../../../docs/ARM-COMPILER-5.md)。

AC6 路径下，项目同时提供可识别的 Arm 汇编 startup 与单一 scatter 时优先采用；否则已知目标使用本目录模板并报告提示。GNU 路径始终使用生成的 F1 启动文件与链接脚本，工程内的 ARM 语法启动、scatter 与 .ld 不会被采用，并给出提示。未知芯片拒绝猜 CPU、RAM 与链接布局。实际 ELF 装载范围、RAM 段与二进制初始向量分别校验。

AC6 内置启动通过标准 __main 完成 scatter 装载、RW/ZI 和 C/C++ 运行库初始化；GNU 内置启动在 Reset_Handler 中复制 .data、清零 .bss、调用 SystemInit 与 __libc_init_array。两条路径默认都在 0x20004c00..0x20005000 保留 1 KiB 栈，静态数据不得侵入。回退模板不保证自定义 section 或绝对地址完全一致，需检查 warning 与 firmware.map；未知编译配置只能使用外部生成的完整二进制路径。

本机 AC6 6.22 对用户工程副本实际编译得到 Flash 2136 字节、RAM 1028 字节（4 字节静态数据 + 1024 字节链接器保留栈）。显示 RAM 包含保留栈，不是运行时峰值；该结果只证明此输入可构建，不等于已在硬件运行。

开发 ST-Link 工具默认位于 tools/stlink，Windows 驱动归档位于 tools/STSW-LINK。驱动安装由通用安装执行器处理，工具与固件流程由本平台处理，二者分别检测。

ST-Link 也可通过离线 ZIP 导入到 `tools/versions/stlink/<版本>/`，识别芯片和调试器会自动查找这些目录。自定义路径接受包根目录或 `bin/`，指定后按该路径工作。Windows x64 可在首选项下载或安装官方 ST-Link 工具，导出后的 ZIP 可通过“导入离线包”安装到其他电脑。目录发现代码位于 `tools/stlink-discovery.ts`。

Arm Compiler 6.22 完整工具已从本机 E 盘迁入 tools/armclang，保留原 license_terms。armCompilerDirectory 可覆盖完整工具目录或 bin；未指定时使用平台工具根目录的 armclang。本机版本是 Keil MDK Community 非商业使用环境，工具不进入 Git；完整安装包会把本机该目录一并打包，使用与再分发遵循 Keil MDK 条款，简洁安装包则不含编译器。

未检测到 Arm Compiler 6 时，「安装 / 更新工具链」会下载 GNU Arm GCC v15.2.1-1.1（Windows x64，xPack 重打包的 ARM GNU 工具链）到工具根目录的 armgcc/，安装前校验 GitHub 发行元数据摘要与归档大小。GNU 工具链按自身许可分发；其他平台需手动安装并由 armCompilerDirectory 指定。首选项同时展示 AC6 与 GNU Arm 的状态和版本，实际使用的编译器会写入构建输出。

内置 TypeScript runtime 随宿主编译，声明与实现必须匹配宿主 SDK；修改内置平台时仍需维护静态 registry 和驱动描述。第三方可复制分享的 API v2 包使用自己的 JavaScript 入口和声明，由宿主发现并在用户确认后加载，见[运行时插件指南](../../../docs/RUNTIME-PLUGINS.md)。平台目录的隔离复制 bundle 检查只验证模块边界；历史实机数据见[硬件记录](../../../docs/HARDWARE-VALIDATION.md)。

连接步骤见 [STM32 使用说明](../../../docs/STM32.md)，工具根目录与缓存见 [工具链说明](../../../docs/TOOLCHAINS.md)。

## 语言与独立分发

本模块自行声明 C/C++ 语言，C99/C11/C17/C23 分别存放在 `languages/C/` 下；`.c` 和 `.h` 属于 C，C++ 后缀使用独立目录，不加载 Arduino 条目。格式与工程覆盖规则见[模块语言适配](../../../docs/MODULE-LANGUAGES.md)。

在仓库根目录执行 `npm run package:runtime -- extensions/boards/STM32F103C8T6 --output ./release/modules --zip`，生成 `STM32F103C8T6_Module`。包中包含 JavaScript、语言和模板资源，使用 `runtime` 编译模式；安装到兼容宿主数据目录 `plugins/STM32F103C8T6_Module/` 后重启。使用者不需要源码仓库或 TypeScript。工具再分发仍遵循各自许可。

调试复用宿主 Cortex-M3/ST-Link 后端，操作与指令修改范围见[硬件调试指南](../../../docs/HARDWARE-DEBUGGING.md)。新模块字段需要包含本次内部更新的宿主；安装、升级和兼容规则见[模块开发指南](../../../docs/RUNTIME-PLUGINS.md)。
