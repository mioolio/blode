# 补全与规则扩展

C/C++ 补全由 clangd 提供；未安装时回退到宿主内置工作区索引。本目录现在只保留 JSON 诊断规则、工程自定义条目和片段解析。

| 位置                                   | 内容                                                        |
| -------------------------------------- | ----------------------------------------------------------- |
| `C/c99/`、`C/c11/`、`C/c17/`、`C/c23/` | 各标准独立的 `rules.json` 规则；`catalog.ts` 仅用于打包导入 |
| `C/project.ts`                         | 工程 `blode.completions.json` 与 include 解析兼容入口       |
| `rules.ts`                             | 规则选择、JSON 校验、项目覆盖及声明式规则执行               |
| `types.ts`                             | 公共补全契约                                                |

内置 C 标准库函数、关键字、控制流片段和 Arduino API 的 JSON 补全数据已删除。工程仍可在 `languages/C/<标准>/` 中声明自定义 `symbols` / `snippets`，首选项和外部 AI 也能维护用户条目；这些条目与 clangd 结果合并显示。

规则文件格式、工程覆盖和诊断行为见[语言规则](../../docs/LANGUAGE-RULES.md)；clangd 的安装、回退与限制见[clangd 语言服务](../../docs/CLANGD.md)。
