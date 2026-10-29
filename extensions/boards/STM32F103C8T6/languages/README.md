# STM32F103C8T6 语言数据

本目录由本模块 `manifest.languages` 显式声明，不修改宿主语言目录。

- `C/c99`、`C/c11`、`C/c17`、`C/c23`：独立版本的 C 补全和规则。
- `C++/c-basics.json`：C++ 可用的 C 基础条目，不包含 Arduino 数据。

`.c` 和 `.h` 使用 C；`.cpp`、`.cc`、`.cxx` 及 C++ 专用头文件后缀使用 C++。新增 JSON 后同步清单，再打包发行。字段、校验与工程覆盖见[模块语言适配](../../../../docs/MODULE-LANGUAGES.md)。
