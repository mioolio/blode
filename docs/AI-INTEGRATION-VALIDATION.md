# AI 管道与 MCP 实际应用验证

时间：2026-10-28 18:45:54（Asia/Shanghai）。

命令：`npx tsx scripts/smoke-desktop.ts`。目标是运行中的 Blode Studio 桌面应用，并非 mock CoreApi。

工程：`C:\Users\molliom\Documents\Blode\Blink`。板卡配置：`esp32-s3`。实际枚举到的端口：`COM1`、`COM3`。

- 通过：running Electron CoreApi state through authenticated named pipe
- 通过：actual host port enumeration without opening devices
- 通过：real route method, schema and explicit-confirmation rejection before side effects
- 通过：core path traversal error mapped through JSON-RPC
- 通过：unique source file write/read through the app and verified on disk
- 通过：temporary source file removed after verified ownership and path checks
- 通过：built MCP stdio bridge launched as a real Node child; initialization and tools/list
- 通过：MCP tools/call to the running app returns active state without leftover smoke files

验证未调用芯片识别、编译、下载工具链、串口连接或烧录。临时头文件使用随机唯一名称，写入后核对实际路径与内容再删除。token 未写入报告或日志。

范围：本记录覆盖真实命名管道 → 核心服务，以及 SDK MCP stdio 客户端 → 构建后桥接子进程 → 命名管道 → 同一核心服务。它不代替前端交互、Electron preload/IPC 或实机固件运行验证；这些由界面与硬件验证记录单独说明。
