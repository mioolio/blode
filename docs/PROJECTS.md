# 工程与编译设置

Blode Studio 将工程描述、编译器选择和构建模式保存在工程根目录的 `be` 文件中。桌面版与 Web 版读取同一份配置；Web 版使用服务所在电脑的文件、工具和构建环境。

## 设置入口

| 入口                             | 内容                                                      |
| -------------------------------- | --------------------------------------------------------- |
| 文件树中右键 `be` → **高级设置** | 工程名称、平台、编译入口、文件清单与 C 标准，附 JSON 预览 |
| **运行 → 编译设置**              | 调试／发布模式、体积优化、通用及各平台的 C/C++ 编译器选择 |
| **首选项 → 工具链**              | 下载版本目录、安装进度、工具路径与默认工具配置            |

编译设置中的已安装清单来自目标机器实际可用的工具，下载目录单独显示在首选项。安装工具后可以刷新已安装清单。编译使用已安装的工具；缺少指定版本时显示错误，由用户安装或重新选择。

打开工程、保存配置和编译均可在设备未连接时执行。烧录、串口和硬件调试使用已连接的目标设备。

## 编译器选择层级

`be.build.settings` 按以下顺序解析，每一层可以选择跟随上级，或选择自己的编译器：

1. **通用**：`common`，作为两个平台的公共起点。
2. **平台通用**：`platforms.stm32.common` 或 `platforms["esp32-s3"].common`。
3. **语言**：同一平台的 `c` 或 `cpp`。

| `family`   | 含义                                            |
| ---------- | ----------------------------------------------- |
| `inherit`  | 跟随上一级；根层跟随工程原有工具链配置          |
| `auto`     | 在当前机器自动查找兼容的工具                    |
| `gnu-arm`  | 选择 GNU Arm GCC，用于 STM32                    |
| `armclang` | 选择 Arm Compiler 6，用于 STM32                 |
| `arduino`  | 选择 Arduino CLI 与 ESP32 包环境，用于 ESP32-S3 |

只有 `family: "inherit"` 继承上级选择，其附加字段可覆盖上级对应字段。指定任意明确的 `family` 都建立完整的新选择，即使系列相同，也会清除上级目录与版本；`auto` 同样清除旧的指定值并恢复自动查找。`version` 用于约束版本，`directory` 指向编译工具目录。Arduino 环境使用 `arduinoCli` 和 `packageDirectory`，其 `version` 指的是 ESP32 core 版本；CLI 版本由所选可执行文件确定。自定义路径属于运行构建的目标机器。

STM32 的 C 与 C++ 可以选用同一系列中的不同已安装版本。一个构建使用统一的链接工具链；包含 C++ 时采用 C++ 选择对应的链接工具。GNU Arm 与 Arm Compiler 6 不能在同一次构建中混用。

ESP32-S3 通过一次 Arduino 构建调用编译 C 与 C++，两者需要使用一致的 Arduino CLI 和 core 环境。版本选择兼容性仍取决于工程源码及库使用的 API。

## 构建模式

`mode` 可选 `debug` 或 `release`，默认 `release`。`optimizeForSize` 默认开启；调试模式固定使用便于逐步调试的优化级别。

| 模式                    | STM32／ESP32-S3 编译参数 | 作用                           |
| ----------------------- | ------------------------ | ------------------------------ |
| `debug`                 | `-O0 -g`                 | 关闭优化并生成调试信息         |
| `release`，体积优化开启 | `-Os -g`                 | 优先减小代码体积，保留符号信息 |
| `release`，体积优化关闭 | `-O2 -g`                 | 使用常规优化，保留符号信息     |

GNU Arm 链接使用 `--gc-sections` 清理未引用段。Arm Compiler 6 在调试模式使用 `--no_remove`，发布模式使用 `--remove`。ESP32-S3 将优化和调试选项写入 Arduino 的 `compiler.c.extra_flags` 与 `compiler.cpp.extra_flags`，并通过 `compiler.c.elf.extra_flags` 传入 `-Wl,--gc-sections`。最终固件大小取决于源码、库、链接脚本与工具版本。

本轮编译设置验证覆盖配置解析、工具选择和构建命令生成，并使用本机 GNU Arm GCC 15.2.1 编译了独立的 C/C++ 小工程，三种模式均成功。Flash 占用及工具发现记录见[发行说明](releases/0.2.3.6.md)。Arm Compiler 6 实际编译、ESP32 实际工程、硬件与 Linux 本次未验证。

## 配置示例

以下是 `be` 中 `build` 对象的示例，可与项目的设备、Flash 布局和工具配置一起保存：

```json
{
  "entry": "src/main.c",
  "files": ["src/main.c", "src/driver.c", "startup/startup_stm32f10x_md.s"],
  "cStandard": "c17",
  "settings": {
    "mode": "release",
    "optimizeForSize": true,
    "common": { "family": "inherit" },
    "platforms": {
      "stm32": {
        "common": { "family": "gnu-arm", "version": "14.2.1-1.1" },
        "c": { "family": "inherit" },
        "cpp": { "family": "inherit" }
      },
      "esp32-s3": {
        "common": { "family": "auto" },
        "c": { "family": "inherit" },
        "cpp": { "family": "inherit" }
      }
    }
  }
}
```

`cStandard` 控制源码标准和对应的语言规则包；`settings` 控制编译工具与模式。选择 C23 等较新标准前，需要确认所选编译器支持该标准。工作区符号索引保存在可重建的 `.blode/index/`，源码与编译入口仍由工程配置决定。

现有工程没有 `build.settings` 时继续使用原有工具链解析流程。增加设置后，优先读取上述层级；使用跟随选项可以沿用工程默认配置。

## 分享与迁移

**文件 → 打包工程**生成可迁移 ZIP。归档副本保留 `mode`、`optimizeForSize`、编译器系列和版本，并移除新编译设置中的本机绝对 `directory`、`arduinoCli`、`packageDirectory` 路径。原工程不被改写。

`.blode-share/manifest.json` 的 `toolRequirements` 记录所需工具；已识别的并行工具目录使用 `gnu-arm:<版本>`、`arduino-cli:<版本>`、`arduino-esp32:<版本>`，各层选择另有带作用域的编译器要求。自定义工具以配置位置标记，接收者在自己的机器配置相应路径。

接收者安装或选择对应版本后重新构建。只保留系列与版本时，会查找目标机器已安装的匹配工具，包括并行版本目录；工具不会随源码 ZIP 分发，也不会因打开工程而自动下载。完整的外部依赖迁移规则见[工程打包](PROJECT-PACKAGING.md)。

## 相关文档

- [工具版本与下载](TOOL-VERSIONS.md)
- [STM32 构建与调试](STM32.md)
- [ESP32-S3 平台](../extensions/boards/esp32-s3/README.md)
- [C/C++ 语言规则](LANGUAGE-RULES.md)
- [0.2.3.6 发行说明](releases/0.2.3.6.md)
