# 多编译入口

一个工作区可以管理多个独立工程。每个入口有名称、工程目录、运行时、语言标准和编译工具设置。入口之间分别保存构建结果。

## 使用方式

1. 打开 **生成 → 编译设置**。
2. 点击 **新增入口**，设置名称和相对于工作区的工程目录。
3. 目录已有 `be` 时，选择“跟随工程配置”即可使用该工程的入口和平台。
4. 根据需要覆盖入口文件、C 标准、Debug / Release、固件体积优化以及各平台的 C / C++ 工具版本。
5. 保存。只有一个入口时直接编译；多个入口时，从 **生成 → 编译 → 入口名称** 选择。

快捷键使用指定的默认入口；没有指定时打开入口菜单。删除入口只修改配置，保留工程文件。

## 配置示例

工作区根目录的 `be` 保留原有项目配置，在 `build` 中添加入口清单：

```json
{
  "build": {
    "defaultTarget": "controller",
    "settings": {
      "common": { "family": "gnu-arm" }
    },
    "targets": [
      {
        "id": "controller",
        "name": "主控 · 调试",
        "root": "Controller",
        "build": {
          "cStandard": "c99",
          "settings": { "mode": "debug" }
        }
      },
      {
        "id": "camera",
        "name": "摄像头 · 发布",
        "root": "Camera",
        "build": {
          "entry": "src",
          "settings": {
            "mode": "release",
            "optimizeForSize": true,
            "platforms": {
              "Esp32_S3_CAM": {
                "cpp": { "family": "arduino", "version": "3.0.7" }
              }
            }
          }
        }
      }
    ]
  }
}
```

以上展示的是 `build` 部分；完整的 `be` 还包含项目名称、运行时等已有字段。示例中的 `Controller/be` 和 `Camera/be` 分别声明自己的平台及工程设置。

| 字段            | 说明                                                              |
| --------------- | ----------------------------------------------------------------- |
| `id`            | 稳定标识；1–64 个字母、数字、下划线或连字符，首字符为字母或数字。 |
| `name`          | 在菜单和编译设置中显示的名称。                                    |
| `root`          | 工作区内的工程目录；`.` 代表工作区根目录。                        |
| `config`        | 可选的平台配置覆盖，例如 `boardId`、`toolchain`。                 |
| `build`         | 可选的 `entry`、`files`、`cStandard` 和 `settings` 覆盖。         |
| `defaultTarget` | 快捷键及 `build()` 无参数调用使用的入口 ID。                      |

覆盖顺序由低到高：工作区共用编译设置 → 子工程 `be` → 入口自身设置。平台内继续区分通用、C 和 C++ 工具选择。入口不能再嵌套入口清单。

## 构建与产物

构建保持当前工作区和协作会话不变。每个入口在自己的工程目录中生成：

```text
Controller/
├── be
├── main.c
└── .blode/targets/controller/
    ├── build-state.json
    ├── build/
    └── staging/
```

源文件、工程配置、编译输入和固件哈希用于判断该入口的构建是否过期。各入口的缓存、对象文件和暂存目录相互独立。最近编译的入口在重新打开软件后恢复；烧录和导出使用该入口的成功产物。

桌面端和 Web 调试器自动关联最近入口的 ELF。成功构建时记录 ELF 校验值，切换入口时更新符号，构建过期、目录删除或 ELF 变更后清除自动关联。手动选择的 ELF 优先；连接期间保留该调试会话的符号。

设备连接使用工作台当前选择的串口或调试器。编译入口中的历史连接编号不会替换当前选择。平台与当前设备选择不一致时，重新选择对应运行时后再烧录。

未配置 `targets` 的工程继续使用原有 `build.entry`、`build.files` 和编译设置。

## API

```ts
await window.blode.build('controller');
await window.blode.build(); // 单入口、默认入口或原有工程
```

自动化接口使用 `build.run`：

```json
{ "targetId": "controller" }
```

`state.get` 中的 `buildTarget` 描述当前产物所属入口，`targetBuilds` 列出各入口的结果与过期状态。产物路径相对于工作区返回；入口内部的编译进程以该入口的工程目录运行。

## 验证范围

已用两个临时 STM32 工程和本机 GNU Arm 工具链执行离线编译，分别验证 C99 / Debug 与 C17 / Release、独立产物、BIN / HEX / S-record / ELF 导出。另覆盖入口增删、重复 ID、越界目录、符号链接、旧工程兼容、重启恢复及 30 个入口的滚动与键盘选择。此次入口验证未调用用户硬件。
