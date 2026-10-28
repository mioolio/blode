# STM32 平台包

此目录拥有 STM32 / ST-Link 的配置、运行时、协议、工具和驱动事实。它使用 ../../runtime.ts 的 RuntimeHost，不导入 core 或 ESP32-S3 平台实现。

| 文件                       | 责任                                                                 |
| -------------------------- | -------------------------------------------------------------------- |
| adapter.ts、manifest.json  | STM32 配置、平台能力和边界校验                                       |
| layout.ts                  | 从 ProjectConfig 读取应用区大小，供链接、ELF 与二进制边界共用        |
| runtime.ts                 | 探针扫描、目标识别、构建/固件验证与烧录分派                          |
| compiler.ts、templates.ts  | Arm Compiler 6 源码编译、ELF/向量验证、明确目标的启动与 scatter 模板 |
| programmer.ts、protocol.ts | st-info/st-flash 工具、输出解析、参数和物理范围校验                  |
| driver.ts                  | 官方驱动归档、INF、USB ID 和驱动库事实                               |

SWD 调试与 UART 串口分开；ST-Link 不需要出现在 COM 列表。平台识别必须确认选定探针、芯片 ID 和物理容量，不能从一个 COM 号或默认容量推断 STM32 型号。

完整二进制烧录输入为项目 firmware.bin，固件需为实际芯片生成并链接到 0x08000000。先识别和构建/验证，再按用户确认执行写入与回读校验。目标 ID/容量变化、输入或产物过期会拒绝烧录。

当前固件映射只允许一个 offset=0、size≤flashSize 的 app 区；应用区按 1 KiB 对齐，可以小于物理 Flash，尾部作为保留区。STM32 擦除粒度随芯片变化，因此禁用 ESP 任意分区编辑，不支持用任意 4 字节偏移声明独立 bootloader/数据区并承诺保留相邻页。界面通过 `layout` 能力从 0x08000000 起调整应用区，`partitions` 能力保持关闭；`BoardDefinition.layout` 只提供 Flash 起始地址，地址段仍来自 ProjectConfig。layout.ts 的 appRegionSize 统一给 BuildResult 和区域检查使用；链接仍以物理 Flash 生成镜像，固件超出应用区或覆盖数据/系统保留区时输出 WARNING，界面和烧录确认弹窗提示，用户可二次确认后继续烧录；超过物理 Flash 或 RAM 越界仍拒绝。数据/系统区可设置名称和颜色，但没有写入路径。RAM 沿用 F1 中容量目标固定的 20 KiB 与 1 KiB 栈，暂不提供任意 RAM 分配。布局页可按 KiB 手动修正被克隆芯片误报的容量，保存时写入 `flashSizeOverride`，重新识别不会覆盖；手动容量不得大于探测值。

设置 be.build.entry 后调用 armclang/armlink/fromelf，入口可为文件、目录或点号；没有入口时保留根 firmware.bin 验证。当前源码配置只支持已识别的 0x410 STM32F1 中容量 Cortex-M3 目标，输出位于 .blode/build/。源码构建需要正确的架构、启动、链接和依赖，单个 main.c 不保证生成可烧录程序。

项目同时提供可识别的 Arm 汇编 startup 与单一 scatter 时优先采用；否则已知目标可使用本目录模板并报告提示。GNU .ld 不能直接交给 armlink，不假称自动转换。未知芯片拒绝猜 CPU、RAM 与链接布局。实际 ELF 装载范围、RAM 段与二进制初始向量分别校验。

内置启动通过 AC6 标准 __main 完成 scatter 装载、RW/ZI 和 C/C++ 运行库初始化，全局构造调用链有实际 ELF 反汇编检查。默认 scatter 在 0x20004c00..0x20005000 保留 1 KiB 栈，静态数据不得侵入。回退模板不保证 GNU 自定义 section 或绝对地址完全一致，需检查 warning 与 firmware.map；未知编译配置只能使用外部生成的完整二进制路径。

本机 AC6 6.22 对用户工程副本实际编译得到 Flash 2136 字节、RAM 1028 字节（4 字节静态数据 + 1024 字节链接器保留栈）。显示 RAM 包含保留栈，不是运行时峰值；该结果只证明此输入可构建，不等于已在硬件运行。

开发 ST-Link 工具默认位于 tools/stlink，Windows 驱动归档位于 tools/STSW-LINK。驱动安装由通用安装执行器处理，工具与固件流程由本平台处理，二者分别检测。

Arm Compiler 6.22 完整工具已从本机 E 盘迁入 tools/armclang，保留原 license_terms。armCompilerDirectory 可覆盖完整工具目录或 bin；未指定时使用平台工具根目录的 armclang。本机版本是 Keil MDK Community 非商业使用环境，工具不进入 Git，平台源码包不包含编译器，也不提供工具许可转授。

manifest 声明 runtimeApiVersion:1。复制整个目录后，需匹配宿主 SDK、在两个 registry 注册，并在 drivers/index.ts 接入 driver.ts 描述及语言资源。目录已通过隔离复制 bundle 检查，这不替代硬件烧录验证。

连接步骤见 [STM32 使用说明](../../../docs/STM32.md)，工具根目录与缓存见 [工具链说明](../../../docs/TOOLCHAINS.md)。
