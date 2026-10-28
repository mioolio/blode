# 本机硬件验证记录

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
- 示例：`examples/blink` 复制到 `.tools/hardware-workspace/Blink`；UART 心跳输出，不依赖 LED 引脚。选择 `esp32-s3`、COM3、16 MiB Flash、PSRAM 关闭。
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
