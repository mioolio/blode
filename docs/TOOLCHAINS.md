# 工具链与构建

## 一键管理

默认板卡为 ESP32-S3，默认工具链模式为 `managed`。在设置中点击安装工具链后，应用查询 Arduino 官方最新稳定版 CLI，下载官方归档并强制校验发布方 SHA-256；随后通过 Espressif 官方稳定索引安装最新 ESP32 Arduino Core。安装不会把编译器放入应用源码，也不会修改全局 Arduino 安装。

数据目录默认为 Electron 的 `userData`，Windows 为 `%APPDATA%/Blode Studio`。`toolchains/arduino-cli.yaml` 存放独立包目录与网络配置，`toolchains/toolchain.lock.json` 记录本次安装的精确版本。`BLODE_DATA_ROOT` 可覆盖运行目录。开发模式下如果仓库根目录存在 `tools/`，应用优先把该目录作为便携工具链根目录（`tools/bin/arduino-cli.exe`、`tools/arduino-data`、`tools/libraries`、`tools/python`）；`BLODE_TOOLCHAIN_ROOT` 可显式覆盖，发布模式仍使用 `userData`。最新版本在用户点击安装/更新时解析，锁文件保留已安装版本；应用离线启动不会自动升级。

烧录使用 esptool。Python 路径留空时，优先使用应用数据目录中的虚拟环境，再尝试开发目录 `.tools/esptool-venv`，最后检测系统 Python。自动安装 esptool 时会创建私有 venv。显式指定 Python 路径表示使用已有环境，需要该环境已经安装 esptool。

桌面下载使用 Electron `net.fetch`，遵循系统代理；CLI 子进程同时接收代理环境与 Arduino `network.proxy` 配置。纯 Node 集成脚本可使用 `HTTP_PROXY`、`HTTPS_PROXY` 和 Node 24 的 `NODE_USE_ENV_PROXY=1`。代理凭据不应提交到项目配置或日志。

## 第三方与自定义工具

`toolchain.mode = custom` 可指定本机已下载的 Arduino CLI 和 Python 可执行文件；路径作为单独参数启动，不经过 shell。额外开发板索引只接受 HTTPS URL。点击安装时，自定义 CLI 使用相同的独立包目录解析并安装 ESP32 Core；适配其他编译平台需要新增板卡适配器，不能把无关架构伪装成 ESP32-S3。

通用适配器面向 esptool 支持的 Espressif ROM 烧录，输入项目目录中的 `firmware.bin`。其构建按钮验证已有二进制的大小与分区范围；它不会编译未知芯片架构。默认通用分区偏移为 0，适合完整合并镜像。仅应用镜像需要用户设置正确的应用偏移。

## 分区与容量

ESP32-S3 当前实现一个 factory 应用分区。bootloader `[0x0,0x8000)` 与分区表 `[0x8000,0x9000)` 固定，由板卡校验器锁定；应用按 64 KiB 对齐，其余分区按 4 KiB 对齐。保存与构建都会校验重叠、边界与名称。OTA 多应用分区需要增加 subtype 与启动选择协议后再开放。

构建把项目源文件复制到 `.blode/staging/<sketch>`，将可视化分区生成 `partitions.csv`，调用真实 Arduino CLI，再从编译器输出读取 Flash/RAM 占用。未构建时不把源码字节数当作固件大小。Flash 剩余空间针对可烧录应用分区，物理总容量单独显示。

项目资源清单独立统计磁盘占用：包括空目录、不可编辑的二进制资源、每个文件的真实字节数和总文件/目录数，排除依赖、版本库和构建缓存。最多扫描 5000 个条目、32 层，达到限制会标记 `inventory.truncated`；不跟随符号链接或 junction。原生文件监听会在外部新增、删除或修改文件后推送 `status.workspaceChanged`，由界面刷新资源树和统计。

最近一次成功构建的 Flash/RAM 数值、时间与产物指纹保存在 `.blode/build-state.json`，重启或重新打开项目会恢复。代码、配置或二进制产物变化时，`buildStale=true`，这些数值仍表示上一次真实构建；需要重新构建才能更新容量并继续烧录。失败的构建不会抹掉上一次成功的容量记录。

烧录前重新探测型号与实际容量，校验已构建的源码/配置指纹以及产物 SHA-256，再将 bootloader、分区表、应用分别写入正确偏移。没有采用 Arduino 默认上传 recipe 的固定应用地址；因此可视化应用偏移会真实生效。Arduino 自动生成的 `.merged.bin` 地址固定，不作为可烧录产物公开。

Arduino 将 `src/` 下的 C/C++/汇编源文件递归编译，建议应用模块使用 `src/<module>` 目录。项目源文件读取有深度、数量和单文件大小限制；依赖安装与完整 clangd 语义服务可以作为独立扩展继续接入。

## 硬件复测

```powershell
npx tsx scripts/verify-hardware.ts --install --flash
```

脚本默认选择 COM3、ESP32-S3 与 16 MiB Flash，对应本次连接的设备；`BLODE_PORT` 可覆盖端口。它把示例复制到 `.tools/hardware-workspace/Blink`，只在指定 `--flash` 时写入硬件。省略 `--install` 使用已有工具链，省略 `--flash` 仅探测和构建。日志保存在 `.tools/hardware-run.log`。其他设备需要先调整脚本或通过界面设置真实容量。

参考：[Arduino CLI 配置](https://arduino.github.io/arduino-cli/latest/configuration/)、[Espressif 安装说明](https://docs.espressif.com/projects/arduino-esp32/en/latest/installing.html)、[Arduino sketch 规范](https://arduino.github.io/arduino-cli/latest/sketch-specification/)。
