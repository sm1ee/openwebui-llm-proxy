#!/usr/bin/env node
/**
 * Codex OpenAI-compatible HTTP Proxy
 *
 * codex app-server (stdio/OAuth) → /v1/chat/completions (HTTP)
 * OpenWebUI에서 OpenAI API endpoint로 연결 가능.
 *
 * Port: 8200
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, 'config.json');

// ── Config ──
const DEFAULT_CONFIG = {
  codex: {
    reasoning: true,
    toolDisplay: true,
    summary: 'detailed',
  },
};

function deepMerge(base, patch) {
  const output = { ...base };
  for (const [key, value] of Object.entries(patch || {})) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      output[key] = deepMerge(base[key] || {}, value);
    } else {
      output[key] = value;
    }
  }
  return output;
}

function loadConfig() {
  try {
    return deepMerge(DEFAULT_CONFIG, JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')));
  } catch {
    return structuredClone(DEFAULT_CONFIG);
  }
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n');
}

function getCodexConfig() {
  return loadConfig().codex || {};
}

const PORT = parseInt(process.env.CODEX_PROXY_PORT || '8200');
const CODEX_BIN = process.env.CODEX_BIN || 'codex';
const CODEX_MODEL = process.env.CODEX_MODEL || 'gpt-5.4';
const CODEX_CWD = process.env.CODEX_CWD || new URL('.', import.meta.url).pathname.replace(/\/llm-proxy\/$/, '/codex-sandbox');

// ── Codex App Server Client ──
class CodexClient {
  constructor() {
    this.nextId = 1;
    this.pending = new Map();
    this.notifications = [];
    this.proc = null;
    this.rl = null;
    this.ready = false;
    this.modelList = [];
    this.restartPromise = null;
  }

  async start() {
    if (this.ready && this.proc && this.proc.exitCode === null) return;

    this.proc = spawn(CODEX_BIN, ['app-server'], {
      stdio: ['pipe', 'pipe', 'inherit'],
      cwd: CODEX_CWD,
      env: process.env,
    });

    this.proc.on('exit', (code, signal) => {
      console.error(`[codex] exited: ${signal || code}`);
      this.ready = false;
      this.proc = null;
      this.rl = null;
      for (const { reject } of this.pending.values()) {
        reject(new Error('codex exited'));
      }
      this.pending.clear();
    });

    this.rl = createInterface({ input: this.proc.stdout });
    this.rl.on('line', (line) => this._handleLine(line));

    await this.request('initialize', {
      clientInfo: {
        name: 'codex_openai_proxy',
        title: 'Codex OpenAI Proxy',
        version: '1.0.0',
      },
    });
    this.notify('initialized', {});
    this.ready = true;

    // 모델 목록 캐싱
    const models = await this.request('model/list', { limit: 100, includeHidden: false });
    this.modelList = models.data || [];
    console.log(`[codex] ready. ${this.modelList.length} models available.`);
  }

  async ensureReady() {
    if (this.ready && this.proc && this.proc.exitCode === null) return;
    await this.restart();
  }

  async restart() {
    if (this.restartPromise) return this.restartPromise;

    this.restartPromise = (async () => {
      console.log('[codex] restarting app-server');
      this.ready = false;

      if (this.rl) {
        try { this.rl.close(); } catch {}
        this.rl = null;
      }

      if (this.proc && this.proc.exitCode === null && !this.proc.killed) {
        try { this.proc.kill('SIGTERM'); } catch {}
      }
      this.proc = null;
      await this.start();
    })().finally(() => {
      this.restartPromise = null;
    });

    return this.restartPromise;
  }

  request(method, params = {}) {
    if (!this.proc || !this.proc.stdin || this.proc.stdin.destroyed) {
      return Promise.reject(new Error('codex is not ready'));
    }
    const id = this.nextId++;
    const msg = { method, id, params };
    this.proc.stdin.write(`${JSON.stringify(msg)}\n`);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout: ${method}`));
      }, 600_000);
      this.pending.set(id, { resolve, reject, timer });
    });
  }

  notify(method, params = {}) {
    this.proc.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  _handleLine(line) {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { return; }

    if (typeof msg.id !== 'undefined') {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) {
        p.reject(new Error(`${msg.error.code}: ${msg.error.message}`));
      } else {
        p.resolve(msg.result);
      }
      return;
    }
    // notification - log significant events only (skip high-frequency deltas)
    if (msg.method && !msg.method.startsWith('$/')) {
      const skip = msg.method === 'item/agentMessage/delta'
        || msg.method === 'item/reasoning/summaryTextDelta'
        || msg.method === 'codex/event/reasoning_content_delta'
        || msg.method === 'codex/event/agent_reasoning_delta';
      if (!skip) {
        let extra = msg.params?.item?.type ? ' item.type=' + msg.params.item.type : '';
        if (msg.method === 'error' || msg.method === 'codex/event/error') {
          extra += ` ERR=${JSON.stringify(msg.params).slice(0, 300)}`;
        }
        console.log(`[codex notification] ${msg.method}${extra}`);
      }
    }
    this.notifications.push(msg);
  }

  drainNotifications() {
    const n = this.notifications;
    this.notifications = [];
    return n;
  }
}

function extractMessageText(content, includeImagePlaceholders = false) {
  if (typeof content === 'string') return content;

  const parts = [];
  for (const item of (content || [])) {
    if (item.type === 'text') {
      parts.push(item.text || '');
    } else if (item.type === 'image_url' && includeImagePlaceholders) {
      parts.push('[User attached an image]');
    }
  }
  return parts.join('\n').trim();
}

function extractSystemPrompt(messages) {
  return messages
    .filter((m) => m.role === 'system')
    .map((m) => extractMessageText(m.content, false))
    .filter(Boolean)
    .join('\n\n');
}

function buildCodexInput(messages) {
  let lastUserIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'user') {
      lastUserIndex = i;
      break;
    }
  }

  if (lastUserIndex === -1) return null;

  const history = [];
  for (let i = 0; i < lastUserIndex; i++) {
    const message = messages[i];
    if (!message || message.role === 'system') continue;
    const text = extractMessageText(message.content, true);
    if (!text) continue;
    const label = message.role === 'assistant' ? 'Assistant' : 'User';
    history.push(`[${label}]\n${text}`);
  }

  const lastUser = messages[lastUserIndex];
  const inputParts = [];

  if (history.length > 0) {
    inputParts.push({
      type: 'text',
      text: `Conversation so far:\n\n${history.join('\n\n')}\n\nRespond to the latest user message below.`,
    });
  }

  if (typeof lastUser.content === 'string') {
    inputParts.push({ type: 'text', text: lastUser.content });
  } else {
    for (const item of (lastUser.content || [])) {
      if (item.type === 'text') {
        inputParts.push({ type: 'text', text: item.text || '' });
      } else if (item.type === 'image_url') {
        const url = item.image_url?.url || (typeof item.image_url === 'string' ? item.image_url : '');
        if (url) inputParts.push({ type: 'image', url });
      }
    }
  }

  if (inputParts.length === 0) {
    inputParts.push({ type: 'text', text: '' });
  }

  return {
    inputParts,
    systemPrompt: extractSystemPrompt(messages),
  };
}

function decodeQuotedString(text) {
  const value = text.trim();
  if (
    (value.startsWith('"') && value.endsWith('"'))
    || (value.startsWith('\'') && value.endsWith('\''))
  ) {
    return value
      .slice(1, -1)
      .replace(/\\\\/g, '\\')
      .replace(/\\n/g, '\n')
      .replace(/\\t/g, '\t')
      .replace(/\\"/g, '"')
      .replace(/\\'/g, '\'');
  }
  return null;
}

function extractToolBodyText(body) {
  const lines = body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) return '';

  const extracted = [];
  for (const line of lines) {
    const match = line.match(/^(?:print|console\.log)\(\s*(['"].*['"])\s*\)\s*;?$/);
    if (!match) return '';
    const decoded = decodeQuotedString(match[1]);
    if (decoded === null) return '';
    extracted.push(decoded);
  }

  return extracted.join('\n');
}

// ── Codex XML tag stripping (streaming state machine) ──
// Codex wraps tool calls in XML: <code_interpreter type="code" lang="python">print("text")</code_interpreter>
// We collect the tool body, then extract the meaningful text from print() calls.
class TagFilter {
  constructor() {
    this.inTag = false;
    this.inToolBody = false;
    this.inClosingTag = false;
    this.toolBodyParts = [];   // accumulate tool body tokens
  }

  filter(delta) {
    const t = delta.trim();

    // Detect opening tag start
    if (/^<(?:code|file|exec|shell|apply_diff|read_file|write_file|run_command)/i.test(t)) {
      this.inTag = true;
      if (t.endsWith('>')) {
        this.inTag = false;
        this.inToolBody = true;
        this.toolBodyParts = [];
      }
      return '';
    }

    // Detect closing tag start — extract text from accumulated body
    if (t === '</' || /^<\/[a-z]/i.test(t)) {
      const extracted = this.inToolBody ? this._extractText() : '';
      this.inToolBody = false;
      this.inClosingTag = true;
      if (t.endsWith('>')) this.inClosingTag = false;
      return extracted;
    }

    // Inside opening tag attributes
    if (this.inTag) {
      if (t.includes('>')) {
        this.inTag = false;
        this.inToolBody = true;
        this.toolBodyParts = [];
      }
      return '';
    }

    // Inside tool body — accumulate
    if (this.inToolBody) {
      this.toolBodyParts.push(delta);
      return '';
    }

    // Inside closing tag
    if (this.inClosingTag) {
      if (t.includes('>')) this.inClosingTag = false;
      return '';
    }

    if (t === '</>' || t === '/>') return '';

    return delta;
  }

  _extractText() {
    const body = this.toolBodyParts.join('').trim();
    this.toolBodyParts = [];
    if (!body) return '';
    return extractToolBodyText(body);
  }
}

// For non-streaming: strip XML tags and extract print() content
function stripArtifactTags(text) {
  return text
    .replace(/<(?:code_interpreter|code|file|exec|shell|apply_diff|read_file|write_file|run_command)[^>]*>([\s\S]*?)<\/[^>]+>/gi, (_, body) => {
      return extractToolBodyText(body);
    })
    .replace(/<\/?(?:code_interpreter|code|file|exec|shell|apply_diff|read_file|write_file|run_command)[^>]*>/gi, '')
    .replace(/<\/?>/g, '');
}

// ── Extract text from notifications ──
function extractText(notifications) {
  const parts = [];
  for (const msg of notifications) {
    const p = msg.params ?? {};
    if (msg.method === 'item/agentMessage/delta') {
      if (typeof p.delta === 'string') parts.push(p.delta);
      else if (typeof p.delta?.text === 'string') parts.push(p.delta.text);
      else if (typeof p.text === 'string') parts.push(p.text);
    } else if (msg.method === 'item/completed') {
      const item = p.item ?? {};
      if (item.type === 'agentMessage' && typeof item.text === 'string') {
        parts.push(item.text);
      }
    }
  }
  return stripArtifactTags(parts.join(''));
}

function extractCompletedAgentText(notifications) {
  const parts = [];
  for (const msg of notifications) {
    const item = msg.params?.item;
    if (msg.method !== 'item/completed' || item?.type !== 'agentMessage') continue;
    const cleaned = stripArtifactTags(item.text || '').trim();
    if (cleaned) parts.push(cleaned);
  }
  return parts.join('\n\n').trim();
}

function notificationTurnId(msg) {
  return msg.params?.turnId || msg.params?.turn?.id || null;
}

function notificationMatchesTurn(msg, turnId) {
  return notificationTurnId(msg) === turnId;
}

function truncateDisplayText(text, maxChars = 1200, maxLines = 40) {
  const normalized = String(text || '').trim();
  if (!normalized) return '';

  const lines = normalized.split('\n');
  const joined = lines.slice(0, maxLines).join('\n');
  const truncated = joined.length > maxChars
    ? `${joined.slice(0, maxChars)}\n... (truncated)`
    : joined;

  return lines.length > maxLines ? `${truncated}\n... (truncated)` : truncated;
}

function formatToolBlock(title, body = '') {
  const safeBody = truncateDisplayText(body).replace(/~~~/g, '~~\\~');
  if (!safeBody) return `\n\n> **[${title}]**\n\n`;
  return `\n\n> **[${title}]**\n\n~~~text\n${safeBody}\n~~~\n\n`;
}

function summarizeMcpResult(result) {
  if (!result) return '';
  if (typeof result === 'string') return result;

  if (Array.isArray(result?.content)) {
    const textBlocks = result.content
      .filter((block) => block?.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text);
    if (textBlocks.length > 0) return textBlocks.join('\n\n');
  }

  try {
    return JSON.stringify(result, null, 2);
  } catch {
    return String(result);
  }
}

function summarizeToolItem(item) {
  if (!item || typeof item !== 'object') return '';

  if (item.type === 'commandExecution') {
    const header = typeof item.exitCode === 'number'
      ? `Command: ${item.command} (exit ${item.exitCode})`
      : `Command: ${item.command}`;
    return formatToolBlock(header, item.aggregatedOutput || '');
  }

  if (item.type === 'fileChange') {
    const count = Array.isArray(item.changes) ? item.changes.length : 0;
    return `\n\n> **[Patch]** ${count} file change${count === 1 ? '' : 's'} applied.\n\n`;
  }

  if (item.type === 'mcpToolCall') {
    const header = `MCP: ${item.server}/${item.tool}${item.error ? ' (error)' : ''}`;
    const body = item.error
      ? JSON.stringify(item.error, null, 2)
      : summarizeMcpResult(item.result);
    return formatToolBlock(header, body);
  }

  if (item.type === 'collabAgentToolCall') {
    return `\n\n> **[Agent Tool]** ${item.tool}\n\n`;
  }

  return '';
}

function maybeScheduleCodexRestart(message) {
  if (!/401 Unauthorized|Missing bearer or basic authentication/i.test(message || '')) return;
  setTimeout(() => {
    codex.restart().catch((err) => {
      console.error('[codex] restart failed after upstream auth error:', err.message);
    });
  }, 0);
}

// ── Wait for turn completion or terminal error ──
function waitForTurnOutcome(client, turnId, timeoutMs = 600_000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const interval = setInterval(() => {
      const turnNotifications = client.notifications.filter((msg) => notificationMatchesTurn(msg, turnId));
      const terminalError = turnNotifications.find((msg) => msg.method === 'error' && msg.params?.willRetry === false);
      if (terminalError) {
        clearInterval(interval);
        const message = terminalError.params?.error?.message || 'Codex turn failed';
        maybeScheduleCodexRestart(message);
        reject(new Error(message));
        return;
      }

      const completed = turnNotifications.find((msg) => {
        return msg.method === 'turn/completed' && msg.params?.turn?.id === turnId;
      });
      if (completed) {
        clearInterval(interval);
        resolve(completed);
        return;
      }

      if (Date.now() - start > timeoutMs) {
        clearInterval(interval);
        reject(new Error('timeout waiting for turn/completed'));
      }
    }, 50);
  });
}

// ── Request Queue — serialize concurrent requests to avoid notification cross-talk ──
const requestQueue = [];
let requestProcessing = false;

function enqueue(fn) {
  return new Promise((resolve, reject) => {
    requestQueue.push({ fn, resolve, reject });
    processQueue();
  });
}

async function processQueue() {
  if (requestProcessing) return;
  const item = requestQueue.shift();
  if (!item) return;
  requestProcessing = true;
  try {
    const result = await item.fn();
    item.resolve(result);
  } catch (err) {
    item.reject(err);
  } finally {
    requestProcessing = false;
    processQueue();
  }
}

async function startThread(client, model, developerInstructions) {
  const params = {
    model,
    cwd: CODEX_CWD,
    approvalPolicy: 'never',
    sandbox: 'danger-full-access',
    ephemeral: true,
  };
  if (developerInstructions) {
    params.developerInstructions = developerInstructions;
  }

  const { thread } = await client.request('thread/start', params);
  console.log(`[codex] new thread for ${model}: ${thread.id}`);
  return thread.id;
}

// ── Main ──
const codex = new CodexClient();
await codex.start();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  try {
    // GET /v1/models
    if (path === '/v1/models' && req.method === 'GET') {
      const data = codex.modelList.map((m) => ({
        id: m.id,
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: 'openai',
      }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data }));
      return;
    }

    // POST /v1/chat/completions
    if (path === '/v1/chat/completions' && req.method === 'POST') {
      const body = await readBody(req);
      const json = JSON.parse(body);
      const messages = json.messages || [];
      const model = json.model || CODEX_MODEL;
      const stream = json.stream || false;

      const builtInput = buildCodexInput(messages);
      if (!builtInput) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'No user message' } }));
        return;
      }
      const { inputParts, systemPrompt } = builtInput;

      // Serialize requests — prevents notification cross-talk between concurrent turns
      await enqueue(() => new Promise((qResolve, qReject) => {
        (async () => {
        try {
          await codex.ensureReady();
          codex.drainNotifications();
          const cfg = getCodexConfig();

          const threadId = await startThread(codex, model, systemPrompt);
          const summaryMode = cfg.reasoning ? (cfg.summary || 'detailed') : 'none';
          const turnResult = await codex.request('turn/start', {
            threadId,
            input: inputParts,
            model,
            summary: summaryMode,
          });
          const turnId = turnResult.turn?.id;

          if (stream) {
            res.writeHead(200, {
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache',
              'Connection': 'keep-alive',
            });

            const chatId = `chatcmpl-${randomUUID().slice(0, 8)}`;
            let seenIdx = 0;
            const tagFilter = new TagFilter();
            let agentMsgBuffer = [];
            let hadCommand = false;
            let agentMsgCount = 0;
            let sentRole = false;
            let clientDisconnected = false;
            let settled = false;
            let interval = null;
            let safetyTimeout = null;

            function sendChunk(field, text) {
              if (!text || res.writableEnded) return;
              const delta = { [field]: text };
              if (!sentRole) {
                delta.role = 'assistant';
                sentRole = true;
              }
              const chunk = {
                id: chatId, object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000), model,
                choices: [{ index: 0, delta, finish_reason: null }],
              };
              res.write(`data: ${JSON.stringify(chunk)}\n\n`);
            }

            function flushBuffer(field) {
              const text = stripArtifactTags(agentMsgBuffer.join(''));
              if (text.trim()) sendChunk(field, text);
              agentMsgBuffer = [];
            }

            function finishStream() {
              if (settled) return;
              settled = true;
              clearInterval(interval);
              clearInterval(keepalive);
              clearTimeout(safetyTimeout);
              if (!res.writableEnded) {
                const endChunk = {
                  id: chatId, object: 'chat.completion.chunk',
                  created: Math.floor(Date.now() / 1000), model,
                  choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
                };
                res.write(`data: ${JSON.stringify(endChunk)}\n\n`);
                res.write('data: [DONE]\n\n');
                res.end();
              }
              qResolve();
            }

            function finishStreamWithError(message) {
              if (settled) return;
              settled = true;
              clearInterval(interval);
              clearInterval(keepalive);
              clearTimeout(safetyTimeout);
              maybeScheduleCodexRestart(message);
              if (!res.writableEnded) {
                if (message) sendChunk('content', `Error: ${message}`);
                const endChunk = {
                  id: chatId, object: 'chat.completion.chunk',
                  created: Math.floor(Date.now() / 1000), model,
                  choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
                };
                res.write(`data: ${JSON.stringify(endChunk)}\n\n`);
                res.write('data: [DONE]\n\n');
                res.end();
              }
              qResolve();
            }

            const keepalive = setInterval(() => {
              if (!res.writableEnded) res.write(': keepalive\n\n');
            }, 15000);

            req.on('close', () => {
              if (res.writableEnded || settled) return;
              clientDisconnected = true;
              clearInterval(interval);
              clearInterval(keepalive);
              clearTimeout(safetyTimeout);
              console.log('[codex] client disconnected');
              qResolve();
            });

            interval = setInterval(() => {
              if (clientDisconnected || settled) return;
              const notifications = codex.notifications;
              for (let i = seenIdx; i < notifications.length; i++) {
                const msg = notifications[i];
                seenIdx = i + 1;
                if (!notificationMatchesTurn(msg, turnId)) continue;

                const p = msg.params ?? {};

                if (msg.method === 'item/started' && p.item?.type === 'agentMessage') {
                  agentMsgBuffer = [];
                  agentMsgCount++;
                  tagFilter.inTag = false;
                  tagFilter.inToolBody = false;
                  tagFilter.inClosingTag = false;
                }

                if (msg.method === 'item/started' && p.item?.type === 'commandExecution') {
                  if (cfg.reasoning) flushBuffer('reasoning_content');
                  else agentMsgBuffer = [];
                  hadCommand = true;
                }

                if (msg.method === 'item/reasoning/delta' || msg.method === 'item/reasoning/summaryTextDelta') {
                  if (cfg.reasoning) {
                    let reasoning = typeof p.delta === 'string' ? p.delta
                      : typeof p.delta?.text === 'string' ? p.delta.text : '';
                    reasoning = stripArtifactTags(reasoning);
                    if (reasoning) sendChunk('reasoning_content', reasoning);
                  }
                }

                if (msg.method === 'item/agentMessage/delta') {
                  const raw = typeof p.delta === 'string' ? p.delta
                    : typeof p.delta?.text === 'string' ? p.delta.text
                    : typeof p.text === 'string' ? p.text : '';
                  const filtered = tagFilter.filter(raw);
                  if (filtered) {
                    if (!hadCommand && agentMsgCount <= 1) {
                      sendChunk('content', filtered);
                    } else {
                      agentMsgBuffer.push(filtered);
                    }
                  }
                }

                if (cfg.toolDisplay && msg.method === 'item/completed') {
                  const toolSummary = summarizeToolItem(p.item);
                  if (toolSummary) sendChunk('content', toolSummary);
                }

                if (msg.method === 'item/completed' && p.item?.type === 'agentMessage' && (hadCommand || agentMsgCount > 1)) {
                  const completedText = stripArtifactTags(p.item.text || '').trim();
                  if (completedText) {
                    agentMsgBuffer = [completedText];
                  }
                  flushBuffer('content');
                }

                if (msg.method === 'error' && p.willRetry === false) {
                  finishStreamWithError(p.error?.message || 'Codex turn failed');
                  return;
                }

                if (msg.method === 'turn/completed' && p.turn?.id === turnId) {
                  flushBuffer('content');
                  finishStream();
                  return;
                }
              }
            }, 50);

            safetyTimeout = setTimeout(() => {
              finishStreamWithError('Timed out waiting for Codex turn completion.');
            }, 600_000);

          } else {
            await waitForTurnOutcome(codex, turnId);
            const turnNotifications = codex.notifications.filter((msg) => notificationMatchesTurn(msg, turnId));
            const text = extractCompletedAgentText(turnNotifications) || extractText(turnNotifications).trim();
            const response = {
              id: `chatcmpl-${randomUUID().slice(0, 8)}`,
              object: 'chat.completion',
              created: Math.floor(Date.now() / 1000), model,
              choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
              usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
            };
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(response));
            qResolve();
          }
        } catch (err) {
          qReject(err);
        }
        })();
      }));
      return;
    }

    // Config
    if (path === '/config' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(loadConfig()));
      return;
    }

    if (path === '/config' && req.method === 'POST') {
      const body = await readBody(req);
      const patch = JSON.parse(body);
      const current = loadConfig();
      for (const section of ['claude', 'codex']) {
        if (patch[section]) {
          current[section] = { ...(current[section] || {}), ...patch[section] };
        }
      }
      saveConfig(current);
      console.log('[config] updated:', JSON.stringify(current));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(current));
      return;
    }

    // Health
    if (path === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', provider: 'codex', model: CODEX_MODEL }));
      return;
    }

    res.writeHead(404);
    res.end('Not Found');
  } catch (err) {
    console.error('[error]', err);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
    }
    if (!res.writableEnded) {
      res.end(JSON.stringify({ error: { message: err.message } }));
    }
  }
});

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => resolve(data));
  });
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[codex-proxy] listening on http://0.0.0.0:${PORT}`);
  console.log(`[codex-proxy] OpenWebUI endpoint: http://host.docker.internal:${PORT}/v1`);
});
