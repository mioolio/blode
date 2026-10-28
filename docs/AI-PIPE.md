# AI 与 Blode Studio 通信

Blode Studio 将同一套核心方法映射为 Electron IPC、系统管道 JSON-RPC 和 MCP 工具。AI 不需要操作界面，也不需要获得 shell 接口。程序必须先启动，当前打开的工程就是调用的目标工程。

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

| 管道方法            | params                                               | result / 作用                                                                    |
| ------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------- |
| `state.get`         | `{}`                                                 | `AppState`：工程根目录、完整配置、源文件、板卡、串口、工具链、最近构建、管道位置 |
| `ports.list`        | `{}`                                                 | `PortInfo[]`：当前真实串口及硬件标识                                             |
| `project.readFile`  | `{ "path": "src/main.ino" }`                         | `{path,language,content}`，限当前工程已索引源文件                                |
| `file.write`        | `{ "path": "src/main.ino", "content": "..." }`       | 创建/覆盖工程允许的源文件，返回 `null`                                           |
| `config.set`        | `{ "config": <完整 ProjectConfig> }`                 | 验证并保存完整配置，返回 `null`                                                  |
| `build.run`         | `{}`                                                 | `BuildResult`：success、Flash/RAM 用量、产物路径、timestamp、工具输出            |
| `flash.run`         | `{ "confirm": true }`                                | 将已构建固件烧录到当前配置端口，返回 `null`                                      |
| `device.probe`      | `{ "port": "COM3", "config": {...} }`，均可省略      | 识别芯片与 Flash；config 可指定板卡/探针，未打开工程也可调用；可能重启设备       |
| `toolchain.install` | `{ "confirm": true }`                                | 官方工具链安装结果 `ToolchainStatus`                                             |
| `serial.open`       | `{ "port": "COM3", "baudRate": 115200 }`，两项可省略 | 打开串口，返回 `null`                                                            |
| `serial.close`      | `{}`                                                 | 关闭监视器释放端口，返回 `null`                                                  |
| `serial.write`      | `{ "data": "hello\n" }`                              | 向已打开串口发送文本，返回 `null`                                                |
| `events.poll`       | `{ "after": 0 }`，after 可省略                       | `{cursor,dropped,events:[{sequence,event:{kind,level,message,time}}]}`           |

`config.set` 需要先读取 `state.get` 的 `config`，修改所需字段后提交完整对象；不接受任意字段或 JSON patch。`ProjectConfig` 的权威 TypeScript 类型位于 [contracts.ts](../src/shared/contracts.ts)，运行时配置校验位于 [config.ts](../src/core/config.ts)。单纯修改分区图并不会改写设备，编译成功后再调用 `flash.run` 才会烧录。

`flash.run` 和 `toolchain.install` 的 `confirm` 必须为布尔值 `true`，不能使用字符串。客户端必须根据用户指令决定是否有权进行对应操作；它是调用者的明确声明，不代表软件另外弹出了授权窗口。

源文件写入经过核心的工程根目录约束、扩展名白名单、大小限制及符号链接/目录联接检查。无法通过本协议直接运行任意 shell 命令。`config.set` 可以配置自定义工具链可执行文件；这些文件属于与 IDE 插件相同的信任边界，必须来自用户信任的来源。

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
