# 硬件调试

Blode Studio 使用 GDB 连接真实芯片，提供反汇编、寄存器、调用栈、内存、固件存储和断点工作区。桌面版打开独立窗口；Web 版打开目标宿主的调试页面，硬件与调试工具连接在宿主电脑上。

本文对应 `codex/runtime-plugins-internal` 内部开发分支。ESP32-S3 调试已实现，尚未完成实机验收；本次未生成新的发行包。

## 支持范围

| 运行时          | 连接                   | 调试工具                                | 功能                                                                           |
| --------------- | ---------------------- | --------------------------------------- | ------------------------------------------------------------------------------ |
| `STM32F103C8T6` | ST-Link / SWD          | `arm-none-eabi-gdb`、`st-util`          | 执行控制、反汇编、寄存器、内存、调用栈、批量断点；SRAM 中的等长 Thumb 指令修改 |
| `Esp32_S3_CAM`  | ESP32-S3 原生 USB-JTAG | `xtensa-esp-elf-gdb`、Espressif OpenOCD | 执行控制、Xtensa 寄存器、反汇编、内存、调用栈、批量硬件断点                    |
| 第三方运行时    | 模块声明               | 模块提供或复用宿主                      | 由 `debugger.mode` 和提供的方法决定                                            |

ESP32-S3 当前不提供汇编预览或指令写入。其他 ESP32 系列、外部 JTAG 适配器、自定义 OpenOCD board 配置及多核独立控制尚未作为内置功能开放。

## 开始调试

1. 在主工作区选定运行时，打开 **视图 → 硬件仿真**。
2. 通过 **连接 → 连接设置** 选择 ST-Link 探针，或填写 ESP32-S3 USB-JTAG 序列号与频率。只有一块目标时可留空 USB 序列号；连接多块板时指定目标。
3. 在 **工具** 菜单安装工具，或指定现有 GDB、调试服务和脚本目录。
4. 连接目标。连接流程不会自动烧录固件。
5. 载入与芯片现有固件一致的 ELF，以使用函数名、源码行、调用栈和符号断点。无 ELF 时仍可读取地址、寄存器和反汇编。
6. 暂停后读取状态；使用继续、暂停、单步和跳出控制程序。

编译工程不要求连接硬件。调试时使用的 ELF 应与已烧录固件一致；修改工程并重新编译后，需要自行决定是否重新烧录。

## ESP32-S3 接线与工具

使用板上的原生 USB 接口：USB D− 为 GPIO19、D+ 为 GPIO20。板载 USB-UART 桥只提供串口，不等同于 USB-JTAG。板级接线和引脚复用以板卡文档为准。

默认使用 `board/esp32s3-builtin.cfg`。Windows 需要适用的 Espressif USB 驱动；Linux 需要相应 USB 权限和 udev 配置。工具安装器不修改系统驱动或提升权限。

工具发现支持受管安装、Arduino 工具目录、ESP-IDF 工具目录、`IDF_TOOLS_PATH`、PATH 和自定义路径。自定义路径指向**宿主电脑**上的程序；OpenOCD scripts 指向包含 `board/esp32s3-builtin.cfg` 的目录。

调试工具窗口按目标显示安装入口：ESP32-S3 为 **安装 Xtensa GDB 与 OpenOCD**，STM32 为 **安装 GNU Arm GDB**。状态显示待检查、检查中、已找到或未找到；ESP32 的 OpenOCD 程序和 scripts 分别检查。悬停“已找到”可查看实际路径。手动修改路径后重新检查，再连接目标；安装不会覆盖用户填写的路径。

独立模块通过 `compiler.baseRuntime` 复用相应工具界面，例如 ESP32-S3 模块仍显示 Xtensa/OpenOCD。安装输出只显示当前调试窗口发起的安装任务，避免混入其他工具的历史记录。

| 工具           | 固定下载版本            | 自动下载配置                        |
| -------------- | ----------------------- | ----------------------------------- |
| Xtensa ESP GDB | `16.2_20250324`         | Windows x64、Linux x64、Linux ARM64 |
| OpenOCD ESP32  | `0.12.0-esp32-20250707` | Windows x64、Linux x64、Linux ARM64 |

发行资产和 SHA-256 来自 Espressif 的 ESP-IDF `v5.5.1` 工具清单。下载后校验、解压、运行版本检查，通过后替换受管版本；失败保留原有工具。安装阶段和输出可在工具安装界面查看。

内置 OpenOCD 仅绑定本机回环地址，关闭额外 Tcl/Telnet 端口；禁用 Flash 编程能力并使用硬件断点。硬件断点数量有限，批量添加时逐项报告结果。

## 工作区操作

顶部菜单按 **连接、调试、视图、工具** 分类。内存区将地址、长度与 **读取内存** 放在同一区域，按 Enter 也可读取。常用地址按钮跟随目标架构：STM32 显示 SRAM/Flash，ESP32-S3 显示 DRAM/IRAM/DROM/IROM；也可使用 PC、SP。

寄存器按架构显示：Cortex-M3 使用 R0–R12、SP、LR、PC；ESP32-S3 使用 PC、A0–A15、PS、SAR，栈指针为 A1。内存单次最多读取 4096 字节，目标需暂停。

批量断点每行填写一个函数、`文件:行号` 或 `*地址`，最多 128 项。结果分别显示成功、已有或失败，保留调试器的具体诊断。

STM32 指令编辑支持单条汇编预览和机器码输入，限定当前会话已反汇编的完整指令、SRAM 地址与相同指令长度。运行中修改需显式选择短暂停机；写前比较原字节，写后回读，再按停止原因决定是否恢复。完整行为见[指令编辑说明](internal/debugger-editing.md)。

## 插件与自动化

`debugger.state` 返回当前架构和会话 ID；状态、安装和连接使用所选运行时配置。桌面、Web、MCP 和 JSON-RPC 共用后端。写入接口需要 `confirm: true`，并检查会话是否仍有效。

第三方模块通过 `debugger.mode: builtin | extend | replace | none` 选择调试提供方式。`baseRuntime` 用于复用内置架构；完全替换模式由插件实现方法表，也可声明自定义视图。参见[模块开发指南](RUNTIME-PLUGINS.md)和[AI 接口](AI-PIPE.md)。

## 验证状态

Windows 已验证两份 ESP32 调试工具的真实下载、SHA-256、解压和版本执行；自动化覆盖目标架构、命令参数、ELF 匹配、工具发现与安装、会话控制和界面配置。以上不包含真实 ESP32-S3 JTAG 会话。

工具窗口另覆盖程序存在但脚本缺失、切换平台时的旧响应、安装中变更目标和 GDB 文件选择器返回时目标已变化等情况。检查只发现本地文件，不在状态刷新时反复启动 GDB 或 OpenOCD。

2026-10-30 工具窗口修复通过 62 项相关回归及类型检查，并在独立 Electron 窗口中验证 6 种界面场景：缺工具、检查中、仅缺 scripts、工具完整、模拟安装进度和切换 STM32。这组界面测试使用模拟接口，没有执行真实工具安装或硬件连接。

待验收：ESP32-S3 实机连接、暂停、断点、内存读取和断开重连；STM32 RAM 指令修改；桌面与 Web 同时操作；Linux x64/ARM64 工具执行与 USB 访问。已有历史烧录记录见[硬件验证记录](HARDWARE-VALIDATION.md)。

## 参考资料

- [Espressif ESP32-S3 JTAG 调试](https://docs.espressif.com/projects/esp-idf/en/stable/esp32s3/api-guides/jtag-debugging/index.html)
- [ESP32-S3 原生 USB-JTAG 配置](https://docs.espressif.com/projects/esp-idf/en/stable/esp32s3/api-guides/jtag-debugging/configure-builtin-jtag.html)
- [ESP-IDF v5.5.1 工具发行清单](https://github.com/espressif/esp-idf/blob/v5.5.1/tools/tools.json)
- [GDB/MI 数据操作](https://sourceware.org/gdb/current/onlinedocs/gdb.html/GDB_002fMI-Data-Manipulation.html)
