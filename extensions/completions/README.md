# 补全扩展

补全分两层：

1. **静态语言包**（例如 `arduino.ts`、`c-basics.ts`）由平台或语言扩展提供，纯数据、可审查，在 `index.ts` 注册。
2. **项目感知的 C/C++ 符号索引**（`c.ts`）由 renderer 在编辑时调用，读取当前工程文件和未保存草稿，递归解析 `#include "..."`。

## C/C++ 动态补全

当前解析器会从当前文件及其递归包含的头文件中提取：

- `#define` 对象宏和函数宏
- 函数声明/定义（单行签名）
- `typedef`、`struct`、`enum`、`union` 名称

它不执行代码、不调用编译器，也不替代 clangd：

VS Code 的 C/C++ 插件通常通过语言服务器（clangd / cpptools）读取 `compile_commands.json`、构建 AST 和符号索引；本实现不启动语言服务器，而是在 renderer 内做确定性的轻量索引，优点是离线、无需额外进程，限制是不会做完整类型推导或宏展开。

- 支持项目内头文件的相对路径和 basename 回退
- 最多 16 层、256 个文件，避免循环和异常工程拖慢编辑
- 多行函数签名、宏展开、类型推导、系统头文件和完整语义分析不在当前范围内
- 头文件需要出现在工程文件索引中；工程外的系统头不会读取

## 用户自定义补全

在工程根目录添加 `blode.completions.json`：

```json
{
  "c": [
    {
      "name": "MY_BOARD_LED",
      "kind": "constant",
      "detail": "PC13 active-low LED",
      "documentation": "Set by the custom board header.",
      "insertText": "MY_BOARD_LED"
    },
    {
      "name": "MY_FAST_PATH",
      "kind": "function",
      "detail": "MY_FAST_PATH(value)",
      "documentation": "Board-specific inline helper.",
      "insertText": "MY_FAST_PATH(${1:value})"
    }
  ]
}
```

支持的 `kind`：`function`、`method`、`type`、`variable`、`constant`、`keyword`、`snippet`、`property`。`c` 和 `cpp` 两个键都可用；数组形式也接受。

自定义条目优先于自动解析结果，同名条目会覆盖自动解析项。`insertText` 使用 Monaco snippet 语法，例如 `${1:value}`。

## 新增静态语言包

复制 `arduino.ts`，实现 `LanguageCompletions`，然后在 `index.ts` 的 `contributions` 中显式注册。静态包不能导入 Node、Electron 或 Monaco。
