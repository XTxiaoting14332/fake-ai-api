"use strict";

// 配置文件，改完重启（本地 node server.js，Vercel 重新部署）生效
module.exports = {
  // 调试日志：每个请求的路径 / UA / 模型名 / 响应码都会打出来
  debug: false,

  // API Key。留空则启动时随机生成一个 sk- 开头的并打印到日志，
  // 也可以改用环境变量 FAKE_API_KEY。
  apiKey: "sk-ZIK8Hygx0BLBOZmt7ZGOY4OcvqkttdIPvLEco7yHYtnKgDcu",

  // 是否校验请求头里的 Key（Authorization 或 x-api-key）
  requireAuth: true,

  // /v1/models 返回的模型列表。请求里填什么模型名都能过，这个列表只是展示用；
  models: [
    "claude-sonnet-4.6",
    "claude-sonnet-4.7",
    "claude-sonnet-4.8",
    "claude-sonnet-5",
    "claude-opus-4.6",
    "claude-opus-4.7",
    "claude-opus-4.8",
    "claude-opus-5",
    "claude-fable-5",
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
  ],

  // /v1/models 里 created 字段的值（Unix 秒）
  modelsCreated: 1700000000,

  // 用 markdown 代码块包裹 ascii 输出，客户端按等宽渲染，防止图被比例字体挤变形
  wrapCodeBlock: true,

  // 流式输出：streamChunkChars 每片字符数，streamDelayMs 每片间隔毫秒。
  // Vercel 免费版函数最长运行 10s，delay 别设太大。
  streamChunkChars: 8,
  streamDelayMs: 20,
};
