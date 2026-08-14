# fake-ai-api

一个恶搞用的假 AI 服务，接口兼容 OpenAI / Anthropic，可部署到 Vercel。

模型列表与鉴权均为真实实现，但任何请求的回答都是 `ascii.txt` 的内容。支持流式输出，用于模拟 LLM 打字效果。

## 本地运行

```bash
node server.js
```

默认监听 3000 端口。API Key 打印在启动日志中：`config.js` 未配置时自动生成（`sk-` 前缀）。

## 部署到 Vercel

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/XTxiaoting14332/fake-ai-api)

推到 GitHub 后在 vercel.com 导入，或使用命令行：

```bash
npm i -g vercel
vercel --prod
```

## 配置

所有配置项都在 `config.js`：

- `apiKey`：留空则启动时随机生成并打印到日志；也可通过环境变量 `FAKE_API_KEY` 配置
- `models`：`/v1/models` 返回的模型列表。请求中的模型名不受此列表限制，列表仅用于展示
- `requireAuth`：是否校验 Key，默认开启
- `streamChunkChars` / `streamDelayMs`：流式输出的分片大小与间隔，控制打字效果
- `debug`：是否输出请求日志

## 接入 Claude Code

```bash
export ANTHROPIC_BASE_URL="http://localhost:3000"
export ANTHROPIC_API_KEY="sk-你的key"
export ANTHROPIC_MODEL="claude-sonnet-4.6"
export ANTHROPIC_SMALL_FAST_MODEL="claude-sonnet-4.6"
claude
```

Claude Code 会自行校验模型名。若报 "There's an issue with the selected model"，将报错中的模型名加入 `config.js` 的 `models` 列表。

## 接入 Codex

在 `~/.codex/config.toml` 中配置：

```toml
model = "gpt-5.6-sol"
model_provider = "fake-ai"

[model_providers.fake-ai]
name = "Fake AI"
base_url = "http://localhost:3000"
env_key = "FAKE_API_KEY"
wire_api = "responses"
```

```bash
export FAKE_API_KEY="sk-你的key"
codex
```

Codex 会用 `/v1/models` 返回的列表校验模型名，因此 `model` 需在 `config.js` 的 `models` 中（`gpt-5.6-sol` / `gpt-5.6-terra` / `gpt-5.6-luna` 均已包含）。如需改用 OpenAI 聊天接口，可将 `wire_api` 设为 `"chat"`。

## 端点

- `GET /v1/models`：模型列表
- `POST /v1/chat/completions`、`/v1/completions`：OpenAI
- `POST /v1/responses`：OpenAI Responses API（Codex）
- `POST /v1/messages`、`/v1/messages/count_tokens`：Anthropic
- `GET /`：落地页（AI 中转站样式，无需 Key）
- `GET /health`：健康检查，无需 Key

接口路径带或不带 `/api` 前缀均可。

## License

GPL-3.0
