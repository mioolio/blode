# 硬件调试

ST-Link 的共享目录发现由 `../tools/stlink-discovery.ts` 提供，支持托管、版本目录、自定义根目录／bin 和 PATH。宿主通过独立的 `st-util` 查找启动调试服务；2026-11-01 已验证隔离 ZIP 导入后的服务路径与 STM32F1 识别，SRAM 指令修改仍待实机验收。

`manifest.debugger.mode` 为 `builtin`，使用宿主的 GDB/MI 会话引擎和 STM32F103C8T6 调试配置。连接通过 ST-Link / SWD；工具为 GNU Arm GDB 与 st-util。

当前实现包括寄存器、反汇编、内存读取、批量断点和 SRAM 指令修改。本目录目前没有替换宿主调试器的业务入口；第三方实现通过运行时插件 `debugger` 接口注册。
