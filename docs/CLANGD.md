# clangd 语言服务

C/C++ 的补全、悬停、定义、引用和诊断优先由 [clangd](https://clangd.llvm.org/) 提供。没有安装 clangd 时，编辑器自动回退到上一版内置的工作区索引服务；两种路径共用同一套 Monaco 适配器。

## 版本与获取

固定使用 clangd **23.1.0** 官方独立发行包（`github.com/clangd/clangd`）。当前提供以下宿主：

| 宿主        | 归档                        | SHA-256                  |
| ----------- | --------------------------- | ------------------------ |
| Windows x64 | `clangd-windows-23.1.0.zip` | `23412a24…f7253768c810`  |
| Linux x64   | `clangd-linux-23.1.0.zip`   | `e53b1a96…a3d9dcbafdfd`  |
| macOS x64   | `clangd-mac-23.1.0.zip`     | `1082e663…4745365159253` |

Linux ARM64 目前没有官方独立归档：这些用户需要通过 PATH 或 `BLODE_CLANGD_PATH` 提供已有的 clangd。

两种分发方式：

1. **完整安装包内置**：维护者执行 `npm run fetch:clangd`，把校验后的 clangd 解压到仓库 `tools/clangd/`；`npm run package:full` 检测到该目录后会把它放进 `resources/tools/clangd/`。最终用户无需下载。
2. **简洁包下载安装**：简洁包不包含 clangd。用户在 **首选项 → 工具链 → 版本** 选择 `clangd 23.1.0` 并安装，文件进入工具根目录的 `versions/clangd/23.1.0/`。下载校验大小与 SHA-256，失败不会留下半安装目录。

开发环境可直接放在 `tools/clangd/`，与完整包使用相同路径。

## 查找顺序

宿主按以下顺序选择可执行文件，找到第一个可运行项即停止：

1. `BLODE_CLANGD_PATH` 指定的文件（高级/测试用途）。
2. `<工具根>/clangd/bin/clangd(.exe)`，即开发目录或完整包内置。
3. `<工具根>/versions/clangd/<版本>/bin/clangd(.exe)`，优先固定版本，再按版本号尝试其他已安装版本。
4. 宿主 `PATH` 中的 `clangd`。

`languageClangdState` 返回是否可用、来源、路径、实际版本和当前宿主是否可自动安装；它不会为了查询状态而启动 clangd。

## 进程与项目参数

每个打开的工程最多一个 clangd 进程，首次请求时启动，切换或关闭工程时退出。宿主会：

- 优先复用实际构建生成的 `compile_commands.json`：Arduino CLI 在 `.blode/build/compile_commands.json` 写入完整参数（响应文件、宏、目标、库路径），STM32 构建也写入同一位置。语言服务直接使用这些真实命令，不再自行猜测目标宏、器件头或预包含；换芯片、换工程不需要维护硬编码列表。
- 没有构建数据库时才回退：读取 `be` 的 `build.entry`／`build.files`，递归收集工作区中所有头文件和源文件所在目录（最多 192 个），再合并工具链/SDK 包含目录。STM32 目标/密度宏由板级构建模块提供（与真实编译器同一套模型）；`.uvprojx` 只在存在时补充额外的 Define/Include，缺失不影响。生成私有 `compile_commands.json` 到应用数据目录 `clangd/<工程哈希>/`，不写入用户工程。
- 以 `--compile-commands-dir=<该目录>`、`--background-index`、`--pch-storage=memory`、`--clang-tidy=false`、`--header-insertion=never`、`--log=error` 启动。内存 PCH 是必要的：磁盘 PCH 在部分 Windows 环境会因临时文件创建失败而退回到无索引补全。
- 通过 `initializationOptions.fallbackFlags` 提供工程定义和包含目录，供没有单独编译命令的文件使用。
- 文档使用全量同步；未保存草稿直接发送，不要求先保存磁盘。

诊断只对翻译单元（`.c`、`.cc`、`.cpp`、`.cxx`）发布。头文件和 `.ino` 依赖构建时的包含顺序、Arduino 预处理或目标 ABI，clangd 单独解析无法复现（例如 `uint8_t`、`HardwareSerial` 到 `Print` 的转换、`../hal.h`），因此不把这些解析结果写进“问题”页；补全、悬停和跳转仍由 clangd 按真实构建命令尽力提供，完整错误以真实编译器构建输出为准。

诊断使用 clangd 的 `textDocument/publishDiagnostics`，宿主按文件缓存最近一次结果，编辑器在内容变化后延迟拉取并写入 `clangd` 标记。clangd 可用时，声明式 C 规则标记不再重复显示；clangd 不可用时规则标记恢复。编辑器标记会同步到“问题／警告”页与状态栏计数，点击条目可跳转到对应文件位置；日志错误与编辑器诊断分开来源、合并显示。

clangd 独有的 `unused-includes` 提示默认不显示，避免出现“编译成功但仍有编辑器问题”的噪声；真实编译器诊断（错误、警告）仍完整保留。

## 编辑器行为

| 能力     | clangd 可用                                                  | clangd 不可用                    |
| -------- | ------------------------------------------------------------ | -------------------------------- |
| 补全     | clangd 结果 + 项目／AI 条目；clangd 为空时仍保留宿主索引兜底 | 宿主索引补全                     |
| 悬停     | clangd Markdown；本地目录条目优先                            | 宿主索引／声明式条目             |
| 定义     | clangd；只保留工程内位置                                     | `language.navigate` 与外部头文件 |
| 引用     | clangd；无结果时回退现有索引                                 | 现有索引                         |
| 诊断     | clangd 标记                                                  | 声明式规则标记                   |
| 格式化   | clangd 全文与选区格式化（遵循 `.clang-format`）              | 不提供格式化                     |
| 代码操作 | clangd quick fix／tweak；编辑应用到未保存缓冲区              | 不提供                           |
| 文件符号 | clangd 文档符号；`Ctrl+Shift+O` 快速大纲                     | 不提供                           |
| 工程符号 | clangd `workspace/symbol`；`Ctrl+T` 搜索面板                 | 宿主语言索引过滤                 |

补全项支持 clangd 的 `textEdit` 与片段格式；标签的前导空格会被去掉。工程外路径的定义结果不直接打开，由回退导航通过只读外部源码能力处理。

格式化使用编辑器内置的“格式化文档／格式化选区”命令（Windows 默认 `Shift+Alt+F`）。“转到符号”在编辑器中按 `Ctrl+T` 打开，空结果时仍可用宿主索引搜索。

代码操作中的 quick fix 与 tweak 可能以 LSP 命令（`clangd.applyFix`／`clangd.applyTweak`）返回。宿主执行命令并捕获 clangd 发回的 `workspace/applyEdit` 请求，再把工程内的文本编辑返回给编辑器，因此未保存草稿不会被磁盘版本覆盖。工程外文件的编辑会被丢弃。`Ctrl+Shift+O` 使用 clangd 文档符号显示当前文件大纲。

## 移除的 JSON 补全

内置 C／Arduino JSON 补全目录已删除：`extensions/completions/C/*` 只保留 `rules.json`，`extensions/completions/C++/`、板卡的 `languages/C++/` 和板卡 C catalog 中的补全条目均已移除。诊断规则、工程 `languages/C/<标准>/*.json`、`blode.completions.json` 与 AI 用户条目仍然保留，不再参与内置补全匹配。

## 边界与限制

| 项目             | 值／说明                                                        |
| ---------------- | --------------------------------------------------------------- |
| 单文档           | 1,000,000 字符；超出不发送                                      |
| 编译命令条目     | 最多 4,000 个源文件                                             |
| 包含目录         | 编译配置目录 + 工程内头文件目录，最多 96 个                     |
| 消息体           | 单条 32 MB 上限；初始化 120 秒、普通请求 30 秒                  |
| 定义／引用位置   | 每次最多 1,000 个工程内结果                                     |
| 代码操作         | 每次最多 100 项；编辑只接受工程内文件                           |
| 工程符号         | 每次最多 500 项；搜索面板输入后 160 ms 去抖                     |
| 项目外结果       | 过滤后由原有导航处理，避免任意宿主路径读取                      |
| 宏与目标专用参数 | 只从包含目录与 C 标准生成；没有逐文件构建宏时可能出现头文件误报 |

## 验证

- `tests/clangd-manifest.test.ts`：发行选择、校验元数据、查找顺序。
- `tests/clangd-install.test.ts`：ZIP 边界、前缀剥离、路径穿越拒绝。
- `tests/clangd-session.test.ts`：初始化参数、文档同步、定义／引用转换、诊断缓存。
- `tests/clangd-client.test.ts`：Monaco 片段与 `textEdit`、悬停、诊断类型、格式化／代码操作／符号、不可用回退。
- `tests/clangd-provider.test.ts`：补全优先级、文档同步与无 clangd 时的宿主索引回退。
- `tests/symbol-search.test.ts`：工作区符号的 clangd 与宿主索引两条路径。
- `tests/clangd-service.test.ts`：未安装与错误工程根目录的行为。
- Windows x64 已用真实 clangd 23.1.0 验证补全、悬停、定义和诊断；Linux／macOS 尚未实机验证。
