# Windows 调试器驱动

Blode Studio 内置 STMicroelectronics 的 STSW-LINK009 驱动包，用于 ST-Link/V2 及更新型号的调试与烧录器。驱动属于操作系统能力，不属于某块板卡；安装入口在顶部“首选项”菜单的“驱动”项，不需要先打开工程。

> 当前应用还没有 STM32 烧录适配器。本页只说明驱动检测与安装；STM32/OpenOCD 的烧录流程需要另做适配。

## 驱动包位置

| 场景     | 路径                                           |
| -------- | ---------------------------------------------- |
| 开发模式 | `tools/STSW-LINK/stsw-link009.zip`             |
| 便携版   | `resources/drivers/STSW-LINK/stsw-link009.zip` |
| 覆盖     | `BLODE_DRIVER_ROOT` 指向包含该 zip 的目录      |

`tools/` 不提交到源码仓库。打包时 `package.json` 的 `extraResources` 会把该目录复制到 `resources/drivers/STSW-LINK`；如果目录不存在，打包会给出警告，应用仍可运行，但“调试器驱动”会显示驱动包不可用。

## 使用流程

1. 打开顶部“首选项” → “驱动”，查看 ST-Link 的状态。
2. 点击“安装 ST-Link 驱动”或“重新安装驱动”。
3. Windows 弹出 UAC 提示时选择“是”。安装过程使用系统自带的 `pnputil.exe`，为驱动包中的三个签名 INF 逐个执行 `/add-driver ... /install`，随后 `/scan-devices`。
4. 安装完成后重新插拔 ST-Link，再点“刷新”确认状态变为“已就绪”。

驱动包解压到 `%APPDATA%/Blode Studio/drivers/stlink`（或 `BLODE_DATA_ROOT` 指向的目录），不修改驱动包中的 INF/CAT 文件。

## 状态含义

| 状态                   | 含义                                                   |
| ---------------------- | ------------------------------------------------------ |
| 已就绪                 | 至少一个 ST-Link 设备已连接，且没有 PnP 问题代码       |
| 已安装，未连接设备     | 驱动包已进入 Windows 驱动库，当前没有设备              |
| 设备已连接，驱动未就绪 | 匹配到 ST-Link USB ID，但设备存在问题代码（常见为 28） |
| 未安装                 | 驱动库和设备都未匹配                                   |
| 当前系统无需安装       | 非 Windows 平台                                        |

检测方式：

- 驱动库：`%SystemRoot%\System32\DriverStore\FileRepository\stlink_{dbg,bridge,vcp}.inf_*`；版本从 INF 的 `DriverVer` 读取。
- 设备：`Get-PnpDevice -PresentOnly`，按驱动包覆盖的 `VID_0483&PID_*` 匹配；`Problem = 0` 视为可用。
- 结果缓存 5 秒；界面上的“刷新”会强制重新检测。

## 边界与安全

- 仅 Windows。当前 Electron 版本要求 Windows 10 及以上，`pnputil` 可用。
- 驱动包由 ST 签名；应用只解压并调用系统安装器，不替换、不修改 INF/CAT。
- 安装需要管理员权限。应用通过一次显式的 `Start-Process -Verb RunAs` 提权；UAC 被取消会返回“驱动安装已取消”，不会静默重试。
- 解压目录固定为应用数据目录下的 `drivers/<包名>`，安装前只清理这个固定目录，不接受外部传入的路径。
- 驱动 ID、INF 名称和 USB ID 放在 `extensions/drivers/stlink.ts`；核心只负责解压、检测和提权。新增其他调试器时，新建 `extensions/drivers/<probe>.ts` 并在 `extensions/drivers/index.ts` 显式注册。
- ST 驱动包的再分发受 ST 许可约束；二进制 zip 不提交到仓库，由打包环境提供。

## 手动安装

如果应用内安装不可用，可以解压 `stsw-link009.zip`，以管理员身份运行 `stlink_winusb_install.bat`，或按厂商说明运行 `dpinst_amd64.exe`。安装完成后同样建议重新插拔设备。
