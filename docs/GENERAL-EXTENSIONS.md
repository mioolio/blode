# 通用扩展开发

通用扩展用于外观、菜单和工作台功能，不需要声明芯片或编译器。它采用 `kind: "extension"`，安装后不会出现在目标设备列表。设备、编译、烧录与调试模块继续使用 [Board Runtime API v2](RUNTIME-PLUGINS.md)。两类包分别管理。

## 安装与使用

1. 打开“扩展 → 管理扩展”，选择宿主电脑上的文件夹、ZIP，或官方示例。
2. 审查包的名称、版本、权限、文件清单和 SHA-256 指纹。
3. 选择“安装并启用”。可以只对本次进程授权，也可以勾选“在此电脑上记住授权”。
4. 在管理器调整扩展设置、打开视图、停用、导出或卸载。

安装 API 将文件复制到应用数据目录的 `extensions/<id>/`，默认停用；管理器的“安装并启用”在审查确认后显式调用启用接口。目录包和 ZIP 使用相同的校验与复制流程。源目录在审查后发生变化时，旧确认失效。

扩展的窗口在桌面端为独立窗口，在 Web 端为新标签页。底部视图作为统一底部面板中的标签显示。停用或卸载会移除菜单、视图入口和外观贡献，恢复原应用主题。

## 最小声明

```json
{
  "apiVersion": 1,
  "kind": "extension",
  "id": "MyExtension",
  "name": "My Extension",
  "version": "1.0.0",
  "permissions": ["ui.windows", "ui.menus"],
  "ui": {
    "views": [{ "id": "main", "label": "My View", "file": "ui/index.html", "location": "window" }],
    "menus": [{ "id": "open", "label": "Open My View", "view": "main" }]
  }
}
```

`id` 以字母开头，最长 48 字符，可含字母、数字、下划线和连字符。`version` 使用语义版本。包内引用使用相对路径，不能引用宿主源码、符号链接或目录联接。

## 权限模型

| 权限            | 能力                                               |
| --------------- | -------------------------------------------------- |
| `ui.appearance` | 贡献应用主题变量、背景、透明效果和桌面磨砂开关     |
| `ui.menus`      | 添加扩展菜单入口，覆盖指定顶层菜单的显示名称／图案 |
| `ui.windows`    | 声明独立窗口或 Web 标签页                          |
| `ui.panels`     | 声明底部面板标签                                   |
| `settings`      | 保存本扩展声明的设置                               |
| `native`        | 执行可访问本机文件、网络和进程的 Node.js ESM 代码  |

声明的功能与权限不匹配时拒绝安装。页面脚本运行于 `sandbox="allow-scripts"` 的不透明来源 iframe，默认禁止网络、嵌套页面、表单和任意资源加载。宿主将包内 CSS、独立脚本及图片内联到隔离文档；第三方前端依赖应由扩展自己的构建流程打包。

隔离文档使用独立 URL：桌面端通过 `blode-extension-ui:` 协议读取；Web 端由认证接口签发一次性、短时有效的文档地址。主页面保留 `script-src 'self'`，扩展文档使用自身策略；页面只获得本扩展的受限消息桥。

`native` 是完整宿主权限，不是受限脚本沙箱。管理器单独提示其文件、网络和进程权限；审查、安装、列出扩展不会导入其原生入口。只有明确授权启用后才加载。原生模块应实现释放逻辑，关闭进程、文件监听器和自己创建的资源。

永久授权在已安装包目录写入 `.uel`，签名绑定本机密钥、安装目录和完整包指纹。删除 `.uel`、修改包或复制到另一台电脑后需要重新审查。分享 ZIP 排除 `.uel` 与本机密钥。已加载的原生代码发生修改后，需重启应用再重新授权；Node.js 模块不会被伪装成已从进程卸载。

## 页面桥与设置

页面可以使用以下桥：

```js
const context = await window.blodeExtension.context();
await window.blodeExtension.configure({ preset: 'glass' });
await window.blodeExtension.openView('preview');
```

`context()` 返回本扩展的声明、设置、语言 JSON 和当前界面语言 `locale`。设置更新只接受 `manifest.settings.fields` 已声明字段；页面只能打开本扩展已声明视图，不能调用编译、文件写入或其他扩展接口。

```json
{
  "locales": { "zh-CN": "locales/zh-CN.json", "en": "locales/en.json" },
  "settings": {
    "defaults": "settings/defaults.json",
    "fields": [
      {
        "id": "preset",
        "label": "settings.preset",
        "type": "select",
        "default": "default",
        "options": [{ "value": "default", "label": "preset.default" }]
      }
    ]
  }
}
```

设置支持 `text`、`number`、`boolean` 和 `select`；数值可限制 `min/max`。用户值保存在应用数据目录的 `extensions.json`，扩展包的默认设置保持独立。语言文件是扩展自己的键值 JSON，不改写主程序语言清单。

## 外观和菜单贡献

`ui.appearance` 可声明基础样式；`ui.presets` 提供若干可选样式，`ui.presetSetting` 指向选择样式的设置字段。所选样式覆盖基础样式。`ui.desktopGlassSetting` 可指向一个布尔设置，让用户在运行时开关桌面磨砂。

```json
{
  "ui": {
    "appearance": {
      "variables": { "--accent": "#2678df", "--radius": "10px" },
      "background": "assets/wallpaper.png",
      "blur": 16,
      "translucent": true,
      "desktopGlass": false,
      "menuOverrides": { "file": { "label": "menu.file", "icon": "⌘" } }
    },
    "desktopGlassSetting": "desktopGlass"
  }
}
```

`desktopGlass` 让工作台外壳、面板和编辑器透出桌面；同时存在背景图片时，桌面磨砂优先显示真实桌面。宿主仅在 Windows 11 22H2 及以上创建 Acrylic 窗口，旧版 Windows、macOS、Linux 和 Web 端仍保持不透明窗口，但不会报错。

菜单 ID 和原操作保持稳定，只覆盖显示名称与图案。显示名可引用扩展自己的语言键；不提供对应翻译时按普通文字显示。扩展菜单项的 `labelKey` 同样使用本扩展语言资源。

主题变量白名单覆盖应用的背景、四层表面、边框、文本、强调色、状态色、悬停、弹出层、标题栏、编辑区背景、圆角和阴影。值不允许资源 URL、脚本表达式或额外 CSS 语句；图片通过 `background` 指定包内资源。宿主记录原内联值，在停用、样式切换或卸载时恢复。多个启用扩展贡献相同变量时，后应用者覆盖前者。

## 可选原生入口

声明 `runtime: "runtime/index.mjs"` 和 `native` 权限后，可导出：

```js
export async function activate(host) {
  host.log(`Extension ${host.id} started`);
  const settings = host.settings();
  // host.directory: installed package; host.dataDirectory: private mutable data.
  return {
    async dispose() {
      /* release owned resources */
    },
  };
}
```

包内容用于指纹校验，应保持只读；运行数据写入 `host.dataDirectory`。宿主源码和 npm 依赖不会自动暴露给分发包。原生依赖需随扩展分发，平台相关二进制由扩展作者提供匹配的构建。

## 二进制应用与分发

安装和运行依据分发包内的 `manifest.json`、相对资源和 ESM 入口，不依赖 `src/`、TypeScript 路径别名或开发工作目录。主程序编译为二进制后，仍将包复制到应用数据目录并按相同规则读取。桌面便携版可附带官方示例目录供安装；Web 服务使用目标电脑的应用数据目录。

官方示例见 [Personalization](../extensions/plugins/Personalization/docs/README.md)，包含 `runtime/`、`ui/`、`styles/`、`locales/`、`settings/`、`assets/`、`permissions/`、`docs/` 八个职责目录。可复制整个目录或导出 ZIP，安装到另一份源码／二进制应用中验证。

## 自动化接口

| 方法                   | 用途                           | 确认            |
| ---------------------- | ------------------------------ | --------------- |
| `extensions.state`     | 状态、权限、安装位置、官方示例 | —               |
| `extensions.review`    | 审查宿主路径中的目录或 ZIP     | —               |
| `extensions.install`   | 复制与已审查指纹相符的包       | `confirm: true` |
| `extensions.enable`    | 按指纹授权并启用               | `confirm: true` |
| `extensions.disable`   | 停用                           | —               |
| `extensions.remove`    | 卸载应用管理的扩展             | `confirm: true` |
| `extensions.configure` | 更新声明设置                   | —               |
| `extensions.export`    | 创建独立 ZIP                   | `confirm: true` |
| `extensions.context`   | 读取本扩展运行上下文           | —               |
| `extensions.view`      | 读取隔离视图文档               | —               |
| `extensions.viewUrl`   | 签发隔离文档地址               | —               |
| `extensions.openView`  | 打开已声明窗口／面板           | —               |

桌面 IPC 和 Web 端方法前缀为 `generalExtension`。接口与自动化使用同一个宿主注册表、schema 和包管理锁。

## 当前验证

自动化覆盖权限声明、安装前后不执行代码、指纹变更、永久授权撤销、原生释放、隔离文档、设置约束、ZIP 复制安装与卸载恢复。Windows 临时目录中的测试不触碰硬件。

最终便携版资源装载、真实原生窗口／浏览器标签页和视觉表现由发布前验收记录确认；Linux/macOS 原生扩展尚未进行实机验证。
