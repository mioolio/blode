# 扩展边界

每个目录只处理一类责任：`boards/<型号>/` 保存设备事实、默认分区和编译选项；`programmers/` 仅生成烧录器参数；`completions/` 保存按语言声明的补全、成员补全与悬停数据；`menus/` 保存资源管理器右键菜单的声明式条目；`registry.ts` 管理显式注册。串口占用、进程启动、文件访问、校验和下载由核心服务统一处理。适配器不得读写磁盘、联网或直接访问 Electron。

`completions/` 下的模块只包含纯数据，不得导入 Node、Electron 或 Monaco。新增语言补全时创建 `completions/<语言>.ts` 并导出 `LanguageCompletions`，再在 `completions/index.ts` 显式注册；同一语言可注册多个补全包，渲染层的适配器会合并结果。Arduino 补全示范见 `completions/arduino.ts`。

`menus/explorer.ts` 只描述菜单项、显示条件和命令 ID，具体命令由渲染层的处理器执行；新增条目不需要修改资源管理器组件。当前示范包含新建文件/文件夹、在资源管理器中显示、复制路径、重命名、删除和刷新。

新增型号时：

1. 在 `boards/<型号>/` 创建 `manifest.json`、`adapter.ts` 和说明；遵循 `extensions/types.ts` 的 `BoardAdapter`。
2. 定义独立的 `descriptionKey`，在语言 JSON 中提供翻译。型号、FQBN、分区名称是机器标识，不需要翻译。
3. 在 `registry.ts` 显式导入并注册。清单不是自动运行的脚本入口，工作区放入第三方清单不会获得执行权限。
4. 增加型号特有的参数/分区测试，检查真实板卡后再声明对应硬件支持。

当前内置两个适配器：`esp32-s3` 面向 ESP32-S3；`generic` 是可自动识别芯片的通用 **Espressif** 二进制烧录器。不同厂商的 MCU 应新建适配目录并实现相应协议，例如 STM32/OpenOCD；esptool 不能烧录 STM32。

`manifest.json` 的 `apiVersion: 1` 描述扩展契约版本。当前为随应用一起编译的可信扩展机制，未提供任意 JS 热安装功能。
