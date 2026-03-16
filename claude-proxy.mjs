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
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const PORT = parseInt(process.env.CLAUDE_PROXY_PORT || '8201');
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'sonnet';

const MODELS = [
  { id: 'claude-opus-4-6', name: 'Claude Opus 4.6' },
  { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6' },
  { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5' },
  { id: 'opus', name: 'Claude Opus (alias)' },
  { id: 'sonnet', name: 'Claude Sonnet (alias)' },
  { id: 'haiku', name: 'Claude Haiku (alias)' },
];

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

function buildPrompt(messages) {
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
    if (m.role === 'assistant') parts.push(`[Assistant] ${content}`);
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

async function handleChatCompletion(json, req, res) {
  const messages = json.messages || [];
  const model = json.model || CLAUDE_MODEL;
  const stream = json.stream || false;

  // DEBUG: Log incoming message structure to diagnose image passthrough
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

  const { prompt, tempFiles } = buildPrompt(messages);
  const systemPrompt = extractSystemPrompt(messages);
  const chatId = `chatcmpl-${randomUUID().slice(0, 8)}`;

  const args = ['-p', '--model', model, '--no-session-persistence', '--effort', 'high'];
  if (systemPrompt) {
    args.push('--system-prompt', systemPrompt);
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

    proc.on('error', (err) => {
      clearInterval(keepalive);
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
    const keepalive = setInterval(() => {
      if (!res.writableEnded) res.write(': keepalive\n\n');
    }, 15000);

    let sentRole = false;
    let buffer = '';
    let usageData = null;

    // Client disconnect → kill child process to save tokens
    // Note: req 'close' fires on normal completion too, so check proc.exitCode
    req.on('close', () => {
      if (proc.exitCode === null && !proc.killed) {
        console.log('[claude] client disconnected, killing process');
        proc.kill('SIGTERM');
      }
    });

    function sendChunk(field, text) {
      if (!text || res.writableEnded) return;
      const delta = { [field]: text };
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
              if (cb.type === 'tool_use' && cb.name) {
                sendChunk('content', `\n\n> **[Tool: ${cb.name}]** `);
              }
            } else if (ev.type === 'content_block_delta') {
              const delta = ev.delta || {};
              if (delta.type === 'thinking_delta' && delta.thinking) {
                sendChunk('reasoning_content', delta.thinking);
              } else if (delta.type === 'text_delta' && delta.text) {
                sendChunk('content', delta.text);
              }
              // input_json_delta, signature_delta: skip (tool input noise)
            }
            // message_start, content_block_stop, message_delta, message_stop: skip
            continue;
          }

          // Full assistant message — emitted AFTER stream_events for each turn
          // Only process tool_use blocks here (thinking/text already sent via deltas)
          if (event.type === 'assistant' && event.message?.content) {
            for (const block of event.message.content) {
              if (block.type === 'tool_use') {
                // Show tool input (compact)
                const inputStr = JSON.stringify(block.input || {});
                const display = inputStr.length > 200
                  ? inputStr.slice(0, 200) + '...'
                  : inputStr;
                sendChunk('content', `\`${display}\`\n\n`);
              }
              // thinking/text already streamed via stream_event deltas — skip
            }
          }
          // Tool result from Claude Code
          else if (event.type === 'user' && event.message?.content) {
            for (const block of event.message.content) {
              if (block.type === 'tool_result') {
                const output = typeof block.content === 'string'
                  ? block.content
                  : JSON.stringify(block.content || '');
                const truncated = output.length > 500
                  ? output.slice(0, 500) + '\n... (truncated)'
                  : output;
                if (block.is_error) {
                  sendChunk('content', `\n> **[Error]** \`${truncated}\`\n\n`);
                } else {
                  sendChunk('content', `\n> \`\`\`\n${truncated}\n\`\`\`\n\n`);
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
              sendChunk('reasoning_content', event.delta.thinking || '');
            } else if (event.delta?.type === 'text_delta') {
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

    proc.on('close', () => {
      clearInterval(keepalive);
      // Clean up temp image files
      for (const f of tempFiles) { try { fs.unlinkSync(f); } catch {} }
      if (res.writableEnded) return;
      // Send usage in final chunk if available
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
      console.error(`[claude stderr] ${d.toString().trim()}`);
    });

  } else {
    // Non-streaming
    args.push('--output-format', 'text');

    const proc = spawn(CLAUDE_BIN, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, TERM: 'dumb', CLAUDECODE: '' },
    });

    proc.stdin.write(prompt);
    proc.stdin.end();

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    await new Promise((resolve) => proc.on('close', resolve));
    // Clean up temp image files
    for (const f of tempFiles) { try { fs.unlinkSync(f); } catch {} }

    if (stderr.trim()) {
      console.error(`[claude stderr] ${stderr.trim()}`);
    }

    const response = {
      id: chatId,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{
        index: 0,
        message: { role: 'assistant', content: stdout.trim() },
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

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[claude-proxy] listening on http://0.0.0.0:${PORT}`);
  console.log(`[claude-proxy] OpenWebUI endpoint: http://host.docker.internal:${PORT}/v1`);
});
