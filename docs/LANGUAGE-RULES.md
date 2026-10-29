# 语言补全与规则

Blode 将语言数据、项目符号索引和编译器分开维护。补全与轻量检查可通过 JSON 调整；编译仍由所选工具链执行。

内部开发版的设备模块可以通过 `manifest.languages` 自行声明固定语言或语言列表。本文说明宿主默认与工程级规则；模块自己的 JSON 格式、独立目录与二进制部署见[模块语言适配](MODULE-LANGUAGES.md)。模块声明存在时不混入宿主默认包，工程规则仍可显式叠加。

首选项及外部 AI 的补全清单继续生效。C 文件兼容旧的 `cpp` 用户条目；显式 `c` 条目优先，同名可覆盖或禁用，`owner` 可配置结构成员补全。普通源码输入复用规则包，仅增量检查当前加载的变更文件。

## 目录与版本

```text
extensions/completions/
├─ C/
│  ├─ c99/                 # 独立 C99 数据
│  ├─ c11/                 # 独立 C11 数据
│  ├─ c17/                 # 独立 C17 数据
│  ├─ c23/                 # 独立 C23 数据
│  ├─ index.ts             # 显式注册标准目录
│  └─ project.ts           # 工程 C 符号解析
├─ C++/
│  └─ arduino/             # Arduino API 和基础语法 JSON
├─ rules.ts               # JSON 校验及声明式规则执行
└─ types.ts               # 公共补全契约
```

每个 C 标准目录均包含 `a.json` 到 `z.json`，按函数名首字母组织标准库条目；`keywords.json` 保存关键字，`control-flow.json` 保存分支与循环片段，`types.json` 保存类型和常量，`rules.json` 保存源代码检查规则。`manifest.json` 列出该版本文件，`catalog.ts` 负责构建时的显式导入。编辑现有 JSON 后即可重新构建；新增内置文件时也需更新本版本的 manifest 和 catalog。

四个版本独立存放，不从其他标准目录继承。切换标准不会加载其他版本的数据。例如 C99 包不包含 `_Atomic`，C17 包不包含 C23 的 `nullptr` 和 `strdup`。当前内置常用标准库函数、类型、控制流和版本提示；完整类型检查由 GCC、Clang 或 Arm Compiler 提供。

标准命名采用 [WG14 项目列表](https://open-std.org/jtc1/sc22/wg14/www/projects.html) 中的 C99、C11、C17 和 C23。C17 对应 ISO/IEC 9899:2018，C23 对应 ISO/IEC 9899:2024；这里没有 `c21` 目录。

## 工程选择

在工程 `be` 的 `build` 中指定 C 标准：

```json
{
  "build": {
    "entry": "src/main.c",
    "cStandard": "c17"
  }
}
```

省略 `cStandard` 时使用 C17。此字段控制 C 规则及 C 编译方言；C++ 和 Arduino 的库补全位于独立目录。

## 自定义补全

在工程中创建 `languages/C/c17/m.json`。项目规则随工程一起保存，覆盖同名内置条目，不修改应用安装目录。

```json
{
  "schemaVersion": 1,
  "language": "c",
  "standard": "c17",
  "symbols": [
    {
      "name": "motor_start",
      "kind": "function",
      "detail": "void motor_start(unsigned speed)",
      "documentation": "启动电机并设置速度。",
      "insertText": "motor_start(${1:speed})"
    }
  ]
}
```

`kind` 支持 `function`、`method`、`variable`、`constant`、`type`、`keyword`、`snippet` 和 `property`。条目必填 `name`、`kind`、`detail`，可选 `documentation`、`insertText` 和 `sortText`。`${1:name}` 等占位符采用 Monaco 的片段语法；`snippets` 数组可定义多行代码片段。

自定义目录使用当前版本的独立文件。例如使用 C99 时创建 `languages/C/c99/`，其中文件的 `standard` 必须为 `c99`。不使用的版本不会参与当前补全或检查。旧 `blode.completions.json` 仍可用于工程补全；新规则建议采用版本目录。

## 语义规则

在 `languages/C/c17/rules.json` 定义检查：

```json
{
  "schemaVersion": 1,
  "language": "c",
  "standard": "c17",
  "rules": [
    {
      "id": "scheduler-delay",
      "kind": "call",
      "names": ["busy_delay"],
      "severity": "warning",
      "message": "此任务请使用调度器延时。",
      "enabled": true
    }
  ]
}
```

`call` 匹配后接括号的名称，`token` 匹配标识符；注释和字符串内容不参与匹配。`severity` 可为 `warning` 或 `error`。规则没有脚本执行或任意正则接口。相同 `id` 的项目规则可覆盖内置规则；设置 `enabled: false` 可关闭该规则。

内置源代码规则默认使用 `warning`，包含旧标准使用新语法的提示和 `gets` 调用提示。项目可覆盖为 `error`，构建预检查会停止编译。配置结构错误本身使用 `error`。这些检查处理词法模式，预处理器展开、完整类型检查和编译器扩展由当前工具链处理；混合 C/C++ 工程中归属不明确的 `.h` 交由编译器检查，避免对 C++ 声明应用 C 语法规则。

## 诊断与索引

JSON 解析错误、未知字段、错误标准、重复条目、缺失 manifest 引用及无效规则参数会报告具体文件、行列和错误信息。编辑器与构建预检查共用同一校验器。项目中的 `.c`、`.h` 等源码由工作区索引补充，未保存文本在编辑器内立即参与补全和导航；磁盘索引缓存位于 `.blode/index/`。

新增语言时创建独立的语言目录并注册对应解析器、数据契约和测试。例如 Java 可放入 `Java/<version>/`；当前未实现 Java 语言服务，不因存在目录而声明支持。
