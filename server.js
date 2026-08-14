"use strict";

// 本地开发服务器：与 Vercel 使用同一个 handler，方便在本地调试。
const http = require("http");
const handler = require("./api/index");

const port = Number(process.env.PORT) || 3000;

const server = http.createServer((req, res) => {
  handler(req, res).catch((err) => {
    console.error("[fake-ai-api] 处理请求出错:", err);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(
        JSON.stringify({
          error: { message: "Internal Server Error", type: "server_error", param: null, code: "internal_error" },
        })
      );
    } else {
      res.end();
    }
  });
});

server.listen(port, () => {
  console.log(`[fake-ai-api] 本地服务已启动: http://localhost:${port}`);
  console.log("[fake-ai-api] 端点: GET /v1/models, POST /v1/chat/completions, POST /v1/messages");
});
