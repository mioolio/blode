# 扩展与运行时包

设备逻辑按完整目录组织，语言补全与规则放在独立的 `completions/` 目录。

| 目录                    | 责任范围                                                                         |
| ----------------------- | -------------------------------------------------------------------------------- |
| `boards/Esp32_S3_CAM/`  | ESP32-S3 的 Arduino 构建、esptool 烧录、设备识别与资源布局；摄像头接线由工程配置 |
| `boards/STM32F103C8T6/` | STM32F103C8T6 的 Arm／GNU 构建、ST-Link、目标模板与布局                          |
| `boards/auto/`          | 中性扫描配置；未选定运行时没有 Flash 分配                                        |
| `boards/<第三方 ID>/`   | 包含清单与 JavaScript 入口的 API v2 运行时插件                                   |
| `completions/`          | 按语言与标准隔离的 JSON 补全、语义规则及适配逻辑                                 |

## 配置与运行时

types.ts 的 BoardAdapter 定义设备事实、能力、默认配置与校验，不在纯配置层执行进程或操作窗口。能力字符串中 `layout` 表示平台有布局页，`partitions` 表示该页允许任意分区编辑；固定布局平台只用 `layout` 提供容量与应用区分配，不开放任意分区。有状态的检测、安装、构建与烧录实现 runtime.ts 中的 PlatformRuntime，由工厂接收 RuntimeHost。

宿主 SDK 提供受控工程路径、进程、源码、串口、网络、事件和取消信号。平台可以拆分自己的工具下载、厂商命令、解析与布局，但不导入 src/core 或另一个平台目录；目录内部使用相对导入。

内置 TypeScript 代码在 `registry.ts` 和 `runtime-registry.ts` 注册并随宿主构建；复制时须匹配宿主 SDK。`Esp32_S3_CAM` 和 `STM32F103C8T6` 是明确范围的配置名称，不表示覆盖整个 ESP32 或 STM32 产品线。旧 `esp32-s3`、`stm32` 工程标识在读取时转换，分平台 C/C++ 编译器版本一并保留。

## 第三方运行时插件

API v2 包放在 `extensions/boards/<id>/` 或宿主应用数据的 `plugins/<id>/`，安装／修改后重启宿主。不需要为第三方包编辑静态 registry。宿主只读清单后注册设备事实，业务代码要先取得用户执行确认。

[清单类型](../src/shared/plugins.ts) 分别声明支持芯片、能力、默认配置、连接方式、约束、编译所有权、默认工具、调试、布局和界面；[插件 SDK](plugins.ts) 提供工程、进程、事件和生命周期服务。USB 或物理连接的协议与设备选择规则由插件实现，不强制转换成串口。

永久授权文件 `.uel` 由宿主在本机确认后生成，不随包分享。原生代码与宿主拥有相同权限，自定义 HTML 视图则通过隔离 iframe 和受控消息桥集成。

完整的目录、清单示例、编译器替换、调试接口、更新策略和测试要求见[运行时插件开发指南](../docs/RUNTIME-PLUGINS.md)。本次属于[内部开发预览](../docs/internal/runtime-plugins.md)。

## 其他扩展

- completions/ 按语言和版本保存 JSON 规则：C/c99、c11、c17、c23 各自独立，C++/arduino 保存 Arduino 数据。片段、符号、成员和悬停通过显式目录注册；工程可在 languages/C/<标准>/ 添加规则。工作区符号由增量索引提供，旧 blode.completions.json 继续兼容。格式见 [语言规则](../docs/LANGUAGE-RULES.md)。
- menus/explorer.ts 声明右键菜单的标题、显示条件和命令 ID，renderer 执行实际动作。编译入口选择只写入 be.build.entry，可指文件或目录，不立即编译。
- drivers/types.ts 与 drivers/index.ts 提供描述和注册；ST-Link 事实来自 boards/STM32F103C8T6/driver.ts，归档位于应用 tools/STSW-LINK/。

平台细节见 [ESP32-S3](boards/Esp32_S3_CAM/README.md) 与 [STM32](boards/STM32F103C8T6/README.md)，通用约定见 [架构说明](../docs/ARCHITECTURE.md)。
