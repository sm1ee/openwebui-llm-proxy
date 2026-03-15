#!/bin/bash
# LLM Proxy 시작 — Codex (:8200) + Claude (:8201)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

export CODEX_CWD="${CODEX_CWD:-${CODEX_CWD:-$(pwd)}}"
export CODEX_MODEL="${CODEX_MODEL:-gpt-5.4}"
export CLAUDE_MODEL="${CLAUDE_MODEL:-sonnet}"

echo "=== LLM Proxy 시작 ==="
echo "  Codex:  http://localhost:8200/v1  (model: $CODEX_MODEL)"
echo "  Claude: http://localhost:8201/v1  (model: $CLAUDE_MODEL)"
echo ""

# 기존 프로세스 정리
pkill -f "node codex-proxy.mjs" 2>/dev/null || true
pkill -f "node claude-proxy.mjs" 2>/dev/null || true
sleep 1

node codex-proxy.mjs &
CODEX_PID=$!

node claude-proxy.mjs &
CLAUDE_PID=$!

echo "  Codex proxy PID:  $CODEX_PID"
echo "  Claude proxy PID: $CLAUDE_PID"
echo ""
echo "OpenWebUI 연결 설정:"
echo "  Admin > Settings > Connections > OpenAI API:"
echo "    URL: http://host.docker.internal:8200/v1"
echo "    Key: dummy (아무값)"
echo ""
echo "  Admin > Settings > Connections > (추가 연결):"
echo "    URL: http://host.docker.internal:8201/v1"
echo "    Key: dummy"
echo ""

trap "kill $CODEX_PID $CLAUDE_PID 2>/dev/null" EXIT
wait
