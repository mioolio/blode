# 扩展与平台包

具体设备以完整目录组织：`boards/esp32-s3/` 与 `boards/stm32/` 各自拥有 adapter、runtime、toolchain/programmer 及所需 layout、protocol、driver 文件。`boards/auto/` 只提供中性扫描配置；未识别时容量为 0、没有分区。

## 配置与运行时

types.ts 的 BoardAdapter 定义设备事实、能力、默认配置与校验，不在纯配置层执行进程或操作窗口。能力字符串中 `layout` 表示平台有布局页，`partitions` 表示该页允许任意分区编辑；固定布局平台只用 `layout` 提供容量与应用区分配，不开放任意分区。有状态的检测、安装、构建与烧录实现 runtime.ts 中的 PlatformRuntime，由工厂接收 RuntimeHost。

宿主 SDK 提供受控工程路径、进程、源码、串口、网络、事件和取消信号。平台可以拆分自己的工具下载、厂商命令、解析与布局，但不导入 src/core 或另一个平台目录；目录内部使用相对导入。

具体平台 manifest 当前使用 `runtimeApiVersion: 1` 并声明 runtime 文件。复制时须匹配目标宿主的 `extensions/runtime.ts` 与 shared 契约，版本字段不是自动兼容协商机制。

## 增加或复制平台

1. 创建或复制完整 boards/<platform>，至少包含 manifest、adapter、runtime 和 README，按需增加工具链、协议、布局及驱动描述。
2. 在 registry.ts 显式注册 adapter，在 runtime-registry.ts 显式注册 runtime 工厂；具体平台 ID 对应，auto 只出现在配置 registry。
3. 操作系统驱动事实由平台 driver.ts 导出，在 drivers/index.ts 注册；通用安装执行器留在 core。
4. 增加配置、参数、输入边界和运行时测试，维护描述、状态及错误的中英文资源。
5. 隔离复制目录后打包，确认不依赖 core 或其他平台，再单独记录硬件验证。

S3 与 STM32 已完成单目录隔离 bundle 检查。这证明依赖边界，不保证任意板卡、固件或宿主版本可直接使用。

平台随应用静态编译。将目录或清单放入用户工程不会使其执行；没有任意 JavaScript 热安装或目录热执行。可信 runtime 可以使用 Node 能力，不等于提供第三方代码沙箱。

## 其他扩展

- completions/ 按语言和版本保存 JSON 规则：C/c99、c11、c17、c23 各自独立，C++/arduino 保存 Arduino 数据。片段、符号、成员和悬停通过显式目录注册；工程可在 languages/C/<标准>/ 添加规则。工作区符号由增量索引提供，旧 blode.completions.json 继续兼容。格式见 [语言规则](../docs/LANGUAGE-RULES.md)。
- menus/explorer.ts 声明右键菜单的标题、显示条件和命令 ID，renderer 执行实际动作。编译入口选择只写入 be.build.entry，可指文件或目录，不立即编译。
- drivers/types.ts 与 drivers/index.ts 提供描述和注册；ST-Link 事实来自 boards/stm32/driver.ts，归档位于应用 tools/STSW-LINK/。

平台细节见 [ESP32-S3](boards/esp32-s3/README.md) 与 [STM32](boards/stm32/README.md)，通用约定见 [架构说明](../docs/ARCHITECTURE.md)。
