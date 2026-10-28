# Blode Studio

面向单片机开发的模块化桌面工作台，使用 Electron、TypeScript、React 和本地打包的 Monaco 编辑器。界面、浏览器工作台与 AI 接入共用工程校验、操作锁和构建记录；芯片识别、编译、烧录及工具链由各平台目录实现。

> [功能展示与真实硬件案例](SHOWCASE.md)：一颗 STM32F103C8T6 报告并实际验证 128 KiB Flash，72 KiB 图案固件完成真实烧录与回读。

## 当前平台

| 选择       | 用途                         | 能力                                                                             |
| ---------- | ---------------------------- | -------------------------------------------------------------------------------- |
| `auto`     | 扫描已注册平台并选择候选设备 | 未识别时容量为 0、无分区，不编译或烧录                                           |
| `esp32-s3` | ESP32-S3 / Arduino-ESP32     | Arduino 源码构建、平台分区、esptool 烧录与串口监视                               |
| `stm32`    | STM32 / ST-Link              | SWD 识别目标，使用 Arm Compiler 6 构建配置完整的源码工程，或验证已有二进制后烧录 |

仅以上三个配置入口已注册。USB 串口是候选连接，实际识别成功后才会确认芯片平台；多个候选需要明确选择。ST-Link 与 COM 串口分别列出，调试器不必具有虚拟串口。

工作台提供文件树右键菜单、内联新建与重命名、可关闭的文件/工具页签、拆分编辑器、未保存草稿、串口控制台，以及带认证的 JSON-RPC 系统管道和 MCP 桥接。C/C++ 补全是声明式提示，目前没有完整 clangd 语义分析。

## 启动

需要 Node.js 24 或更高版本和 npm：

```powershell
npm ci
npm run dev
```

启动后选择外部工程目录或其中的 `be` 文件。打开没有描述符的文件夹时，应用以 `auto` 初始化配置，不预设 ESP 的容量、分区或编译目标。

1. 选择候选设备并识别平台，或明确选择已支持的平台。
2. 打开顶部“首选项”菜单，在“工具链”中配置或安装平台工具；语言与调试器驱动设置无需打开工程。
3. 保存源码和配置，执行构建或固件验证，确认目标后烧录。

`auto` 模式下工具链设置同时显示两平台工具位置和状态；识别前不显示 ESP FQBN、索引或分区设置。STM32 的连接与固件限制见 [STM32 使用说明](docs/STM32.md)。

`npm run build` 构建主进程和前端，`npm start` 运行已有产物；`npm run package` 生成 Windows 便携版到 `release/`。开发数据保存在 `.tools/dev-user-data`，工具链默认位于仓库 `tools/`；安装版使用用户应用数据目录。覆盖变量及 Windows 运行时标签检查见 [开发说明](docs/DEVELOPMENT.md)。

## 工程描述符与入口

工程根目录的 `be` 是 JSON 配置；应用源码仓库与用户固件工程分开存放。中性初始配置例如：

```json
{
  "version": 1,
  "name": "my-device-project",
  "boardId": "auto",
  "port": "",
  "baudRate": 460800,
  "flashSize": 0,
  "partitions": [],
  "programmer": { "transport": "auto", "serialNumber": "", "frequencyKhz": 1800 },
  "toolchain": {
    "mode": "custom",
    "arduinoCli": "",
    "python": "python",
    "additionalUrls": [],
    "fqbn": ""
  }
}
```

识别后，平台生成并校验真实配置。右键文件或目录选择编译入口会把工程相对路径写入 `be.build.entry`，不会立即编译；入口的构建含义由平台运行时解释。单个 `main.c` 不能替代 MCU 启动代码、链接脚本或完整构建配置。

`build.sketch` 和 `build.files` 仍表示显式构建输入。保存配置保留 `build` 段；旧 `.blode/project.json` 工程继续兼容。构建及缓存位于工程 `.blode/`，不进入平台包。

STM32 的源码入口使用 Arm Compiler 6 的 armclang、armlink、fromelf；没有 `build.entry` 时保留根目录 `firmware.bin` 验证方式。项目启动文件和 Arm scatter 优先，已知 `0x410` STM32F1 中容量目标有平台模板；未知芯片不猜 CPU 或内存。布局页可分配应用区、添加带自定义名称/颜色的数据区和系统区，并修正芯片误报容量；编译结果按区域检查，越界会警告，烧录确认弹窗允许二次确认后继续；同时显示 Flash/RAM 的实际占用。工具与授权限制见 [STM32 平台说明](extensions/boards/stm32/README.md)。

## 平台目录

| 位置                                           | 责任                                                 |
| ---------------------------------------------- | ---------------------------------------------------- |
| `extensions/boards/auto/`                      | 中性检测配置，无具体硬件运行时                       |
| `extensions/boards/esp32-s3/`                  | S3 adapter、runtime、工具链、烧录参数和布局          |
| `extensions/boards/stm32/`                     | STM32 adapter、runtime、ST-Link 协议、工具及驱动描述 |
| `extensions/registry.ts`                       | 静态注册板卡元数据与配置适配器                       |
| `extensions/runtime-registry.ts`               | 静态注册具体平台运行时工厂                           |
| `extensions/runtime.ts`                        | 平台使用的宿主 SDK 与生命周期契约                    |
| `extensions/completions/`、`extensions/menus/` | 纯数据补全与资源管理器菜单                           |
| `src/core/`                                    | 通用锁、路径、配置、指纹、缓存、串口及宿主基础设施   |
| `src/renderer/`、`src/automation/`             | 界面与 JSON-RPC/MCP 传输适配                         |

平台运行时不依赖 `src/core/` 或另一个平台目录。已完成复制单个平台目录后隔离打包的依赖检查；它证明模块可独立组合，不代表任意硬件或宿主版本均兼容。

复制目录后，还需在两个 registry 显式注册，保持 manifest 的 `runtimeApiVersion` 与宿主 SDK 匹配，并补齐语言资源和验证。清单不会自动执行代码；当前只支持随应用编译的可信平台包。详见 [扩展约定](extensions/README.md) 和 [架构说明](docs/ARCHITECTURE.md)。

## 工具与验证

平台负责工具版本、安装、构建与烧录验证，通用核心不生成厂商命令。工具目录与离线配置见 [工具链说明](docs/TOOLCHAINS.md)。ST-Link 驱动和命令行工具分别安装，驱动安装需确认系统提权。

```powershell
npm run typecheck
npm test
```

自动化测试、隔离打包与真实硬件验证分开记录。历史 ESP32-S3 数据见 [硬件记录](docs/HARDWARE-VALIDATION.md)，其中端口和固件不作为其他设备默认值。硬件脚本必须显式设置外部 `BLODE_PROJECT_ROOT`，仅传 `--flash` 时写设备。

Windows 使用命名管道，macOS/Linux 使用 Unix socket；MCP 与界面共用核心 API。浏览器工作台默认监听 `127.0.0.1:47821`，外部访问需要配置与令牌。详见 [AI-PIPE.md](docs/AI-PIPE.md)。

## 贡献与许可

欢迎在 [项目仓库](https://github.com/mioolio/blode) 提交平台包、编辑器改进和文档修正。新增平台应附 README、契约与边界测试，并说明硬件验证范围。源码保持单文件不超过 1000 行，界面与协议文案同时维护中英文资源。

不提交依赖、打包产物、`tools/`、`.tools/`、工程缓存或本机凭据。项目采用 Apache License 2.0，见 [LICENSE](LICENSE)。
