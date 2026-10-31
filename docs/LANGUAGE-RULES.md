# 语言补全与规则

C/C++ 补全由 clangd 提供；未安装时回退到宿主工作区索引，见 [clangd](CLANGD.md) 与[内置语言服务](LANGUAGE-SERVICE.md)。本文说明仍然保留的 JSON 诊断规则、工程自定义条目和规则格式。

内置 C/Arduino JSON 补全目录已移除：`extensions/completions/C/*` 只保留 `rules.json`，不再包含标准库函数、关键字或 Arduino 函数补全。工程 `languages/C/<标准>/*.json`、`blode.completions.json`、AI 用户条目和模块用户贡献仍会与 clangd 结果合并。

## 目录与版本

```text
extensions/completions/
├─ C/
│  ├─ c99/rules.json        # 独立 C99 规则
│  ├─ c11/rules.json        # 独立 C11 规则
│  ├─ c17/rules.json        # 独立 C17 规则
│  ├─ c23/rules.json        # 独立 C23 规则
│  ├─ index.ts              # 显式注册标准目录
│  └─ project.ts            # 工程 C 条目与 include 兼容解析
├─ rules.ts                 # JSON 校验及声明式规则执行
└─ types.ts                 # 公共补全契约
```

每个标准目录只保留 `rules.json` 与构建用的 `catalog.ts`。四个版本独立存放，不从其他标准目录继承；切换标准只加载当前版本的规则。标准命名采用 [WG14 项目列表](https://open-std.org/jtc1/sc22/wg14/www/projects.html) 中的 C99、C11、C17 和 C23；这里没有 `c21` 目录。

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

省略 `cStandard` 时使用 C17。此字段同时决定 clangd 的 `-std=` 参数和声明式规则的版本。

## 自定义补全

在工程中创建 `languages/C/c17/m.json`。项目条目随工程保存，与 clangd 结果合并；同名的 AI 或项目条目优先显示。

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

自定义目录使用当前版本的独立文件。例如使用 C99 时创建 `languages/C/c99/`，其中文件的 `standard` 必须为 `c99`。旧 `blode.completions.json` 仍可用于工程补全；新条目建议采用版本目录。

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

内置源代码规则默认使用 `warning`，包含旧标准使用新语法的提示和 `gets` 调用提示。项目可覆盖为 `error`，构建预检查会停止编译。配置结构错误本身使用 `error`。这些检查处理词法模式，预处理器展开、完整类型检查和编译器扩展由 clangd 或当前工具链处理；混合 C/C++ 工程中归属不明确的 `.h` 交由编译器检查。

clangd 可用时，C/C++ 诊断以 clangd 为准，声明式规则标记不再重复显示；clangd 不可用时规则标记恢复。构建前检查继续使用同一校验器。

## 诊断与索引

JSON 解析错误、未知字段、错误标准、重复条目和无效规则参数会报告具体文件、行列和错误信息。编辑器与构建预检查共用同一校验器。项目中的 `.c`、`.h` 等源码由工作区索引补充；磁盘索引缓存位于 `.blode/index/`。

外部头文件可从已安装工具链和编译包含目录定位，并以只读标签打开。目录发现、多个候选、引用与自动化接口见[源码定位](SOURCE-NAVIGATION.md)。

新增语言时创建独立的语言目录并注册对应解析器、数据契约和测试；当前未实现 Java 语言服务，不因存在目录而声明支持。
