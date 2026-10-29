# 补全扩展

语言补全按语言和标准版本组织：

| 目录                                   | 内容                                                   |
| -------------------------------------- | ------------------------------------------------------ |
| `C/c99/`、`C/c11/`、`C/c17/`、`C/c23/` | 各标准独立的 JSON 函数、类型、关键字、控制流及检查规则 |
| `C++/arduino/`                         | Arduino API、成员函数和基础片段 JSON                   |
| `C/project.ts`                         | 旧工程自定义补全及 include 解析兼容入口                |
| `rules.ts`                             | 版本选择、JSON 校验、项目覆盖及声明式规则执行          |

C 标准在 `be.build.cStandard` 选择，默认 C17。每个版本中 `a.json` 到 `z.json` 按函数首字母组织，语法片段位于 `control-flow.json`，其余字段和扩展方法见 [语言补全与规则](../../docs/LANGUAGE-RULES.md)。

项目规则放在 `languages/C/<standard>/`，与工程一起分享；同名补全和规则覆盖当前版本的内置数据。工作区符号索引补充源文件定义与声明，为补全、跳转、悬停提供文件位置；磁盘缓存位于 `.blode/index/`。

旧入口 `arduino.ts`、`c-basics.ts`、`c.ts` 仍导出迁移后的模块。旧工程的 `blode.completions.json` 也继续支持：

```json
{
  "c": [
    {
      "name": "MY_BOARD_LED",
      "kind": "constant",
      "detail": "PC13 active-low LED",
      "insertText": "MY_BOARD_LED"
    }
  ]
}
```

`c`、`cpp` 或直接数组形式均可用。新工程建议使用按标准分目录的 JSON，语法错误和无效规则会显示文件、行列及诊断信息。
