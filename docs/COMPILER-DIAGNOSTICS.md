# 编译诊断

编译器的警告显示在底部“警告”，错误显示在“问题”；面板标签和状态栏同步计数。诊断项显示工程文件、行列及消息。点击后打开源文件、定位代码；警告使用淡琥珀色行背景，错误使用淡红色，并保留编辑器下划线和概览标记。

## 输出与定位

- 支持 GCC／Clang 的 `文件:行:列`、缺省列号、Arm Compiler 5 的 `"文件", line 行号` 和括号坐标格式；链接器等没有源码坐标的警告也列入警告页。
- 宿主在每次编译开始时建立源码映射。Arduino 的主草图改名、入口目录内的辅助文件、组件源码及 `.blode/targets/<id>` 使用该次编译的原文件路径。
- 定位只使用已建立的完整路径映射。同名文件不会通过文件名猜选；没有可识别工程位置的工具消息保留原文。
- 文件尚未打开时，诊断仍参与列表和计数。打开后应用相应的编辑器标记；相同位置和消息的诊断去重，编译器标记不重复参与编辑器统计。

原始编译输出继续保留在“输出”。颜色和定位信息使用独立的 `blode-compiler` 标记，不覆盖 clangd、语言规则或协作者的标记。

## 生命周期与同步

`LogEvent.diagnostic` 携带工程根目录、严重程度、消息、原编译路径及可选的源码位置。桌面、Web 实时事件和重连日志回放使用相同结构。

日志缓冲保留当前编译边界、最近 500 条普通输出和最多 1000 条编译诊断，详细编译输出不会提前挤掉诊断。下一次编译清除上一轮诊断；清空日志或切换工程时同步清除对应的编辑器标记。

设备模块继续使用现有 `RuntimeHost.emit` 输出工具日志，无需更改模块签名或绑定前端。宿主只在编译操作期间解析编译诊断。

## 验证记录

2026-11-01，Windows x64：

- 本次相关回归 33 项通过，覆盖解析、原文件映射、宿主分类、未打开文件的计数、新模型标记、去重、日志保留与回放，以及语言服务和源码导航；类型检查通过。
- 本机 ESP32 GCC 对合成 C 文件执行语法检查，实际生成 `unused_value` 未使用变量警告。浏览器使用真实 ConsolePanel、RuntimeSelector 和 Monaco 验证计数为 1、跳转到第 2 行第 7 列、行背景标记，以及清除后计数和标记归零。未连接或烧录硬件。
- 扩展回归中的既有测试 `desktop and browser debugger routes follow the latest verified target ELF...` 在 `tests/build-targets.test.ts:372` 失败：预期 `firmware.elf`，实际为空。使用修改前的 `service.ts` 和 `build-targets.ts` 重测得到同一失败；该项单独记录，不计入本次通过数。

复现本次测试：

```sh
npm run typecheck
node --import tsx --import ./tests/register-styles.mjs --test tests/compiler-diagnostics.test.ts tests/recent-logs.test.ts tests/editor-problems.test.ts tests/clangd-provider.test.ts tests/module-languages.test.ts tests/monaco-navigation.test.ts tests/workspace-lsp.test.ts tests/completions.test.ts
```
