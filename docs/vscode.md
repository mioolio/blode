# VS Code 连接

从编辑区右上角的 **更多操作 → 在 VS Code 中打开**，在服务端电脑打开同一份工程和当前文件。桌面版与 Web 版使用相同入口；Web 会启动运行 Blode 服务的电脑上的 VS Code。

## 使用

1. 在服务端电脑安装 Visual Studio Code。
2. 在 Blode 打开工程。
3. 点击 **在 VS Code 中打开**。Blode 先保存当前工程的修改，再生成工作区配置并打开当前文件；保存失败时保留当前工作区。
4. 在 VS Code 编辑和保存。Blode 监听工程磁盘变化，将更新传给桌面和网页工作区。

VS Code 中尚未保存的编辑保留在 VS Code。若磁盘变更与 Blode 中未保存的协作草稿冲突，Blode 显示合并入口；处理后继续保存或编译。

## 生成的配置

工作区文件位于工程的 `.blode/vscode/project.code-workspace`。它通过相对路径引用工程，包含 UTF-8、自动保存、Arduino 文件关联和 C/C++ 头文件搜索配置：

```json
{
  "folders": [{ "name": "工程名称", "path": "../.." }],
  "settings": {
    "files.autoSave": "afterDelay",
    "files.autoSaveDelay": 750,
    "files.encoding": "utf8",
    "files.associations": { "*.ino": "cpp" },
    "C_Cpp.default.includePath": ["${workspaceFolder}/**"]
  },
  "extensions": {
    "recommendations": ["ms-vscode.cpptools"]
  }
}
```

工程已配置 Arm 编译器目录且对应程序存在时，额外生成 `C_Cpp.default.compilerPath`。C/C++ 扩展列为推荐项，由用户在 VS Code 中安装。

该文件由 Blode 在打开时更新。已有 `.vscode/settings.json`、`c_cpp_properties.json`、任务和调试配置继续由工程维护。工作区文件使用 VS Code 的标准 `.code-workspace` 格式，其相对目录和设置层级见 [VS Code 工作区文档](https://code.visualstudio.com/docs/editing/workspaces/multi-root-workspaces)。

## 宿主程序查找

| 系统    | 查找位置                                                                                 |
| ------- | ---------------------------------------------------------------------------------------- |
| Windows | 当前用户安装目录、Program Files、PATH 中的 `Code.exe` 或官方 `bin` 目录对应的 `Code.exe` |
| Linux   | PATH 中的 `code`，以及 `/usr/share/code/code`、`/usr/bin/code`、`/snap/bin/code`         |
| macOS   | `/Applications/Visual Studio Code.app`、用户 Applications 目录和 PATH                    |

打开工作区时使用 `--reuse-window`，定位源码使用 `--goto 文件:行:列`；这些参数采用 [VS Code 命令行接口](https://code.visualstudio.com/docs/configure/command-line)。实现直接传递程序路径和参数数组，Windows 的 `.cmd` 不经过命令解释器执行。

## 接口

桌面 IPC 和浏览器桥接共用 `window.blode.vscodeOpen`；外部 AI 使用 `vscode.open`。

```ts
await window.blode.vscodeOpen({
  expectedProjectRoot: 'C:\\work\\camera',
  path: 'src/main.cpp',
  line: 24,
  column: 3,
  confirm: true,
});
```

| 参数                  | 类型               | 含义                                    |
| --------------------- | ------------------ | --------------------------------------- |
| `expectedProjectRoot` | 绝对路径           | 发起操作时的工程根目录                  |
| `path`                | 可选的工程相对路径 | 打开指定文件；省略则仅打开工作区        |
| `line`／`column`      | 可选的正整数       | 文件位置，默认均为 1；需同时提供 `path` |
| `confirm`             | `true`             | 允许生成配置并启动服务端程序            |

返回 `{ workspaceFile, executable }`，分别为生成的工作区路径和启动程序路径。工程切换、路径越界或符号链接会中止操作；未找到程序与启动失败分别返回 `error.vscodeNotFound` 和 `error.vscodeLaunch`。

## 验证

`tests/vscode.test.ts` 在临时工程中验证工作区生成、原配置保留、带空格和特殊字符的路径、切换工程、符号链接边界、程序查找、参数校验及桥接路由。启动函数由测试替身替换。

Windows 的真实 VS Code 窗口交互，以及 Linux／macOS 的安装和启动仍待实机验证。

相关文档：[多人协作](COLLABORATION.md) · [Web 宿主](WEB-HOST.md) · [工程配置](PROJECTS.md)
