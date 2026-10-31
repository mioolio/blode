# Personalization

Blode Studio 官方通用扩展示例，提供跟随应用、玻璃背景和简洁浅色三套样式，以及可单独开关的桌面磨砂。支持扩展菜单、独立窗口、Web 标签页及底部预览。

在“扩展 → 管理扩展”选择官方示例，检查权限后安装并启用。更改样式后即时生效；停用或卸载时恢复应用主题。

“桌面磨砂”打开后，工作台外壳、面板和编辑器会透出真实桌面，并与当前样式配色组合；此前选择的背景图片会暂时隐藏。该效果使用 Windows 原生 Acrylic 材质，仅在 Windows 11 22H2 及以上的桌面版显示，其他系统与 Web 版保持不透明窗口。

## 目录

| 目录           | 内容                  |
| -------------- | --------------------- |
| `runtime/`     | 独立 ESM 页面业务代码 |
| `ui/`          | 窗口和底部预览页面    |
| `styles/`      | 页面样式              |
| `locales/`     | 扩展自己的中英文 JSON |
| `settings/`    | 默认设置              |
| `assets/`      | 可替换的背景图片      |
| `permissions/` | 权限及用途            |
| `docs/`        | 使用与修改说明        |

整个目录可以直接复制到另一台电脑，或通过扩展管理器导出 ZIP。目录不引用宿主 TypeScript、源码路径或 npm 包；编译为二进制的 Blode 使用同一份 `manifest.json` 和页面资源安装。

## 修改

修改 `manifest.json` 的 `ui.presets` 可添加样式、菜单名称／图案和应用主题变量。`assets/aurora.svg` 可替换为自己的背景，并更改 preset 的 `background` 路径。新样式需要同时加入 `settings.fields` 中的选项以及 `locales/` 的显示名称。

`settings.fields` 中的 `desktopGlass` 布尔字段由 `ui.desktopGlassSetting` 绑定为桌面磨砂开关；页面通过 `window.blodeExtension.configure({ desktopGlass: true })` 保存，宿主据此为工作台启用透明外壳。关闭后恢复当前样式的不透明表面。

页面脚本使用 ESM，运行于 iframe。新增第三方模块依赖时，先在扩展自己的项目中打包为独立脚本再分发；不导入宿主源码。宿主将本包引用的 CSS、脚本与图片内联为隔离文档。

修改包内容后需要重新审查指纹。开发时先在管理器卸载旧包，再从修改后的目录安装；本机 `.uel` 授权不随 ZIP 分享。
