# 内置语言服务（LSP 回退）

C/C++ 的补全与悬停优先由 clangd 回答，见 [clangd 语言服务](CLANGD.md)。clangd 未安装或启动失败时，编辑器回退到宿主内置的轻量 LSP 子集：它复用导航使用的增量源码索引，并解析当前文件直接包含的外部头文件。两种实现共用 Monaco 适配器、文档同步和结果转换。

回退服务不是完整的 clangd：没有类型推导、宏展开和模板实例化。定义、声明、引用和 `#include` 定位在回退路径使用 [`language.navigate`](SOURCE-NAVIGATION.md)；诊断使用前端的声明式语言规则。

## 组成

| 位置                                           | 责任                                           |
| ---------------------------------------------- | ---------------------------------------------- |
| `src/shared/lsp.ts`                            | LSP 消息类型、工作区文档 URI、边界校验         |
| `src/core/lsp-schemas.ts`                      | 传输信封和每种消息的参数校验                   |
| `src/core/language-server.ts`                  | 回退服务：文档同步、补全、悬停、头文件符号缓存 |
| `src/core/clangd/`                             | clangd 发现、安装、进程、会话与编译参数        |
| `src/renderer/editor/workspaceDocumentSync.ts` | 版本有序的全量文档同步，两个客户端共用         |
| `src/renderer/editor/lspConvert.ts`            | LSP 结果到 Monaco 补全、悬停和标记的统一转换   |
| `src/renderer/editor/workspaceLsp.ts`          | 回退服务的 Monaco 客户端                       |
| `src/renderer/editor/clangd/client.ts`         | clangd 的 Monaco 客户端与可用性探测            |
| `src/renderer/editor/clangd/providers.ts`      | 格式化、代码操作、文档符号与命令 provider      |
| `src/renderer/editor/clangd/convert.ts`        | 工作区编辑、文档符号与代码操作的 Monaco 转换   |
| `src/renderer/workspace/symbolSearch.ts`       | 工程符号搜索（clangd 或宿主索引回退）          |
| `src/renderer/components/SymbolSearch.tsx`     | `Ctrl+T` 符号搜索面板                          |
| `src/renderer/editor/completionProvider.ts`    | 合并项目／AI 条目、clangd、回退索引与本地兜底  |

## 传输

桌面 IPC 与 Web 宿主共用同一组方法，参数带当前工程根目录；宿主在每次调用时校验根目录仍是打开中的工程，否则返回 `error.collaborationProjectChanged`。

| 方法                        | 方向          | 用途                                                                      |
| --------------------------- | ------------- | ------------------------------------------------------------------------- |
| `languageLspRequest`        | 编辑器 → 宿主 | `initialize`、`shutdown`、`textDocument/completion`、`textDocument/hover` |
| `languageLspNotify`         | 编辑器 → 宿主 | 一批 `didOpen`、`didChange`、`didClose`，最多 32 条                       |
| `languageClangdState`       | 编辑器 → 宿主 | clangd 可用性、来源与版本                                                 |
| `languageClangdRequest`     | 编辑器 → 宿主 | clangd 的补全、悬停、定义、引用、格式化、代码操作、符号与命令             |
| `languageClangdNotify`      | 编辑器 → 宿主 | 批量文档同步                                                              |
| `languageClangdDiagnostics` | 编辑器 → 宿主 | 读取最近一次 clangd 诊断缓存                                              |

文档以 `blode://workspace/<工程相对路径>` 标识，路径按段编码；`..`、绝对路径、反斜杠、冒号和编码后的分隔符都会被拒绝。渲染器只同步当前工程内的模型，外部只读源码不参与同步。

文档采用全量同步：每次变更发送完整文本，宿主按版本合并。客户端只发送版本号变化过的模型，并将同一批变更放入一次调用，保持版本顺序。

## 回退补全来源

1. 工作区符号：保存的文件，以及当前打开、尚未保存的草稿。草稿覆盖磁盘版本，因此新写的函数和宏可以立即补全。
2. 直接包含的外部头文件：对当前文件最多 12 个直接 `#include` 做包含解析，读取命中的 SDK／Arduino／工具链头文件并在 15 秒内缓存解析结果。
3. 项目条目：`blode.completions.json`、工程 `languages/C/<标准>/*.json`、AI 用户条目和模块用户贡献仍由前端合并；内置 C/Arduino JSON 补全目录已移除，见 [clangd](CLANGD.md#移除的-json-补全)。
4. 成员访问 `对象.`／`对象->` 仍交给声明式目录的 `owner` 分组，回退服务返回空列表，避免全局符号污染成员提示。

前端按标签去重：同一名称只保留一处，项目／AI 条目优先于语言服务结果，服务结果优先于本地草稿索引兜底。服务不可用（工程未打开、请求失败）时仍使用本地草稿索引，补全不会中断。

函数项支持片段格式；悬停显示签名与来源位置，外部头文件使用宿主返回的显示路径。

## 边界

| 限制         | 值                                     |
| ------------ | -------------------------------------- |
| 单文档文本   | 1,000,000 UTF-16 码元                  |
| 已同步文档   | 64 个，按最近打开淘汰                  |
| 单次补全条目 | 600 项，超出时标记 `isIncomplete`      |
| 直接包含解析 | 12 个／次，头文件符号每个最多 1,200 项 |
| 头文件缓存   | 15 秒；外部源码缓存 20 秒              |
| 工程索引刷新 | 1 秒；其间只增量合并变化的草稿         |

语言服务不写工程文件、不执行命令、不跟随符号链接；外部头文件仍由导航服务按只读源文件读取。工程切换或关闭后旧根目录的请求会被拒绝，已同步的旧文档在下一次打开时清理。

## 验证

- `tests/language-server.test.ts`：能力声明、前缀过滤、草稿覆盖、直接包含头文件合并与缓存、成员访问让位、悬停、URI 边界、外来根目录、非法参数、`didChange` 生效。
- `tests/workspace-lsp.test.ts`：`initialize` 握手、`didOpen`／`didChange` 版本同步、结果去重与片段格式、无 LSP 时的本地兜底。
- `tests/module-languages.test.ts`：模块语言目录、用户条目与本地符号在异步补全路径下保持原有作用域。
- clangd 自身的测试见 [clangd 验证](CLANGD.md#验证)。

这些是服务级测试，不包含真实 SDK 头文件规模或浏览器帧率验收。
