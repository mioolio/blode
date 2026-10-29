# 贡献指南

感谢你参与 Blode Studio。欢迎提交错误修复、语言规则、平台适配、测试和文档改进。

[项目说明](README.md) · [开发约定](docs/DEVELOPMENT.md) · [架构](docs/ARCHITECTURE.md) · [安全报告](SECURITY.md)

## 报告问题

使用 [GitHub Issues](https://github.com/mioolio/blode/issues)。提交前检索现有问题，并提供：

- 发行号和发行版，例如 `0.2.3.6 / Windows desktop` 或 `0.2.3.6 / Node Web host`。
- 服务电脑的系统、架构、Node.js／Git／编译器版本。
- 工程类型、所选平台、构建入口和 C 标准。
- 最小重现步骤、预期行为和实际行为。
- 脱敏后的输出、启动阶段耗时或截图。

编译问题尽量提供可分享的最小工程。硬件问题补充芯片、调试器、串口／SWD 连接方式和相关工具版本。删除启动令牌、密钥、凭据、个人路径及未授权共享的工程代码后再上传材料。漏洞按[安全政策](SECURITY.md)报告。

## 开发环境

使用 Node.js 24+ 和 npm。Git 相关工作流与测试需要本机 Git：

```sh
npm ci
npm run dev
```

独立 Web 宿主：

```sh
npm run web:build
npm run web:start
```

主进程、preload、平台包和宿主协议修改后重启开发进程。界面支持热更新。开发数据默认位于 `.tools/dev-user-data/`，避免用实际硬件或生产工程作为可破坏测试的默认目标。

## 提交变更

1. 通过 Issue 说明问题和预期行为；较大的协议或架构变化先讨论接口。
2. 从当前开发分支创建主题分支。
3. 保持提交围绕同一个问题，补充与行为对应的测试和文档。
4. 完成相关检查后提交 Pull Request。
5. 在 PR 中列出行为变化、兼容性影响、测试结果，以及仍未验证的系统或硬件。

PR 描述应让没有读过讨论的人理解问题、结果和验证。涉及界面的变化附截图；涉及构建或导出时附可重现的参数与产物检查方法。不要仅写“修复问题”或“已测试”。

## 代码与模块约定

- 使用 TypeScript 和项目现有格式；运行 `npm run format:check` 或对修改文件使用 Prettier。
- 源文件保持职责集中，尽量不超过 1000 行；大型功能拆成可独立测试的模块。
- 平台事实、编译与烧录适配放在 `extensions/boards/<platform>/`，核心保留通用宿主、锁和协议。
- 补全数据按语言和标准放在 `extensions/completions/`，规则格式见[语言规则](docs/LANGUAGE-RULES.md)。
- JSON-RPC、MCP、桌面 IPC 与 Web 接口共用契约与校验，不复制一套权限或状态逻辑。
- 用户可见文案同时维护中英文资源；错误应包含可采取行动的信息。
- 文档区分已实现、自动化测试、实际硬件验证和未来计划。

不提交 `node_modules/`、`dist/`、`release/`、`tools/`、`.tools/`、工程缓存、个人配置或凭据。测试临时仓库与数据应位于自己创建的专用目录，并在结束时释放。

## 验证

按变更范围选择检查；协议、路径、协作、版本管理及打包变化需要对应边界测试：

```sh
npm run typecheck
npm test
npm run build
```

Web 宿主变化另执行 `npm run web:build` 并检查命令行帮助与服务启动。发行工具变化检查文件清单、版本、许可证、依赖和摘要。

Git 测试使用临时仓库及本地裸远端；下载测试优先使用固定数据与校验值；硬件边界通过 fixture 注入。真实设备测试记录系统、工具版本、芯片、步骤和结果，测试前确认该设备和目标工程允许对应写操作。

## 文档与发行

新增功能同步更新主要 README、面向用户的指南和 CHANGELOG。兼容性调整必须说明旧工程、历史记录、配置和产物如何处理。

发行版本用 `package.releaseVersion` 表示，npm 的 `version` 保持合法语义版本。构建说明见[开发约定](docs/DEVELOPMENT.md)，当前基线见 [0.2.3.6 版本说明](docs/releases/0.2.3.6.md)。

## 许可证

提交代码或文档时，确保你有权以仓库的 [Apache License 2.0](LICENSE) 许可贡献。引入第三方内容需保留来源和许可说明；编译器与驱动的许可不因被工作台调用而改变。
