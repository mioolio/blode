# Windows 调试器驱动

ST-Link 驱动在 **文件 → 首选项 → 调试器驱动** 中管理，无需先打开工程。当前软件已实现 STM32 的 ST-Link 识别、烧录和 GDB 调试工作区；工具安装见[ST-Link 工具](TOOL-VERSIONS.md#st-link-discovery-and-status)。

## 驱动与工具

| 项目               | 用途                                                | 管理位置                            |
| ------------------ | --------------------------------------------------- | ----------------------------------- |
| STSW-LINK009 驱动  | Windows 识别 ST-Link USB 接口、驱动版本及 PnP 状态  | 首选项 → 调试器驱动                 |
| ST-Link 1.9.0 工具 | `st-info` 识别、`st-flash` 烧录、`st-util` 调试服务 | 编译与工具链；工具链与导出          |
| GNU Arm GDB        | STM32 调试会话                                      | 独立调试窗口 → 工具；或指定已有 GDB |

“驱动已就绪”与命令行工具安装状态分别显示。2026-11-01 的 ST-Link 源码修复已接入 Windows 下载／安装及版本目录发现；实际验证见[硬件记录](HARDWARE-VALIDATION.md)。

## 驱动包位置

| 环境       | 路径                                           |
| ---------- | ---------------------------------------------- |
| 开发模式   | `tools/STSW-LINK/stsw-link009.zip`             |
| 桌面发行包 | `resources/drivers/STSW-LINK/stsw-link009.zip` |
| 显式覆盖   | `BLODE_DRIVER_ROOT` 指定包含该 ZIP 的目录      |

`tools/` 不进入 Git。桌面打包由 `electron-builder.config.cjs` 的 `extraResources` 携带驱动归档，构建环境提供该文件。缺少归档时，驱动页面显示安装包不可用；已安装驱动的检测独立进行。

## 安装

1. 打开调试器驱动页，查看 ST-Link 的版本、连接数和状态。
2. 点击安装或重新安装驱动，在 UAC 窗口确认。
3. 宿主解压归档，并调用 Windows `pnputil.exe` 逐个安装三个签名 INF，随后扫描设备。
4. 根据设备状态重新插拔探针，点击刷新。

归档解压到宿主数据目录的 `drivers/stlink/`。驱动 INF／CAT 保持厂商原始内容。UAC 取消返回取消结果，安装输出与错误可在任务区域查看。

## 状态与刷新

| 状态                   | 含义                                      |
| ---------------------- | ----------------------------------------- |
| 已就绪                 | 匹配的 ST-Link 设备存在，PnP 没有问题代码 |
| 已安装，未连接设备     | 驱动库已有包，当前未发现对应设备          |
| 设备已连接，驱动未就绪 | USB ID 匹配，设备仍有 PnP 问题代码        |
| 未安装                 | 当前驱动库与设备均未匹配                  |
| 当前系统无需安装       | 非 Windows 宿主                           |

驱动版本从 DriverStore 中匹配的 INF 读取；设备检测使用当前 PnP USB ID 与问题代码。初次检测后缓存，显式刷新、安装和系统设备变更使状态失效，不使用每五秒重复探测。

驱动定义位于 `extensions/boards/STM32F103C8T6/tools/driver.ts`，在 `extensions/drivers/index.ts` 注册；`src/core/drivers.ts` 负责通用检测和安装。Linux 的 USB 权限及 udev 配置另行处理，尚未实机验收。

驱动归档与工具链各自遵循上游许可。Windows 应用签名、OBE 包签名与厂商驱动签名的职责见[签名说明](PACKAGE-SIGNING.md)。
