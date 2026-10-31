# 平台工具链与构建

## 平台选择

默认配置是 auto，而不是某个 MCU。未识别时容量为 0、无分区，不显示 ESP FQBN、开发板索引或托管模式切换；首选项显示 Arduino CLI、Python 和 ST-Link 工具位置，以及两平台工具状态。

安装请求交给已注册的平台 runtime。auto 只能在目标平台可唯一确定时分派；多个候选、缺少识别能力或无法确认平台时应先明确选择。安装成功不等于已确认目标芯片，也不等于已构建固件。

## 安装进度

首选项顶部的“工具安装输出”显示当前工具、实际下载字节量与百分比，以及校验、解压、安装和最终结果。第三方 CLI／安装程序输出同步显示；总大小未知或安装阶段使用不定进度条。独立调试窗口安装 GNU 工具时也显示同一任务进度。重新打开首选项可查看本次应用运行期间的最近安装任务。

设备列表首次初始化后使用缓存，手动刷新或 Windows 系统设备变更通知会更新列表；读取安装或工具状态不会定时重新枚举设备。更多操作见 [桌面工作台新功能](NEW-FEATURES.md)。

## 工具位置

首选项采用左侧分类导航和右侧详情，可选择并行安装的 GNU Arm GCC、Arduino CLI 和 Arduino-ESP32 版本。选择 GNU／CLI 会写入明确的工具路径；选择 ESP32 core 会写入 `toolchain.packageDirectory`，隔离该版本的内核、库和缓存。其他版本保留，不覆盖原工程源码。版本清单、公开下载链接、完整性检查与平台验证范围见 [工具版本管理](TOOL-VERSIONS.md)。

| 环境       | 默认工具链根目录                 |
| ---------- | -------------------------------- |
| 开发桌面   | 仓库 tools/                      |
| 完整安装包 | 应用目录 resources/tools/        |
| 简洁安装包 | Electron userData 下 toolchains/ |
| 显式覆盖   | BLODE_TOOLCHAIN_ROOT             |

打包有两种模式，由 electron-builder.config.cjs 统一配置。`npm run package:lite` 生成便携版，只包含应用、板卡清单、文档与 ST-Link 驱动归档，缺少的工具在首次使用时安装到 userData 的 toolchains/。`npm run package:full` 额外把仓库 tools/ 下的 arduino-cli、Arduino-ESP32 内核、ST-Link 工具与 Arm Compiler 6 一并打包到 resources/tools/，安装目标为 zip 以便直接解压运行（完整包约 3.3 GiB，不适合做成每次启动都要解包的便携 exe）。完整包启动时优先使用内置工具根；内置工具根不可写时，arduino-cli 配置回落到 userData，其余缺失组件仍可按原有流程安装，或通过 armCompilerDirectory、stlinkDirectory、Arduino CLI 路径指向本机第三方工具。

clangd 语言服务与编译器分开：完整包在维护者执行 `npm run fetch:clangd` 后，把校验过的 `tools/clangd/` 一并放入 `resources/tools/clangd/`，最终用户无需下载；简洁包不包含它，用户在“首选项 → 工具链 → 版本”安装 `clangd 23.1.0`，文件进入 `versions/clangd/23.1.0/`。宿主依次查找显式路径、内置目录、已安装版本和 PATH；未找到时编辑器的 C/C++ 补全回退到内置索引，见 [clangd 语言服务](CLANGD.md)。

不在完整包内的内容：tools/python 是本机 venv 链接，tools/downloads 与 arduino-data/tmp 是缓存，arduino-cli.yaml 记录本机绝对路径与代理，library_index.json 由 `arduino-cli core update-index` 重新生成；这些在打包时一律排除。

BLODE_DATA_ROOT 指定应用数据与连接凭据，不等于固件工程目录。开发用户数据为 .tools/dev-user-data，可用 BLODE_DEV_USER_DATA 覆盖。用户工程通过 be 记录自己的工具配置；工程缓存位于该工程 .blode/。

S3 使用根目录下 bin/arduino-cli.exe、arduino-data/、downloads/、libraries/ 和 python/。STM32 的 ST-Link 工具使用 stlink/，保持 bin、依赖 DLL 与芯片定义目录。Windows 驱动归档单独位于 tools/STSW-LINK/，不与 st-info/st-flash 混同。

本机原 E 盘的 Arm Compiler 6.22 完整工具目录已迁入 tools/armclang，保留 bin、include、lib、sw 和 license_terms；旧目录不再作为工具来源。该目录约 1.79 GiB、4087 个文件，不进入 Git，但完整安装包会把它一并放进 resources/tools/armclang。toolchain.armCompilerDirectory 可显式指定另一完整安装目录或 bin；留空时依次使用该内置目录与用户工具根目录中的 armclang。

Arm Compiler 6 属于 Keil MDK 授权组件，应用自身不下载它：简洁包不含该目录，完整包只打包本机构建产物，使用与再分发遵循 Keil MDK 条款与随附的 license_terms。未检测到 AC6 时，STM32 的「安装 / 更新工具链」会下载 GNU Arm GCC（arm-none-eabi-gcc / objcopy）到工具根目录的 armgcc/，并校验发行元数据中的 SHA-256；该目录同样可被 toolchain.armCompilerDirectory 显式指定。首选项同时显示 AC6 与 GNU Arm 的安装状态与版本。

路径通过参数数组交给进程，不拼接 shell。自定义路径代表用户信任的本机工具；空路径的托管/PATH 选择由对应平台定义。各平台实现留在其目录的 toolchain/programmer 模块，core 不维护厂商下载和命令分支。

## ESP32-S3

S3 托管模式解析官方稳定 Arduino CLI，下载归档并校验发布方 SHA-256，再使用 Espressif 稳定索引安装 Arduino-ESP32。实际版本写入工具链 lock 文件，离线启动不自动升级。

Python 路径为空时优先使用专用 venv，再尝试开发 .tools/esptool-venv 与系统 Python；安装 esptool 使用专用环境。显式 Python 路径需已有对应模块，不向系统解释器强行安装依赖。识别与烧录优先调用 Python 的 esptool 模块；没有可用 Python 时改用 Arduino-ESP32 内核自带的 esptool.exe，因此完整包无需安装 Python 也能编译并烧录 ESP32-S3。

自定义模式可指定 Arduino CLI、Python、FQBN 和 HTTPS 索引。主 sketch 与 src/ 下模块按 Arduino 规则构建；平台 runtime 复制输入至 .blode/staging，生成 partitions.csv，调用真实 CLI，并从编译报告读取 Flash/RAM。

当前布局只有一个 factory 应用。bootloader 和分区表的系统保留区固定；应用按 64 KiB、数据按 4 KiB 对齐，布局由 S3 adapter/layout 校验。OTA 不通过新增一个图形 app 分区自动获得支持。平台烧录前识别芯片和容量，写入 bootloader、分区表与应用的明确地址。

## STM32

ST-Link / SWD 是独立调试连接，不要求 COM 口。st-info 用于探针与目标识别，st-flash 用于写入和回读验证。Windows 驱动安装与这些工具的安装是两步。

Windows x64 托管 ST-Link 使用固定官方发行归档及元数据 SHA-256 校验；保留 DLL、芯片定义和版本锁。其他环境可通过 PATH 或 stlinkDirectory 提供已有工具。芯片 ID、容量和选择的探针必须确认后才能烧录。

设置 be.build.entry 后优先使用 Arm Compiler 6 的 armclang 编译 C/C++、armlink 链接、fromelf 生成二进制；未安装 AC6 时改用 GNU Arm GCC 的 arm-none-eabi-gcc 编译链接、objcopy 生成二进制。入口可为文件、目录或代表整个工程的点号。AC6 路径下项目已有的 Arm 启动文件和 scatter 优先；GNU 路径使用平台生成的 F1 中容量启动文件与链接脚本，忽略工程内的 ARM 语法启动、scatter 与 GNU .ld 并给出提示。内置模板只覆盖明确识别的 0x410 STM32F1 中容量配置，未知芯片不猜 CPU、RAM 或链接布局。

项目 Arm 启动文件与 .sct 必须是完整配对，否则已知目标会提示并使用明确的 F1 模板。AC6 模板通过 __main 执行运行库初始化；GNU 模板在 Reset_Handler 中复制 .data、清零 .bss、调用 SystemInit 与 __libc_init_array，因此 C++ 全局构造在两条路径下都会执行。两者默认在 0x20004c00..0x20005000 保留 1 KiB 栈。模板不能保证 GNU 自定义 section 或绝对地址相同，需检查构建 warning 和 .blode/build/firmware.map。输出还包括 firmware.elf 与 firmware.bin；本次用户工程副本测得 Flash 2136 字节、RAM 1028 字节（4 字节静态数据 + 1024 字节保留栈）。RAM 数值包含链接器保留栈，不是运行时峰值，不能由此推断其他工程或硬件运行结果。

默认 GNU 安装使用 v15.2.1-1.1；版本目录另提供 14.2.1-1.1 和 13.3.1-1.1，源自 xPack 对 ARM GNU 工具链的重打包。Windows x64、Linux x64 与 Linux ARM64 的原生归档选择及下载校验已准备；Linux 尚未实际验证。安装前校验发行元数据或发布方校验清单中的 SHA-256 与归档大小；其许可为 GNU 工具链自身许可，可随安装流程下载。其他主机可使用已有工具并通过 armCompilerDirectory 指定；Arm Compiler 6 仍须遵循自身授权条款。

没有 build.entry 时保留工程根目录 firmware.bin 的验证方式。完整固件按实际目标生成并链接到 0x08000000；当前只允许从 Flash 起点写入单一完整固件区，不套用 ESP 分区，不承诺保留独立 bootloader 或相邻数据页。main.c 本身不足以生成正确启动和链接环境。

本机 Arm 工具版本标识为 Keil MDK Community 非商业使用环境；原始 license_terms 保留，工具使用和重新分发遵循这些条款。可分享的平台源码不包含编译器，也不将本机授权当作向其他用户分发工具的许可。

参见 [STM32 平台包](../extensions/boards/STM32F103C8T6/README.md) 与 [设备使用说明](STM32.md)。

## 输入与构建记录

右键文件或目录设置入口只写 be.build.entry，不立即编译。build.sketch/build.files 继续保留显式输入语义，实际文件/目录的处理由平台实现。

成功构建/验证记录包含时间、真实容量与产物哈希，保存到 .blode/build-state.json。源码、构建配置、入口或二进制变化会使缓存过期，失败构建不覆盖成成功。烧录时再次校验目标及输入/产物，不能把旧容量数据显示当作当前产物已可烧录。

资源统计与构建输入分开：资源树扫描到的文件不等于全部参与编译。二进制输入由 runtime 声明，不能只哈希文本编辑器中的文件。

## 网络与硬件复测

桌面下载由 Electron 网络接口遵循系统代理；平台子进程接收代理环境，S3 另写 CLI proxy 配置。纯 Node 脚本可显式使用 HTTP_PROXY/HTTPS_PROXY 等环境，代理凭据不得提交配置或日志。

```powershell
$env:BLODE_PROJECT_ROOT = 'D:\\firmware\\my-device'
npx tsx scripts/verify-hardware.ts --install
# 仅在核对目标和固件后：
npx tsx scripts/verify-hardware.ts --flash
```

BLODE_PROJECT_ROOT 必须指向仓库外已有有效工程，不会自动建固件项目或覆盖其容量/端口。省略 --install 使用已有工具；省略 --flash 只识别和构建/验证，不写 Flash。日志位于仓库 .tools/hardware-run.log，脚本不自动打开串口监视器。
