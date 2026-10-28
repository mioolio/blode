# Blode Studio 功能展示与真实硬件案例

Blode Studio 是一个面向单片机的模块化桌面工作台。它不只负责“把代码编译出来”，还把**芯片识别、资源分配、编译边界检查、烧录确认和真实回读**串成一条可验证的链路。

> 本文包含一次真实的 STM32F103C8T6 实机记录：标称 64 KiB 的芯片报告 128 KiB，75,888 字节固件写入后在 `0x08010000` 读回 `0xA5A5A5A5`。记录时间：2026-10-29（Asia/Shanghai）。

---

## 1. 能做什么

| 能力     | 说明                                                                              |
| -------- | --------------------------------------------------------------------------------- |
| 自动识别 | ST-Link 枚举、USB 串口候选、芯片 ID/Flash/SRAM 探测；多候选不默认取第一台         |
| 多平台   | ESP32-S3（Arduino）、STM32 / ST-Link，以及可自行注册的平台包                      |
| 源码构建 | STM32 使用 Arm Compiler 6（armclang / armlink / fromelf）；ESP32 使用 Arduino CLI |
| 资源布局 | 修改物理容量、应用区大小，添加数据区/系统区，自定义名称与颜色                     |
| 容量纠偏 | 芯片误报容量时可手动覆盖；重新识别不会覆盖手动值                                  |
| 编译检查 | 以真实 ELF 装载范围、二进制镜像和 SRAM 段检查资源占用                             |
| 越界警告 | 固件超出应用区或覆盖保留区时输出 WARNING；仍可在二次确认后烧录                    |
| 真实烧录 | ST-Link / st-flash 写入后校验；支持回读验证                                       |
| 首选项   | “文件 → 首选项”打开“常规 / 工具链 / 驱动”二级菜单，弹窗呈现，不占用编辑页签       |
| C 补全   | 递归解析工程头文件、宏、函数、typedef；支持 `blode.completions.json` 自定义条目   |
| 工作区前 | 未打开工程也可扫描/识别开发板和调试器；MCP 的 `device.probe` 可带可选 config      |
| 自动化   | 带认证的 JSON-RPC 系统管道与 MCP 桥接，共用同一 CoreApi                           |
| 可扩展   | `extensions/boards/<id>/` 完整平台包；启动文件、scatter、工具链和布局按平台拆分   |

界面细节：

- 资源布局在窄窗口下自动改为单栏并支持滚动。
- 添加数据区/系统区使用一个“+ 添加区域”按钮和二级菜单，不再平铺按钮。
- 程序 Flash 和 RAM 的已用/上限会跟随当前配置，而不是停留在旧构建。

---

## 2. 真实案例：64 KiB 标称，128 KiB 实测

### 2.1 硬件

| 项目           | 值                                        |
| -------------- | ----------------------------------------- |
| 开发板         | 常见 STM32F103C8T6 “Blue Pill” 最小系统板 |
| 调试器         | ST-Link V2，`V2J27S6`                     |
| ST-Link 序列号 | `7501000123••••••`（公开文档已截断）      |
| 芯片 ID        | `0x410`（STM32F1xx_MD）                   |
| SRAM           | 20 KiB                                    |
| Flash 自述容量 | **128 KiB (131072 bytes)**                |
| 目标电压       | 3227 mV                                   |
| 日期           | 2026-10-29（Asia/Shanghai）               |

> `st-info` 只报告 `STM32F1xx_MD` / `0x410` 这一中容量系列，不能从 ID 单独区分具体型号；C8T6 是这块板卡的标称型号。容量结论只针对本次被测单元。

`st-info` 的实际输出：

```text
Found 1 stlink programmers
  version:    V2J27S6
  serial:     7501000123••••••  (redacted)
  flash:      131072 (pagesize: 1024)
  sram:       20480
  chipid:     0x410
  dev-type:   STM32F1xx_MD
  voltage:    3227 mV
```

这就是案例的起点：传统资料通常把 STM32F103C8T6 写作 64 KiB，但这颗芯片的 Flash 容量寄存器报告 128 KiB。

### 2.2 工程配置

示例工程位于 [examples/stm32f103-128k](examples/stm32f103-128k/README.md)。核心配置：

```json
{
  "boardId": "stm32",
  "flashSize": 131072,
  "flashSizeOverride": true,
  "partitions": [{ "id": "firmware", "name": "firmware", "type": "app", "offset": 0, "size": 131072 }],
  "programmer": {
    "transport": "stlink",
    "serialNumber": "7501000123••••••",
    "frequencyKhz": 1800,
    "targetChipId": "0x410"
  },
  "build": { "entry": "src/flash_70k.c" }
}
```

- `flashSize` 是物理容量。
- `partitions[0].size` 是应用区，也是编译/布局检查的软上限。
- `flashSizeOverride: true` 表示这是用户确认过的容量，重新识别时不会被探测结果覆盖。
- 当前烧录模型仍是从 `0x08000000` 写入单一固件；应用区是软边界，物理 Flash 是硬边界。

### 2.3 固件

`src/flash_70k.c` 放入 **72 KiB** 的 `0xA5` 图案，并在运行时读取 `0x08010000`：

```c
#define FLASH_70K_BYTES   (72u * 1024u)
#define FLASH_70K_PROBE   0x08010000u
#define FLASH_70K_FILL    0xA5u

__attribute__((used))
const uint8_t flash_70k_blob[FLASH_70K_BYTES] = {
    [0 ... (FLASH_70K_BYTES - 1u)] = FLASH_70K_FILL
};
```

`0x08010000` 正好是 **64 KiB 之后的第一个字**。
如果芯片只有 64 KiB，通常会读到镜像（例如复位向量/初始栈指针），而不是图案；如果 64 KiB 以上真实存在，就能读回 `0xA5A5A5A5`。

### 2.4 编译结果

Blode Studio 的 STM32 构建记录：

```text
Flash application usage: 75888 / 131072 bytes
SRAM usage: 1028 / 20480 bytes
SRAM allocation includes 1024 bytes reserved for the descending stack.
```

| 资源  |     已用 |      上限 |
| ----- | -------: | --------: |
| Flash | 75,888 B | 131,072 B |
| SRAM  |  1,028 B |  20,480 B |

75,888 字节已经超过 65,536 字节；如果链接器仍按 64 KiB 限制，构建会直接失败。因此，这个 `.bin` 本身就能证明构建链路使用了 128 KiB 的应用区。

### 2.5 真实烧录与回读

使用与应用 ST-Link 运行路径相同的工具和参数写入：

```powershell
tools/stlink/bin/st-flash.exe `
  --serial <your-st-link-serial> `
  --freq 1800 --hot-plug --format binary `
  write .blode/build/firmware.bin 0x08000000
```

实际结果：

```text
75/75  pages written
Starting verification of write complete
Flash written and verified! jolly good!
```

随后从 `0x08010000` 回读 16 字节：

```powershell
tools/stlink/bin/st-flash.exe `
  --serial <your-st-link-serial> `
  --freq 1800 --hot-plug `
  read read64.bin 0x08010000 16
```

```text
read from address 0x08010000 size 16
```

回读内容：

```text
a5a5a5a5 a5a5a5a5 a5a5a5a5 a5a5a5a5
```

**结论：**

1. 固件实际写入并校验通过，共 75 页。
2. 64 KiB 边界之后仍然可读，且读到的正是固件写入的 `0xA5` 图案。
3. 这颗芯片在本次测试中可使用 128 KiB Flash；它不只是“报告 128 KiB”，而是**真实写入、回读、校验**通过。
4. 这不代表所有标称 C8T6 的芯片都能稳定使用 128 KiB；容量、擦除页和克隆批次存在差异，必须逐颗实测。

串口接 PA9/PA10（115200 8N1）时，固件会打印自检结果：容量寄存器值、72 KiB 图案首尾字节、尾部 4 KiB 匹配数、`0x08010000` 读值，以及 `128KB OK` / `64KB only` 的结论。本次验证使用烧录器回读作为客观证据，没有把未采集的串口文本写成日志；接入串口后可直接复现这段输出。

即使没有串口，烧录器的写入校验和 `0x08010000` 回读也足以验证本次写入。若需要运行级证据，还应补充串口日志、LED 心跳或调试器读取外设状态。

### 2.6 这个功能解决了什么问题

常见工具通常只读取容量寄存器，然后给出一个“能不能编译”的结论。Blode Studio 把这件事拆成可检查的步骤：

- 探测值与用户确认值分开；
- 应用区/物理 Flash/保留区分开；
- 编译结果与烧录前确认分开；
- 写入校验与运行验证分开；
- 越界时给出警告，而不是静默截断或直接替用户决定。

这让“厂家说 64 KiB、芯片说 128 KiB、固件实际用了 74 KiB”这类情况有据可查，而不是靠猜。

---

## 3. 资源布局与编译检查

STM32 固定布局现在支持：

- 修改物理 Flash 容量；
- 修改应用区大小；
- 添加数据区/系统区，设置名称、大小和颜色；
- 用加号 + 二级菜单添加区域；
- 编译后检查固件是否超出应用区或覆盖保留区；
- 越界时输出 WARNING，并在烧录确认弹窗中再次提示；
- 用户仍可在二次确认后烧录（只要没有超过物理 Flash）。

数据区和系统区目前是**保留区域**，没有文件系统写入路径，因此只能检查固件是否侵占它们，不能统计“数据区实际用了多少”。RAM 也仍按 STM32F1 中容量 profile 固定为 20 KiB，并保留 1 KiB 栈；当前不提供任意 RAM 分配。

---

## 4. 任意用户编写自己的平台

平台包是源码级、可审查的扩展，不是在线热插拔脚本。新增一个开发板/芯片系列时，复制并实现：

```text
extensions/boards/my-board/
  manifest.json    # id、入口、runtime、能力
  adapter.ts       # 默认配置、容量、布局元数据、校验
  runtime.ts       # 探测、构建、烧录、工具链状态
  layout.ts        # 可选的地址范围/应用区逻辑
  compiler.ts      # 可选：平台自己的编译器集成
  programmer.ts    # 可选：平台自己的烧录器
  README.md        # 目标、限制、接线和验证记录
```

`manifest.json` 声明能力，例如：

```json
{
  "id": "my-board",
  "entry": "adapter.ts",
  "runtime": "runtime.ts",
  "runtimeApiVersion": 1,
  "capabilities": ["compile", "flash", "probe", "serial", "layout", "partitions"]
}
```

然后在两个注册表登记：

```ts
// extensions/registry.ts
import { myBoardAdapter } from './boards/my-board/adapter.js';
const adapters = new Map([...existing, [myBoardAdapter.definition.id, myBoardAdapter]]);

// extensions/runtime-registry.ts
export const createPlatformRuntimes: CreatePlatformRuntimes = (host) => [
  ...,
  createMyBoardRuntime(host),
];
```

边界原则：

- 平台目录拥有厂商事实：Flash 地址、容量、探测命令、工具链、烧录参数、布局规则。
- `src/core` 只提供通用宿主能力，不按厂商拼接命令。
- renderer 不导入 Node、不直接启动编译器；平台能力通过 `BoardDefinition.capabilities` 暴露。
- 当前扩展随应用静态构建；工程目录中的任意 JavaScript 不会被执行。这是安全边界，不是热安装插件市场。

用户可以在这个边界内编写自己的：

- 启动文件、scatter/linker 配置；
- 芯片初始化、时钟、引脚、外设驱动；
- 自定义资源区、容量策略和烧录参数；
- 新平台包、编译器或烧录器适配。

---

## 5. 快速开始

```powershell
npm ci
npm run dev
```

打开 [examples/stm32f103-128k/be](examples/stm32f103-128k/be)，连接 ST-Link，识别芯片，构建并烧录。

更多细节：

- [STM32 使用说明](docs/STM32.md)
- [硬件验证记录](docs/HARDWARE-VALIDATION.md)
- [平台扩展约定](extensions/README.md)
- [架构说明](docs/ARCHITECTURE.md)

---

## 6. 边界声明

本案例只证明**这一颗被测芯片**在本次写入、回读、校验中可以使用 128 KiB。它不能证明所有 STM32F103C8T6 都是 128 KiB，也不能替代电压、时钟、擦除寿命、长期运行和量产一致性验证。

“无限可能”来自可编写、可审查、可验证的平台代码，而不是跳过校验。Blode Studio 的目标是让每一次越界、覆盖和烧录都可见、可确认、可回溯。
