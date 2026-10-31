# Arm Compiler 5

STM32F103C8T6 模块提供 AC5 编译后端，与 GNU Arm GCC 和 Arm Compiler 6 并列选择。ESP32 构建使用各自的工具链。

## 使用

1. 将完整工具链放入 `tools/armcc/` 或 `tools/versions/armcc/<版本>/`，也可在首选项指定已有目录。目录应包含 `bin`、`include`、`lib` 和 `sw`；`bin` 中需要 `armcc`、`armasm`、`armlink` 和 `fromelf`。
2. 打开 **生成 → 编译设置**，选择识别出的 AC5 版本；选择自定义目录时，将工具类型设为 **Arm Compiler 5**。
3. C 源文件使用 **C99**。本后端的 C++ 方言为 C++03。C11、C17 和 C23 配置会返回明确错误。
4. 选择 Debug 或 Release 后编译，固件通过现有导出和烧录流程使用。

工具版本保留 update 和 build，例如 `5.06-u5-b528`。同一版本系列的不同构建可以并列安装；已指定版本或目录缺失时会报错，避免切换到其他编译器。

```json
{
  "build": {
    "entry": "src",
    "cStandard": "c99",
    "settings": {
      "mode": "debug",
      "common": {
        "family": "armcc",
        "version": "5.06-u5-b528"
      }
    }
  }
}
```

以上为现有 `be` 文件中的 `build` 配置片段。

## 构建行为

- C／C++ 调用 `armcc`，ARM 语法汇编调用 `armasm`，链接和 BIN 生成分别调用 `armlink`、`fromelf`。
- 使用兼容的原工程启动文件与 scatter；未提供时，为 STM32F103C8T6 生成启动与链接配置。
- 旧式 ARMCC 内联汇编保持原样，AC6 的 CMSIS 兼容转换仅用于 AC6 构建。
- 编译生成依赖文件和供 clangd 使用的兼容编译数据库。输出使用工程相对路径，支持中文及带空格的工程父目录。
- 已有 ELF 校验、资源占用、BIN／HEX／ELF 导出及命名子工程继续共用宿主接口。

## 工具交付

在 **首选项 → 工具链与导出** 中导出已安装工具。ZIP 保留可执行程序、动态库、头文件、运行库和产品信息，导入后重新进入版本目录。许可证及激活文件不纳入归档；运行使用目标机器的正常授权环境。

## 验证范围

2026-11-01 使用 AC5 5.06 update 5（build 528）在 Windows x64 上验证：通过 Blode 宿主编译 C99、C++ 模板、旧式 ARM 内联汇编及原生 Keil 启动工程，验证 Debug／Release、ELF／BIN／HEX 导出、中文及空格路径、版本不匹配和语言标准错误。

自动化夹具覆盖本机识别、离线导出／导入及文件依赖保留。设置 `BLODE_ARMCC_TEST_ROOT` 后可用现有 AC5 运行真实编译测试；`BLODE_ARMCC_MANAGED_ROOT` 可进一步验证版本目录自动选择。

本批没有进行实机烧录、硬件单步或 Linux 验证。
