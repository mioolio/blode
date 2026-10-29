# 补全清单与外部 AI 预测提示

C 标准库与声明式语义规则的目录格式见 [语言规则](LANGUAGE-RULES.md)。工程通过 `be.build.cStandard` 选择 C99／C11／C17／C23，工作区符号索引及 `language.index` 接口提供定义位置。用户和外部 AI 仍可通过补全清单添加、覆盖和禁用条目。

补全清单是声明式数据。用户可在“首选项 → 补全与 AI 预测”编辑，已认证的外部 AI 也可通过同一接口读写。软件不会执行清单中的 JavaScript，也不会连接任何模型服务或保存模型 API 密钥。

## 手动维护补全清单

首选项中的 JSON 包含 `useBuiltins` 和 `entries`：

```json
{
  "useBuiltins": true,
  "entries": [
    {
      "language": "cpp",
      "name": "board_init",
      "kind": "function",
      "detail": "void board_init(void)",
      "documentation": "初始化当前开发板。",
      "insertText": "board_init();"
    },
    {
      "language": "cpp",
      "owner": "Board",
      "name": "start",
      "kind": "method",
      "detail": "void start()",
      "insertText": "start()"
    }
  ]
}
```

- C／Arduino 在编辑器中使用 `cpp` 语言 ID。
- `kind` 可选 `function`、`method`、`variable`、`constant`、`type`、`keyword`、`snippet`、`property`。
- `owner` 存在时，只在对应的 `Board.` 等成员访问后显示。
- 同一 `language`／`owner`／`name` 替换内置同名项；加上 `disabled: true` 可隐藏内置项。`useBuiltins: false` 关闭内置清单，保留用户项与工程符号解析。
- `insertText` 支持 Monaco 的 `${1:参数}` 片段语法。预测提示接口则接收普通文本，不解释片段占位符。
- 点击保存后立即生效；“恢复内置清单”清除用户覆盖，不改变 AI 预测开关。可展开“查看内置清单”参考已有结构。
- 原有工程级 `blode.completions.json` 和头文件／宏解析继续工作。

清单最多 1000 项，配置总大小限制为 1 MB，保存在应用数据目录的 `ai-assistance.json`。它属于本机用户设置，不写入平台核心源码。修改带版本号，其他用户或 AI 同时更新时会提示版本冲突，刷新后重新合并，不会静默覆盖。

## 外部 AI 修改清单

沿用 [AI 管道](AI-PIPE.md) 的连接、令牌与 JSON-RPC 封包。以下示例展示 `method` 与 `params`；同名能力也通过 MCP 工具目录暴露。

1. 调用 `ai.state`，取得 `revision`、`predictionEnabled`、`useBuiltins`、用户 `entries` 与只读 `builtins`。
2. 在原清单上合并变更，以取得的版本调用 `ai.configure`。

```json
{
  "method": "ai.configure",
  "params": {
    "revision": 0,
    "useBuiltins": true,
    "entries": [
      {
        "language": "cpp",
        "name": "LED_PIN",
        "kind": "constant",
        "detail": "当前板载 LED 引脚"
      }
    ]
  }
}
```

`entries` 是新的完整用户清单，提交前应保留不打算删除的项目。恢复默认使用 `ai.configure` 的 `{ "revision": 当前版本, "resetCatalog": true }`。AI 可让用户打开首选项，说明需要修改的条目；用户与 AI 使用同一个版本和校验规则。

## 可选的预测提示

预测提示**默认关闭**。用户在首选项启用后，或者外部 AI 通过 `ai.configure` 明确设置 `predictionEnabled: true` 后，编辑器才开始发布上下文。未启用时不会创建预测请求。

1. 用户暂停输入约 450 ms 后，编辑器提交当前工程、文件、模型版本、光标与附近上下文。
2. 外部 AI 调用 `ai.predictions.poll` 获取待处理请求。首次传 `{}`，后续可传 `{ "after": 上次返回的cursor }`。
3. 请求包含唯一 `id`、递增 `sequence`、`projectRoot`、`path`、`editorId`、`modelVersion`、`line`、`column`、`prefix`、`suffix` 和过期时间。前后文各最多 12000 个字符，不自动发送整个工程。
4. AI 生成**从光标开始追加的普通文本**，调用：

```json
{
  "method": "ai.prediction.submit",
  "params": {
    "requestId": "从待处理请求取得的 id",
    "text": "return 0;"
  }
}
```

匹配当前编辑器快照的结果以灰色预测文本显示。按 `Tab` 接受整个可见建议，可通过撤销恢复；继续输入、移动光标、切换文件、远程改动或按 `Escape` 会让旧建议失效，并在需要时生成新请求。建议最多 16384 字符，请求 60 秒后过期。旧请求、已取消请求、切换工程后的结果会被拒绝；客户端也再次核对模型版本与光标，避免延迟响应插入错误位置。

`status.aiPredictionRequested <id>` 与 `status.aiPredictionReady <id>` 事件可帮助外部 AI 决定何时轮询；`ai.prediction.read` 用于读取已提交结果，`ai.prediction.cancel` 可按 `editorId` 及可选 `requestId` 取消。普通编辑器补全在预测关闭或外部 AI 未响应时照常工作。

预测服务不会自行运行模型。用户需要保持外部 AI 连接，由它读取请求并提交建议。关闭开关会立即取消所有待处理预测，不影响常规补全清单。
