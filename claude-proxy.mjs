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

function buildPrompt(messages) {
  // OpenAI messages → 단일 프롬프트 변환
  return messages
    .map((m) => {
      const content = typeof m.content === 'string'
        ? m.content
        : (m.content || []).map((c) => c.text || '').join('');
      if (m.role === 'system') return `[System] ${content}`;
      if (m.role === 'assistant') return `[Assistant] ${content}`;
      return content;
    })
    .join('\n\n');
}

async function handleChatCompletion(json, res) {
  const messages = json.messages || [];
  const model = json.model || CLAUDE_MODEL;
  const stream = json.stream || false;
  const prompt = buildPrompt(messages);
  const chatId = `chatcmpl-${randomUUID().slice(0, 8)}`;

  const args = ['-p', '--model', model, '--no-session-persistence', '--effort', 'high'];

  if (stream) {
    args.push('--output-format', 'stream-json', '--verbose');

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
    proc.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          let textDelta = '';
          let thinkingDelta = '';

          if (event.type === 'assistant' && event.message?.content) {
            for (const block of event.message.content) {
              if (block.type === 'thinking') thinkingDelta += block.thinking || '';
              else if (block.type === 'text') textDelta += block.text || '';
            }
          } else if (event.type === 'content_block_delta') {
            if (event.delta?.type === 'thinking_delta') {
              thinkingDelta = event.delta.thinking || '';
            } else {
              textDelta = event.delta?.text || '';
            }
          } else {
            continue;
          }

          if (thinkingDelta) {
            const delta = { reasoning_content: thinkingDelta };
            if (!sentRole) { delta.role = 'assistant'; sentRole = true; }
            res.write(`data: ${JSON.stringify({
              id: chatId, object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000), model,
              choices: [{ index: 0, delta, finish_reason: null }],
            })}\n\n`);
          }

          if (textDelta) {
            const delta = { content: textDelta };
            if (!sentRole) { delta.role = 'assistant'; sentRole = true; }
            res.write(`data: ${JSON.stringify({
              id: chatId, object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000), model,
              choices: [{ index: 0, delta, finish_reason: null }],
            })}\n\n`);
          }
        } catch { /* ignore non-json lines */ }
      }
    });

    proc.on('close', () => {
      clearInterval(keepalive);
      if (res.writableEnded) return;
      res.write(`data: ${JSON.stringify({
        id: chatId, object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000), model,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      })}\n\n`);
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
      await handleChatCompletion(json, res);
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
