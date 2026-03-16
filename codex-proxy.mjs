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
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';

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
  }

  async start() {
    this.proc = spawn(CODEX_BIN, ['app-server'], {
      stdio: ['pipe', 'pipe', 'inherit'],
      cwd: CODEX_CWD,
      env: process.env,
    });

    this.proc.on('exit', (code, signal) => {
      console.error(`[codex] exited: ${signal || code}`);
      this.ready = false;
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

  request(method, params = {}) {
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
    // Extract string arguments from print() calls
    const printMatch = body.match(/^print\s*\(\s*(['"])([\s\S]*?)\1\s*\)$/);
    if (printMatch) return printMatch[2];
    // Multiple print statements or f-strings — extract all string literals
    const prints = [...body.matchAll(/print\s*\(\s*(?:f?['"])([\s\S]*?)(?:['"]\s*)\)/g)];
    if (prints.length > 0) return prints.map(m => m[1]).join('\n');
    // Not a simple print — return the body as-is (could be useful code)
    return body;
  }
}

// For non-streaming: strip XML tags and extract print() content
function stripArtifactTags(text) {
  return text
    .replace(/<(?:code_interpreter|code|file|exec|shell|apply_diff|read_file|write_file|run_command)[^>]*>([\s\S]*?)<\/[^>]+>/gi, (_, body) => {
      const printMatch = body.trim().match(/^print\s*\(\s*(['"])([\s\S]*?)\1\s*\)$/);
      return printMatch ? printMatch[2] : body.trim();
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
      if (item.type === 'agent_message' && Array.isArray(item.content)) {
        for (const c of item.content) {
          if (c?.type === 'output_text' && typeof c.text === 'string') {
            parts.push(c.text);
          }
        }
      }
    }
  }
  return stripArtifactTags(parts.join(''));
}

// ── Wait for notification ──
function waitForNotification(client, method, predicate, timeoutMs = 600_000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const interval = setInterval(() => {
      const found = client.notifications.find(
        (m) => m.method === method && predicate(m.params)
      );
      if (found) {
        clearInterval(interval);
        resolve(found);
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(interval);
        reject(new Error(`timeout waiting for ${method}`));
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

// ── Thread Cache (model → threadId) ──
const threadCache = new Map();

async function getOrCreateThread(client, model) {
  if (threadCache.has(model)) {
    return threadCache.get(model);
  }
  try {
    const { thread } = await client.request('thread/start', {
      model,
      cwd: CODEX_CWD,
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
    });
    threadCache.set(model, thread.id);
    console.log(`[codex] new thread for ${model}: ${thread.id}`);
    return thread.id;
  } catch (err) {
    threadCache.delete(model);  // invalidate on error
    throw err;
  }
}

function invalidateThread(model) {
  threadCache.delete(model);
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

      // 마지막 user 메시지 추출
      const userMsgs = messages.filter((m) => m.role === 'user');
      const lastMsg = userMsgs[userMsgs.length - 1];
      if (!lastMsg) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'No user message' } }));
        return;
      }

      // Build input array — preserve both text and image content parts
      // OpenWebUI sends Chat Completions format:
      //   {type: "image_url", image_url: {url: "data:image/png;base64,..."}}
      // Codex app-server expects:
      //   text:  {type: "text", text: "..."}
      //   image: {type: "image", url: "data:image/png;base64,..."}
      let inputParts;
      if (typeof lastMsg.content === 'string') {
        inputParts = [{ type: 'text', text: lastMsg.content }];
      } else {
        inputParts = [];
        for (const c of (lastMsg.content || [])) {
          if (c.type === 'text') {
            inputParts.push({ type: 'text', text: c.text || '' });
          } else if (c.type === 'image_url') {
            // Convert nested {url: "..."} → flat URL string for Codex
            const url = c.image_url?.url || (typeof c.image_url === 'string' ? c.image_url : '');
            if (url) {
              inputParts.push({ type: 'image', url });
            }
          }
        }
        if (inputParts.length === 0) {
          inputParts = [{ type: 'text', text: '' }];
        }
      }

      // Serialize requests — prevents notification cross-talk between concurrent turns
      await enqueue(() => new Promise((qResolve, qReject) => {
        (async () => {
        try {
          codex.drainNotifications();

          const threadId = await getOrCreateThread(codex, model);
          const turnResult = await codex.request('turn/start', {
            threadId,
            input: inputParts,
            model,
            summary: 'detailed',
          });
          const turnId = turnResult.turn?.id;

          if (stream) {
            res.writeHead(200, {
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache',
              'Connection': 'keep-alive',
            });

            const chatId = `chatcmpl-${randomUUID().slice(0, 8)}`;
            let seenIdx = 0;  // track last processed notification index
            const tagFilter = new TagFilter();
            let agentMsgBuffer = [];
            let hadCommand = false;  // true after first commandExecution in this turn
            let agentMsgCount = 0;   // number of agentMessages started
            let sentRole = false;    // send role: "assistant" in first chunk

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

            // Keepalive: prevent OpenWebUI timeout during long tool executions
            const keepalive = setInterval(() => {
              if (!res.writableEnded) res.write(': keepalive\n\n');
            }, 15000);

            // Client disconnect → clean up intervals
            let clientDisconnected = false;
            let safetyTimeout = null;
            req.on('close', () => {
              if (res.writableEnded) return; // normal completion, not a disconnect
              clientDisconnected = true;
              clearInterval(interval);
              clearInterval(keepalive);
              clearTimeout(safetyTimeout);
              console.log('[codex] client disconnected');
            });

            const interval = setInterval(() => {
              if (clientDisconnected) return;
              const notifications = codex.notifications;
              for (let i = seenIdx; i < notifications.length; i++) {
                const msg = notifications[i];
                seenIdx = i + 1;

                const p = msg.params ?? {};

                if (msg.method === 'item/started' && p.item?.type === 'agentMessage') {
                  agentMsgBuffer = [];
                  agentMsgCount++;
                  tagFilter.inTag = false;
                  tagFilter.inToolBody = false;
                  tagFilter.inClosingTag = false;
                }

                if (msg.method === 'item/started' && p.item?.type === 'commandExecution') {
                  // Previous agentMessage was thinking — flush as reasoning
                  flushBuffer('reasoning_content');
                  hadCommand = true;
                }

                if (msg.method === 'item/reasoning/delta' || msg.method === 'item/reasoning/summaryTextDelta') {
                  let reasoning = typeof p.delta === 'string' ? p.delta
                    : typeof p.delta?.text === 'string' ? p.delta.text : '';
                  reasoning = stripArtifactTags(reasoning);
                  if (reasoning) sendChunk('reasoning_content', reasoning);
                }

                if (msg.method === 'item/agentMessage/delta') {
                  const raw = typeof p.delta === 'string' ? p.delta
                    : typeof p.delta?.text === 'string' ? p.delta.text
                    : typeof p.text === 'string' ? p.text : '';
                  const filtered = tagFilter.filter(raw);
                  if (filtered) {
                    if (!hadCommand && agentMsgCount <= 1) {
                      // First agentMessage, no commands yet — stream directly as content
                      sendChunk('content', filtered);
                    } else {
                      // After commands, buffer (might be thinking or final answer)
                      agentMsgBuffer.push(filtered);
                    }
                  }
                }

                if (msg.method === 'error' || msg.method === 'codex/event/error') {
                  invalidateThread(model);
                }

                if (msg.method === 'turn/completed') {
                  // Flush any remaining buffer as content (final answer)
                  flushBuffer('content');
                  const endChunk = {
                    id: chatId, object: 'chat.completion.chunk',
                    created: Math.floor(Date.now() / 1000), model,
                    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
                  };
                  if (!res.writableEnded) {
                    res.write(`data: ${JSON.stringify(endChunk)}\n\n`);
                    res.write('data: [DONE]\n\n');
                  }
                  clearInterval(interval);
                  clearInterval(keepalive);
                  clearTimeout(safetyTimeout);
                  if (!res.writableEnded) res.end();
                  qResolve();
                  return;
                }
              }
            }, 50);

            safetyTimeout = setTimeout(() => {
              clearInterval(interval);
              clearInterval(keepalive);
              if (!res.writableEnded) res.end();
              qResolve();
            }, 600_000);

          } else {
            const done = await waitForNotification(
              codex, 'turn/completed', (p) => p?.turn?.id === turnId
            );
            const text = extractText(codex.notifications).trim();
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
