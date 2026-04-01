#!/usr/bin/env node
/**
 * Claude Code OpenAI-compatible HTTP Proxy
 *
 * claude -p (print mode) → /v1/chat/completions (HTTP)
 * OpenWebUI에서 OpenAI API endpoint로 연결 가능.
 *
 * Port: 8201
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync, spawn } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, 'config.json');

const PORT = parseInt(process.env.CLAUDE_PROXY_PORT || '8201');
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'sonnet';
const LOCAL_FILE_VIEWER_BASE_URL = String(process.env.LOCAL_FILE_VIEWER_BASE_URL || 'https://ai.smlee.io').replace(/\/+$/, '');
const LOCAL_FILE_PATH_PREFIX = String(
  process.env.LOCAL_FILE_PATH_PREFIX
  || process.env.OPENCLAW_WORKSPACE_DIR
  || '/Users/bugclaw/.openclaw/workspace'
).replace(/\/+$/, '');
const LOCAL_FILE_SIGNING_KEY_FILE = process.env.LOCAL_FILE_SIGNING_KEY_FILE || path.join(__dirname, '.local-file-signing.key');
const LOCAL_FILE_LINK_TTL_SECONDS = parseInt(process.env.LOCAL_FILE_LINK_TTL_SECONDS || String(60 * 60 * 24 * 30), 10);

function loadLocalFileSigningKey() {
  const envValue = String(process.env.LOCAL_FILE_SIGNING_KEY || '').trim();
  if (envValue) return envValue;
  try {
    return fs.readFileSync(LOCAL_FILE_SIGNING_KEY_FILE, 'utf8').trim();
  } catch {
    return '';
  }
}

const LOCAL_FILE_SIGNING_KEY = loadLocalFileSigningKey();
const RELATIVE_LOCAL_FILE_CACHE = new Map();
const RELATIVE_LOCAL_FILE_BASE_DIRS = Array.from(new Set(
  [
    '',
    path.relative(LOCAL_FILE_PATH_PREFIX, __dirname),
    path.relative(LOCAL_FILE_PATH_PREFIX, path.join(__dirname, '..')),
  ]
    .map((value) => String(value || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''))
    .filter((value, index, values) => values.indexOf(value) === index)
));

// ── Config ──
const DEFAULT_CONFIG = {
  claude: {
    thinking: true,
    toolDisplay: true,
    toolBodyDisplay: false,
    debugLog: false,
    effort: 'high',
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

function getClaudeConfig() {
  return loadConfig().claude || {};
}

const MODELS = [
  { id: 'claude-opus-4-6', name: 'Claude Opus 4.6' },
  { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6' },
  { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5' },
  { id: 'opus', name: 'Claude Opus (alias)' },
  { id: 'sonnet', name: 'Claude Sonnet (alias)' },
  { id: 'haiku', name: 'Claude Haiku (alias)' },
];

const activeChildPids = new Set();

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

  console.log(`[claude] stopping ${label} pid=${rootPid} (${termTargets.length - 1} descendants)`);
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

function trackChildProcess(proc) {
  if (Number.isInteger(proc?.pid) && proc.pid > 0) {
    activeChildPids.add(proc.pid);
  }
}

function untrackChildProcess(proc) {
  if (Number.isInteger(proc?.pid) && proc.pid > 0) {
    activeChildPids.delete(proc.pid);
  }
}

async function terminateChildProcess(proc, reason) {
  if (!proc || !Number.isInteger(proc.pid) || proc.exitCode !== null) return;
  untrackChildProcess(proc);
  await killProcessTree(proc.pid, reason);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => resolve(data));
  });
}

function saveBase64Image(dataUrl) {
  // Supports: data:image/png;base64,... , data:image/jpeg;base64,...  etc.
  const match = dataUrl.match(/^data:image\/([a-zA-Z0-9+.-]+);base64,(.+)$/s);
  if (!match) return null;
  const raw = match[1].split('+')[0]; // e.g. "svg+xml" → "svg"
  const ext = raw === 'jpeg' ? 'jpg' : raw;
  const tmpPath = path.join(os.tmpdir(), `owui-img-${randomUUID().slice(0, 8)}.${ext}`);
  try {
    fs.writeFileSync(tmpPath, Buffer.from(match[2], 'base64'));
    return tmpPath;
  } catch (err) {
    console.error(`[claude] failed to save image: ${err.message}`);
    return null;
  }
}

function buildPrompt(messages, cfg = {}) {
  // system 메시지 분리 — --system-prompt 플래그로 전달
  const parts = [];
  const tempFiles = [];
  for (const m of messages) {
    if (m.role === 'system') continue; // handled separately
    let content;
    if (typeof m.content === 'string') {
      content = m.content;
    } else {
      const contentParts = [];
      for (const c of (m.content || [])) {
        if (c.type === 'text') {
          contentParts.push(c.text || '');
        } else if (c.type === 'image_url') {
          // OpenWebUI sends images as base64 data URLs (after convert_url_images_to_base64)
          const url = c.image_url?.url || (typeof c.image_url === 'string' ? c.image_url : '');
          if (url.startsWith('data:')) {
            const tmpPath = saveBase64Image(url);
            if (tmpPath) {
              tempFiles.push(tmpPath);
              // Claude Code -p mode: Read tool can view image files natively
              contentParts.push(`\n[User attached an image: ${tmpPath}]\nIMPORTANT: Read the file "${tmpPath}" to view the attached image before responding.`);
            } else {
              contentParts.push('[User attached an image but it could not be decoded]');
            }
          } else if (url) {
            contentParts.push(`[User attached an image URL: ${url}]\nPlease fetch and view this image URL before responding.`);
          }
        }
      }
      content = contentParts.join('\n');
    }
    if (m.role === 'assistant') {
      const sanitized = sanitizeAssistantText(content, {
        toolDisplay: false,
        toolBodyDisplay: false,
        forHistory: true,
      });
      parts.push(`[Assistant] ${sanitized}`);
    }
    else parts.push(content);
  }
  return { prompt: parts.join('\n\n'), tempFiles };
}

function extractSystemPrompt(messages) {
  const sysMsgs = messages
    .filter((m) => m.role === 'system')
    .map((m) => typeof m.content === 'string' ? m.content : (m.content || []).map((c) => c.text || '').join(''));
  return sysMsgs.join('\n\n') || '';
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

function formatInlineLabel(text) {
  const normalized = String(text || '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' ')
    .trim();
  if (!normalized) return '';

  const maxChars = 120;
  const truncated = normalized.length > maxChars
    ? `${normalized.slice(0, 72)}...${normalized.slice(-(maxChars - 75))}`
    : normalized;

  const matches = truncated.match(/`+/g) || [];
  const longest = matches.reduce((max, run) => Math.max(max, run.length), 0);
  const fence = '`'.repeat(Math.max(1, longest + 1));
  return `${fence}${truncated}${fence}`;
}

function normalizeDisplayLabel(text) {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' ')
    .trim()
    .slice(0, 120)
    .replace(/(.{72}).+(.{24})$/, '$1...$2');
}

function escapeHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeRegExp(text) {
  return String(text || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeWorkspaceRelativePath(value) {
  const normalized = String(value || '')
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .replace(/^\/+/, '')
    .trim();

  if (!normalized) return '';
  if (normalized.includes('..')) return '';
  return normalized;
}

function resolveWorkspaceRelativeFile(relativePath) {
  const normalized = normalizeWorkspaceRelativePath(relativePath);
  if (!normalized) return '';

  const candidate = path.resolve(LOCAL_FILE_PATH_PREFIX, normalized);
  const workspaceRelative = path.relative(LOCAL_FILE_PATH_PREFIX, candidate);
  if (!workspaceRelative || workspaceRelative.startsWith('..') || path.isAbsolute(workspaceRelative)) {
    return '';
  }

  try {
    const stat = fs.statSync(candidate);
    if (!stat.isFile()) return '';
    return workspaceRelative.replace(/\\/g, '/');
  } catch {
    return '';
  }
}

function findRelativeLocalFileTarget(relativePath) {
  const normalized = normalizeWorkspaceRelativePath(relativePath);
  if (!normalized) return '';
  if (RELATIVE_LOCAL_FILE_CACHE.has(normalized)) {
    return RELATIVE_LOCAL_FILE_CACHE.get(normalized) || '';
  }

  for (const baseDir of RELATIVE_LOCAL_FILE_BASE_DIRS) {
    const withBase = normalizeWorkspaceRelativePath(
      baseDir ? path.posix.join(baseDir, normalized) : normalized
    );
    const resolved = resolveWorkspaceRelativeFile(withBase);
    if (resolved) {
      RELATIVE_LOCAL_FILE_CACHE.set(normalized, resolved);
      return resolved;
    }
  }

  try {
    const stdout = execFileSync(
      'rg',
      ['--files', LOCAL_FILE_PATH_PREFIX, '-g', `**/${normalized}`],
      { encoding: 'utf8', maxBuffer: 1024 * 1024 }
    );
    const matches = Array.from(new Set(
      stdout
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => path.relative(LOCAL_FILE_PATH_PREFIX, line).replace(/\\/g, '/'))
    ));

    if (matches.length === 1) {
      RELATIVE_LOCAL_FILE_CACHE.set(normalized, matches[0]);
      return matches[0];
    }
  } catch (error) {
    if (error?.status !== 1 && error?.code !== 'ENOENT') {
      console.error(`[claude] relative local-file lookup failed for "${normalized}": ${error.message}`);
    }
  }

  RELATIVE_LOCAL_FILE_CACHE.set(normalized, '');
  return '';
}

function unwrapCodeInterpreterOutput(text) {
  const raw = String(text || '');
  const outputMatch = raw.match(/<output\b[^>]*>([\s\S]*?)<\/output\s*>/i);
  return trimBoundaryNewlines(outputMatch ? outputMatch[1] : raw);
}

function renderCodeInterpreterResultBlock(body, options = {}) {
  const cfg = options || {};
  const normalized = unwrapCodeInterpreterOutput(body);
  if (!normalized) return '';
  if (cfg.forHistory || cfg.toolDisplay === false) return '';
  if (cfg.toolBodyDisplay === true) return formatDisplayBlock('[result]', normalized);
  return formatDisplayBlock('[result]', '');
}

function sanitizeAssistantText(text, options = {}) {
  let output = String(text || '');

  output = output.replace(
    /<code_interpreter_result\b[^>]*>([\s\S]*?)<\/code_interpreter_result\s*>/gi,
    (_, body) => renderCodeInterpreterResultBlock(body, options)
  );

  output = output
    .replace(/<\/?output\b[^>]*>/gi, '')
    .replace(/<\/?code_interpreter_result\b[^>]*>/gi, '')
    .replace(/\n{3,}/g, '\n\n');

  return trimBoundaryNewlines(output);
}

class CodeInterpreterResultFilter {
  constructor(options = {}) {
    this.buffer = '';
    this.options = options;
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

  _drain(flushAll) {
    let output = '';
    const openRe = /<code_interpreter_result\b[^>]*>/i;
    const closeRe = /<\/code_interpreter_result\s*>/i;

    while (this.buffer) {
      const openMatch = this.buffer.match(openRe);
      if (!openMatch) {
        if (flushAll) {
          output += sanitizeAssistantText(this.buffer, this.options);
          this.buffer = '';
        } else {
          const { safe, remainder } = splitTrailingPartialTag(this.buffer);
          output += sanitizeAssistantText(safe, this.options);
          this.buffer = remainder;
        }
        break;
      }

      const start = openMatch.index ?? 0;
      if (start > 0) {
        output += sanitizeAssistantText(this.buffer.slice(0, start), this.options);
        this.buffer = this.buffer.slice(start);
        continue;
      }

      const openEnd = this.buffer.indexOf('>');
      if (openEnd === -1) break;

      const afterOpen = this.buffer.slice(openEnd + 1);
      const closeMatch = afterOpen.match(closeRe);
      if (!closeMatch || typeof closeMatch.index !== 'number') break;

      const body = afterOpen.slice(0, closeMatch.index);
      output += renderCodeInterpreterResultBlock(body, this.options);
      this.buffer = afterOpen.slice(closeMatch.index + closeMatch[0].length);
    }

    return output;
  }
}

function parseLocalFileTarget(href) {
  const raw = String(href || '').trim();
  if (!raw) return null;
  if (raw.includes('/local-file/t/')) return null;

  const extractAbsolute = (value, hash = '') => {
    if (!value.startsWith(LOCAL_FILE_PATH_PREFIX)) return null;
    const relativePath = decodeURIComponent(value.slice(LOCAL_FILE_PATH_PREFIX.length).replace(/^\/+/, ''));
    if (!relativePath) return null;
    return { relativePath, hash };
  };

  const extractRelative = (value, hash = '') => {
    const normalized = normalizeWorkspaceRelativePath(decodeURIComponent(String(value || '')));

    if (!normalized) return null;
    if (!normalized.includes('/')) return null;
    if (normalized.includes('..')) return null;
    if (normalized.startsWith('local-file/')) return null;
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(normalized)) return null;
    if (!/\.[A-Za-z0-9._-]+$/.test(normalized)) return null;

    const resolved = findRelativeLocalFileTarget(normalized);
    if (!resolved) return null;

    return { relativePath: resolved, hash };
  };

  if (raw.startsWith(LOCAL_FILE_PATH_PREFIX)) {
    const [pathname, hash = ''] = raw.split('#', 2);
    return extractAbsolute(pathname, hash ? `#${hash}` : '');
  }

  try {
    const parsed = new URL(raw);
    return extractAbsolute(parsed.pathname, parsed.hash || '');
  } catch {
    const [pathname, hash = ''] = raw.split('#', 2);
    return extractRelative(pathname, hash ? `#${hash}` : '');
  }
}

function signLocalFileTarget(relativePath) {
  if (!LOCAL_FILE_SIGNING_KEY) return '';
  const payload = {
    path: String(relativePath || '').replace(/^\/+/, ''),
    exp: Math.floor(Date.now() / 1000) + LOCAL_FILE_LINK_TTL_SECONDS,
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = createHmac('sha256', LOCAL_FILE_SIGNING_KEY)
    .update(encodedPayload)
    .digest('base64url');
  return `${encodedPayload}.${signature}`;
}

function normalizeLocalFileHref(href) {
  const target = parseLocalFileTarget(href);
  if (!target) return '';

  const signed = signLocalFileTarget(target.relativePath);
  if (!signed) {
    return `${LOCAL_FILE_VIEWER_BASE_URL}${LOCAL_FILE_PATH_PREFIX}/${target.relativePath}${target.hash}`;
  }

  return `${LOCAL_FILE_VIEWER_BASE_URL}/local-file/t/${signed}${target.hash}`;
}

function rewriteLocalFileLinks(text) {
  const input = String(text || '');
  if (!input) return input;

  let output = input.replace(/\]\(([^)\s]+)\)/g, (match, href) => {
    const rewritten = normalizeLocalFileHref(href);
    return rewritten ? `](${rewritten})` : match;
  });

  const rawUrlRe = new RegExp(
    `https?:\\/\\/[^\\s<>()]*${escapeRegExp(LOCAL_FILE_PATH_PREFIX)}[^\\s<>()]*`,
    'g'
  );
  output = output.replace(rawUrlRe, (href) => normalizeLocalFileHref(href) || href);

  const rawRelativePathRe = /(^|[\s>:(])((?:\.\/)?(?:[A-Za-z0-9._-]+\/)+[A-Za-z0-9._-]+\.[A-Za-z0-9._-]+(?:#[^\s<>()]+)?)/g;
  output = output.replace(rawRelativePathRe, (match, prefix, candidate) => {
    const rewritten = normalizeLocalFileHref(candidate);
    if (!rewritten) return match;
    return `${prefix}[${candidate}](${rewritten})`;
  });

  return output;
}

function splitTrailingPartialMarkdownLink(text) {
  const lastOpen = text.lastIndexOf('](');
  if (lastOpen !== -1) {
    const lastClose = text.lastIndexOf(')');
    if (lastClose > lastOpen) {
      return { safe: text, remainder: '' };
    }
    if (lastClose <= lastOpen) {
      const tail = text.slice(lastOpen);
      if (tail.length <= 4096) {
        return { safe: text.slice(0, lastOpen), remainder: tail };
      }
    }
  }

  const trailingLinkLabel = text.match(/\[[^\]\n]{0,256}\]$/);
  if (trailingLinkLabel && trailingLinkLabel.index != null) {
    return {
      safe: text.slice(0, trailingLinkLabel.index),
      remainder: text.slice(trailingLinkLabel.index),
    };
  }

  const trailingPathFragment = text.match(/((?:\.\/)?(?:[A-Za-z0-9._-]+\/)+[A-Za-z0-9._-]*)$/);
  if (trailingPathFragment?.index != null) {
    return {
      safe: text.slice(0, trailingPathFragment.index),
      remainder: text.slice(trailingPathFragment.index),
    };
  }

  return { safe: text, remainder: '' };
}

class LocalFileLinkFilter {
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

  _drain(flushAll) {
    if (flushAll) {
      const output = rewriteLocalFileLinks(this.buffer);
      this.buffer = '';
      return output;
    }

    const { safe, remainder } = splitTrailingPartialMarkdownLink(this.buffer);
    this.buffer = remainder;
    return rewriteLocalFileLinks(safe);
  }
}

function formatDisplayBlock(title, body = '', language = '') {
  const normalized = trimBoundaryNewlines(body);
  const summary = normalizeDisplayLabel(title);
  const prefixedSummary = summary ? `- ${summary}` : '';
  if (!summary) return '';
  if (!normalized) return `\n\n${formatInlineLabel(prefixedSummary)}\n\n`;
  return `\n\n<details open>\n<summary>${escapeHtml(prefixedSummary)}</summary>\n\n${formatCodeBlock(normalized, language)}\n\n</details>\n\n`;
}

async function handleChatCompletion(json, req, res) {
  const messages = json.messages || [];
  const model = json.model || CLAUDE_MODEL;
  const stream = json.stream || false;

  const cfg = getClaudeConfig();

  if (cfg.debugLog) {
    for (const m of messages) {
      if (m.role === 'system') continue;
      if (typeof m.content !== 'string') {
        console.log(`[DEBUG] ${m.role} content (array):`, JSON.stringify((m.content || []).map(c => ({
          type: c.type,
          ...(c.type === 'image_url' ? { url_prefix: (c.image_url?.url || '').slice(0, 80) } : {}),
          ...(c.type === 'text' ? { text: (c.text || '').slice(0, 60) } : {}),
        }))));
      } else {
        console.log(`[DEBUG] ${m.role} content (string): ${m.content.slice(0, 80)}`);
      }
    }
  }

  const { prompt, tempFiles } = buildPrompt(messages, cfg);
  const systemPrompt = extractSystemPrompt(messages);
  const chatId = `chatcmpl-${randomUUID().slice(0, 8)}`;

  const effort = cfg.effort || 'high';
  const args = ['-p', '--model', model, '--no-session-persistence', '--effort', effort];
  if (systemPrompt) {
    args.push('--system-prompt', systemPrompt);
  }

  function cleanupTempFiles() {
    for (const f of tempFiles) {
      try { fs.unlinkSync(f); } catch {}
    }
  }

  if (stream) {
    args.push('--output-format', 'stream-json', '--verbose', '--include-partial-messages');

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    const proc = spawn(CLAUDE_BIN, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, TERM: 'dumb', CLAUDECODE: '' },
    });
    trackChildProcess(proc);
    let keepalive = null;

    proc.on('error', (err) => {
      untrackChildProcess(proc);
      if (keepalive) clearInterval(keepalive);
      cleanupTempFiles();
      console.error(`[claude spawn error] ${err.message}`);
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({
          id: chatId, object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000), model,
          choices: [{ index: 0, delta: { content: `Error: ${err.message}` }, finish_reason: 'stop' }],
        })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      }
    });

    proc.stdin.write(prompt);
    proc.stdin.end();

    // Keepalive: Opus 등 느린 모델은 첫 응답까지 오래 걸림
    // OpenWebUI 타임아웃 방지를 위해 15초마다 SSE comment 전송
    keepalive = setInterval(() => {
      if (!res.writableEnded) res.write(': keepalive\n\n');
    }, 15000);

    let sentRole = false;
    let buffer = '';
    let usageData = null;
    let sawReasoningDelta = false;
    let sawTextDelta = false;
    let stderrBuffer = '';
    let sentVisibleContent = false;
    let clientDisconnected = false;
    const resultFilter = new CodeInterpreterResultFilter(cfg);
    const contentLinkFilter = new LocalFileLinkFilter();

    // Client disconnect → kill child process to save tokens
    // Note: req 'close' fires on normal completion too, so check proc.exitCode
    req.on('close', () => {
      clientDisconnected = true;
      if (proc.exitCode === null && !proc.killed) {
        console.log('[claude] client disconnected, killing process tree');
        terminateChildProcess(proc, 'claude client disconnected').catch((err) => {
          console.error('[claude] failed to stop disconnected child tree:', err.message);
        });
      }
    });

    function sendChunk(field, text) {
      if (!text || res.writableEnded) return;
      let rewritten = text;
      if (field === 'content') {
        rewritten = resultFilter.filter(rewritten);
        rewritten = contentLinkFilter.filter(rewritten);
      }
      if (!rewritten || res.writableEnded) return;
      sentVisibleContent = true;
      const delta = { [field]: rewritten };
      if (!sentRole) { delta.role = 'assistant'; sentRole = true; }
      res.write(`data: ${JSON.stringify({
        id: chatId, object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000), model,
        choices: [{ index: 0, delta, finish_reason: null }],
      })}\n\n`);
    }

    proc.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);

          // Token-level streaming via --include-partial-messages
          // stream_event wraps Anthropic API events: content_block_delta, etc.
          if (event.type === 'stream_event') {
            const ev = event.event || {};
            if (ev.type === 'content_block_start') {
              const cb = ev.content_block || {};
              if (cb.type === 'tool_use' && cb.name && cfg.toolDisplay) {
                sendChunk('content', `\n\n${formatInlineLabel(`[tool] ${cb.name}`)}\n\n`);
              }
            } else if (ev.type === 'content_block_delta') {
              const delta = ev.delta || {};
              if (delta.type === 'thinking_delta' && delta.thinking) {
                sawReasoningDelta = true;
                if (cfg.thinking) sendChunk('reasoning_content', delta.thinking);
              } else if (delta.type === 'text_delta' && delta.text) {
                sawTextDelta = true;
                sendChunk('content', delta.text);
              }
              // input_json_delta, signature_delta: skip (tool input noise)
            }
            // message_start, content_block_stop, message_delta, message_stop: skip
            continue;
          }

          // Full assistant message — emitted AFTER stream_events for each turn.
          // Some Claude CLI turns omit text/thinking deltas and only include the
          // final assistant message, so keep a fallback here for those cases.
          if (event.type === 'assistant' && event.message?.content) {
            for (const block of event.message.content) {
              if (block.type === 'tool_use') {
                if (cfg.toolDisplay && cfg.toolBodyDisplay === true) {
                  const inputStr = JSON.stringify(block.input || {});
                  const display = inputStr.length > 200
                    ? inputStr.slice(0, 200) + '...'
                    : inputStr;
                  sendChunk('content', formatDisplayBlock(`[tool] ${block.name || 'input'}`, display, 'json'));
                }
              } else if ((block.type === 'thinking' || block.type === 'reasoning' || block.type === 'reasoning_content') && !sawReasoningDelta) {
                const thinkingText = block.thinking || block.text || '';
                if (thinkingText && cfg.thinking) {
                  sawReasoningDelta = true;
                  sendChunk('reasoning_content', thinkingText);
                }
              } else if ((block.type === 'text' || block.type === 'output_text') && !sawTextDelta) {
                const text = block.text || '';
                if (text) {
                  sawTextDelta = true;
                  sendChunk('content', text);
                }
              }
            }
          }
          // Tool result from Claude Code
          else if (event.type === 'user' && event.message?.content && cfg.toolDisplay) {
            for (const block of event.message.content) {
              if (block.type === 'tool_result') {
                const output = typeof block.content === 'string'
                  ? block.content
                  : JSON.stringify(block.content || '');
                const truncated = output.length > 500
                  ? output.slice(0, 500) + '\n... (truncated)'
                  : output;
                if (block.is_error) {
                  sendChunk('content', formatDisplayBlock('[error]', cfg.toolBodyDisplay === true ? truncated : ''));
                } else {
                  sendChunk('content', formatDisplayBlock('[result]', cfg.toolBodyDisplay === true ? truncated : ''));
                }
              }
            }
          }
          // Tool use summary (concise alternative if tool_result is verbose)
          else if (event.type === 'tool_use_summary') {
            // Already showed tool_result above; log only
            console.log(`[claude] tool summary: ${event.summary || ''}`);
          }
          // Fallback: content_block_delta (Anthropic API format, may appear in future CLI versions)
          else if (event.type === 'content_block_delta') {
            if (event.delta?.type === 'thinking_delta') {
              sawReasoningDelta = true;
              if (cfg.thinking) sendChunk('reasoning_content', event.delta.thinking || '');
            } else if (event.delta?.type === 'text_delta') {
              sawTextDelta = true;
              sendChunk('content', event.delta.text || '');
            }
          }
          // Extract usage from result event
          else if (event.type === 'result') {
            usageData = {
              prompt_tokens: event.usage?.input_tokens || 0,
              completion_tokens: event.usage?.output_tokens || 0,
              total_tokens: (event.usage?.input_tokens || 0) + (event.usage?.output_tokens || 0),
            };
            if (event.total_cost_usd) {
              console.log(`[claude] cost: $${event.total_cost_usd.toFixed(4)}, tokens: ${usageData.total_tokens}`);
            }
          }
        } catch { /* ignore non-json lines */ }
      }
    });

    proc.on('close', (code, signal) => {
      clearInterval(keepalive);
      untrackChildProcess(proc);
      cleanupTempFiles();
      if (res.writableEnded) return;

      const trailingResultChunk = resultFilter.flush();
      const trailingFromResult = trailingResultChunk ? contentLinkFilter.filter(trailingResultChunk) : '';
      const trailingLinkChunk = `${trailingFromResult}${contentLinkFilter.flush()}`;
      if (trailingLinkChunk) {
        sentVisibleContent = true;
        const delta = { content: trailingLinkChunk };
        if (!sentRole) { delta.role = 'assistant'; sentRole = true; }
        res.write(`data: ${JSON.stringify({
          id: chatId, object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000), model,
          choices: [{ index: 0, delta, finish_reason: null }],
        })}\n\n`);
      }

      const stderrMessage = stderrBuffer.trim();
      if (!clientDisconnected && code !== 0 && !sentVisibleContent) {
        const message = stderrMessage || `Claude exited with code ${code}${signal ? ` (${signal})` : ''}`;
        sendChunk('content', `Error: ${message}`);
      }

      const finalChunk = {
        id: chatId, object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000), model,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      };
      if (usageData) finalChunk.usage = usageData;
      res.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    });

    proc.stderr.on('data', (d) => {
      const text = d.toString();
      stderrBuffer += text;
      console.error(`[claude stderr] ${text.trim()}`);
    });

  } else {
    // Non-streaming
    args.push('--output-format', 'text');

    const proc = spawn(CLAUDE_BIN, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, TERM: 'dumb', CLAUDECODE: '' },
    });
    trackChildProcess(proc);

    proc.stdin.write(prompt);
    proc.stdin.end();

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    res.on('close', () => {
      if (res.writableEnded || proc.exitCode !== null || proc.killed) return;
      console.log('[claude] client disconnected during non-stream response, killing process tree');
      terminateChildProcess(proc, 'claude non-stream client disconnected').catch((err) => {
        console.error('[claude] failed to stop non-stream child tree:', err.message);
      });
    });

    const exitCode = await new Promise((resolve) => {
      proc.on('error', (err) => {
        untrackChildProcess(proc);
        stderr += err.message;
      });
      proc.on('close', (code) => {
        untrackChildProcess(proc);
        resolve(code);
      });
    });
    cleanupTempFiles();

    if (stderr.trim()) {
      console.error(`[claude stderr] ${stderr.trim()}`);
    }

    if (exitCode !== 0) {
      throw new Error(stderr.trim() || `Claude exited with code ${exitCode}`);
    }

    const response = {
      id: chatId,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: rewriteLocalFileLinks(sanitizeAssistantText(stdout.trim(), cfg)),
        },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(response));
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  try {
    if (path === '/v1/models' && req.method === 'GET') {
      const data = MODELS.map((m) => ({
        id: m.id, object: 'model',
        created: Math.floor(Date.now() / 1000), owned_by: 'anthropic',
      }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data }));
      return;
    }

    if (path === '/v1/chat/completions' && req.method === 'POST') {
      const body = await readBody(req);
      const json = JSON.parse(body);
      await handleChatCompletion(json, req, res);
      return;
    }

    if (path === '/config' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(loadConfig()));
      return;
    }

    if (path === '/config' && req.method === 'POST') {
      const body = await readBody(req);
      const patch = JSON.parse(body);
      const current = loadConfig();
      // partial merge: only update provided keys
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

    if (path === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', provider: 'claude', model: CLAUDE_MODEL }));
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
  console.log(`[claude-proxy] shutting down (${reason})`);

  try {
    server.close();
  } catch {}

  const childPids = [...activeChildPids];
  await Promise.allSettled(childPids.map((pid) => killProcessTree(pid, reason)));
  activeChildPids.clear();

  process.exit(exitCode);
}

server.on('error', (err) => {
  console.error('[server error]', err);
  shutdownProxy(`server error: ${err.message}`, 1).catch((shutdownErr) => {
    console.error('[claude-proxy] shutdown after server error failed:', shutdownErr.message);
    process.exit(1);
  });
});

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    shutdownProxy(`received ${signal}`, 0).catch((err) => {
      console.error('[claude-proxy] signal shutdown failed:', err.message);
      process.exit(1);
    });
  });
}

process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
  shutdownProxy('uncaughtException', 1).catch((shutdownErr) => {
    console.error('[claude-proxy] uncaughtException shutdown failed:', shutdownErr.message);
    process.exit(1);
  });
});

process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
  shutdownProxy('unhandledRejection', 1).catch((shutdownErr) => {
    console.error('[claude-proxy] unhandledRejection shutdown failed:', shutdownErr.message);
    process.exit(1);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[claude-proxy] listening on http://0.0.0.0:${PORT}`);
  console.log(`[claude-proxy] OpenWebUI endpoint: http://host.docker.internal:${PORT}/v1`);
});
