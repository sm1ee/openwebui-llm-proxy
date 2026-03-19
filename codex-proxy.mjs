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
import { execFileSync, spawn } from 'node:child_process';
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function collectDescendantPids(rootPid) {
  let table = '';
  try {
    table = execFileSync('ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8' });
  } catch {
    return [];
  }

  const childrenByParent = new Map();
  for (const line of table.split('\n')) {
    const [pidText, ppidText] = line.trim().split(/\s+/, 2);
    const pid = Number(pidText);
    const ppid = Number(ppidText);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
    const children = childrenByParent.get(ppid) || [];
    children.push(pid);
    childrenByParent.set(ppid, children);
  }

  const descendants = [];
  const stack = [...(childrenByParent.get(rootPid) || [])];
  while (stack.length > 0) {
    const pid = stack.pop();
    descendants.push(pid);
    const children = childrenByParent.get(pid);
    if (children?.length) stack.push(...children);
  }

  return descendants;
}

async function killProcessTree(rootPid, label = 'process') {
  if (!Number.isInteger(rootPid) || rootPid <= 0) return;

  const targets = [...collectDescendantPids(rootPid).reverse(), rootPid];
  const alive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  const termTargets = targets.filter(alive);
  if (termTargets.length === 0) return;

  console.log(`[codex] stopping ${label} pid=${rootPid} (${termTargets.length - 1} descendants)`);
  for (const pid of termTargets) {
    try { process.kill(pid, 'SIGTERM'); } catch {}
  }

  await sleep(1000);

  const killTargets = targets.filter(alive);
  if (killTargets.length === 0) return;

  for (const pid of killTargets) {
    try { process.kill(pid, 'SIGKILL'); } catch {}
  }

  await sleep(250);
}

// ── Codex App Server Client ──
class CodexClient {
  constructor() {
    this.nextId = 1;
    this.pending = new Map();
    this.notifications = [];
    this.nextNotificationSeq = 1;
    this.notificationCursors = new Map();
    this.proc = null;
    this.rl = null;
    this.ready = false;
    this.modelList = [];
    this.startPromise = null;
    this.restartPromise = null;
    this.expectedExitPids = new Set();
    this.lastFailure = null;
  }

  async start() {
    if (this.ready && this.proc && this.proc.exitCode === null) return;
    if (this.startPromise) return this.startPromise;

    this.startPromise = (async () => {
      this.lastFailure = null;
      const proc = spawn(CODEX_BIN, ['app-server'], {
        stdio: ['pipe', 'pipe', 'inherit'],
        cwd: CODEX_CWD,
        env: process.env,
      });
      this.proc = proc;

      proc.on('exit', (code, signal) => {
        const expected = this.expectedExitPids.delete(proc.pid);
        const failureMessage = `codex exited: ${signal || code}`;
        this.lastFailure = new Error(failureMessage);
        if (!expected) {
          console.error(`[codex] exited: ${signal || code}`);
        }

        if (this.proc === proc) {
          this.ready = false;
          this.proc = null;
          this.rl = null;
        }

        for (const { reject, timer } of this.pending.values()) {
          clearTimeout(timer);
          reject(new Error('codex exited'));
        }
        this.pending.clear();
        this.notifications = [];
        this.notificationCursors.clear();
      });

      this.rl = createInterface({ input: proc.stdout });
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
    })().finally(() => {
      this.startPromise = null;
    });

    return this.startPromise;
  }

  async ensureReady() {
    if (this.ready && this.proc && this.proc.exitCode === null) return;
    if (this.restartPromise) {
      await this.restartPromise;
      return;
    }
    await this.start();
  }

  async stop(reason = 'shutdown') {
    const proc = this.proc;
    const rl = this.rl;

    this.ready = false;
    this.proc = null;
    this.rl = null;

    if (rl) {
      try { rl.close(); } catch {}
    }

    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(new Error(reason));
    }
    this.pending.clear();
    this.notifications = [];
    this.notificationCursors.clear();
    this.lastFailure = new Error(reason);

    if (!proc || proc.exitCode !== null) return;

    this.expectedExitPids.add(proc.pid);
    await killProcessTree(proc.pid, reason);
  }

  async restart(reason = 'restart requested') {
    if (this.restartPromise) return this.restartPromise;

    this.restartPromise = (async () => {
      console.log(`[codex] restarting app-server (${reason})`);
      await this.stop(reason);
      await this.start();
    })().finally(() => {
      this.restartPromise = null;
    });

    return this.restartPromise;
  }

  async shutdown(reason = 'shutdown requested') {
    await this.stop(reason);
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
    this.notifications.push({ seq: this.nextNotificationSeq++, msg });
  }

  isAlive() {
    return Boolean(this.proc && this.proc.exitCode === null);
  }

  createNotificationCursor({ includeBuffered = false } = {}) {
    const id = randomUUID();
    const startSeq = includeBuffered && this.notifications.length > 0
      ? this.notifications[0].seq
      : this.nextNotificationSeq;
    this.notificationCursors.set(id, startSeq);
    return id;
  }

  readCursorNotifications(cursorId) {
    const nextSeq = this.notificationCursors.get(cursorId);
    if (typeof nextSeq !== 'number') return [];

    const notifications = [];
    let lastSeq = nextSeq;
    for (const entry of this.notifications) {
      if (entry.seq < nextSeq) continue;
      notifications.push(entry.msg);
      lastSeq = entry.seq + 1;
    }

    if (notifications.length > 0) {
      this.notificationCursors.set(cursorId, lastSeq);
    }

    this.pruneNotifications();
    return notifications;
  }

  closeNotificationCursor(cursorId) {
    if (!cursorId) return;
    this.notificationCursors.delete(cursorId);
    this.pruneNotifications();
  }

  pruneNotifications() {
    if (this.notifications.length === 0) return;

    if (this.notificationCursors.size === 0) {
      this.notifications = [];
      return;
    }

    let minSeq = Infinity;
    for (const seq of this.notificationCursors.values()) {
      if (seq < minSeq) minSeq = seq;
    }
    if (!Number.isFinite(minSeq)) return;

    let cutIndex = 0;
    while (cutIndex < this.notifications.length && this.notifications[cutIndex].seq < minSeq) {
      cutIndex++;
    }
    if (cutIndex > 0) {
      this.notifications = this.notifications.slice(cutIndex);
    }
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

const ARTIFACT_TAG_NAMES = [
  'code_interpreter',
  'exec',
  'shell',
  'apply_diff',
  'read_file',
  'write_file',
  'run_command',
];
const ARTIFACT_TAG_PATTERN = ARTIFACT_TAG_NAMES.join('|');
const ARTIFACT_OPEN_RE = new RegExp(`<(${ARTIFACT_TAG_PATTERN})\\b`, 'i');
const ARTIFACT_BLOCK_RE = new RegExp(
  `<(${ARTIFACT_TAG_PATTERN})\\b([^>]*)>([\\s\\S]*?)<\\/\\1\\s*>`,
  'gi',
);

function escapeRegExp(text) {
  return String(text || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractTagAttribute(attrs, name) {
  const match = String(attrs || '').match(new RegExp(`\\b${name}\\s*=\\s*(['"])(.*?)\\1`, 'i'));
  return match?.[2] || '';
}

function defaultArtifactLanguage(tagName) {
  switch (String(tagName || '').toLowerCase()) {
    case 'code_interpreter':
      return '';
    case 'shell':
    case 'exec':
    case 'run_command':
      return 'bash';
    case 'apply_diff':
      return 'diff';
    default:
      return '';
  }
}

function trimBoundaryNewlines(text) {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/^\n+/, '')
    .replace(/\n+$/, '');
}

function buildFence(text) {
  const matches = String(text || '').match(/`+/g) || [];
  const longest = matches.reduce((max, run) => Math.max(max, run.length), 0);
  return '`'.repeat(Math.max(3, longest + 1));
}

function formatCodeBlock(body, language = '') {
  const normalized = trimBoundaryNewlines(body);
  if (!normalized) return '';
  const fence = buildFence(normalized);
  const info = language ? String(language).trim() : '';
  return `${fence}${info}\n${normalized}\n${fence}`;
}

function renderArtifactTag(tagName, attrs, body) {
  const normalized = trimBoundaryNewlines(body);
  if (!normalized) return '';
  const language = extractTagAttribute(attrs, 'lang')
    || extractTagAttribute(attrs, 'language')
    || defaultArtifactLanguage(tagName);
  return `\n\n${formatCodeBlock(normalized, language)}\n\n`;
}

function parseOpenTag(openTagText) {
  const match = String(openTagText || '').match(/^<([a-z_][\w-]*)([\s\S]*?)>$/i);
  if (!match) return null;
  return {
    tagName: match[1].toLowerCase(),
    attrs: match[2] || '',
  };
}

function splitTrailingPartialTag(text) {
  const lastLt = text.lastIndexOf('<');
  if (lastLt === -1) return { safe: text, remainder: '' };
  const tail = text.slice(lastLt);
  if (tail.includes('>')) return { safe: text, remainder: '' };
  if (/^<\/?[a-z_][\w-]*(?:[\s"'=:/.-][^>]*)?$/i.test(tail)) {
    return { safe: text.slice(0, lastLt), remainder: tail };
  }
  return { safe: text, remainder: '' };
}

// ── Codex XML tag conversion (streaming-safe) ──
// Codex can emit structured XML-ish artifacts like
// <code_interpreter type="code" lang="python">...</code_interpreter>.
// Convert them to normal Markdown code fences so Open WebUI renders them.
class TagFilter {
  constructor() {
    this.buffer = '';
  }

  filter(delta) {
    if (!delta) return '';
    this.buffer += delta;
    return this._drain(false);
  }

  flush() {
    if (!this.buffer) return '';
    return this._drain(true);
  }

  reset() {
    this.buffer = '';
  }

  _drain(flushAll) {
    let output = '';

    while (this.buffer) {
      const openMatch = this.buffer.match(ARTIFACT_OPEN_RE);
      if (!openMatch) {
        if (flushAll) {
          output += this.buffer;
          this.buffer = '';
        } else {
          const { safe, remainder } = splitTrailingPartialTag(this.buffer);
          output += safe;
          this.buffer = remainder;
        }
        break;
      }

      const start = openMatch.index ?? 0;
      if (start > 0) {
        output += this.buffer.slice(0, start);
        this.buffer = this.buffer.slice(start);
        continue;
      }

      const openEnd = this.buffer.indexOf('>');
      if (openEnd === -1) break;

      const parsed = parseOpenTag(this.buffer.slice(0, openEnd + 1));
      if (!parsed) {
        output += this.buffer[0];
        this.buffer = this.buffer.slice(1);
        continue;
      }

      const afterOpen = this.buffer.slice(openEnd + 1);
      const closeRe = new RegExp(`</${escapeRegExp(parsed.tagName)}\\s*>`, 'i');
      const closeMatch = afterOpen.match(closeRe);
      if (!closeMatch || typeof closeMatch.index !== 'number') break;

      const body = afterOpen.slice(0, closeMatch.index);
      output += renderArtifactTag(parsed.tagName, parsed.attrs, body);
      this.buffer = afterOpen.slice(closeMatch.index + closeMatch[0].length);
    }

    return output;
  }
}

// For non-streaming / completed messages: convert XML-ish artifacts to Markdown.
function stripArtifactTags(text) {
  return text
    .replace(ARTIFACT_BLOCK_RE, (_, tagName, attrs, body) => renderArtifactTag(tagName, attrs, body))
    .replace(new RegExp(`</?(?:${ARTIFACT_TAG_PATTERN})\\b[^>]*>`, 'gi'), '')
    .replace(/<\/>/g, '');
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

function extractAgentMessageDeltaText(notifications) {
  const parts = [];
  const tagFilter = new TagFilter();
  let current = [];
  let sawDelta = false;

  function flushCurrent() {
    const trailing = tagFilter.flush();
    if (trailing) current.push(trailing);
    const cleaned = stripArtifactTags(current.join('')).trim();
    if (cleaned) parts.push(cleaned);
    current = [];
    tagFilter.reset();
  }

  for (const msg of notifications) {
    const p = msg.params ?? {};

    if (msg.method === 'item/started' && p.item?.type === 'agentMessage') {
      if (current.length > 0) flushCurrent();
      continue;
    }

    if (msg.method === 'item/agentMessage/delta') {
      const raw = typeof p.delta === 'string' ? p.delta
        : typeof p.delta?.text === 'string' ? p.delta.text
        : typeof p.text === 'string' ? p.text : '';
      const filtered = tagFilter.filter(raw);
      if (filtered) current.push(filtered);
      if (raw) sawDelta = true;
      continue;
    }

    if (msg.method === 'item/completed' && p.item?.type === 'agentMessage') {
      flushCurrent();
    }
  }

  if (current.length > 0 || tagFilter.buffer) flushCurrent();
  return sawDelta ? parts.join('\n\n').trim() : '';
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
  const normalized = trimBoundaryNewlines(text);
  if (!normalized) return '';

  const lines = normalized.split('\n');
  const joined = lines.slice(0, maxLines).join('\n');
  const truncated = joined.length > maxChars
    ? `${joined.slice(0, maxChars)}\n... (truncated)`
    : joined;

  return lines.length > maxLines ? `${truncated}\n... (truncated)` : truncated;
}

function formatToolBlock(title, body = '') {
  const safeBody = truncateDisplayText(body);
  if (!safeBody) return `\n\n**[${title}]**\n\n`;
  return `\n\n**[${title}]**\n\n${formatCodeBlock(safeBody)}\n\n`;
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

function maybeScheduleCodexRestart(message, { force = false } = {}) {
  const text = String(message || '');
  if (!force && !/401 Unauthorized|Missing bearer or basic authentication|timeout waiting for turn\/completed|timed out waiting for codex turn completion|stream disconnected before completion|codex exited/i.test(text)) return;
  setTimeout(() => {
    codex.restart(text || 'scheduled recovery').catch((err) => {
      console.error('[codex] restart failed after recovery trigger:', err.message);
    });
  }, 0);
}

// ── Wait for turn completion or terminal error ──
function waitForTurnOutcome(client, turnId, cursorId, timeoutMs = 600_000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const turnNotifications = [];
    const interval = setInterval(() => {
      if (!client.isAlive()) {
        clearInterval(interval);
        reject(client.lastFailure || new Error('codex exited'));
        return;
      }

      const notifications = client.readCursorNotifications(cursorId);
      for (const msg of notifications) {
        if (!notificationMatchesTurn(msg, turnId)) continue;
        turnNotifications.push(msg);

        if (msg.method === 'error' && msg.params?.willRetry === false) {
          clearInterval(interval);
          const message = msg.params?.error?.message || 'Codex turn failed';
          maybeScheduleCodexRestart(message);
          reject(new Error(message));
          return;
        }

        if (msg.method === 'turn/completed' && msg.params?.turn?.id === turnId) {
          clearInterval(interval);
          resolve(turnNotifications);
          return;
        }
      }

      if (Date.now() - start > timeoutMs) {
        clearInterval(interval);
        maybeScheduleCodexRestart('timeout waiting for turn/completed', { force: true });
        reject(new Error('timeout waiting for turn/completed'));
      }
    }, 50);
  });
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
      await codex.ensureReady();
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

      await codex.ensureReady();
      const cfg = getCodexConfig();
      const threadId = await startThread(codex, model, systemPrompt);
      const summaryMode = cfg.reasoning ? (cfg.summary || 'detailed') : 'none';
      const notificationCursor = codex.createNotificationCursor();

      try {
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

          function flushAgentContent(fallbackText = '') {
            const trailing = tagFilter.flush();
            if (trailing) agentMsgBuffer.push(trailing);
            const bufferedText = stripArtifactTags(agentMsgBuffer.join('')).trim();
            const fallback = stripArtifactTags(fallbackText).trim();
            const text = bufferedText || fallback;
            if (text) sendChunk('content', text);
            agentMsgBuffer = [];
          }

          function cleanupStream() {
            clearInterval(interval);
            clearInterval(keepalive);
            clearTimeout(safetyTimeout);
            codex.closeNotificationCursor(notificationCursor);
          }

          function finishStream() {
            if (settled) return;
            settled = true;
            cleanupStream();
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
          }

          function finishStreamWithError(message) {
            if (settled) return;
            settled = true;
            cleanupStream();
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
          }

          const keepalive = setInterval(() => {
            if (!res.writableEnded) res.write(': keepalive\n\n');
          }, 15000);

          req.on('close', () => {
            if (res.writableEnded || settled) return;
            clientDisconnected = true;
            cleanupStream();
            console.log(`[codex] client disconnected for turn ${turnId}`);
          });

          interval = setInterval(() => {
            if (clientDisconnected || settled) return;

            try {
              if (!codex.isAlive()) {
                finishStreamWithError(codex.lastFailure?.message || 'codex exited');
                return;
              }

              const notifications = codex.readCursorNotifications(notificationCursor);
              for (const msg of notifications) {
                if (!notificationMatchesTurn(msg, turnId)) continue;

                const p = msg.params ?? {};

                if (msg.method === 'item/started' && p.item?.type === 'agentMessage') {
                  agentMsgBuffer = [];
                  agentMsgCount++;
                  tagFilter.reset();
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
                  flushAgentContent(p.item.text || '');
                  tagFilter.reset();
                }

                if (msg.method === 'item/completed' && p.item?.type === 'agentMessage' && !hadCommand && agentMsgCount <= 1) {
                  const trailingText = tagFilter.flush().trim();
                  if (trailingText) sendChunk('content', trailingText);
                }

                if (msg.method === 'error' && p.willRetry === false) {
                  finishStreamWithError(p.error?.message || 'Codex turn failed');
                  return;
                }

                if (msg.method === 'turn/completed' && p.turn?.id === turnId) {
                  if (!hadCommand && agentMsgCount <= 1) {
                    const trailingText = tagFilter.flush().trim();
                    if (trailingText) sendChunk('content', trailingText);
                  }
                  flushBuffer('content');
                  finishStream();
                  return;
                }
              }
            } catch (err) {
              finishStreamWithError(err?.message || 'Codex stream failed');
            }
          }, 50);

          safetyTimeout = setTimeout(() => {
            finishStreamWithError('timeout waiting for turn/completed');
          }, 600_000);
          return;
        }

        const turnNotifications = await waitForTurnOutcome(codex, turnId, notificationCursor);
        const text = extractAgentMessageDeltaText(turnNotifications)
          || extractCompletedAgentText(turnNotifications)
          || extractText(turnNotifications).trim();
        const response = {
          id: `chatcmpl-${randomUUID().slice(0, 8)}`,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000), model,
          choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(response));
        codex.closeNotificationCursor(notificationCursor);
      } catch (err) {
        codex.closeNotificationCursor(notificationCursor);
        maybeScheduleCodexRestart(err?.message || '');
        throw err;
      }
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

let shuttingDown = false;

async function shutdownProxy(reason, exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[codex-proxy] shutting down (${reason})`);

  try {
    server.close();
  } catch {}

  try {
    await codex.shutdown(reason);
  } catch (err) {
    console.error('[codex-proxy] failed to stop codex child tree:', err.message);
  }

  process.exit(exitCode);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => resolve(data));
  });
}

server.on('error', (err) => {
  console.error('[server error]', err);
  shutdownProxy(`server error: ${err.message}`, 1).catch((shutdownErr) => {
    console.error('[codex-proxy] shutdown after server error failed:', shutdownErr.message);
    process.exit(1);
  });
});

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    shutdownProxy(`received ${signal}`, 0).catch((err) => {
      console.error('[codex-proxy] signal shutdown failed:', err.message);
      process.exit(1);
    });
  });
}

process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
  shutdownProxy('uncaughtException', 1).catch((shutdownErr) => {
    console.error('[codex-proxy] uncaughtException shutdown failed:', shutdownErr.message);
    process.exit(1);
  });
});

process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
  shutdownProxy('unhandledRejection', 1).catch((shutdownErr) => {
    console.error('[codex-proxy] unhandledRejection shutdown failed:', shutdownErr.message);
    process.exit(1);
  });
});

server.listen(PORT, '0.0.0.0', async () => {
  try {
    await codex.ensureReady();
  } catch (err) {
    console.error('[codex] initial startup failed:', err.message);
  }
  console.log(`[codex-proxy] listening on http://0.0.0.0:${PORT}`);
  console.log(`[codex-proxy] OpenWebUI endpoint: http://host.docker.internal:${PORT}/v1`);
});
