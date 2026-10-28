# 平台工具链与构建

## 平台选择

默认配置是 auto，而不是某个 MCU。未识别时容量为 0、无分区，不显示 ESP FQBN、开发板索引或托管模式切换；首选项显示 Arduino CLI、Python 和 ST-Link 工具位置，以及两平台工具状态。

安装请求交给已注册的平台 runtime。auto 只能在目标平台可唯一确定时分派；多个候选、缺少识别能力或无法确认平台时应先明确选择。安装成功不等于已确认目标芯片，也不等于已构建固件。

## 工具位置

| 环境     | 默认工具链根目录                 |
| -------- | -------------------------------- |
| 开发桌面 | 仓库 tools/                      |
| 安装版   | Electron userData 下 toolchains/ |
| 显式覆盖 | BLODE_TOOLCHAIN_ROOT             |

BLODE_DATA_ROOT 指定应用数据与连接凭据，不等于固件工程目录。开发用户数据为 .tools/dev-user-data，可用 BLODE_DEV_USER_DATA 覆盖。用户工程通过 be 记录自己的工具配置；工程缓存位于该工程 .blode/。

S3 使用根目录下 bin/arduino-cli.exe、arduino-data/、downloads/、libraries/ 和 python/。STM32 的 ST-Link 工具使用 stlink/，保持 bin、依赖 DLL 与芯片定义目录。Windows 驱动归档单独位于 tools/STSW-LINK/，不与 st-info/st-flash 混同。

本机原 E 盘的 Arm Compiler 6.22 完整工具目录已迁入 tools/armclang，保留 bin、include、lib、sw 和 license_terms；旧目录不再作为工具来源。该目录约 1.79 GiB、4087 个文件，不进入 Git。toolchain.armCompilerDirectory 可显式指定另一完整安装目录或 bin；留空使用平台工具根目录中的 armclang 安装。

路径通过参数数组交给进程，不拼接 shell。自定义路径代表用户信任的本机工具；空路径的托管/PATH 选择由对应平台定义。各平台实现留在其目录的 toolchain/programmer 模块，core 不维护厂商下载和命令分支。

## ESP32-S3

S3 托管模式解析官方稳定 Arduino CLI，下载归档并校验发布方 SHA-256，再使用 Espressif 稳定索引安装 Arduino-ESP32。实际版本写入工具链 lock 文件，离线启动不自动升级。

Python 路径为空时优先使用专用 venv，再尝试开发 .tools/esptool-venv 与系统 Python；安装 esptool 使用专用环境。显式 Python 路径需已有对应模块，不向系统解释器强行安装依赖。

自定义模式可指定 Arduino CLI、Python、FQBN 和 HTTPS 索引。主 sketch 与 src/ 下模块按 Arduino 规则构建；平台 runtime 复制输入至 .blode/staging，生成 partitions.csv，调用真实 CLI，并从编译报告读取 Flash/RAM。

当前布局只有一个 factory 应用。bootloader 和分区表的系统保留区固定；应用按 64 KiB、数据按 4 KiB 对齐，布局由 S3 adapter/layout 校验。OTA 不通过新增一个图形 app 分区自动获得支持。平台烧录前识别芯片和容量，写入 bootloader、分区表与应用的明确地址。

## STM32

ST-Link / SWD 是独立调试连接，不要求 COM 口。st-info 用于探针与目标识别，st-flash 用于写入和回读验证。Windows 驱动安装与这些工具的安装是两步。

Windows x64 托管 ST-Link 使用固定官方发行归档及元数据 SHA-256 校验；保留 DLL、芯片定义和版本锁。其他环境可通过 PATH 或 stlinkDirectory 提供已有工具。芯片 ID、容量和选择的探针必须确认后才能烧录。

设置 be.build.entry 后使用 Arm Compiler 6 的 armclang 编译 C/C++、armlink 链接、fromelf 生成二进制；入口可为文件、目录或代表整个工程的点号。项目已有的 Arm 启动文件和 scatter 优先。内置模板只覆盖明确识别的 0x410 STM32F1 中容量配置，未知芯片不猜 CPU、RAM 或链接布局。GNU .ld 不能直接传给 armlink；需要兼容提示或在已知目标使用平台模板，不能假称已采用该 GNU 链接脚本。

项目 Arm 启动文件与 .sct 必须是完整配对，否则已知目标会提示并使用明确的 F1 模板。模板通过 AC6 的 __main 执行运行库初始化，支持 C++ 全局构造；默认在 0x20004c00..0x20005000 保留 1 KiB 栈。模板不能保证 GNU 自定义 section 或绝对地址相同，需检查构建 warning 和 .blode/build/firmware.map。输出还包括 firmware.elf 与 firmware.bin；本次用户工程副本测得 Flash 2136 字节、RAM 1028 字节（4 字节静态数据 + 1024 字节保留栈）。RAM 数值包含链接器保留栈，不是运行时峰值，不能由此推断其他工程或硬件运行结果。

没有 build.entry 时保留工程根目录 firmware.bin 的验证方式。完整固件按实际目标生成并链接到 0x08000000；当前只允许从 Flash 起点写入单一完整固件区，不套用 ESP 分区，不承诺保留独立 bootloader 或相邻数据页。main.c 本身不足以生成正确启动和链接环境。

本机 Arm 工具版本标识为 Keil MDK Community 非商业使用环境；原始 license_terms 保留，工具使用和重新分发遵循这些条款。可分享的平台源码不包含编译器，也不将本机授权当作向其他用户分发工具的许可。

参见 [STM32 平台包](../extensions/boards/stm32/README.md) 与 [设备使用说明](STM32.md)。

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
