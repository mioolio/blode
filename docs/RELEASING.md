# 发行构建

## 一键构建 Windows x64

安装 Node.js 24+ x64，在源码根目录双击 **`build-release.bat`**，输入四段版本号，例如 `0.3.5.9`。

也可在命令行运行：

```powershell
.\build-release.bat 0.3.5.9
```

脚本自动完成：

1. 检查运行环境，缺少构建依赖时运行 `npm ci`。
2. 更新 `package.json` 的 `releaseVersion` 和 npm 版本，并同步 `package-lock.json`；例如 `0.3.5.9` 对应 npm 版本 `0.3.5-9`。
3. 依次构建桌面便携 EXE、Web 独立 EXE 和依赖本机 Node.js 的 Web ZIP。
4. 校验发行包哈希，汇总 `SHA256SUMS`、`release-manifest.json` 和 `RELEASE-NOTES.md`。

输出目录为 **`release/<版本号>/`**，完整日志在 `.tools/release-<版本号>-<时间戳>.log`。失败时保留日志并停止；已生成的文件不会被覆盖，重新构建前请移走该版本的已有发行包。脚本只构建本机文件，不提交 Git、创建标签或上传 GitHub。

## 发行说明

如已有 `docs/releases/<版本号>.md`，构建时直接使用。没有时，从 `CHANGELOG.md` 的“未发布”节生成初稿。可在构建前完善该文件；Node.js ZIP 和发行目录会携带相同说明。

## 签名

本机存在维护者签名身份时，沿用现有签发流程，为设备模块和发行包生成签名。私钥、快速签发脚本及本机工具目录不会加入发行包。未配置身份的源码克隆仍可完成构建，产物不带官方签名。见 [组件与发行签名](PACKAGE-SIGNING.md)。

Web EXE 构建会在 Node 副本注入载荷前移除原运行时证书，生成完成后再签署发行文件，符合 [Node.js SEA 构建顺序](https://nodejs.org/download/release/v24.10.0/docs/api/single-executable-applications.html)。该处理内置于构建脚本，无需额外安装 Windows SDK。

## 手动发布

构建完成后，在 GitHub 手动创建发行版，填写版本与说明，并上传三个发行包、各自的 `.sha256` 与 `.obe`（如有），以及 `SHA256SUMS`。`release-manifest.json` 可作为机器可读清单一并上传。
