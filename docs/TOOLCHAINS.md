# 平台工具链与构建

当前源码核对日期：2026-11-01。版本目录及接口见[工具版本](TOOL-VERSIONS.md)，实现、发行及验收状态见[状态总览](STATUS.md)。

## 设置分工

| 入口                  | 管理内容                                                       |
| --------------------- | -------------------------------------------------------------- |
| 生成 → 编译设置       | 当前入口的编译器、版本、Debug／Release、体积优化与 C／C++ 覆盖 |
| 生成 → 组件库         | 设备模块、工程组件、Arduino 库及其导入／导出                   |
| 首选项 → 编译与工具链 | 可下载工具版本、安装、离线导入与路径配置                       |
| 首选项 → 工具链与导出 | 实际检测到的本机工具、版本、目录、来源和重新打包               |
| 首选项 → 调试器驱动   | Windows 驱动检测与安装                                         |
| 首选项 → 工具任务输出 | 下载、安装和导出的阶段、日志与最终结果                         |

`auto` 是中性设备检测配置。编译根据工程入口、平台及工具设置解析，设备未连接时仍可编译；烧录和调试使用真实连接。安装请求交给明确的平台运行时，多候选时由用户选择。

## 工具根目录

| 环境                 | 默认位置                                               |
| -------------------- | ------------------------------------------------------ |
| 桌面开发             | 仓库 `tools/`                                          |
| 标准桌面便携版       | 应用用户数据目录的 `toolchains/`，或已提供的内置工具根 |
| Web EXE／Node.js ZIP | Web 宿主数据目录的 `toolchains/`                       |
| 可选完整桌面构建     | `resources/tools/`，来自维护者构建配置所列的本机工具   |
| 显式覆盖             | `BLODE_TOOLCHAIN_ROOT`                                 |

开发用户数据默认在 `.tools/dev-user-data/`，由 `BLODE_DEV_USER_DATA` 覆盖；`BLODE_DATA_ROOT` 指定核心宿主数据。工程的 `be` 保存构建设置，`.blode/` 保存工程构建状态与缓存。

当前一键构建生成三种 Windows x64 发行物：桌面便携 EXE、自带 Node 的 Web EXE、需要 Node.js 24+ x64 的 Web ZIP。标准三个包不附带大型编译器或本机许可证。`package:full` 是额外的桌面 ZIP 构建方式，不属于这三个既有 0.3.5.9 产物；携带目录以 `electron-builder.config.cjs` 为准，体积随本机工具变化。

显式工具目录属于运行服务的电脑。版本选择不修改源码，其他已安装版本保留。缺少指定版本时报告错误，可安装或重新选择；打开工程不自动下载工具。

## 安装与导出进度

任务输出记录准备、下载、SHA-256 校验、解压、安装和最终结果。已知下载总量时显示字节及百分比；未知总量和部分安装阶段显示不定进度。独立调试窗口使用同一任务体系。

导出依次重新检测工具、收集当前文件、计算清单／哈希、压缩并校验归档。每次生成新的 ZIP，保留源目录、文件数量、大小、压缩引擎、进度、归档哈希和耗时。安装快照的导出不会复用旧包；下载历史是另一类记录。详见[离线交付](OFFLINE-DELIVERY.md)。

设备状态首次初始化后缓存，手动刷新或 Windows 设备事件触发更新；工具检查不会周期性扫描硬件。安装完成后使工具状态缓存失效。

## ESP32-S3

`Esp32_S3_CAM` 使用 Arduino CLI 和 Arduino-ESP32。目录可为托管的 `bin/arduino-cli`、`arduino-data/`、`libraries/`，也可选 `versions/arduino-cli/<版本>/` 与隔离的 `versions/arduino-esp32/<版本>/`。

指定 core 的 `installed.json` 及 CLI 配置保留版本与目录关系。显式 Python 路径使用已有 esptool 模块；托管流程可准备专用环境，也支持 Arduino 平台包中可执行的 esptool。代理、临时缓存和本机配置不作为可分享源码。

运行时按 Arduino 规则将输入放入 `.blode/staging/`，生成分区表并调用 CLI，保留平台原有编译参数；不以单独编译 `.ino` 替代 Arduino 的完整构建与链接。主 sketch 与 `src/` 的规则由所选 core 决定。摄像头 GPIO、Flash、PSRAM 和组件兼容性由工程配置。

布局目前使用一个 factory 应用，固定 bootloader／分区表保留区；应用按 64 KiB、数据按 4 KiB 对齐。烧录使用实际产物及其明确地址。UART GDB 需要启用 runtime stub 的固件，原生 USB-JTAG 使用另一套连接工具；见[硬件调试](HARDWARE-DEBUGGING.md)。

## STM32

`STM32F103C8T6` 支持 GNU Arm GCC、Arm Compiler 5 和 Arm Compiler 6。编译器家族、版本及目录在当前入口设置；C／C++ 可分别选择同一兼容后端的工具，链接使用该次构建对应的工具链。AC5 支持 C99／C++03，详见 [AC5](ARM-COMPILER-5.md)。

| 工具布局                                 | 说明                                            |
| ---------------------------------------- | ----------------------------------------------- |
| `armgcc/`、`versions/gnu-arm/<版本>/`    | GNU Arm 编译、链接和 objcopy                    |
| `armclang/`、`versions/armclang/<版本>/` | AC6 的 armclang、armlink、fromelf               |
| `armcc/`、`versions/armcc/<版本>/`       | AC5 的 armcc、armasm、armlink、fromelf          |
| `stlink/`、`versions/stlink/<版本>/`     | ST-Link 程序、依赖 DLL 和 `share/stlink/chips/` |

ST-Link 的统一查找位于模块 `tools/stlink-discovery.ts`：支持托管目录、版本目录、PATH 及自定义包根目录／`bin/`。`st-info` 和 `st-flash` 同时运行成功且版本一致时报告已安装，调试器另查找 `st-util`。Windows x64 可下载／安装官方 1.9.0 ZIP，也可通过离线包迁移；驱动由独立页面管理。

`be.build.entry` 可为文件、目录或 `.`。Arm 后端使用工程启用的 Arm 启动文件与 scatter，或受支持目标的生成模板；GNU 后端使用自己的 F1 启动与链接脚本。默认目标为 Cortex-M3、`0x410`、20 KiB SRAM 和 1 KiB 保留栈。目标范围、链接限制与资源检查见[STM32](STM32.md)。没有源码入口时，运行时保留根目录 `firmware.bin` 的验证方式。

GNU 安装使用固定版本的发行元数据或发布方校验文件。AC5／AC6 使用本机已有授权环境，不提供内置官方下载目录；工具快照排除许可证、密钥等本机文件。应用的 OBE／Windows 签名与编译器许可分开处理。

## clangd

clangd 为 C/C++ 语言服务，不替代固件编译器。当前目录提供 23.1.0，安装在 `versions/clangd/23.1.0/`；可选完整桌面构建也能携带预先获取的 `tools/clangd/`。查找使用配置路径、托管目录、版本目录与 PATH；未安装时回退工作区索引。见 [clangd](CLANGD.md)。

## 构建记录与复测

成功构建记录输入、配置和产物哈希；文件或配置变化使记录过期。命名入口在 `.blode/targets/<id>/` 保存各自产物与状态，普通入口使用 `.blode/build-state.json` 和 `.blode/build/`。固件导出及烧录校验相应产物。

Windows 已记录真实 GNU／AC5／AC6 编译、ESP32-S3 构建烧录与 UART 调试，以及最新 ST-Link 工具 ZIP 迁移后的 STM32F1 识别。Linux/macOS 实机结果仍待补充，详见[硬件记录](HARDWARE-VALIDATION.md)和[平台支持](PLATFORM-SUPPORT.md)。

硬件复测脚本使用仓库外现有工程：

```powershell
$env:BLODE_PROJECT_ROOT = 'D:\firmware\my-device'
npx tsx scripts/verify-hardware.ts
npx tsx scripts/verify-hardware.ts --install
# 确认目标与固件后执行写入：
npx tsx scripts/verify-hardware.ts --flash
```

省略 `--install` 使用已有工具，省略 `--flash` 不写 Flash；芯片识别仍会访问真实设备。日志写入 `.tools/hardware-run.log`。下载代理来自宿主网络接口或子进程环境，凭据不提交到工程或日志。
