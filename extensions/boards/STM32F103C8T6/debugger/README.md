# 硬件调试

`manifest.debugger.mode` 为 `builtin`，使用宿主的 GDB/MI 会话引擎和 STM32F103C8T6 调试配置。连接通过 ST-Link / SWD；工具为 GNU Arm GDB 与 st-util。

当前实现包括寄存器、反汇编、内存读取、批量断点和 SRAM 指令修改。本目录目前没有替换宿主调试器的业务入口；第三方实现通过运行时插件 `debugger` 接口注册。
