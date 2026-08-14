"use strict";

// 这个文件匹配 /api 下任意路径（如 /api/v1/chat/completions），
// 与 api/index.js 共用同一个处理器。
module.exports = require("../lib/handler");
