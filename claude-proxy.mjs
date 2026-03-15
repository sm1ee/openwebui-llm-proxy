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
  // system 메시지 분리 — --system-prompt 플래그로 전달
  const parts = [];
  for (const m of messages) {
    if (m.role === 'system') continue; // handled separately
    const content = typeof m.content === 'string'
      ? m.content
      : (m.content || []).map((c) => c.text || '').join('');
    if (m.role === 'assistant') parts.push(`[Assistant] ${content}`);
    else parts.push(content);
  }
  return parts.join('\n\n');
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
  const prompt = buildPrompt(messages);
  const systemPrompt = extractSystemPrompt(messages);
  const chatId = `chatcmpl-${randomUUID().slice(0, 8)}`;

  const args = ['-p', '--model', model, '--no-session-persistence', '--effort', 'high'];
  if (systemPrompt) {
    args.push('--system-prompt', systemPrompt);
  }

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

          // Claude Code stream-json: {"type": "assistant", "message": {"content": [...]}}
          if (event.type === 'assistant' && event.message?.content) {
            for (const block of event.message.content) {
              if (block.type === 'thinking') {
                sendChunk('reasoning_content', block.thinking || '');
              } else if (block.type === 'text') {
                sendChunk('content', block.text || '');
              } else if (block.type === 'tool_use') {
                // Show tool execution to user
                const inputStr = JSON.stringify(block.input || {});
                const display = inputStr.length > 200
                  ? inputStr.slice(0, 200) + '...'
                  : inputStr;
                sendChunk('content', `\n\n> **[Tool: ${block.name}]** \`${display}\`\n\n`);
              }
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
