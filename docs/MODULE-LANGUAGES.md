# 模块语言适配指南

本指南面向运行时模块作者，介绍语言声明、补全 JSON、标准版本和编译前规则。适用于 2026-10-30 内部开发更新；整体包结构与安装方式见[模块开发指南](RUNTIME-PLUGINS.md)。

## 所有权与数据流

模块在 `manifest.json` 声明语言，并从自己的 `languages/` 目录提供数据。宿主负责校验、选取当前语言和标准、把数据交给编辑器与构建检查，不修改主程序的全局语言清单。

```text
manifest.languages
  → 当前文件后缀 + be.build.cStandard
  → 模块内 languages/ JSON
  → 补全、片段、悬停、编译前规则
  + 工作区符号索引
  + 用户 AI 补全、显式工程规则
```

声明 `languages` 后，宿主全局 C/Arduino 默认包不参与该模块的补全与默认规则；内置补全包已移除，C/C++ 补全由 clangd 或宿主索引提供。模块目录仍可声明自定义补全条目与声明式规则。未声明该字段的旧模块继续使用原有机制。模块之间可以使用相同函数名，各自的数据不共享也不写回主程序。

## 目录规范

```text
languages/
  C/
    c99/catalog.json
    c11/catalog.json
    c17/catalog.json
    c23/catalog.json
```

这是当前 ESP32 与 STM32 标准模块的布局。每个 C 目录只保留自己的声明规则（可附带模块自定义补全条目），不混入其他标准，也不再包含内置标准库或 Arduino 补全数据。项目使用 `be.build.cStandard` 选择标准；C23 对应的编译器命令行名称由工具链适配处理。

较大的模块仍可按多个 JSON 文件拆分规则或自定义条目。每个文件独立遵循相同 schema，清单列出所有需要的路径；宿主不自动扫描未声明文件。文件名只是组织方式，不改变补全优先级。

## 声明多语言

下面是放入 `manifest.languages` 的完整字段值：

```json
{
  "mode": "declared",
  "default": "cpp",
  "entries": [
    {
      "id": "c",
      "editorLanguage": "cpp",
      "extensions": [".c"],
      "catalogs": [],
      "standards": {
        "c99": ["languages/C/c99/catalog.json"],
        "c11": ["languages/C/c11/catalog.json"],
        "c17": ["languages/C/c17/catalog.json"],
        "c23": ["languages/C/c23/catalog.json"]
      }
    },
    {
      "id": "cpp",
      "editorLanguage": "cpp",
      "extensions": [".cpp", ".cc", ".cxx", ".h", ".hpp", ".ino"],
      "catalogs": []
    }
  ]
}
```

| 字段             | 含义                                                 |
| ---------------- | ---------------------------------------------------- |
| `mode`           | `declared` 为语言列表；`fixed` 为单语言              |
| `default`        | 已声明的默认语言 ID，用于模块默认上下文              |
| `entries[].id`   | 模块中的语言 ID，例如 `c`、`cpp`                     |
| `editorLanguage` | Monaco 语言 ID；C 与 C++ 当前均使用 `cpp` 编辑器服务 |
| `extensions`     | 小写文件后缀；同一模块中不能重复归属                 |
| `catalogs`       | 始终加载的该语言 JSON，全部相对包根                  |
| `standards`      | 按 C 标准选择的附加目录；不跨版本合并                |

文件路径限定在 `languages/` 下，使用 `/`，不允许绝对路径、`..` 或逃出包目录的链接。语言列表最多 32 项，每项最多 32 个后缀，每份清单数组最多 64 个文件。

`id: c` 与 `editorLanguage: cpp` 分别表达源语言和编辑器服务，不表示将 C 工程按 C++ 编译。实际编译语言与编译器仍由工程、构建后端和文件类型决定。模块自定义的 C++ 条目应直接声明在模块 `languages/` 中，不再叠加宿主内置的 C++ 补全数据。

## 固定单语言

只支持一种语言的模块使用 `fixed`，并且必须只有一个条目：

```json
{
  "mode": "fixed",
  "default": "cpp",
  "entries": [
    {
      "id": "cpp",
      "editorLanguage": "cpp",
      "extensions": [".ino", ".cpp", ".h"],
      "catalogs": []
    }
  ]
}
```

固定语言声明只作用于列出的源码后缀，不把 JSON、Markdown 或二进制文件强制改成代码。声明未内置的新 `editorLanguage` 不会自动安装新的语法高亮或语言服务器；需要宿主具备相应编辑器服务。

## 补全 JSON 格式

每个 catalog 使用 UTF-8 严格 JSON，不支持注释或尾逗号。以下例子同时提供函数、片段、成员及规则，可分别拆到多个文件：

```json
{
  "schemaVersion": 1,
  "language": "cpp",
  "triggerCharacters": [".", "#"],
  "symbols": [
    {
      "name": "camera_init",
      "kind": "function",
      "detail": "int camera_init(const camera_config_t *config)",
      "documentation": "初始化本模块摄像头配置。",
      "insertText": "camera_init(${1:config})"
    }
  ],
  "snippets": [
    {
      "name": "guard-return",
      "kind": "snippet",
      "detail": "检查返回值",
      "insertText": "if (${1:result} != 0) {\n\treturn ${1:result};\n}"
    }
  ],
  "members": [
    {
      "owner": "Camera",
      "members": [
        {
          "name": "capture",
          "kind": "method",
          "detail": "Frame capture()",
          "insertText": "capture()"
        }
      ]
    }
  ],
  "rules": [
    {
      "id": "legacy-camera-init",
      "kind": "call",
      "names": ["legacy_camera_init"],
      "severity": "warning",
      "message": "请使用 camera_init。",
      "enabled": true
    }
  ]
}
```

该示例展示扩展格式，不代表 ESP32 标准模块提供这些摄像头函数。模块作者应只声明自己的实际 API。

`language` 必须等于对应条目的 `editorLanguage`。`symbols`、`snippets`、`members`、`rules` 均可省略；只含规则的文件同样需要 `schemaVersion` 和 `language`。

补全条目的 `kind` 可为 `function`、`method`、`variable`、`constant`、`type`、`keyword`、`snippet`、`property`。`name` 和 `detail` 必填；`documentation`、`insertText`、`sortText` 可选。插入文本使用编辑器片段占位符，例如 `${1:value}`。`members` 按 `owner` 组织成员，不等同于编译器完整类型推导。

## 规则检查与诊断

规则的 `kind: call` 匹配调用名称，`kind: token` 匹配标识符；`names` 是名称列表。`severity` 为 `warning` 或 `error`，`enabled` 默认开启。目前语义规则只支持 C/C++，其他语言可声明补全，但非空规则会产生明确诊断，避免按 C 的注释和字符串规则误报。它们是有定位信息的声明式检查，不是可执行脚本，也不替代真实编译器的语法、类型或链接诊断。

构建前先验证 catalog，再检查当前源码。错误会进入问题与输出列表；错误级规则阻止继续构建，警告级规则保留提示。所选标准未声明、文件缺失、字段错误或 JSON 不合法都会产生诊断。宿主不会为了让错误消失而回退到另一个标准或另一个模块的规则。

工程可在 `languages/C/<标准>/` 添加自己的规则，具体格式沿用[工程语言规则](LANGUAGE-RULES.md)；模块 catalog 与工程覆盖文件的 schema 不同，不应直接混用。工作区自定义函数继续由 `.blode/index/` 的增量索引提供，无需人工抄入 catalog。

AI 的补全维护接口作用于用户配置，不会直接修改模块发行目录。默认关闭的预测提示继续由已连接的外部 AI 提供；语言 catalog 本身不发起模型请求。

## 二进制宿主与打包

- **内置模块**：`device/adapter.ts` 静态导入本模块 JSON，随宿主构建嵌入，不在运行时反查仓库 `.ts` 路径。
- **独立模块**：`package:runtime` 保留 `languages/` 资源，宿主按清单从包目录加载。用户无需主程序源码或 TypeScript。
- **授权**：语言发现仅解析 JSON，不执行模块原生代码；文件仍受包路径、大小与内容校验约束。修改语言资源会改变包内容，后续执行需重新确认。
- **更新**：修改后重新打包、替换完整模块并重启宿主，避免旧业务代码与新语言清单混用。

## 作者验收清单

1. `.c`、`.cpp`、`.ino`、`.h` 等后缀分别加载预期语言，切换文件不残留其他模块条目。
2. C99/C11/C17/C23 的补全与规则分别测试，未声明标准明确报错。
3. 切换到 STM32 后不出现 ESP32 Arduino 模块条目；用户主动添加的 AI 条目仍保留。
4. 无效 JSON、错误 `language`、重复后缀、缺文件和越界路径得到定位诊断。
5. 工作区符号、工程规则、AI 维护条目与默认关闭的预测功能可正常叠加。
6. 在没有源码仓库的宿主中安装发行包，确认语言 JSON 能被读取且无需加载原生业务代码。
