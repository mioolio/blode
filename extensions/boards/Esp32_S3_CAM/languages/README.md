# ESP32-S3 语言数据

本目录由本模块 `manifest.languages` 显式声明，不修改宿主语言目录。

- `C/c99`、`C/c11`、`C/c17`、`C/c23`：独立版本的 C 补全和规则。
- `C++/c-basics.json`：C++ 可用的 C 基础条目。
- `C++/arduino.json`：Arduino 片段、函数和成员。

`.c` 使用 C；`.ino`、C++ 源码和头文件使用 C++。新增 JSON 后同步清单，再打包发行。字段、校验与工程覆盖见[模块语言适配](../../../../docs/MODULE-LANGUAGES.md)。
