# 硬件调试

Blode Studio 使用 GDB 连接真实芯片，提供反汇编、寄存器、调用栈、内存、固件存储和断点工作区。桌面版打开独立窗口；Web 版打开目标宿主的调试页面，硬件与调试工具连接在宿主电脑上。

本文对应 `main` 的内部开发预览。ESP32-S3 UART 调试已通过 Windows 参考固件实机验证；USB-JTAG、相机工程迁移与 Linux 仍待验收。本次未生成新的发行包。

## 支持范围

| 运行时          | 连接                   | 调试工具                                     | 功能                                                                           |
| --------------- | ---------------------- | -------------------------------------------- | ------------------------------------------------------------------------------ |
| `STM32F103C8T6` | ST-Link / SWD          | `arm-none-eabi-gdb`、`st-util`               | 执行控制、反汇编、寄存器、内存、调用栈、批量断点；SRAM 中的等长 Thumb 指令修改 |
| `Esp32_S3_CAM`  | ESP32-S3 原生 USB-JTAG | `xtensa-esp-elf-gdb`、Espressif OpenOCD      | 执行控制、Xtensa 寄存器、反汇编、内存、调用栈、批量硬件断点                    |
| `Esp32_S3_CAM`  | 烧录底座 UART GDB      | `xtensa-esp-elf-gdb`、带 runtime stub 的固件 | 执行控制、寄存器、反汇编、内存、调用栈和断点；使用独占串口                     |
| 第三方运行时    | 模块声明               | 模块提供或复用宿主                           | 由 `debugger.mode` 和提供的方法决定                                            |

ESP32-S3 当前不提供汇编预览或指令写入。其他 ESP32 系列、外部 JTAG 适配器、自定义 OpenOCD board 配置及多核独立控制尚未作为内置功能开放。

## 开始调试

1. 在主工作区选定运行时，打开 **视图 → 硬件仿真**。
2. 通过 **连接 → 连接设置** 选择 ST-Link 探针，或选择 ESP32-S3 的原生 USB-JTAG／烧录底座调试。USB-JTAG 可填写序列号与频率；底座调试选择串口和波特率。
3. 在 **工具** 菜单安装工具，或指定现有 GDB、调试服务和脚本目录。
4. 连接目标。
5. 载入与芯片现有固件一致的 ELF，以使用函数名、源码行、调用栈和符号断点。无 ELF 时仍可读取地址、寄存器和反汇编。
6. 暂停后读取状态；使用继续、暂停、单步和跳出控制程序。

连接设置可单独保存，连接前也会自动保存。桌面与 Web 使用同一设置接口，仅更新当前工程的调试参数；工程或平台切换后，旧窗口的保存请求会被拒绝。

调试 ELF 与已烧录固件保持一致；重新编译并烧录后加载对应 ELF。

连接失败时，界面和调试日志会保留 OpenOCD / GDB 的实际输出，包括 USB 驱动、设备占用或工具启动错误。修复这些问题后可直接重试；留空 USB 序列号仍使用自动选择。当前连接回归与验证范围见[本次内部更新](internal/components-and-esp32-recovery.md)。

## ESP32-S3 接线与工具

原生 USB-JTAG 使用板上的原生 USB 接口：USB D− 为 GPIO19、D+ 为 GPIO20。若板卡仅引出 USB-UART 接口，可使用下方的烧录底座调试；如需 JTAG，则连接另一个原生 USB 接口，或按板卡原理图与 [Espressif 接线说明](https://docs.espressif.com/projects/esp-idf/en/stable/esp32s3/api-guides/jtag-debugging/configure-builtin-jtag.html)连接原生 USB 引脚。供电与引脚复用以板卡文档为准。

### 串口已连接，但调试器找不到设备

串口烧录与 USB-JTAG 使用不同接口。CH340、CP210x 等 USB-UART 桥可以用于烧录和串口通信，不能作为内置 USB-JTAG 调试器。

| 宿主识别到的接口                                   | 可用于当前功能                                             |
| -------------------------------------------------- | ---------------------------------------------------------- |
| CH340 串口，例如 `COM3`、`VID_1A86&PID_7523`       | 串口烧录、串口监视；固件启用 runtime stub 后可使用底座调试 |
| ESP32-S3 原生 USB Serial/JTAG，`VID_303A&PID_1001` | 原生 USB-JTAG 调试；Windows 中还需 JTAG 接口对应的驱动     |

遇到 `esp_usb_jtag: could not find or open device!` 时，先检查原生 USB 连接是否出现在宿主设备列表，再检查对应接口的驱动、序列号和占用情况。

Windows 在点击连接时检查一次 USB 设备，分别提示未找到原生接口、设备状态异常、序列号不匹配或存在多个目标；状态刷新不触发枚举。系统枚举不可用或信息不足时，继续由 OpenOCD 判断连接结果。

### 工具与驱动

默认使用 `board/esp32s3-builtin.cfg`。Windows 需要适用的 Espressif USB 驱动；Linux 需要相应 USB 权限和 udev 配置。工具安装器不修改系统驱动或提升权限。

工具发现支持受管安装、Arduino 工具目录、ESP-IDF 工具目录、`IDF_TOOLS_PATH`、PATH 和自定义路径。自定义路径指向**宿主电脑**上的程序；OpenOCD scripts 指向包含 `board/esp32s3-builtin.cfg` 的目录。

调试工具窗口按平台和连接方式显示安装入口：ESP32-S3 原生 USB-JTAG 安装 Xtensa GDB 与 OpenOCD，烧录底座调试只安装 Xtensa GDB，STM32 安装 GNU Arm GDB。状态显示待检查、检查中、已找到或未找到；OpenOCD 程序和 scripts 分别检查。悬停“已找到”可查看实际路径。手动修改路径后重新检查，再连接目标；安装不会覆盖用户填写的路径。

独立模块通过 `compiler.baseRuntime` 复用相应工具界面，例如 ESP32-S3 模块仍显示 Xtensa/OpenOCD。安装输出只显示当前调试窗口发起的安装任务，避免混入其他工具的历史记录。

| 工具           | 固定下载版本            | 自动下载配置                        |
| -------------- | ----------------------- | ----------------------------------- |
| Xtensa ESP GDB | `16.2_20250324`         | Windows x64、Linux x64、Linux ARM64 |
| OpenOCD ESP32  | `0.12.0-esp32-20250707` | Windows x64、Linux x64、Linux ARM64 |

发行资产和 SHA-256 来自 Espressif 的 ESP-IDF `v5.5.1` 工具清单。下载后校验、解压、运行版本检查，通过后替换受管版本；失败保留原有工具。安装阶段和输出可在工具安装界面查看。

内置 OpenOCD 仅绑定本机回环地址，关闭额外 Tcl/Telnet 端口；禁用 Flash 编程能力并使用硬件断点。硬件断点数量有限，批量添加时逐项报告结果。

## 烧录底座调试

CH340 等 USB-UART 底座通过固件中的 runtime GDB stub 提供调试连接，不使用 OpenOCD。选择 **连接设置 → 烧录底座调试**，指定宿主串口、波特率并加载匹配的 ELF。当前参考配置使用 UART0：GPIO43 为 TX、GPIO44 为 RX，115200、8N1。

模块提供 [ESP-IDF v5.1.4 参考工程](../extensions/boards/Esp32_S3_CAM/debugger/firmware/uart-gdb/README.md)，包含配置、完整构建／烧录命令、ELF 和合并 BIN 导出方法。它是 4 MiB、无 PSRAM 的计数器示例。既有相机工程需按文档以 Arduino 3.0.7 作为 IDF 组件重新构建，保留原有 Flash、PSRAM、分区和摄像头配置；普通 Arduino 预编译库不能仅靠增加宏启用 runtime stub。

调试会话独占串口，UART0 的业务命令应迁到其他 UART 或网络。暂停会影响相机采集与实时任务。IDF 在启动时自动初始化 stub，应用不重复初始化或重新安装 UART0 RX 驱动。崩溃后的 panic stub 只用于事后查看，runtime stub 才提供运行中暂停与继续。

连接时 Blode 自动释放串口监视并接管端口；其他应用占用的串口需要先关闭。正常断开会清理断点，原本暂停的目标继续保持暂停；运行中的目标短暂停机清理后恢复运行，期间若命中断点或用户请求暂停则保持暂停。断开不复位或烧录芯片。

参考工程在构建目录生成 IDF 5.1.4 `esp_gdbstub` 组件副本，将 UART Ctrl+C 信号修正为 SIGINT，并保留 panic 的原异常映射；固定源码摘要校验通过后才应用此修改。配置关闭 `CONFIG_ESP_GDBSTUB_SUPPORT_TASKS`，寄存器与调用栈使用当前停止上下文，FreeRTOS 任务枚举与切换另行支持。

Windows + CH340 参考固件已通过实机联调。相机工程迁移与 Linux 构建／串口访问待验收，具体记录如下。

## 工作区操作

顶部菜单按 **连接、调试、视图、工具** 分类。内存区将地址、长度与 **读取内存** 放在同一区域，按 Enter 也可读取。常用地址按钮跟随目标架构：STM32 显示 SRAM/Flash，ESP32-S3 显示 DRAM/IRAM/DROM/IROM；也可使用 PC、SP。

寄存器按架构显示：Cortex-M3 使用 R0–R12、SP、LR、PC；ESP32-S3 使用 PC、A0–A15、PS、SAR，栈指针为 A1。内存单次最多读取 4096 字节，目标需暂停。

UART stub 当前支持上述核心寄存器；IDF 5.1.4 的旧版寄存器包与新版 GDB 的浮点／TIE 扩展布局不同，扩展寄存器未纳入本次支持范围。使用通用 Xtensa GDB 16.2 时，Blode 自动指定同一工具包的 `lib/xtensa_esp32s3.so` 架构配置。

批量断点每行填写一个函数、`文件:行号` 或 `*地址`，最多 128 项。结果分别显示成功、已有或失败，保留调试器的具体诊断。

STM32 指令编辑支持单条汇编预览和机器码输入，限定当前会话已反汇编的完整指令、SRAM 地址与相同指令长度。运行中修改需显式选择短暂停机；写前比较原字节，写后回读，再按停止原因决定是否恢复。完整行为见[指令编辑说明](internal/debugger-editing.md)。

## 插件与自动化

`debugger.state` 返回当前架构和会话 ID；状态、安装和连接使用所选运行时配置。桌面、Web、MCP 和 JSON-RPC 共用后端。写入接口需要 `confirm: true`，并检查会话是否仍有效。

第三方模块通过 `debugger.mode: builtin | extend | replace | none` 选择调试提供方式。`baseRuntime` 用于复用内置架构；完全替换模式由插件实现方法表，也可声明自定义视图。参见[模块开发指南](RUNTIME-PLUGINS.md)和[AI 接口](AI-PIPE.md)。

## 验证状态

Windows 已验证两份 ESP32 调试工具的真实下载、SHA-256、解压和版本执行；自动化覆盖目标架构、命令参数、ELF 匹配、工具发现与安装、会话控制和界面配置。以上不包含真实 ESP32-S3 JTAG 会话。

工具窗口另覆盖程序存在但脚本缺失、切换平台时的旧响应、安装中变更目标和 GDB 文件选择器返回时目标已变化等情况。检查只发现本地文件，不在状态刷新时反复启动 GDB 或 OpenOCD。

2026-10-30 工具窗口修复通过 62 项相关回归及类型检查，并在独立 Electron 窗口中验证 6 种界面场景：缺工具、检查中、仅缺 scripts、工具完整、模拟安装进度和切换 STM32。这组界面测试使用模拟接口，没有执行真实工具安装或硬件连接。

同日早期排查中，宿主仅枚举到 CH340 串口。OpenOCD 加载 USB-JTAG 接口并执行 `init; shutdown`，复现 `could not find or open device`；该记录对应原生 USB-JTAG 未接入的诊断场景。

UART 参考工程已在 Windows x64 使用 IDF v5.1.4、GCC `esp-12.2.0_20230208` 完成实际编译与 esptool 合并。最终验证版本 `uart-gdb-idf5.1.4-context`：应用 BIN 为 192,192 字节，合并 BIN 为 257,728 字节，匹配 ELF 为 2,894,648 字节；同时生成引导程序和分区表。构建使用工程内的 SIGINT 组件覆写，并关闭任务枚举。

2026-10-30 已备份 Flash 覆盖区域并烧录该计数器参考固件，通过 ESP32-S3 + CH340、115200 波特率和 Xtensa GDB 16.2 完成实机验证：

| 验证项             | 实际结果                                   |
| ------------------ | ------------------------------------------ |
| 连接、寄存器与内存 | 读取当前停止上下文、计数器及程序状态       |
| 断点与指令单步     | 断点 PC `0x42006ee7`，单步后 `0x42006eea`  |
| 继续与暂停         | 暂停上报 SIGINT，计数器由 9 增至 13        |
| 运行中断开与重连   | 等待后重连，计数器继续增至 24              |
| 暂停时断开与重连   | 计数器保持 24，目标仍暂停                  |
| 会话结束           | 串口释放成功；继续并正常断开后目标保持运行 |

上述记录使用参考计数器固件和匹配 ELF。摄像头业务、FreeRTOS 任务切换及双核独立控制另行验收。

真实 Xtensa GDB 16.2 与模拟 UART 端点已通过生产调试服务整链路验证，使用上述参考固件 ELF 和 IDF 5.1.4 的 408 字节寄存器包。覆盖 PC、A0–A15、PS、SAR 映射，内存读取，实际单步／继续／暂停协议，`Z0/z0` 断点及运行／暂停两种断开清理；断点被拒绝时没有回退写入目标内存。连接初始化关闭旧版 stub 不支持的线程事件报文。模拟端点验证不包含实机时序、板卡连接和固件运行。

隐藏 Electron 窗口验证了串口选择、固件模式、GDB 工具状态和连接界面；另验证专用设置接口的保存、连接前保存及工程切换保护，未放开主窗口的通用工程写接口。真实鼠标点击验证覆盖原生弹窗内的连接方式、COM 端口和固件模式，确认列表可见、点击命中选项，Escape 只关闭当前列表。

本轮最终类型检查与变更文件格式检查通过。全量测试 630 项中通过 629 项，1 项既有 Windows PowerShell PTY 提示符时序测试失败；该文件单独复测 7 项全部通过。UART 专项与上述实机验证通过，终端时序问题单独跟踪。

待验收：ESP32-S3 原生 USB-JTAG、现有相机工程迁移及 panic 崩溃现场；STM32 RAM 指令修改；桌面与 Web 同时操作；Linux x64/ARM64 工具执行与 USB／串口访问。已有历史烧录记录见[硬件验证记录](HARDWARE-VALIDATION.md)。

## 参考资料

- [Espressif ESP32-S3 JTAG 调试](https://docs.espressif.com/projects/esp-idf/en/stable/esp32s3/api-guides/jtag-debugging/index.html)
- [ESP32-S3 原生 USB-JTAG 配置](https://docs.espressif.com/projects/esp-idf/en/stable/esp32s3/api-guides/jtag-debugging/configure-builtin-jtag.html)
- [ESP-IDF v5.5.1 工具发行清单](https://github.com/espressif/esp-idf/blob/v5.5.1/tools/tools.json)
- [GDB/MI 数据操作](https://sourceware.org/gdb/current/onlinedocs/gdb.html/GDB_002fMI-Data-Manipulation.html)
