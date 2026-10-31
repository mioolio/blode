# 组件与发行签名

Blode Studio 使用两层签名：`obe` 用于组件来源和完整性校验，Authenticode 用于 Windows EXE／DLL 的发布者信息。

## 已接入的范围

| 对象         | 签名与验证                                                                                                                                  |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| 官方设备模块 | 构建独立模块后签署目录；ZIP 导出保留 `obe`，安装时重新校验                                                                                  |
| 通用扩展     | 目录与 ZIP 安装检查签名，官方 Personalization 示例附带签名                                                                                  |
| 源码组件     | 目录与 ZIP 导入检查签名；Arduino 在线组件安装前提示其未经过 Blode Studio 认证                                                               |
| 工具链       | 离线安装检查签名与全部文件哈希，已签名工具链的 ZIP 导出保留完整签名载荷                                                                     |
| AC5 本机工具 | `armar`、`armasm`、`armcc`、`armlink`、`fromelf` 和 `armcompiler_libFNP.dll` 已添加分发签名；根目录与 `bin` 分别生成 `obe`                  |
| 发行文件     | 桌面便携 EXE、Web EXE 和 Web Node.js ZIP 的发行脚本生成同名 `.obe`；Windows EXE 在本机签名身份存在时添加 Authenticode，再计算最终 `.sha256` |

第三方原有发布者签名保持原样。Blode Studio 的分发签名表示由该发布者签署这一份载荷，原产品和代码的作者信息继续保留。

## 安装结果

| 状态                                     | 安装行为                                               |
| ---------------------------------------- | ------------------------------------------------------ |
| 官方公钥匹配、签名有效且哈希一致         | 正常安装                                               |
| 无 `obe`                                 | 提示未经官方认证，需确认风险后安装                     |
| 自带公钥可验证，但未列入宿主信任清单     | 显示非官方签名及公钥指纹，需确认                       |
| `obe` 被改动、签名损坏或格式错误         | 显示签名无效，需单独确认                               |
| 签名清单可验证，文件增加、删除或哈希变化 | 显示“签名有效，内容校验失败”，列出异常文件，需单独确认 |

确认仅针对当次检查所得的文件指纹。安装重新读取载荷，指纹改变会要求重新检查。确认不会跳过路径、压缩包结构、容量、平台或模块配置校验。

签名清单失效和文件哈希不符分别呈现；只有清单签名能够验证时才显示“签名有效”。签名认证发布来源，不等同于代码审计结果。

## `obe` 文件格式

`obe` 是目录根部的 UTF-8 JSON 文件，不是新的压缩格式。ZIP 的单层包装目录会在校验前还原。主要字段：

- `format: "blode-obe"`、`version: 1`、`algorithm: "Ed25519"`。
- `publisher`、`keyId`、`publicKey`、`signedAt`：签发者、公钥指纹、公钥和签署时间。
- `subject`：组件类型、ID 和版本。
- `files`：每个文件的相对路径、字节数及 SHA-256；`obe` 自身不列入自身清单。
- `signature`：对清单正文进行确定性 JSON 序列化后的 Ed25519 签名，Base64 编码。

对象键按字典顺序排列，数组顺序保留，文件清单按路径排序。清单内不能包含重复路径、大小写冲突、绝对路径或目录穿越。新增和删除文件同样影响完整性。

包内的公钥用于验证数学签名；官方身份只由编译进宿主的 `src/shared/package-publishers.json` 决定，包内无法自行声明为可信发布者。

## 维护者操作

签名材料位于仓库根部 `.signing/`：

```text
.signing/                       # 忽略 Git、工程 ZIP 和组件分享
├─ blode-studio-ed25519.pem      # OBE 私钥
├─ blode-studio.pfx              # Windows 代码签名私钥与证书
├─ blode-studio.cer              # Windows 公钥证书
├─ windows-signing.json          # 本机 PFX 配置
└─ native-backup-*/              # 原始工具及签署报告
```

此目录仅保留在维护者电脑。应用仅内置公钥，不会向用户分发签发私钥，也不会在普通用户导出第三方组件时替其签署官方身份。

仓库内预签署的官方扩展目录通过 `.gitattributes` 禁用文本换行转换，保证 Windows 和 Unix 检出具有相同文件字节。修改载荷后重新签署；提交前以 Git 暂存区实际内容验证，避免工作区校验正常但提交后哈希改变。

初始化新身份仅执行一次；已有私钥不会被覆盖：

```powershell
node --import tsx scripts/sign-packages.ts init
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/windows-code-signing.ps1 -Action Init
```

对准备分发的目录签署并检查：

```powershell
node --import tsx scripts/sign-packages.ts sign path/to/module device MyModule 1.0.0
node --import tsx scripts/sign-packages.ts verify path/to/module
```

本机工具签署会先备份 EXE／DLL，保留其他厂商已有签名，再生成 `bin/obe` 和工具链根部 `obe`：

```powershell
node --import tsx scripts/sign-native-tools.ts tools/versions/armcc/5.06-u5-b528 armcc:5.06-u5-b528 5.06-u5-b528
```

清单中的 ID／版本必须与目录中的 `manifest.json` 一致。修改已签名文件后需要重新签署。工具目录应为待分发的完整载荷；许可证、私钥、缓存等本机文件不应混入。

执行现有 `package:desktop`、`package:web` 或 `package:web:node` 时，有维护者私钥则自动签署，没有私钥则生成普通未签名构建。可用 `BLODE_SIGNING_KEY` 指定安全存放的 OBE 私钥。公钥变更需要发布新的宿主信任清单；旧公钥应在仍需验证旧包时保留。

## Windows 证书边界

当前生成的是 **Blode Studio 自签名代码签名证书**，不是公开 CA 签发的企业身份认证。本次未将证书写入 Windows 受信任根，Windows 可能显示证书链不受信任；它不会因此自动获得 SmartScreen 信誉。

发行流程在签名之后计算哈希及 `.obe`，后续修改 EXE 会使校验失效。Blode 的组件安装使用固定公钥完成 OBE 验证，不依赖目标电脑是否信任这张 Windows 证书。

## 验证记录

2026-11-01，Windows x64：完成签名／清单篡改／文件增删／哈希变更／未知公钥／版本替换／安装确认指纹检查；工具 ZIP 和设备模块 ZIP 已验证导入导出；签署后的 AC5 通过 Blode 实际编译，覆盖 C99、C++、ARMASM、Debug／Release、命名入口和固件导出。0.3.5.9 的桌面便携版、Web EXE 和 Web Node.js ZIP 已完成 OBE 验证，包内两个官方设备模块签名通过。

新增语言文件同样属于模块或扩展签名载荷。更新翻译后需要更新包版本并重新签署；签发过程不改变 Blode Studio 的[永久免费承诺](FREE-SOFTWARE.md)。当前源码的后续修改应重新构建，不回写已校验的旧发行文件。

技术参考：[Node.js Crypto](https://nodejs.org/api/crypto.html#cryptosignalgorithm-data-key-callback)、[Microsoft New-SelfSignedCertificate](https://learn.microsoft.com/en-us/powershell/module/pki/new-selfsignedcertificate)。
