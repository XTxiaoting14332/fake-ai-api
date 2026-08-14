"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const config = require("../config");


const ASCII_TEXT = fs
  .readFileSync(path.join(__dirname, "..", "ascii.txt"), "utf8")
  .replace(/\s+$/, "");

let INDEX_HTML = "";
try {
  INDEX_HTML = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
} catch (err) {
  console.log("[fake-ai-api] 未找到 index.html，根路径将返回 404");
}

const CHUNK_SIZE = Number(config.streamChunkChars) > 0 ? Number(config.streamChunkChars) : 8;
const CHUNK_DELAY = Number(config.streamDelayMs) >= 0 ? Number(config.streamDelayMs) : 20;


function generateApiKey() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.randomBytes(48);
  let key = "";
  for (let i = 0; i < bytes.length; i += 1) {
    key += chars[bytes[i] % chars.length];
  }
  return `sk-${key}`;
}

const API_KEY =
  (typeof config.apiKey === "string" && config.apiKey.trim()) ||
  process.env.FAKE_API_KEY ||
  generateApiKey();

if (config.apiKey && String(config.apiKey).trim()) {
  console.log(`[fake-ai-api] 使用 config.js 中配置的 API Key: ${API_KEY}`);
} else if (process.env.FAKE_API_KEY) {
  console.log(`[fake-ai-api] 使用环境变量 FAKE_API_KEY: ${API_KEY}`);
} else {
  console.log(`[fake-ai-api] 未配置 API Key，本次冷启动随机生成: ${API_KEY}`);
  console.log(
    "[fake-ai-api] 注意: 每次冷启动该 Key 都会重新生成，建议在 config.js 写死，或在 Vercel 配置环境变量 FAKE_API_KEY。"
  );
}


const MODELS = (Array.isArray(config.models) ? config.models : []).map((m) => {
  const item = typeof m === "string" ? { id: m } : m || {};
  const id = item.id;
  // owned_by 按模型名推断归属，避免露出马脚
  const defaultOwner = String(id).startsWith("claude") ? "anthropic" : "openai";
  return {
    id,
    object: "model",
    created: item.created ?? config.modelsCreated ?? 1700000000,
    owned_by: item.owned_by ?? defaultOwner,
  };
});



function logLine(msg) {
  if (config.debug !== false) {
    console.log(`[fake-ai-api] ${new Date().toISOString()} ${msg}`);
  }
}

function randId(prefix, len = 24) {
  return prefix + crypto.randomBytes(Math.ceil(len / 2)).toString("hex").slice(0, len);
}

function estimateTokens(s) {
  const text = typeof s === "string" ? s : JSON.stringify(s);
  return Math.max(1, Math.ceil(text.length / 4));
}

function chunkText(text, size) {
  const chunks = [];
  for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size));
  return chunks;
}

function sendJson(res, status, obj) {
  const payload = JSON.stringify(obj);
  if (res._logMeta) logLine(`${res._logMeta.method} ${res._logMeta.p} -> ${status}`);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Length", Buffer.byteLength(payload));
  res.setHeader("Cache-Control", "no-store");
  res.end(payload);
}

function sendOpenAIError(res, status, code, message, param = null) {
  return sendJson(res, status, {
    error: { message, type: "invalid_request_error", param, code },
  });
}

function sendAnthropicError(res, status, type, message) {
  return sendJson(res, status, { type: "error", error: { type, message } });
}

function isAuthorized(req) {
  if (config.requireAuth === false) return true;
  const raw = req.headers["authorization"] || req.headers["x-api-key"] || "";
  const token = String(raw).replace(/^Bearer\s+/i, "").trim();
  return token.length > 0 && token === API_KEY;
}

function readBody(req, limit = 1000000) {
  return new Promise((resolve, reject) => {
    let data = "";
    let done = false;
    req.on("data", (chunk) => {
      if (done) return;
      data += chunk;
      if (data.length > limit) {
        done = true;
        reject(new Error("payload_too_large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!done) resolve(data);
    });
    req.on("error", (err) => {
      if (!done) {
        done = true;
        reject(err);
      }
    });
  });
}

async function parseJsonBody(req, res) {
  const meta = res._logMeta || { method: "?", p: "?" };
  let raw;
  try {
    raw = await readBody(req);
  } catch (err) {
    const status = err.message === "payload_too_large" ? 413 : 400;
    logLine(`${meta.method} ${meta.p} 请求体读取失败: ${err.message}`);
    sendOpenAIError(res, status, err.message, "Failed to read request body.");
    return null;
  }
  if (!raw.trim()) return {};
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    logLine(`${meta.method} ${meta.p} 请求体不是合法 JSON，原文前 500 字符: ${JSON.stringify(raw.slice(0, 500))}`);
    sendOpenAIError(res, 400, "invalid_json", "Request body is not valid JSON.");
    return null;
  }
  logLine(
    `${meta.method} ${meta.p} body: ${JSON.stringify({
      model: parsed.model ?? null,
      stream: parsed.stream ?? false,
      max_tokens: parsed.max_tokens ?? null,
      messages: Array.isArray(parsed.messages) ? parsed.messages.length : null,
      tools: Array.isArray(parsed.tools) ? parsed.tools.length : null,
      system: typeof parsed.system === "string" ? `${parsed.system.length} 字符` : Array.isArray(parsed.system) ? `${parsed.system.length} 块` : null,
      prompt: typeof parsed.prompt === "string" ? `${parsed.prompt.length} 字符` : null,
    })}`
  );
  // 模型名原样转义输出：如果里面混了 ANSI 控制字符（\u001b）或不可见字符，这里会原形毕露
  if (parsed.model !== undefined) {
    logLine(`${meta.method} ${meta.p} model 原样(转义后): ${JSON.stringify(parsed.model)}`);
  }
  return parsed;
}

function normalizePath(req) {
  let raw = req.url || "/";
  const q = raw.indexOf("?");
  let p = q >= 0 ? raw.slice(0, q) : raw;
  if (p.startsWith("/api")) p = p.slice(4) || "/";
  if (p.length > 1) p = p.replace(/\/+$/, "");
  return p || "/";
}

/* ============================== OpenAI 兼容响应 ============================== */

function sendOpenAIChat(res, body, legacy) {
  const id = randId("chatcmpl-");
  const model = body.model;
  const created = Math.floor(Date.now() / 1000);
  const promptText =
    typeof body.prompt === "string" ? body.prompt : JSON.stringify(body.messages || "");
  const message = legacy
    ? { role: "assistant", text: ASCII_TEXT }
    : { role: "assistant", content: ASCII_TEXT };

  return sendJson(res, 200, {
    id,
    object: legacy ? "text_completion" : "chat.completion",
    created,
    model,
    choices: [{ index: 0, message, finish_reason: "stop" }],
    usage: {
      prompt_tokens: estimateTokens(promptText),
      completion_tokens: estimateTokens(ASCII_TEXT),
      total_tokens: estimateTokens(promptText) + estimateTokens(ASCII_TEXT),
    },
  });
}

function streamOpenAIChat(res, body, legacy) {
  const id = randId("chatcmpl-");
  const model = body.model;
  const created = Math.floor(Date.now() / 1000);
  const object = legacy ? "text_completion" : "chat.completion.chunk";

  res.statusCode = 200;
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const chunks = chunkText(ASCII_TEXT, CHUNK_SIZE);
  if (res._logMeta) {
    logLine(`${res._logMeta.method} ${res._logMeta.p} -> 200 开始流式输出，共 ${chunks.length} 个分片`);
  }
  let index = 0;

  const writeChunk = (delta) => {
    res.write(
      `data: ${JSON.stringify({ id, object, created, model, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`
    );
  };

  const finish = () => {
    res.write(
      `data: ${JSON.stringify({ id, object, created, model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`
    );
    res.write("data: [DONE]\n\n");
    res.end();
  };

  // 第一个分片带上 role，模拟 OpenAI 真实行为
  writeChunk(legacy ? { text: chunks[0] || "" } : { role: "assistant", content: chunks[0] || "" });
  index = 1;

  const timer = setInterval(() => {
    if (index < chunks.length) {
      writeChunk(legacy ? { text: chunks[index] } : { content: chunks[index] });
      index += 1;
    } else {
      clearInterval(timer);
      finish();
    }
  }, CHUNK_DELAY);
}

/* ============================== OpenAI 兼容：Responses API（Codex 用） ============================== */

function buildResponsesPayload(id, body, status, output) {
  const created = Math.floor(Date.now() / 1000);
  const inputTokens = estimateTokens(body);
  const outputTokens = estimateTokens(ASCII_TEXT);
  return {
    id,
    object: "response",
    created_at: created,
    status,
    error: null,
    incomplete_details: null,
    instructions: body.instructions ?? null,
    max_output_tokens: body.max_output_tokens ?? null,
    model: body.model,
    output,
    parallel_tool_calls: true,
    previous_response_id: null,
    reasoning: null,
    store: true,
    temperature: 1,
    text: { format: { type: "text" } },
    tool_choice: "auto",
    tools: [],
    top_p: 1,
    truncation: "disabled",
    usage: {
      input_tokens: inputTokens,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: outputTokens,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: inputTokens + outputTokens,
    },
    user: null,
    metadata: {},
  };
}

function sendResponses(res, body) {
  const id = randId("resp_");
  const outputItem = {
    id: randId("msg_"),
    type: "message",
    status: "completed",
    role: "assistant",
    content: [{ type: "output_text", text: ASCII_TEXT, annotations: [] }],
  };
  return sendJson(res, 200, buildResponsesPayload(id, body, "completed", [outputItem]));
}

function streamResponses(res, body) {
  const id = randId("resp_");
  const msgId = randId("msg_");

  res.statusCode = 200;
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const evt = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  const payload = (status, output) => buildResponsesPayload(id, body, status, output);

  evt({ type: "response.created", response: payload("in_progress", []) });
  evt({ type: "response.in_progress", response: payload("in_progress", []) });
  evt({
    type: "response.output_item.added",
    output_index: 0,
    item: { id: msgId, type: "message", status: "in_progress", role: "assistant", content: [] },
  });
  evt({
    type: "response.content_part.added",
    item_id: msgId,
    output_index: 0,
    content_index: 0,
    part: { type: "output_text", text: "", annotations: [] },
  });

  const chunks = chunkText(ASCII_TEXT, CHUNK_SIZE);
  if (res._logMeta) {
    logLine(`${res._logMeta.method} ${res._logMeta.p} -> 200 开始流式输出，共 ${chunks.length} 个分片`);
  }
  let index = 0;

  const timer = setInterval(() => {
    if (index < chunks.length) {
      evt({
        type: "response.output_text.delta",
        item_id: msgId,
        output_index: 0,
        content_index: 0,
        delta: chunks[index],
      });
      index += 1;
    } else {
      clearInterval(timer);
      const item = {
        id: msgId,
        type: "message",
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text: ASCII_TEXT, annotations: [] }],
      };
      evt({
        type: "response.output_text.done",
        item_id: msgId,
        output_index: 0,
        content_index: 0,
        text: ASCII_TEXT,
        annotations: [],
      });
      evt({
        type: "response.content_part.done",
        item_id: msgId,
        output_index: 0,
        content_index: 0,
        part: { type: "output_text", text: ASCII_TEXT, annotations: [] },
      });
      evt({ type: "response.output_item.done", output_index: 0, item });
      evt({ type: "response.completed", response: payload("completed", [item]) });
      res.write("data: [DONE]\n\n");
      res.end();
    }
  }, CHUNK_DELAY);
}

/* ============================== Anthropic 兼容响应 ============================== */

function sendAnthropicMessage(res, body) {
  const id = randId("msg_");
  return sendJson(res, 200, {
    id,
    type: "message",
    role: "assistant",
    model: body.model,
    content: [{ type: "text", text: ASCII_TEXT }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: estimateTokens(body),
      output_tokens: estimateTokens(ASCII_TEXT),
    },
  });
}

function streamAnthropicMessage(res, body) {
  const id = randId("msg_");
  const inputTokens = estimateTokens(body);
  const outputTokens = estimateTokens(ASCII_TEXT);

  res.statusCode = 200;
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const evt = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  evt("message_start", {
    type: "message_start",
    message: {
      id,
      type: "message",
      role: "assistant",
      model: body.model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: inputTokens, output_tokens: 1 },
    },
  });
  evt("content_block_start", {
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "" },
  });

  const chunks = chunkText(ASCII_TEXT, CHUNK_SIZE);
  if (res._logMeta) {
    logLine(`${res._logMeta.method} ${res._logMeta.p} -> 200 开始流式输出，共 ${chunks.length} 个分片`);
  }
  let index = 0;

  const timer = setInterval(() => {
    if (index < chunks.length) {
      evt("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: chunks[index] },
      });
      index += 1;
    } else {
      clearInterval(timer);
      evt("content_block_stop", { type: "content_block_stop", index: 0 });
      evt("message_delta", {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: outputTokens },
      });
      evt("message_stop", { type: "message_stop" });
      res.end();
    }
  }, CHUNK_DELAY);
}

/* ============================== 主入口 ============================== */

async function handle(req, res) {
  const method = (req.method || "GET").toUpperCase();
  const p = normalizePath(req);

  // CORS：方便浏览器端/网页工具直接调用
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Authorization, Content-Type, x-api-key, anthropic-version"
  );
  res.setHeader("Access-Control-Max-Age", "86400");

  if (method === "OPTIONS") {
    res.statusCode = 204;
    return res.end();
  }

  // 落地页（无需 Key）：长得像正经 AI 中转站，防手贱访问露馅
  if (method === "GET" && (p === "/" || p === "/index.html")) {
    if (!INDEX_HTML) {
      return sendOpenAIError(res, 404, "not_found", `Endpoint not found: GET ${p}`);
    }
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    return res.end(INDEX_HTML);
  }

  // 健康检查（无需 Key），只回一个 ok，不暴露任何信息；根路径返回 404，跟真 API 一样
  if (method === "GET" && p === "/health") {
    return sendJson(res, 200, { status: "ok" });
  }

  // 模型列表（公开信息，无需 Key）
  if (method === "GET" && p === "/v1/models") {
    return sendJson(res, 200, { object: "list", data: MODELS });
  }

  // OpenAI 兼容：chat completions / legacy completions
  if (method === "POST" && (p === "/v1/chat/completions" || p === "/v1/completions")) {
    if (!isAuthorized(req)) {
      return sendOpenAIError(
        res,
        401,
        "invalid_api_key",
        `Incorrect API key provided: ${API_KEY}. You can find your API key at https://platform.openai.com/account/api-keys.`
      );
    }
    const body = await parseJsonBody(req, res);
    if (!body) return undefined;
    if (!body.model) {
      return sendOpenAIError(res, 400, "invalid_request_error", "You must provide a model parameter.");
    }
    const legacy = p === "/v1/completions";
    if (body.stream) return streamOpenAIChat(res, body, legacy);
    return sendOpenAIChat(res, body, legacy);
  }

  // OpenAI 兼容：Responses API（Codex 默认走这个）
  if (method === "POST" && p === "/v1/responses") {
    if (!isAuthorized(req)) {
      return sendOpenAIError(
        res,
        401,
        "invalid_api_key",
        `Incorrect API key provided: ${API_KEY}. You can find your API key at https://platform.openai.com/account/api-keys.`
      );
    }
    const body = await parseJsonBody(req, res);
    if (!body) return undefined;
    if (!body.model) {
      return sendOpenAIError(res, 400, "invalid_request_error", "You must provide a model parameter.");
    }
    if (body.stream) return streamResponses(res, body);
    return sendResponses(res, body);
  }

  // Anthropic 兼容：token 计数（Claude Code 启动时会调用，返回 404 会报模型异常）
  if (method === "POST" && p === "/v1/messages/count_tokens") {
    if (!isAuthorized(req)) {
      return sendAnthropicError(res, 401, "authentication_error", "invalid x-api-key");
    }
    const body = await parseJsonBody(req, res);
    if (!body) return undefined;
    return sendJson(res, 200, { input_tokens: estimateTokens(body) });
  }

  // Anthropic 兼容：/v1/messages
  if (method === "POST" && p === "/v1/messages") {
    if (!isAuthorized(req)) {
      return sendAnthropicError(res, 401, "authentication_error", "invalid x-api-key");
    }
    const body = await parseJsonBody(req, res);
    if (!body) return undefined;
    if (!body.model) {
      return sendAnthropicError(res, 400, "invalid_request_error", "model: field required");
    }
    if (body.stream) return streamAnthropicMessage(res, body);
    return sendAnthropicMessage(res, body);
  }

  return sendOpenAIError(res, 404, "not_found", `Endpoint not found: ${method} ${p}`);
}

// 主入口：记录请求日志 + 统一兜底错误
module.exports = async function handler(req, res) {
  const method = (req.method || "GET").toUpperCase();
  const p = normalizePath(req);
  res._logMeta = { method, p };

  const ua = String(req.headers["user-agent"] || "").slice(0, 100);
  const hasAuth = !!(req.headers["authorization"] || req.headers["x-api-key"]);
  logLine(
    `${method} ${p} UA="${ua}" auth=${hasAuth ? "yes" : "no"}${req.headers["anthropic-version"] ? ` anthropic-version=${req.headers["anthropic-version"]}` : ""}`
  );

  try {
    await handle(req, res);
  } catch (err) {
    console.error(`[fake-ai-api] 处理 ${method} ${p} 出错:`, err);
    if (!res.headersSent) {
      sendOpenAIError(res, 500, "internal_error", "Internal Server Error");
    } else {
      res.end();
    }
  }
};
