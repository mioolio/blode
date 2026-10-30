# ESP32-S3 烧录底座调试固件

通过接在 UART0 上的 CH340、CP210x 等烧录底座运行串口 GDB。固件内的 ESP-IDF runtime GDB stub 接收调试协议，宿主使用 Xtensa GDB；这条连接不使用 OpenOCD 或 JTAG。

这是独立计数器参考工程：ESP32-S3、4 MiB Flash、DIO 40 MHz、无 PSRAM、单应用分区。它不包含相机应用。迁移现有 16 MiB／PSRAM 相机工程时，保留原工程的 Flash、PSRAM、摄像头引脚和分区配置，仅合入调试设置与 UART 使用调整。

## 固定基线

| 依赖                | 版本                                                               |
| ------------------- | ------------------------------------------------------------------ |
| ESP-IDF             | `v5.1.4`，提交 `d7b0a45ddbddbac53afb4fc28168f9f9259dbb79`          |
| Xtensa ESP32-S3 GCC | `esp-12.2.0_20230208`，GCC 12.2.0                                  |
| Xtensa GDB          | IDF 推荐 `12.1_20231023`；Blode 的受管 Xtensa GDB 也可用于连接验证 |
| CMake / Ninja       | IDF 推荐 `3.24.0` / `1.10.2`                                       |
| Arduino（可选迁移） | `3.0.7`，声明兼容 IDF `>=5.1,<5.2`                                 |

工具版本与平台下载地址以固定标签的 [tools.json](https://github.com/espressif/esp-idf/blob/v5.1.4/tools/tools.json) 为准。使用 IDF 的 Python 环境和 `v5.1` 约束文件，不把依赖装入系统 Python。

### IDF 5.1.4 UART 中断兼容

该版本的 runtime stub 从 UART 中断现场读取异常原因，正常 Ctrl+C 可能被报告为 SIGSEGV。参考工程在构建目录生成 `esp_gdbstub` 组件副本，仅将 UART handler 的信号改为 SIGINT（2）；崩溃入口仍按原异常原因上报。

`cmake/runtime-stub.cmake` 校验固定版本源文件的 SHA-256 和替换片段，再通过 `EXTRA_COMPONENT_DIRS` 使用生成组件。SDK 原文件不变，源码不匹配时停止配置。迁移工程时一并复制此 CMake 文件及入口配置；GDB 保持原有异常处理。

参考配置关闭 `CONFIG_ESP_GDBSTUB_SUPPORT_TASKS`，寄存器与调用栈对应当前停止上下文。IDF 5.1.4 的任务枚举可能返回列表外的当前线程 ID，影响断点后的重新连接；FreeRTOS 多任务枚举与切换另行支持。已有 `sdkconfig` 的工程需在 **GDB Stub → Enable listing FreeRTOS tasks through GDB Stub** 中关闭此项。

## 构建

先安装 ESP-IDF v5.1.4。源码安装示例（Windows PowerShell）：

```powershell
git clone --branch v5.1.4 --recursive https://github.com/espressif/esp-idf.git esp-idf-5.1.4
cd esp-idf-5.1.4
.\install.ps1 esp32s3
.\export.ps1
```

在这个已导出 IDF 环境的终端中，将本目录复制到自己的工作目录，进入副本后执行：

```powershell
idf.py set-target esp32s3
idf.py build
```

首次构建读取 `sdkconfig.defaults`。已有 `sdkconfig` 时，使用 `idf.py menuconfig` 核对 **ESP System Settings → Panic handler behaviour → GDBStub at runtime** 和 UART 设置，再重新构建。CMake 和源码均检查 IDF 版本、目标与 runtime stub，避免用普通 Arduino 预编译库生成表面上启用调试的固件。

主要产物：

| 文件                                          | 用途                                       |
| --------------------------------------------- | ------------------------------------------ |
| `build/blode_uart_gdb.elf`                    | 符号、源码行、反汇编；调试窗口加载这份 ELF |
| `build/blode_uart_gdb.bin`                    | 应用镜像，参考分区地址 `0x10000`           |
| `build/bootloader/bootloader.bin`             | 引导程序，地址 `0x0`                       |
| `build/partition_table/partition-table.bin`   | 分区表，地址 `0x8000`                      |
| `build/flash_args`、`build/flasher_args.json` | 本次构建的实际烧录参数                     |

需要自行烧录参考固件时，在副本目录运行 `idf.py -p COM3 flash`，将 `COM3` 改为宿主实际端口。此命令写入参考工程的引导程序、分区表和应用。现有相机工程应使用自己重新构建的产物及烧录参数。

如需单个二进制文件，在 `build` 目录使用 IDF 的 esptool 合并：

```powershell
python -m esptool --chip esp32s3 merge_bin -o blode_uart_gdb-merged.bin '@flash_args'
```

合并文件从地址 `0x0` 烧录；仍需保留同次构建的 ELF。

## 连接

- UART0 TX 为 **GPIO43**，RX 为 **GPIO44**，**115200、8N1**。底座通常已完成交叉连接；分线连接时 USB-UART TX 接 GPIO44、RX 接 GPIO43，并共地，使用板卡对应的 3.3 V 逻辑电平。
- 正常启动后进入 **硬件仿真 → 连接设置 → 烧录底座调试**，选择底座 COM 端口和 115200 波特率，载入 ELF 后连接。
- 串口由调试会话独占。Blode 自动释放自身串口监视；连接前关闭其他终端与烧录工具，调试结束后再恢复这些操作。
- 可在 `blode_debug_tick` 设置断点，观察 `blode_debug_counter` 和 `blode_debug_values`，测试继续、暂停、单步和内存读取。

runtime stub 通过字节 `0x03` 进入调试，Blode 连接流程负责发送该请求。仅在崩溃时启用的 panic stub 属于事后查看，不能替代 runtime stub 的继续／单步功能。

当前界面读取 PC、A0–A15、PS、SAR 等核心寄存器；旧版 stub 与新版 GDB 的浮点／TIE 扩展寄存器布局不同，扩展寄存器不在本次支持范围内。使用受管 GDB 16.2 时，Blode 自动加载同一工具包中的 `lib/xtensa_esp32s3.so` 架构配置。

## 初始化与 UART 约束

`CONFIG_ESP_SYSTEM_GDBSTUB_RUNTIME=y` 使 IDF 的 [`freertos/app_startup.c`](https://github.com/espressif/esp-idf/blob/v5.1.4/components/freertos/app_startup.c) 在 `app_main` 前调用官方 `esp_gdbstub_init()`。应用不再次调用它，也不重新安装 UART0 RX 驱动。

UART0 输入被 stub 消费，因此原有相机的串口命令、二进制传输和调试协议不能同时使用这一端口。将业务控制迁到 UART1／UART2 或网络；避免 `Serial.begin()`、`uart_driver_install(UART_NUM_0, ...)` 抢占 stub 的中断。保留 IDF 的 `printf`／日志输出即可。暂停与单步会影响相机采集、网络和实时任务。

参考配置按 IDF 官方 gdbstub 示例关闭中断与任务看门狗，使用调试优化。生产配置应恢复工程的看门狗策略，并关闭 runtime stub。

## 迁移 Arduino 3.0.7 工程

Arduino Boards Manager 的预编译 IDF 库没有开启本模板的 runtime stub。需要将 Arduino 作为 IDF 组件重新构建底层 SDK；仅增加 `-DCONFIG_ESP_SYSTEM_GDBSTUB_RUNTIME=1` 不会产生所缺的库代码。

1. 在现有工程副本建立 IDF CMake 工程，使用 **IDF v5.1.4 + Arduino 3.0.7**。从本模板合入 GDB stub、UART0、调试优化与看门狗设置；保留自己的 Flash、PSRAM、分区表和摄像头配置。
2. 在工程目录运行 `idf.py add-dependency "espressif/arduino-esp32==3.0.7"`，保存生成的 `main/idf_component.yml` 和 `dependencies.lock`，固定间接依赖。若使用手动源码组件，按官方说明将 **3.0.7 标签**克隆为 `components/arduino` 并初始化其子模块。
3. 将 `.ino` 改为包含 `Arduino.h` 的 `.cpp`，在 `main/CMakeLists.txt` 登记全部源文件和包含目录。组件管理器会建立 Arduino 依赖；手动 `components/arduino` 方式则添加 `REQUIRES arduino`。
4. `menuconfig` 中关闭 **Autostart Arduino setup and loop on boot**，保持 `CONFIG_FREERTOS_HZ=1000`，在 `extern "C" void app_main()` 中调用一次 `initArduino()` 后执行自己的初始化和循环。IDF 已初始化 GDB stub，无需再次调用。
5. 移走 UART0 业务收发及 `Serial.begin()`，再通过 `idf.py build` 完整重建。第三方 Arduino 库须作为组件登记源文件与依赖；Blode 的 Arduino CLI 入口不会自动把工程转换为 IDF 工程。

Arduino 组件迁移的基线与使用方式见 [3.0.7 官方说明](https://github.com/espressif/arduino-esp32/blob/3.0.7/docs/en/esp-idf_component.rst)和[依赖声明](https://github.com/espressif/arduino-esp32/blob/3.0.7/idf_component.yml)。现有相机应用迁移及 Linux 构建／串口访问待验收。

## 验证范围

2026-10-30 已在 Windows x64 使用固定的 IDF v5.1.4 与 GCC 12.2.0 完成实际编译。当前停止上下文修订生成应用 BIN（192,192 字节）、ELF、引导程序、分区表和合并 BIN（257,728 字节）。验证环境使用 Python 3.9.13、CMake 3.24.3、Ninja 1.11.1 和 esptool 4.12.0。ELF 符号及启动反汇编确认包含 `esp_gdbstub_init()` 和 UART 中断处理，且启动函数调用 stub 初始化。构建记录确认使用工程内生成组件并关闭任务枚举；校验覆盖 SDK 原文件保持不变、保留 panic 信号映射及源文件不匹配时拒绝配置。

同日已通过 Windows + CH340 的参考固件实机验证：断点 PC 从 `0x42006ee7` 单步至 `0x42006eea`；暂停正确报告 SIGINT；继续运行后计数器由 9 增至 13，运行中断开再连接后为 24，暂停断开再连接仍为 24。会话结束释放串口，继续并正常断开后目标保持运行。完整记录见[硬件调试验证](../../../../../../docs/HARDWARE-DEBUGGING.md#验证状态)。

模板配置依据 ESP-IDF v5.1.4 的 [系统 Kconfig](https://github.com/espressif/esp-idf/blob/v5.1.4/components/esp_system/Kconfig)、[官方 runtime stub 示例](https://github.com/espressif/esp-idf/tree/v5.1.4/examples/system/gdbstub)及启动源码。当前验证使用计数器固件和停止上下文；原生 USB-JTAG、相机迁移、panic 崩溃现场、任务枚举与 Linux 另行验收。
