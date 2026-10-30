# AI 与 Blode Studio 通信

Blode Studio 将同一套核心方法映射为 Electron IPC、系统管道 JSON-RPC 和 MCP 工具。AI 可使用具名接口管理工程；显式命令接口 `terminal.run` 另需 `confirm: true`。桌面程序或独立 Node Web 服务必须先启动，当前打开的工程就是调用目标。

## 连接与身份验证

- Windows：`\\.\pipe\blode-<profile hash>` 命名管道。
- macOS / Linux：临时目录中的 `blode-<uid>-<profile hash>.sock` Unix socket。
- 默认连接信息：Windows `%APPDATA%\Blode Studio\automation\connection.json`；macOS `~/Library/Application Support/Blode Studio/automation/connection.json`；Linux `${XDG_CONFIG_HOME:-~/.config}/Blode Studio/automation/connection.json`。
- 自定义数据目录时，用环境变量 `BLODE_CONNECTION_FILE` 或桥接参数 `--connection <绝对路径>` 指定连接信息文件。
- 实际 endpoint 和 token 文件路径也可从界面的 AI 接口面板查看；不要猜测管道名。

连接信息格式：

```json
{
  "version": 1,
  "endpoint": "\\\\.\\pipe\\blode-0123456789abcdef",
  "tokenFile": "C:\\Users\\name\\AppData\\Roaming\\Blode Studio\\automation\\token",
  "pid": 12345
}
```

读取 `tokenFile` 获取 64 位十六进制字符串。每次应用启动都会生成新 token，每次请求都必须携带 `auth`。凭证不放在工程、响应、MCP 配置或日志中。Unix 使用 `0600` 文件权限；Windows 使用 `icacls` 限制为当前用户的读写权限。持有 token 的本机进程可以修改当前工程、配置和使用设备；仅将它提供给可信的 AI 客户端。

## JSON-RPC 2.0 帧规范

传输编码为 UTF-8，每行一个 JSON 对象，以 LF (`\n`) 结束；也兼容 CRLF。不是 HTTP，没有 Content-Length 头。允许分包和多帧连续写入，不支持批量数组。请求 `id` 是字符串或整数；省略 `id` 表示 notification，不返回结果，建议所有工作操作都提供 `id`。

```json
{ "jsonrpc": "2.0", "id": 1, "method": "ports.list", "auth": "<token>", "params": {} }
```

```json
{ "jsonrpc": "2.0", "id": 1, "result": [{ "path": "COM3", "vendorId": "1A86", "productId": "7523" }] }
```

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "error": {
    "code": -32602,
    "message": "rpc.invalidParams",
    "data": [{ "path": ["confirm"], "code": "invalid_value" }]
  }
}
```

`message` 使用稳定的机器键，适合客户端按自身语言翻译。核心服务错误时，`data.reason` 包含核心错误键或工具诊断。成功但没有返回值的方法返回 `null`。

## 标准映射

MCP 工具名统一为 `blode_` + 将方法名中的 `.` 替换为 `_`。例如 `project.readFile` 映射到 `blode_project_readFile`，所有参数及结果保持一致。

| 管道方法            | params                                                                      | result / 作用                                                                    |
| ------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `state.get`         | `{}`                                                                        | `AppState`：工程根目录、完整配置、源文件、板卡、串口、工具链、最近构建、管道位置 |
| `ports.list`        | `{}`                                                                        | `PortInfo[]`：当前真实串口及硬件标识                                             |
| `project.readFile`  | `{ "path": "src/main.ino" }`                                                | `{path,language,content}`，限当前工程已索引源文件                                |
| `project.asset`     | `{ "expectedProjectRoot": "<当前工程根目录>", "path": "assets/photo.png" }` | 图片／音视频／二进制元信息与资源读取地址；通过 `ui.command` 的 `openFile` 显示   |
| `file.write`        | `{ "path": "src/main.ino", "content": "..." }`                              | 创建/覆盖工程允许的源文件，返回 `null`                                           |
| `config.set`        | `{ "config": <完整 ProjectConfig> }`                                        | 验证并保存完整配置，返回 `null`                                                  |
| `build.run`         | `{}`                                                                        | `BuildResult`：success、Flash/RAM 用量、产物路径、timestamp、工具输出            |
| `flash.run`         | `{ "confirm": true }`                                                       | 将已构建固件烧录到当前配置端口，返回 `null`                                      |
| `device.probe`      | `{ "port": "COM3", "config": {...} }`，均可省略                             | 识别芯片与 Flash；config 可指定板卡/探针，未打开工程也可调用；可能重启设备       |
| `toolchain.install` | `{ "confirm": true }`                                                       | 官方工具链安装结果 `ToolchainStatus`                                             |
| `serial.open`       | `{ "port": "COM3", "baudRate": 115200 }`，两项可省略                        | 打开串口，返回 `null`                                                            |
| `serial.close`      | `{}`                                                                        | 关闭监视器释放端口，返回 `null`                                                  |
| `serial.write`      | `{ "data": "hello\n" }`                                                     | 向已打开串口发送文本，返回 `null`                                                |
| `events.poll`       | `{ "after": 0 }`，after 可省略                                              | `{cursor,dropped,events:[{sequence,event:{kind,level,message,time}}]}`           |

`config.set` 需要先读取 `state.get` 的 `config`，修改所需字段后提交完整对象；不接受任意字段或 JSON patch。`ProjectConfig` 的权威 TypeScript 类型位于 [contracts.ts](../src/shared/contracts.ts)，运行时配置校验位于 [config.ts](../src/core/config.ts)。单纯修改分区图并不会改写设备，编译成功后再调用 `flash.run` 才会烧录。

`flash.run` 和 `toolchain.install` 的 `confirm` 必须为布尔值 `true`，不能使用字符串。客户端必须根据用户指令决定是否有权进行对应操作；它是调用者的明确声明，不代表软件另外弹出了授权窗口。

源文件写入经过核心的工程根目录约束、扩展名白名单、大小限制及符号链接/目录联接检查。命令窗口在目标电脑运行持久 PTY Shell；`terminal.open/run/write/close` 需 `confirm: true`。`run` 提交一条命令，`write` 支持后续交互输入；`stop` 发送 Ctrl+C，`close` 结束会话。`state` 支持 `sessionId`／`after` 增量游标，`resize` 设置行列；输出缓存有界。`config.set` 可以配置自定义工具链可执行文件；工具路径、Git 与命令调用属于可信主机操作。

## 扩展工作台能力

连接后先调用 `capabilities.get` 查询当前方法、说明及确认要求；MCP 工具目录使用同一份参数校验清单。新增能力覆盖文件／目录管理、工程与最近记录、驱动、固件导出与独立烧录、硬件调试、补全配置、协作草稿以及界面操作。

| 能力       | 方法                                                                                                                                                                                                         |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 文件与目录 | `file.create`、`directory.create`、`file.rename`、`file.delete`                                                                                                                                              |
| 工程与历史 | `project.open`、`project.close`、`recent.list`、`recent.remove`                                                                                                                                              |
| 驱动       | `drivers.status`、`drivers.install`                                                                                                                                                                          |
| 固件       | `firmware.prepare`、`firmware.export`、`firmware.flash`                                                                                                                                                      |
| 独立调试   | `debugger.open`、`debugger.state`、`debugger.symbols.set`、`debugger.connect`、`debugger.action`、`debugger.breakpoint`、`debugger.memory`、`debugger.storage`、`debugger.tools.install`、`debugger.gdb.set` |
| 调试编辑   | `debugger.assemble` 生成机器码预览；`debugger.breakpoints` 批量断点；`debugger.patch` 使用会话 ID、原字节比较和 `confirm: true` 修改 SRAM 指令                                                               |
| 界面与日志 | `ui.state`、`ui.command`、`window.action`、`logs.latest`                                                                                                                                                     |
| 补全与预测 | `ai.state`、`ai.configure`、`ai.predictions.poll`、`ai.prediction.submit`、`ai.prediction.read`、`ai.prediction.request`、`ai.prediction.cancel`                                                             |
| 多人协作   | `collaboration.state`、`collaboration.open`、`collaboration.presence`、`collaboration.edit`、`collaboration.save`、`collaboration.resolve`、`collaboration.leave`                                            |
| 撤销与重做 | `collaboration.undo`（`direction: undo/redo`，`scope: own/global`；全局仅可信本地传输）                                                                                                                      |
| 本地 Git   | `git.status`、`git.diff`、`git.action`                                                                                                                                                                       |
| 工具版本   | `tools.versions`、`tools.installVersion`、`tools.selectVersion`                                                                                                                                              |
| 组件库     | `components.state`、`components.search`、`components.install`、`components.import`、`components.remove`                                                                                                      |
| 工程打包   | `project.package.preview`、`project.package.export`                                                                                                                                                          |
| 主机目录   | `host.browse`（目标电脑路径）                                                                                                                                                                                |
| 命令窗口   | `terminal.state`、`terminal.open`、`terminal.run`、`terminal.write`、`terminal.resize`、`terminal.stop`、`terminal.close`                                                                                    |
| 插件视图   | `runtime.plugins`、`runtime.view.info`、`runtime.view.open`；打开请求可指定工作台 `target`                                                                                                                   |

文件树操作使用工程相对路径。`project.open`、`firmware.prepare/export`、`debugger.symbols.set` 和 `debugger.gdb.set` 使用桌面服务所在电脑的绝对路径；不通过浏览器任意访问客户端文件。`firmware.prepare` 返回不可变选择 ID，随后将 ID、配置、地址及 `confirm: true` 交给 `firmware.flash`。导出默认不覆盖已有文件，覆盖时另需 `confirmOverwrite: true`。

`flash.run`、`toolchain.install`、`file.delete`、`project.close`、`drivers.install`、`firmware.flash`、`debugger.tools.install`、`components.install/import/remove` 和 `window.action` 都必须传布尔值 `confirm: true`。软件允许已授权 AI 直接执行这些动作，不额外弹出确认流程；参数校验、设备互斥、构建指纹和目标边界检查仍然生效。

`debugger.patch` 同样要求 `confirm: true`，且必须使用 `debugger.state` 返回的当前 `sessionId`。参数还包括 `address`、原机器码 `expected`、新机器码 `bytes` 和布尔值 `pauseAndResume`。内置实现仅改写 STM32F103C8T6 SRAM 中等长的单条 Thumb 指令；运行中修改需 `pauseAndResume: true`，写入或校验失败后不继续运行。`debugger.assemble` 接收 `address`、`source` 并返回机器码预览，不写入硬件。`debugger.breakpoints` 接收最多 128 项 `locations`，逐项返回状态。详见[调试编辑契约](internal/debugger-editing.md)。

`ui.state` 列出已连接界面的 `clientId`、当前文件、标签、未保存文件及面板状态。`ui.command` 默认作用于桌面端，无桌面端时选择一个活跃网页客户端；也可用 `target` 指定 ID。命令会等待该界面回执。例如：

```json
{ "method": "ui.command", "params": { "action": "preferences" } }
```

```json
{ "method": "ui.command", "params": { "action": "consolePanel", "visible": false } }
```

支持的 `action` 为 `home`、`project`、`view`（附 `view: code/layout/ai`）、`openFile/closeFile/pinFile`（附 `path`）、`preferences`、`save`、`console`（附 `tab: output/serial/problems/warnings/terminal`）、`consolePanel/devicePanel`（附 `visible`）、`editor`（附 `command: undo/redo/find/format/gotoLine/selectAll`）、`splitEditor`、`language`（附 `language: zh-CN/en`）、`syncDrafts`（附 `visible`）及 `clearLogs`。它是命名操作接口，不接受任意 JavaScript。

工具示例：`tools.installVersion({"id":"gnu-arm:14.2.1-1.1","confirm":true})`；`tools.selectVersion` 返回要合入 `config.toolchain` 的字段，再通过 `config.set` 保存。Git 的提交、拉取、推送和删除远端均需显式确认；禁止强推，拉取仅快进。工程 ZIP 导出需要先预览，外部依赖另需 `confirmExternal: true`，未解决警告另需 `allowIncomplete: true`。所有接口以 `capabilities.get` 返回的参数模式为准。

`project.readFile` 读取磁盘索引；读取含未保存修改的当前共享版本请使用 `collaboration.open`。编辑时提交其 `session`、`revision` 与 UTF-16 偏移变化，收到冲突后先核对合并，再以准确版本保存。旧 `file.write` 无法静默替换其他用户的共享草稿。工程切换会先保存已同步的共享修改；未同步的本地编辑应先经目标界面的 `save` 命令保存。

手动及 AI 修改补全、预测请求示例见 [补全与外部 AI 预测](AI-COMPLETIONS.md)；协作者颜色、版本合并与稳定阅读位置见 [网页多人协作](COLLABORATION.md)。

## 组件库接口

组件操作针对当前宿主工程。先读取 `components.state`，再将返回的 `projectRoot` 原样作为写操作的 `expectedProjectRoot`；宿主在开始及提交时检查工程是否仍匹配。无工程时可搜索在线索引，但不能安装、导入或移除。

| 方法                 | params                                                                                                          | 返回                                                                                    |
| -------------------- | --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `components.state`   | `{}`                                                                                                            | `projectRoot`、`manifestPath`、项目 `components`、平台内置 `provided`                   |
| `components.search`  | `{ "query": "SSD1306" }`                                                                                        | `query`、`entries`、`truncated`；条目含版本列表、最新版本、描述、作者及按版本划分的依赖 |
| `components.install` | `{ "name": "<搜索结果名称>", "version": "<所选版本>", "expectedProjectRoot": "<当前根目录>", "confirm": true }` | 更新后的组件状态；同时安装缺少的递归依赖                                                |
| `components.import`  | `{ "path": "<宿主绝对路径>", "kind": "directory", "expectedProjectRoot": "<当前根目录>", "confirm": true }`     | 更新后的组件状态；ZIP 使用 `kind: "archive"`                                            |
| `components.remove`  | `{ "id": "<组件 id>", "expectedProjectRoot": "<当前根目录>", "confirm": true }`                                 | 更新后的组件状态；拒绝删除有本地变更或仍被依赖的组件                                    |

搜索只在显式请求时联网。`components.state` 读取本地清单与已安装平台库，不隐式搜索。库索引和下载来自 Arduino 官方分发地址；安装会校验归档并解析依赖，错误保留库名、版本或路径等诊断信息。组件导入不执行包内脚本。

目录或 ZIP 通过 `host.browse` 在目标机器上选择。例如，`components.state` 返回 `C:\projects\device` 后，可发送：

```json
{
  "method": "components.import",
  "params": {
    "path": "E:\\libraries\\Display.zip",
    "kind": "archive",
    "expectedProjectRoot": "C:\\projects\\device",
    "confirm": true
  }
}
```

MCP 对应工具为 `blode_components_state`、`blode_components_search`、`blode_components_install`、`blode_components_import` 和 `blode_components_remove`。使用 `events.poll` 读取安装事件中的 `installation` 状态、阶段及下载字节数；同次操作以 `installation.id` 关联，不拼接其他安装任务的日志。

清单文件为工程根目录的 `blode.components.json`。编译时宿主从清单与实际文件派生 `ProjectBuildInputs.components`；这是运行时构建输入，不是 `be.build` 可配置字段，AI 不应通过 `file.write` 向 `be` 添加 `components`。目录格式与删除保护见[组件库指南](COMPONENT-LIBRARIES.md)，运行时字段见[项目组件构建输入](RUNTIME-PLUGINS.md#项目组件构建输入)。

## Node.js 直接调用示例

不依赖 MCP 或本工程包，任何支持 Node.js 的 AI 都可以调用：

```js
import net from 'node:net';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const manifestPath =
  process.env.BLODE_CONNECTION_FILE ??
  path.join(process.env.APPDATA, 'Blode Studio', 'automation', 'connection.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const auth = (await readFile(manifest.tokenFile, 'utf8')).trim();

function request(method, params = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(manifest.endpoint);
    const id = crypto.randomUUID();
    let buffer = Buffer.alloc(0);
    const fail = (error) => {
      socket.destroy();
      reject(error);
    };
    socket.setTimeout(15 * 60 * 1000 + 5000, () => fail(new Error('timeout')));
    socket.once('error', fail);
    socket.once('connect', () =>
      socket.write(JSON.stringify({ jsonrpc: '2.0', id, method, params, auth }) + '\n'),
    );
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > 8 * 1024 * 1024) return fail(new Error('result too large'));
      const newline = buffer.indexOf(10);
      if (newline < 0) return;
      try {
        const response = JSON.parse(buffer.subarray(0, newline).toString('utf8'));
        socket.destroy();
        if (response.id !== id) return reject(new Error('response id mismatch'));
        if (response.error) return reject(response.error);
        resolve(response.result);
      } catch (error) {
        fail(error);
      }
    });
  });
}

const state = await request('state.get');
console.log(state.config.boardId, await request('ports.list'));
```

生产客户端建议使用本仓库的 `src/automation/client.ts`：它使用 Buffer 拼接处理多字节字符跨包、读取最新 token、检查响应 id、限制缓冲大小并处理连接关闭。

## Python 直接调用示例

Windows 命名管道可作为二进制文件打开；Unix 使用 socket。只用 Python 标准库：

```python
import json, os, socket
from pathlib import Path

connection = Path(os.environ.get('BLODE_CONNECTION_FILE') or (
    Path(os.environ['APPDATA']) / 'Blode Studio' / 'automation' / 'connection.json'
))
manifest = json.loads(connection.read_text(encoding='utf-8'))
token = Path(manifest['tokenFile']).read_text(encoding='utf-8').strip()
request = {'jsonrpc':'2.0', 'id':1, 'method':'ports.list', 'params':{}, 'auth':token}
frame = (json.dumps(request, ensure_ascii=False) + '\n').encode('utf-8')

if os.name == 'nt':
    with open(manifest['endpoint'], 'r+b', buffering=0) as pipe:
        pipe.write(frame)
        response = json.loads(pipe.readline(8 * 1024 * 1024))
else:
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
        client.settimeout(905)
        client.connect(manifest['endpoint'])
        client.sendall(frame)
        with client.makefile('rb') as reader:
            response = json.loads(reader.readline(8 * 1024 * 1024))

if 'error' in response:
    raise RuntimeError(response['error'])
print(response['result'])
```

macOS/Linux 请通过 `BLODE_CONNECTION_FILE` 指定上文对应路径。Python Windows 文件式管道的打开可能因服务尚未启动或繁忙而失败；由调用方有限重试连接，不能自动重试烧录请求。

## MCP stdio 配置

开发运行 `npm run mcp`。`npm run build` 后生成 `dist/mcp-bridge.mjs`，可给任意支持 MCP 的 AI 配置：

```json
{
  "mcpServers": {
    "blode-studio": {
      "command": "node",
      "args": ["C:/Users/name/Desktop/blode/dist/mcp-bridge.mjs"],
      "env": {
        "BLODE_CONNECTION_FILE": "C:/Users/name/AppData/Roaming/Blode Studio/automation/connection.json",
        "BLODE_LANG": "zh-CN"
      }
    }
  }
}
```

桥接器 stdout 只输出 MCP 帧，启动诊断写 stderr。默认工具描述为中文，`BLODE_LANG=en-US` 切换英文。桥接器本身不安装依赖、不启动 IDE、不执行代码；工具调用始终经过运行中 IDE 的同一套验证。构建产物依赖本工程的 `node_modules`，移动部署时需保留依赖或另行分发桥接器依赖。

## 建议的 AI 工作顺序

1. `state.get` 读取工程与配置，`ports.list` 列出端口。
2. `device.probe` 核对真实芯片和 Flash，避免将串口转换器名称当作芯片型号；未打开工程时可通过可选 `config` 指定板卡与探针。
3. 读取源文件，再通过 `file.write` 写入；`config.set` 更新完整配置。
4. `build.run`，检查 `success`、工具输出、真实占用与分区大小。
5. 用户已授权烧录时调用 `flash.run` 且 `confirm:true`。
6. `serial.open`，用 `events.poll` 读取设备输出；下一次请求携带上次返回的 `cursor`。

## 限制与错误码

- 单请求最大 2 MiB，单源文件内容最多 1,000,000 字符且继续受核心字节上限约束；响应最大 8 MiB。
- 同时最多 8 个连接，每连接最多排队 8 帧，请求按每连接接收顺序执行。
- 空闲连接 60 秒关闭；每请求最长等待 15 分钟。核心操作另有自身超时及互斥约束。
- 构建/安装在客户端断开或 RPC 超时后可能仍继续；超时不代表取消。先检查 `state.get` 和事件，不能自动重复写入或烧录。
- 事件仅保留最近 256 条，每条最多 8192 字符；`dropped:true` 表示有历史被丢弃。应用重启后事件游标重新计数。
- 无文件系统任意读取、shell、网络代理、远程监听、自动发现其他账户凭证接口。

| 错误码   | 含义                                 |
| -------- | ------------------------------------ |
| `-32700` | JSON 解析失败                        |
| `-32600` | 非法请求对象或响应                   |
| `-32601` | 未注册方法                           |
| `-32602` | 参数或路径非法                       |
| `-32000` | 核心操作失败，查看 `data.reason`     |
| `-32001` | token 错误或失效，错误验证后关闭连接 |
| `-32002` | 请求超时                             |
| `-32003` | 连接关闭                             |
| `-32004` | 工程文件不存在                       |
| `-32005` | 请求大小、连接队列等限制             |
| `-32006` | 响应太大                             |

覆盖验证见 `tests/automation.test.ts`：真实 Windows 命名管道请求、身份验证、分帧、参数校验、显式确认、路径约束、事件游标、第二实例及 MCP 客户端往返。
