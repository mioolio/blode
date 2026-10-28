# Blode Studio

面向单片机与硬件开发的模块化桌面工作台。核心不绑定某一家芯片：工程、编辑、编译、烧录、串口、分区布局、浏览器工作台和 AI 接入都通过稳定接口组合；不同 MCU、开发板、烧录协议各自放在独立适配目录中。

> 目标：让同一套工作台适配尽可能多的单片机与硬件开发场景，而不是把某一个型号写死在核心代码里。

应用本体使用 Electron、TypeScript、React 19 和本地打包的 Monaco 编辑器。界面默认中文，可切换英文。应用运行时是 Node/Electron；Python 只作为当前 Arduino/esptool 工具链的外部依赖使用，不进入安装包。

## 设计原则

- **核心硬件无关**：`src/core` 只负责工程、进程、文件、串口和通用生命周期，不包含具体芯片引脚或烧录算法。
- **一个文件夹一个适配场景**：板卡、烧录器、补全、菜单分别放在 `extensions/` 下的独立目录，新增硬件不需要改核心。
- **工程清单可读**：工程根目录的 `be` 是 JSON 引导文件，保存板卡、分区、工具链和编译文件列表。
- **可验证优先**：类型检查、自动化测试和真实硬件构建结果分开记录，不把“通过测试”当作“已支持某块板”。
- **模块化可维护**：单个源码文件不超过 1000 行；界面样式、核心服务和组件按职责拆分。

## 当前能力

- 多面板工作台：资源管理器、Monaco 编辑器、设备检查器、底部编译/串口/问题控制台。
- VS Code 风格编辑体验：标签、拆分编辑器、未保存星号、光标行列、补全、悬停、查找和格式化。
- 工程管理：通过 `be` 导入项目区，文件树右键菜单，内联新建/重命名，按工程保留标签状态。
- 构建与烧录：托管或自定义工具链，真实编译结果计算 Flash/RAM 占用，烧录前校验构建一致性、芯片和容量。
- 分区布局：拖拽调整、缩放、重叠检测，系统区锁定，容量不足时阻止无效保存。
- 串口与网页工作台：串口监视器、本机 HTTP + SSE 浏览器访问，可选的桌面到网页草稿同步。
- 自动化：本地 JSON-RPC 系统管道、MCP 桥接，AI 与界面共用同一套校验和操作锁。

## 快速开始

需要 Node.js 24 或更高版本和 npm。应用本体不依赖 Python；只有当前 ESP32 工具链和示例中的外部拍照脚本可能调用本机 Python，且不会打包进应用。

```powershell
npm ci
npm run dev
```

启动后默认不打开工作区：

1. 点击“选择 be 项目文件”，选择工程目录中的 `be`；或直接打开文件夹。
2. `be` 不存在时会自动创建，并在首次打开时补全默认配置。
3. 在右侧选择板卡和串口，安装/更新工具链，然后编译、烧录。

生产模式：

```powershell
npm run build
npm start
```

Windows 便携版：`npm run package`，输出到 `release/`。

## 工程引导文件 `be`

`be` 是工程根目录下的 JSON 文件，既是项目标记，也是配置和编译入口：

```json
{
  "version": 1,
  "name": "my-hardware-project",
  "boardId": "esp32-s3",
  "port": "COM3",
  "baudRate": 460800,
  "flashSize": 16777216,
  "partitions": [],
  "toolchain": {
    "mode": "managed",
    "arduinoCli": "",
    "python": "",
    "additionalUrls": [],
    "fqbn": "esp32:esp32:esp32s3"
  },
  "build": {
    "sketch": "main.ino",
    "files": ["main.ino", "src/config.h"]
  }
}
```

- `boardId` 选择 `extensions/boards/` 中已注册的适配器。
- `build.sketch` 指定主程序；`build.files` 指定参与编译的文件。缺省时回退到扫描工程根目录的 `.ino`。
- 示例中的 `partitions` 省略了具体条目；实际工程必须由对应板卡适配器生成并通过完整性校验。
- 界面里保存配置会写回 `be`，并保留 `build` 段。
- 旧工程继续兼容 `.blode/project.json`；构建产物仍写入 `.blode/build/`。

## 每个文件夹是一个适配场景

| 目录 | 适配场景 |
| --- | --- |
| `extensions/boards/esp32-s3/` | ESP32-S3：Arduino-ESP32 编译、分区约束、PSRAM/Flash 选项 |
| `extensions/boards/generic/` | 通用 Espressif 预编译二进制烧录，不虚构编译器 |
| `extensions/programmers/` | 烧录协议参数，例如 esptool 地址、波特率和校验 |
| `extensions/completions/` | 按语言声明的补全、成员补全和悬停数据 |
| `extensions/menus/` | 资源管理器右键菜单的声明式条目 |
| `extensions/registry.ts` | 可信扩展的显式注册表，工作区清单不会自动执行 |
| `src/core/` | 主进程、工程、配置、工具链、编译、串口和公共锁 |
| `src/shared/` | 界面、核心与自动化共用的数据契约 |
| `src/renderer/` | 多面板界面、编辑器、分区视图和状态管理 |
| `src/automation/` | JSON-RPC 系统管道、统一方法映射和 MCP 适配 |
| `examples/blink/` | 可直接打开的 Arduino 心跳示例 |
| `tests/` | 协议、路径、配置、分区、适配器和界面文案测试 |

新增一个 MCU 或硬件场景时，优先新建独立目录，而不是修改现有板卡：

1. 在 `extensions/boards/<vendor-chip>/` 创建 `manifest.json`、`adapter.ts`、`README.md`。
2. 实现 `BoardAdapter`：默认配置、分区规则、编译参数和校验逻辑。
3. 如果烧录协议不同，在 `extensions/programmers/` 增加对应参数生成器；不能用 esptool 代替 STM32、RP2040 等芯片。
4. 在 `extensions/registry.ts` 显式注册，并在语言 JSON 中补充 `descriptionKey`。
5. 增加该型号的配置/分区测试；有真实硬件时再补充构建和烧录验证记录。

更细的扩展边界见 [扩展说明](extensions/README.md) 和 [架构文档](docs/ARCHITECTURE.md)。

## 从代码到设备

不同板卡的按钮流程一致，具体参数由适配器决定：

1. 选择板卡和串口，识别芯片并核对实际 Flash 容量。
2. 安装或选择工具链；托管模式会校验下载包并记录实际版本。
3. 调整分区布局并保存；系统保留区和芯片约束由适配器校验。
4. 编译并在资源区查看真实 Flash/RAM 占用。
5. 烧录前检查构建与源码/配置一致、产物未变化，然后写入固件。
6. 用串口监视器查看运行输出。

当前内置的 ESP32-S3 实机记录见 [硬件验证记录](docs/HARDWARE-VALIDATION.md)。其他板卡的验证结果应放在各自适配目录的 README 中，避免把单台电脑的串口号写成产品默认值。

## AI 与自动化

Windows 使用命名管道，macOS/Linux 使用 Unix socket，传输为带认证的 JSON-RPC 2.0 换行帧；MCP stdio 桥把相同方法映射为 MCP 工具。界面和 AI 共用核心服务、路径检查、配置校验和操作锁。

开发模式还会启动浏览器工作台（默认 `http://127.0.0.1:47821`），默认只监听本机；外部访问需在 `config/application.json` 中开启，并使用 `web-token.txt` 中的令牌。方法 schema、调用示例和 MCP 配置见 [AI 系统管道说明](docs/AI-PIPE.md)。

## 开发与测试

```powershell
npm run typecheck
npm test
```

修改前端后由 Vite 热更新；修改主进程、preload、系统管道或板卡适配器后，需要退出并重新运行 `npm run dev`。

代码约定：

- 单个源码文件不超过 1000 行，超出时按职责拆分。
- 核心不写具体厂商逻辑；硬件事实放进对应适配目录。
- 新增错误、状态和界面文案时同时补充中英文 JSON。
- 不提交 `node_modules/`、`dist/`、`release/`、`tools/`、`.blode/build/` 或本机串口/令牌等环境相关文件。

## 贡献

欢迎贡献新的板卡、烧录器、补全包、界面改进和文档修正。

仓库：<https://github.com/mioolio/blode>

提交 Pull Request 前建议：

1. Fork 仓库并从 `main` 创建分支。
2. 每个适配场景放在独立文件夹，附上 README 和测试。
3. 运行 `npm run typecheck` 和 `npm test`；涉及硬件时说明板卡型号、工具链版本和验证范围。
4. 在 PR 描述中写清楚改了什么、为什么这样拆分，以及哪些项目尚未验证。

如果你愿意的话，欢迎在 <https://github.com/mioolio/blode> 提交代码、Issue 或适配方案。

## 许可

本项目使用 Apache License 2.0，详见 [LICENSE](LICENSE)。
