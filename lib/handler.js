"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const config = require("../config");

const ASCII_RAW = fs
  .readFileSync(path.join(__dirname, "..", "ascii.txt"), "utf8")
  .replace(/\s+$/, "");

// 用 markdown 代码块包裹输出，客户端会按等宽渲染，避免比例字体把图挤变形
const ASCII_TEXT =
  config.wrapCodeBlock === false ? ASCII_RAW : "```text\n" + ASCII_RAW + "\n```";

let INDEX_HTML = "";
try {
  INDEX_HTML = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
} catch (err) {
  console.log("[fake-ai-api] 未找到 index.html，根路径将返回 404");
}

let ROBOTS_TXT = "";
try {
  ROBOTS_TXT = fs.readFileSync(path.join(__dirname, "..", "robots.txt"), "utf8");
} catch (err) {
  console.log("[fake-ai-api] 未找到 robots.txt");
}

let SITEMAP_XML = "";
try {
  SITEMAP_XML = fs.readFileSync(path.join(__dirname, "..", "sitemap.xml"), "utf8");
} catch (err) {
  console.log("[fake-ai-api] 未找到 sitemap.xml");
}

const CHUNK_SIZE = Number(config.streamChunkChars) > 0 ? Number(config.streamChunkChars) : 8;
const CHUNK_DELAY = Number(config.streamDelayMs) >= 0 ? Number(config.streamDelayMs) : 20;

/* ============================== API Key ============================== */

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

/* ============================== 模型列表 ============================== */

const MODELS = (Array.isArray(config.models) ? config.models : []).map((m, i) => {
  const item = typeof m === "string" ? { id: m } : m || {};
  const id = item.id;
  const defaultOwner = String(id).startsWith("claude") ? "anthropic" : "openai";
  return {
    id,
    object: "model",
    created: item.created ?? (config.modelsCreated ?? 1700000000) + i * 604800,
    owned_by: item.owned_by ?? defaultOwner,
  };
});

/* ============================== 小工具 ============================== */

function logLine(msg) {
  if (config.debug !== false) {
    console.log(`[fake-ai-api] ${new Date().toISOString()} ${msg}`);
  }
}

function randId(prefix, len = 24) {
  return prefix + crypto.randomBytes(Math.ceil(len / 2)).toString("hex").slice(0, len);
}

// 近似 token 数：中文按 1 token/字，其余按 4 字符/token
function estimateTokens(s) {
  const text = typeof s === "string" ? s : JSON.stringify(s);
  let cjk = 0;
  let ascii = 0;
  for (const ch of text) {
    if (/[\u2e80-\u9fff\u3000-\u303f\uff00-\uffef]/.test(ch)) cjk += 1;
    else ascii += 1;
  }
  return Math.max(1, cjk + Math.ceil(ascii / 4));
}

function chunkText(text, size) {
  const chunks = [];
  for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size));
  return chunks;
}

// 测试用：问候词触发时返回英文问候，不再吐 ascii（英文忽略大小写）
const GREETING_TEXT = "Hello! How can I help you today?";
const GREETING_WORDS = ["hello", "你好", "测试"];

// 把请求里用户侧文本拼出来（兼容 chat/completions/responses/messages 的格式差异）
// 跳过 <system-reminder> 注入块（claude code 的插件上下文，不是用户输入）
function extractUserText(body) {
  let text = "";
  if (typeof body.prompt === "string") text += body.prompt + "\n";
  if (Array.isArray(body.messages)) {
    for (const m of body.messages) {
      if (!m) continue;
      if (typeof m.content === "string") {
        if (!m.content.startsWith("<system-reminder>")) text += m.content + "\n";
      } else if (Array.isArray(m.content)) {
        for (const part of m.content) {
          if (typeof part === "string") {
            if (!part.startsWith("<system-reminder>")) text += part + "\n";
          } else if (part && typeof part.text === "string") {
            if (!part.text.startsWith("<system-reminder>")) text += part.text + "\n";
          }
        }
      }
    }
  }
  if (body.input !== undefined) {
    if (typeof body.input === "string") text += body.input + "\n";
    else if (Array.isArray(body.input)) {
      for (const item of body.input) {
        if (typeof item === "string") text += item + "\n";
        else if (item && typeof item.content === "string") text += item.content + "\n";
        else if (item && Array.isArray(item.content)) {
          for (const part of item.content) {
            if (typeof part === "string") text += part + "\n";
            else if (part && typeof part.text === "string") text += part.text + "\n";
          }
        }
      }
    }
  }
  return text;
}

function detectGreeting(body) {
  const text = extractUserText(body).toLowerCase();
  if (text.includes("hello") || text.includes("你好") || text.includes("测试")) {
    return GREETING_TEXT;
  }
  // hi 用单词边界匹配，避免 history/this 这类词误触发
  if (/\bhi\b/.test(text)) return GREETING_TEXT;
  return null;
}

// 工具调用测试：提示里明确要求“use ... tool”时返回 tool_calls，不再吐 ascii
// 若对话里已有工具结果/已调用过工具，不再触发，避免客户端死循环
function hasToolResult(body) {
  const scanMsgs = (list) => {
    for (const m of list) {
      if (!m) continue;
      if (m.role === "tool") return true;
      if (Array.isArray(m.tool_calls) && m.tool_calls.length) return true;
      if (Array.isArray(m.content)) {
        for (const part of m.content) {
          if (part && part.type === "tool_result") return true;
        }
      }
    }
    return false;
  };
  if (Array.isArray(body.messages) && scanMsgs(body.messages)) return true;
  if (Array.isArray(body.input)) {
    for (const item of body.input) {
      if (item && item.type === "function_call_output") return true;
      if (item && Array.isArray(item.content)) {
        for (const part of item.content) {
          if (part && part.type === "tool_result") return true;
        }
      }
    }
  }
  return false;
}

// 仅当“最后一条消息是纯工具结果”时才承接工具结果，
// 避免历史里残留的旧工具结果把新的用户提问顶掉
function pendingToolResult(body) {
  const list = Array.isArray(body.messages) ? body.messages : [];
  const last = list.length ? list[list.length - 1] : null;
  if (!last) return false;
  if (last.role === "tool") return true;
  if (Array.isArray(last.content)) {
    let hasResult = false;
    let hasText = false;
    for (const part of last.content) {
      if (part && part.type === "tool_result") hasResult = true;
      else if (typeof part === "string" || (part && part.type === "text" && typeof part.text === "string" && part.text.trim())) hasText = true;
    }
    return hasResult && !hasText;
  }
  return false;
}

// 提取最近一次工具结果文本（OpenAI tool 角色 / Anthropic tool_result 块）
function toolResultText(body) {
  if (Array.isArray(body.messages)) {
    for (let i = body.messages.length - 1; i >= 0; i -= 1) {
      const m = body.messages[i];
      if (!m) continue;
      if (m.role === "tool") {
        return typeof m.content === "string" ? m.content : JSON.stringify(m.content);
      }
      if (Array.isArray(m.content)) {
        for (const part of m.content) {
          if (part && part.type === "tool_result") {
            if (typeof part.content === "string") return part.content;
            if (Array.isArray(part.content)) {
              return part.content.map((c) => (typeof c === "string" ? c : c && c.text ? c.text : "")).join("");
            }
          }
        }
      }
    }
  }
  return null;
}

function detectToolCall(body) {
  if (hasToolResult(body)) return null;
  const lower = extractUserText(body).toLowerCase();
  if (!/use[\s\S]{0,30}tool/.test(lower)) return null;
  let name = "get_current_time";
  if (Array.isArray(body.tools)) {
    for (const t of body.tools) {
      const fname = t && t.function && t.function.name;
      if (fname && lower.includes(fname.toLowerCase())) {
        name = fname;
        break;
      }
    }
  }
  return { name, arguments: "{}" };
}

// 依请求计算实际要返回的文本：问候触发、stop 序列截断、max_tokens 截断
// 返回 { text, reason }，reason 为 stop / stop_sequence / length
function computeOutput(body, maxField = "max_tokens", stopField = "stop") {
  const stops = body[stopField];
  const stopList = Array.isArray(stops) ? stops : stops ? [stops] : [];
  // 工具结果回传后：先承接工具结果（防死循环，也避免回 ascii 穿帮），再问候，最后才是 ascii
  // 工具结果里带 tool_use_error（claude 的执行错误）时不做承接，直接落回问候/ascii
  const rawResult = pendingToolResult(body) ? toolResultText(body) : null;
  const toolResult = rawResult && !rawResult.includes("tool_use_error") ? rawResult : null;
  let text =
    toolResult !== null
      ? toolResult
        ? `Got it. The tool returned: ${toolResult}`
        : "Got it."
      : detectGreeting(body) || ASCII_TEXT;
  let reason = "stop";

  let earliest = -1;
  for (const s of stopList) {
    const i = text.indexOf(s);
    if (i >= 0 && (earliest === -1 || i < earliest)) earliest = i;
  }
  if (earliest >= 0) {
    text = text.slice(0, earliest);
    reason = "stop_sequence";
  }

  const tokens = Number(body[maxField]);
  if (tokens > 0) {
    const chars = Math.floor(tokens * 4);
    if (text.length > chars) {
      text = text.slice(0, chars);
      reason = "length";
    }
  }
  return { text, reason };
}

function buildUsage(promptTokens, completionTokens) {
  return {
    prompt_tokens: promptTokens,
    prompt_tokens_details: { cached_tokens: 0, audio_tokens: 0 },
    completion_tokens: completionTokens,
    completion_tokens_details: { reasoning_tokens: 0, audio_tokens: 0 },
    total_tokens: promptTokens + completionTokens,
  };
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

function submittedKey(req) {
  const raw = req.headers["authorization"] || req.headers["x-api-key"] || "";
  return String(raw).replace(/^Bearer\s+/i, "").trim();
}

function isAuthorized(req) {
  if (config.requireAuth === false) return true;
  const token = submittedKey(req);
  return token.length > 0 && token === API_KEY;
}

// 401 回显请求里提交的 Key（对齐 OpenAI 行为，不泄露服务端写死的 Key）
function authFailure(res, req) {
  return sendOpenAIError(
    res,
    401,
    "invalid_api_key",
    `Incorrect API key provided: ${submittedKey(req) || "(none)"}. You can find your API key at https://platform.openai.com/account/api-keys.`
  );
}

const VALID_ROLES = new Set(["system", "user", "assistant", "tool", "developer", "function"]);

// 校验 OpenAI 侧请求参数，非法则直接回 400，返回 false
function validateOpenAIBody(res, body) {
  if (!body.model) {
    return sendOpenAIError(res, 400, "invalid_request_error", "You must provide a model parameter.");
  }
  if (Array.isArray(body.messages)) {
    for (let i = 0; i < body.messages.length; i += 1) {
      const m = body.messages[i];
      if (m && typeof m.role === "string" && !VALID_ROLES.has(m.role)) {
        return sendOpenAIError(
          res,
          400,
          "invalid_request_error",
          `messages.${i}.role: '${m.role}' is not a valid role.`
        );
      }
    }
  }
  if (body.temperature !== undefined && body.temperature !== null) {
    const t = Number(body.temperature);
    if (Number.isNaN(t) || t < 0 || t > 2) {
      return sendOpenAIError(res, 400, "invalid_request_error", "temperature: must be between 0 and 2.");
    }
  }
  if (body.top_p !== undefined && body.top_p !== null) {
    const tp = Number(body.top_p);
    if (Number.isNaN(tp) || tp < 0 || tp > 1) {
      return sendOpenAIError(res, 400, "invalid_request_error", "top_p: must be between 0 and 1.");
    }
  }
  if (body.n !== undefined && body.n !== null) {
    const n = Number(body.n);
    if (!Number.isInteger(n) || n < 1 || n > 128) {
      return sendOpenAIError(res, 400, "invalid_request_error", "n: must be an integer between 1 and 128.");
    }
  }
  return true;
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

/* ============================== OpenAI 兼容：chat / legacy completions ============================== */

function sendOpenAIChat(res, body, legacy) {
  const toolCall = legacy ? null : detectToolCall(body);
  if (toolCall) {
    const id = randId("chatcmpl-");
    const created = Math.floor(Date.now() / 1000);
    const n = Math.max(1, Math.min(Number(body.n) || 1, 128));
    const usage = buildUsage(estimateTokens(JSON.stringify(body.messages || [])), 1);
    const choices = [];
    for (let i = 0; i < n; i += 1) {
      choices.push({
        index: i,
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: randId("call_"), type: "function", function: { name: toolCall.name, arguments: toolCall.arguments } },
          ],
        },
        finish_reason: "tool_calls",
      });
    }
    return sendJson(res, 200, {
      id,
      object: "chat.completion",
      created,
      model: body.model,
      choices,
      usage,
      system_fingerprint: "fp_" + crypto.randomBytes(4).toString("hex"),
      service_tier: "default",
    });
  }

  const { text, reason } = computeOutput(body, "max_tokens");
  const model = body.model;
  const created = Math.floor(Date.now() / 1000);
  const n = Math.max(1, Math.min(Number(body.n) || 1, 128));
  const promptText = legacy
    ? (typeof body.prompt === "string" ? body.prompt : "")
    : JSON.stringify(body.messages || []);
  const usage = buildUsage(estimateTokens(promptText), estimateTokens(text));
  const finishReason = reason === "stop_sequence" ? "stop" : reason;

  if (legacy) {
    const choices = [];
    for (let i = 0; i < n; i += 1) {
      choices.push({ index: i, text, logprobs: null, finish_reason: finishReason });
    }
    return sendJson(res, 200, {
      id: randId("cmpl-"),
      object: "text_completion",
      created,
      model,
      choices,
      usage,
    });
  }

  let content = text;
  if (body.response_format && body.response_format.type === "json_object") {
    content = JSON.stringify({ output: text.replace(/^```text\n|\n```$/g, "") });
  }
  const choices = [];
  for (let i = 0; i < n; i += 1) {
    choices.push({
      index: i,
      message: { role: "assistant", content, refusal: null },
      finish_reason: finishReason,
    });
  }
  return sendJson(res, 200, {
    id: randId("chatcmpl-"),
    object: "chat.completion",
    created,
    model,
    choices,
    usage,
    system_fingerprint: "fp_" + crypto.randomBytes(4).toString("hex"),
    service_tier: "default",
  });
}

function streamOpenAIChat(res, body, legacy) {
  const toolCall = legacy ? null : detectToolCall(body);
  if (toolCall) {
    const id = randId("chatcmpl-");
    const created = Math.floor(Date.now() / 1000);
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    const callId = randId("call_");
    const steps = [
      {
        delta: {
          role: "assistant",
          content: null,
          tool_calls: [{ index: 0, id: callId, type: "function", function: { name: "", arguments: "" } }],
        },
        finish_reason: null,
      },
      { delta: { tool_calls: [{ index: 0, function: { name: toolCall.name, arguments: "" } }] }, finish_reason: null },
      { delta: { tool_calls: [{ index: 0, function: { arguments: toolCall.arguments } }] }, finish_reason: null },
      { delta: {}, finish_reason: "tool_calls" },
    ];
    let step = 0;
    const timer = setInterval(() => {
      if (step < steps.length) {
        const s = steps[step];
        res.write(
          `data: ${JSON.stringify({
            id,
            object: "chat.completion.chunk",
            created,
            model: body.model,
            choices: [{ index: 0, delta: s.delta, finish_reason: s.finish_reason }],
          })}\n\n`
        );
        step += 1;
      } else {
        clearInterval(timer);
        res.write("data: [DONE]\n\n");
        res.end();
      }
    }, CHUNK_DELAY);
    if (res._logMeta) {
      logLine(`${res._logMeta.method} ${res._logMeta.p} -> 200 流式输出工具调用`);
    }
    return;
  }

  const id = randId(legacy ? "cmpl-" : "chatcmpl-");
  const model = body.model;
  const created = Math.floor(Date.now() / 1000);
  const object = legacy ? "text_completion" : "chat.completion.chunk";
  const { text, reason } = computeOutput(body, "max_tokens");
  const n = Math.max(1, Math.min(Number(body.n) || 1, 128));
  const finishReason = reason === "stop_sequence" ? "stop" : reason;
  const promptText = legacy
    ? (typeof body.prompt === "string" ? body.prompt : "")
    : JSON.stringify(body.messages || []);
  const usage = buildUsage(estimateTokens(promptText), estimateTokens(text));

  res.statusCode = 200;
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const chunks = chunkText(text, CHUNK_SIZE);
  if (res._logMeta) {
    logLine(`${res._logMeta.method} ${res._logMeta.p} -> 200 开始流式输出，共 ${chunks.length} 个分片`);
  }
  let index = 0;

  const choicesFor = (delta, fr) =>
    Array.from({ length: n }, (_, i) => ({ index: i, delta: i === 0 ? delta : {}, finish_reason: fr }));

  const writeChunk = (delta, fr) => {
    res.write(`data: ${JSON.stringify({ id, object, created, model, choices: choicesFor(delta, fr) })}\n\n`);
  };

  writeChunk(legacy ? { text: chunks[0] || "" } : { role: "assistant", content: chunks[0] || "" }, null);
  index = 1;

  const timer = setInterval(() => {
    if (index < chunks.length) {
      writeChunk(legacy ? { text: chunks[index] } : { content: chunks[index] }, null);
      index += 1;
    } else {
      clearInterval(timer);
      writeChunk({}, finishReason);
      if (!legacy && body.stream_options && body.stream_options.include_usage) {
        res.write(`data: ${JSON.stringify({ id, object, created, model, choices: [], usage })}\n\n`);
      }
      res.write("data: [DONE]\n\n");
      res.end();
    }
  }, CHUNK_DELAY);
}

/* ============================== OpenAI 兼容：Responses API（Codex 用） ============================== */

function buildResponsesPayload(id, body, status, output, text, usage) {
  const created = Math.floor(Date.now() / 1000);
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
    usage,
    user: null,
    metadata: {},
  };
}

function sendResponses(res, body) {
  const { text } = computeOutput(body, "max_output_tokens");
  const id = randId("resp_");
  const usage = buildUsage(estimateTokens(body), estimateTokens(text));
  const outputItem = {
    id: randId("msg_"),
    type: "message",
    status: "completed",
    role: "assistant",
    content: [{ type: "output_text", text, annotations: [] }],
  };
  return sendJson(res, 200, buildResponsesPayload(id, body, "completed", [outputItem], text, usage));
}

function streamResponses(res, body) {
  const { text } = computeOutput(body, "max_output_tokens");
  const id = randId("resp_");
  const msgId = randId("msg_");
  const usage = buildUsage(estimateTokens(body), estimateTokens(text));

  res.statusCode = 200;
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const evt = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  const payload = (status, output) => buildResponsesPayload(id, body, status, output, text, usage);

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

  const chunks = chunkText(text, CHUNK_SIZE);
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
        content: [{ type: "output_text", text, annotations: [] }],
      };
      evt({
        type: "response.output_text.done",
        item_id: msgId,
        output_index: 0,
        content_index: 0,
        text,
        annotations: [],
      });
      evt({
        type: "response.content_part.done",
        item_id: msgId,
        output_index: 0,
        content_index: 0,
        part: { type: "output_text", text, annotations: [] },
      });
      evt({ type: "response.output_item.done", output_index: 0, item });
      evt({ type: "response.completed", response: payload("completed", [item]) });
      res.write("data: [DONE]\n\n");
      res.end();
    }
  }, CHUNK_DELAY);
}

/* ============================== OpenAI 兼容：其他端点 ============================== */

// 伪 embedding 向量：同一输入恒定输出，不同输入不同
function fakeVector(dim, seedText) {
  let seed = 0;
  for (const ch of String(seedText)) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
  const vec = [];
  for (let i = 0; i < dim; i += 1) {
    seed = (seed * 1103515245 + 12345) >>> 0;
    vec.push((seed / 4294967296) * 2 - 1);
  }
  return vec;
}

function sendEmbeddings(res, body) {
  const raw = body.input;
  const texts = Array.isArray(raw) ? raw.map((x) => (typeof x === "string" ? x : "")) : [typeof raw === "string" ? raw : ""];
  const dim = body.dimensions ? Math.max(1, Math.min(Number(body.dimensions) || 1536, 3072)) : 1536;
  const data = texts.map((t, i) => ({ object: "embedding", index: i, embedding: fakeVector(dim, t) }));
  return sendJson(res, 200, {
    object: "list",
    data,
    model: body.model,
    usage: buildUsage(estimateTokens(texts.join("")), data.length),
  });
}

function sendModerations(res, body) {
  const categories = [
    "harassment",
    "harassment/threatening",
    "hate",
    "hate/threatening",
    "self_harm",
    "self_harm/intent",
    "self_harm/instructions",
    "sexual",
    "sexual/minors",
    "violence",
    "violence/graphic",
  ];
  const categoriesObj = {};
  const scoresObj = {};
  const appliedObj = {};
  for (const c of categories) {
    categoriesObj[c] = false;
    scoresObj[c] = 0.0001;
    appliedObj[c] = ["text"];
  }
  return sendJson(res, 200, {
    id: randId("modr-"),
    model: "omni-moderation-latest",
    results: [
      {
        flagged: false,
        categories: categoriesObj,
        category_scores: scoresObj,
        category_applied_input_types: appliedObj,
      },
    ],
  });
}

function sendEntity(res, prefix, objectName, extra = {}) {
  return sendJson(res, 200, {
    id: randId(prefix),
    object: objectName,
    created_at: Math.floor(Date.now() / 1000),
    ...extra,
  });
}

/* ============================== Anthropic 兼容 ============================== */

function sendAnthropicMessage(res, body) {
  const toolCall = detectToolCall(body);
  if (toolCall) {
    return sendJson(res, 200, {
      id: randId("msg_"),
      type: "message",
      role: "assistant",
      model: body.model,
      content: [{ type: "tool_use", id: randId("toolu_"), name: toolCall.name, input: {} }],
      stop_reason: "tool_use",
      stop_sequence: null,
      usage: { input_tokens: estimateTokens(body), output_tokens: 1 },
    });
  }

  const { text, reason } = computeOutput(body, "max_tokens", "stop_sequences");
  const stopReason = reason === "stop_sequence" ? "stop_sequence" : reason === "length" ? "max_tokens" : "end_turn";
  const id = randId("msg_");
  return sendJson(res, 200, {
    id,
    type: "message",
    role: "assistant",
    model: body.model,
    content: [{ type: "text", text }],
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: estimateTokens(body),
      output_tokens: estimateTokens(text),
    },
  });
}

function streamAnthropicMessage(res, body) {
  const { text, reason } = computeOutput(body, "max_tokens", "stop_sequences");
  const stopReason = reason === "stop_sequence" ? "stop_sequence" : reason === "length" ? "max_tokens" : "end_turn";
  const id = randId("msg_");
  const inputTokens = estimateTokens(body);
  const outputTokens = estimateTokens(text);

  res.statusCode = 200;
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const evt = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  const toolCall = detectToolCall(body);
  if (toolCall) {
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
      content_block: { type: "tool_use", id: randId("toolu_"), name: toolCall.name, input: {} },
    });
    evt("content_block_stop", { type: "content_block_stop", index: 0 });
    evt("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "tool_use", stop_sequence: null },
      usage: { output_tokens: 1 },
    });
    evt("message_stop", { type: "message_stop" });
    res.end();
    return;
  }

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

  const chunks = chunkText(text, CHUNK_SIZE);
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
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: { output_tokens: outputTokens },
      });
      evt("message_stop", { type: "message_stop" });
      res.end();
    }
  }, CHUNK_DELAY);
}

/* ============================== 主路由 ============================== */

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

  // sitemap.xml（无需 Key）
  if (method === "GET" && p === "/sitemap.xml") {
    if (!SITEMAP_XML) {
      return sendOpenAIError(res, 404, "not_found", `Endpoint not found: GET ${p}`);
    }
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/xml; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    return res.end(SITEMAP_XML);
  }

  // robots.txt（无需 Key）
  if (method === "GET" && p === "/robots.txt") {
    if (!ROBOTS_TXT) {
      return sendOpenAIError(res, 404, "not_found", `Endpoint not found: GET ${p}`);
    }
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    return res.end(ROBOTS_TXT);
  }

  // 健康检查（无需 Key），只回一个 ok，不暴露任何信息
  if (method === "GET" && p === "/health") {
    return sendJson(res, 200, { status: "ok" });
  }

  // 模型列表（公开信息，无需 Key）
  if (method === "GET" && p === "/v1/models") {
    return sendJson(res, 200, { object: "list", data: MODELS });
  }

  // 单模型详情
  if (method === "GET" && p.startsWith("/v1/models/")) {
    const mid = decodeURIComponent(p.slice("/v1/models/".length));
    const found = MODELS.find((m) => m.id === mid);
    if (!found) {
      return sendOpenAIError(res, 404, "model_not_found", `The model '${mid}' does not exist.`);
    }
    return sendJson(res, 200, found);
  }

  // OpenAI 兼容：chat completions / legacy completions
  if (method === "POST" && (p === "/v1/chat/completions" || p === "/v1/completions")) {
    if (!isAuthorized(req)) return authFailure(res, req);
    const body = await parseJsonBody(req, res);
    if (!body) return undefined;
    if (validateOpenAIBody(res, body) !== true) return undefined;
    const legacy = p === "/v1/completions";
    if (body.stream) return streamOpenAIChat(res, body, legacy);
    return sendOpenAIChat(res, body, legacy);
  }

  // OpenAI 兼容：Responses API（Codex 默认走这个；部分版本不带 /v1 前缀）
  if (method === "POST" && (p === "/v1/responses" || p === "/responses")) {
    if (!isAuthorized(req)) return authFailure(res, req);
    const body = await parseJsonBody(req, res);
    if (!body) return undefined;
    if (!body.model) {
      return sendOpenAIError(res, 400, "invalid_request_error", "You must provide a model parameter.");
    }
    if (body.stream) return streamResponses(res, body);
    return sendResponses(res, body);
  }

  // OpenAI 兼容：embeddings
  if (method === "POST" && p === "/v1/embeddings") {
    if (!isAuthorized(req)) return authFailure(res, req);
    const body = await parseJsonBody(req, res);
    if (!body) return undefined;
    if (!body.model) {
      return sendOpenAIError(res, 400, "invalid_request_error", "You must provide a model parameter.");
    }
    return sendEmbeddings(res, body);
  }

  // OpenAI 兼容：moderations
  if (method === "POST" && p === "/v1/moderations") {
    if (!isAuthorized(req)) return authFailure(res, req);
    const body = await parseJsonBody(req, res);
    if (!body) return undefined;
    if (!body.input) {
      return sendOpenAIError(res, 400, "invalid_request_error", "You must provide an input parameter.");
    }
    return sendModerations(res, body);
  }

  // OpenAI 兼容：audio（请求体是 multipart，不做 JSON 解析，直接回 ascii 文本）
  if (method === "POST" && (p === "/v1/audio/transcriptions" || p === "/v1/audio/translations")) {
    if (!isAuthorized(req)) return authFailure(res, req);
    return sendJson(res, 200, { text: ASCII_RAW });
  }

  // OpenAI 兼容：files（multipart 上传，同样不解析 JSON）
  if (method === "POST" && p === "/v1/files") {
    if (!isAuthorized(req)) return authFailure(res, req);
    return sendEntity(res, "file-", "file", {
      bytes: 0,
      filename: "upload.txt",
      purpose: "assistants",
      status: "processed",
    });
  }
  if (method === "GET" && p === "/v1/files") {
    if (!isAuthorized(req)) return authFailure(res, req);
    return sendJson(res, 200, { object: "list", data: [] });
  }

  // OpenAI 兼容：assistants / threads 轻量占位
  if (method === "POST" && p === "/v1/assistants") {
    if (!isAuthorized(req)) return authFailure(res, req);
    const body = await parseJsonBody(req, res);
    if (!body) return undefined;
    return sendEntity(res, "asst_", "assistant", {
      name: body.name ?? null,
      description: body.description ?? null,
      model: body.model ?? MODELS[0]?.id ?? null,
      instructions: body.instructions ?? null,
      tools: body.tools ?? [],
      tool_resources: {},
      metadata: {},
      temperature: 1,
      top_p: 1,
      response_format: "auto",
    });
  }
  if (method === "POST" && p === "/v1/threads") {
    if (!isAuthorized(req)) return authFailure(res, req);
    await parseJsonBody(req, res);
    return sendEntity(res, "thread_", "thread", { metadata: {}, tool_resources: {} });
  }
  if (method === "POST" && /^\/v1\/threads\/[^/]+\/messages$/.test(p)) {
    if (!isAuthorized(req)) return authFailure(res, req);
    const body = await parseJsonBody(req, res);
    if (!body) return undefined;
    const tid = p.split("/")[3];
    return sendEntity(res, "msg_", "thread.message", {
      thread_id: tid,
      role: body.role ?? "user",
      content: body.content ?? [],
      assistant_id: null,
      run_id: null,
      metadata: {},
    });
  }
  if (method === "POST" && /^\/v1\/threads\/[^/]+\/runs$/.test(p)) {
    if (!isAuthorized(req)) return authFailure(res, req);
    const body = await parseJsonBody(req, res);
    if (!body) return undefined;
    const tid = p.split("/")[3];
    return sendEntity(res, "run_", "thread.run", {
      thread_id: tid,
      assistant_id: body.assistant_id ?? null,
      model: body.model ?? MODELS[0]?.id ?? null,
      status: "completed",
      required_action: null,
      last_error: null,
      instructions: body.instructions ?? null,
      tools: body.tools ?? [],
      metadata: {},
      usage: buildUsage(0, 0),
    });
  }

  // OpenAI 兼容：账单（对齐首页"余额实时可见"文案）
  if (method === "GET" && p === "/dashboard/billing/usage") {
    if (!isAuthorized(req)) return authFailure(res, req);
    const now = Math.floor(Date.now() / 1000);
    return sendJson(res, 200, {
      object: "list",
      total_usage: 45231,
      has_more: false,
      data: [
        {
          object: "usage",
          start_time: now - 30 * 86400,
          end_time: now,
          total_usage: 45231,
          source: "internal",
        },
      ],
    });
  }
  if (method === "GET" && p === "/dashboard/billing/subscription") {
    if (!isAuthorized(req)) return authFailure(res, req);
    const now = Math.floor(Date.now() / 1000);
    return sendJson(res, 200, {
      object: "billing_subscription",
      id: randId("sub_"),
      plan: { id: "pro", title: "Pro" },
      current_period_start: now - 7 * 86400,
      current_period_end: now + 23 * 86400,
      status: "active",
      hard_limit_usd: 10.0,
      soft_limit_usd: 10.0,
      system_hard_limit_usd: 20.0,
      access_until: now + 60 * 86400,
      cancel_at_period_end: false,
    });
  }

  // 用户余额（部分客户端会查，需 Key）
  if ((method === "GET" || method === "POST") && p === "/user/balance") {
    if (!isAuthorized(req)) return authFailure(res, req);
    return sendJson(res, 200, {
      object: "user_balance",
      balance: 3020.77,
      currency: "USD",
      used: 4.23,
      limit: null,
    });
  }

  // rikkaHub 等客户端查余额的接口
  if ((method === "GET" || method === "POST") && p === "/v1/credits") {
    if (!isAuthorized(req)) return authFailure(res, req);
    return sendJson(res, 200, {
      code: 200,
      message: "success",
      data: {
        total_credits: 3025.0,
        used_credits: 4.23,
        remaining_credits: 3020.77,
        balance: 3020.77,
        currency: "USD",
      },
    });
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
    if (body.max_tokens === undefined || body.max_tokens === null || Number(body.max_tokens) < 1) {
      return sendAnthropicError(res, 400, "invalid_request_error", "max_tokens: field required");
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
