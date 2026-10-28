# 调试模式与刷新

应用配置位于仓库根目录的 `config/application.json`。它配置桌面应用本身，与工程的 `.blode/project.json` 独立。主进程从 `app.getAppPath()/config/application.json` 读取配置：

```json
{
  "debug": {
    "enabled": true,
    "openDevToolsOnStart": false
  }
}
```

`debug.enabled` 默认 `true`，允许开发运行时使用调试快捷键；`openDevToolsOnStart` 默认 `false`，设为 `true` 后在窗口首次加载完成时自动打开开发者工具。主进程还检查 `!app.isPackaged`，已打包的应用不启用这些调试控制。配置修改后须重新启动 Electron 主进程。

配置缺失时使用默认值；JSON 格式错误、布尔值写成字符串、未知字段等情况会报告 `error.invalidApplicationConfig`，不会悄悄忽略错误。

| 快捷键                     | 行为                           |
| -------------------------- | ------------------------------ |
| `F12`                      | 打开或关闭当前窗口的开发者工具 |
| `F5` / `Ctrl+R`            | 刷新当前界面                   |
| `Ctrl+F5` / `Ctrl+Shift+R` | 忽略缓存并强制重载当前界面     |

只有明确按下这些按键时才刷新；松开按键、长按产生的重复事件和其他编辑器快捷键不触发刷新。快捷键通过 Electron `before-input-event` 处理，即使 Monaco 获得焦点也有效。

刷新与强制重载重新创建前端状态，未保存的编辑内容可能丢失。需要保留修改时先使用保存操作；已保存的工程文件、配置和构建结果仍由主进程管理。这里的刷新不会重新编译主进程、preload 或型号适配器；修改这些模块后仍需停止并重新运行 `npm run dev`。

`src/core/debug.ts` 独立负责配置读取、纯快捷键映射与窗口事件绑定。主进程负责决定是否允许启用；`classifyDebugShortcut()` 可在普通 Node 测试中验证，不需要启动 Electron。配置不会自动保存源码、写入固件或触发设备操作。
