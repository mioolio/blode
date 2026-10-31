# 本机硬件验证记录

核对日期：2026-11-01。各节按操作与日期保留实际结果，当前实现状态见[状态总览](STATUS.md)。

## 2026-11-01：STM32 工具迁移与识别

环境：Windows x64、ST-Link 1.9.0。通过真实工具链服务完成以下步骤：

1. 工具目录检查同时执行 `st-info --version` 与 `st-flash --version`，退出码为 0，版本均为 1.9.0。
2. 导出当前 ST-Link 安装为 ZIP，实际归档 8,471,745 字节，保留程序、DLL 与芯片定义。
3. 将 ZIP 导入隔离的 `versions/stlink/1.9.0/`，不填写自定义 ST-Link 目录。
4. 从导入目录运行 hot-plug 探测，识别 1 个探针、`STM32F1xx_MD`、芯片 ID `0x410`；工具报告 Flash 为 131,072 字节。
5. GDB 工作区发现隔离版本内的 `bin/st-util.exe`。

本轮只检查工具、迁移和芯片身份，没有写入固件或启动 GDB 会话。芯片容量为该次探测返回值；模块默认配置仍是 64 KiB Flash／20 KiB SRAM。55 项相关测试、类型检查及独立模块构建通过，命令见[验证状态](STATUS.md)。

## 2026-10-30：ESP32-S3 烧录底座调试

Windows x64、CH340、115200 波特率、Xtensa GDB 16.2、IDF 5.1.4 计数器参考固件及匹配 ELF：已记录寄存器／内存读取、断点、指令单步、继续／暂停，以及运行和暂停两种状态下的断开重连。完整固件尺寸、地址和计数器结果见[调试验证](HARDWARE-DEBUGGING.md#验证状态)。

此结果对应参考计数器固件；相机工程迁移、原生 USB-JTAG、STM32 SRAM 指令修改及 Linux/macOS 的验收继续进行。

## 2026-10-29：STM32 容量与烧录案例

已保存标称 STM32F103C8T6、工具报告 128 KiB、写入 75,888 字节并回读高地址内容的单台设备记录，见[真实硬件案例](../SHOWCASE.md#2-真实案例64-kib-标称128-kib-实测)。该节保留当时工程与命令，不作为其他芯片的容量结论。

## 2026-10-28：ESP32-S3 历史记录

> 以下保留 2026-10-28 的实机过程。例程、目录、端口和脚本参数为当时状态。根例程目录已移除；当前硬件脚本显式指定仓库外已有工程，见[开发说明](DEVELOPMENT.md)。

日期：2026-10-28（Asia/Shanghai）。本次验证针对用户连接的开发板，结果不是模拟数据。

Windows PnP 报告：`USB-SERIAL CH340 (COM3)`，VID `1A86` / PID `7523`，状态 `OK`。`Win32_SerialPort` 只列出 COM1，因此串口枚举使用 SerialPort/SetupAPI，不能只依赖该 WMI 类。

本项目专用 Python 虚拟环境中安装了 PyPI 稳定版 `esptool 5.6.0`，未更改系统 Python 的包：

```powershell
python -m venv .tools/esptool-venv
.\.tools\esptool-venv\Scripts\python.exe -m pip install esptool
.\.tools\esptool-venv\Scripts\python.exe -m esptool --chip auto --port COM3 --baud 115200 flash-id
```

退出码 `0`，关键输出：

```text
esptool v5.6.0
Serial port COM3:
Connecting....
Detecting chip type... ESP32-S3
Connected to ESP32-S3 on COM3:
Chip type:          ESP32-S3 (QFN56) (revision v0.2)
Features:           Wi-Fi, BT 5 (LE), Dual Core + LP Core, 240MHz, Embedded PSRAM 8MB (AP_3v3)
Crystal frequency:  40MHz

Uploading stub flasher...
Running stub flasher...
Stub flasher running.

Flash Memory Information:
=========================
Manufacturer: 68
Device: 4018
Detected flash size: 16MB
Flash type set in eFuse: quad (4 data lines)
Flash voltage set by eFuse: 3.3V

Hard resetting via RTS pin...
```

这条命令读取芯片/Flash 信息，临时向 RAM 加载官方探测 stub 并重置设备；未执行 Flash 写入或擦除。检测证明型号识别、COM3 访问与 ROM bootloader 握手成功，**不代表完成编译、固件烧录或运行验证**。如后续完成烧录，应另行补充固件来源、地址、命令退出码与运行日志。

建议实际项目选择 `esp32-s3`、`COM3`、`16 MiB`。PSRAM 参数需与模块总线匹配；当前默认关闭。后续串口编号变化时须重新刷新选择。

官方参考：[esptool flash-id 与 write-flash](https://docs.espressif.com/projects/esptool/en/latest/esp32s3/esptool/basic-commands.html)。

## 编译、烧录与运行验证（已完成）

2026-10-28 18:55（Asia/Shanghai），通过项目自身 `CoreService` 完成真实构建和烧录；没有生成或打包桌面安装程序。

- 工具链：Arduino CLI `1.5.1`、Espressif Arduino Core `3.3.12`、esptool `5.6.0`。CLI 归档强制验证官方 SHA-256，开发板依赖由 Arduino CLI 按索引校验。
- 当时的历史固件来自现已移除的 `examples/blink`，当时复制到 `.tools/hardware-workspace/Blink`；UART 心跳输出，不依赖 LED 引脚。该次配置为 `esp32-s3`、COM3、16 MiB Flash、PSRAM 关闭。这些路径不再作为当前脚本输入。
- 编译报告：Flash 使用 `273837` 字节，应用分区 `3145728` 字节，剩余 `2871891` 字节；静态 RAM 使用 `21600` 字节，可用上限 `327680` 字节，剩余 `306080` 字节。
- 烧录速率 `460800`。bootloader：地址 `0x00000000`、`19968` 字节；分区表：地址 `0x00008000`、`3072` 字节；应用镜像：地址 `0x00010000`、`273984` 字节。三段均返回 `Hash of data verified.`，烧录退出码 `0`。
- 监视器以 `115200` 打开 COM3，收到启动标识以及连续 5 条心跳（0–4）。日志保存于 `.tools/hardware-run.log`。

```text
Blode Studio / ESP32-S3 ready
heartbeat=0; free_heap=358828 bytes
heartbeat=1; free_heap=358828 bytes
heartbeat=2; free_heap=358828 bytes
heartbeat=3; free_heap=358828 bytes
heartbeat=4; free_heap=358828 bytes
```

编译器报告的程序存储占用与 `.bin` 文件长度不同，后者包含镜像头及对齐；界面的 Flash/RAM 数据采用真实编译器报告。运行时 `free_heap` 统计与静态 RAM 预算范围不同，不能直接相减比较。

本次已烧录的原始分区图未包含 coredump 分区，启动时出现非致命 `No core dump partition found` 日志，应用仍正常运行。后续默认分区图增加 64 KiB coredump 分区，并生成正确 subtype；此默认布局调整已通过单元校验，尚未重新写入本机设备。

成功构建记录与源码/配置/产物指纹已保存至 `.blode/build-state.json`。再次打开该工作目录会恢复真实容量；外部改动会标记 `buildStale`，不将旧产物作为新构建烧录。
