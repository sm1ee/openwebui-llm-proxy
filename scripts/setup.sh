#!/bin/bash
# OpenWebUI LLM Proxy — Initial Setup
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_DIR"

echo "=== OpenWebUI LLM Proxy Setup ==="
echo ""

# 1. .env file
if [ ! -f .env ]; then
    echo "[1/5] Creating .env file..."
    cp .env.example .env
    echo "  → Edit .env to set your QDRANT_API_KEY"
    echo ""
    read -p "  Press Enter when .env is configured..."
else
    echo "[1/5] .env file found"
fi

# 2. Docker services
echo ""
echo "[2/5] Starting Docker services..."
docker compose up -d --build

echo "  Waiting for containers..."
sleep 5

# 3. Qdrant health check
echo ""
echo "[3/5] Checking Qdrant..."
for i in {1..10}; do
    if curl -sf http://localhost:6333/healthz > /dev/null 2>&1; then
        echo "  Qdrant is running"
        break
    fi
    echo "  Waiting... ($i/10)"
    sleep 2
done

# 4. Python dependencies (for ingest scripts)
echo ""
echo "[4/5] Installing Python dependencies..."
pip3 install qdrant-client requests --quiet 2>/dev/null || true
source .env 2>/dev/null || true
export QDRANT_API_KEY

# 5. Status
echo ""
echo "[5/5] System Status"
echo ""
echo "  Qdrant:    http://localhost:6333"
echo "  Tool API:  http://localhost:8100"
echo "  OpenWebUI: http://localhost:3000"
echo ""

docker compose ps

echo ""
echo "=== Setup Complete ==="
echo ""
echo "Next steps:"
echo "  1. Visit http://localhost:3000 → Create admin account"
echo "  2. Start LLM proxies:  ./start.sh"
echo "  3. OpenWebUI Admin > Settings > Connections:"
echo "     - Codex:  http://host.docker.internal:8200/v1  Key: dummy"
echo "     - Claude: http://host.docker.internal:8201/v1  Key: dummy"
echo "  4. OpenWebUI Admin > Tools:"
echo "     - Paste contents of openwebui-tools/security_research_tools.py"
echo "  5. Initialize vector DB:"
echo "     python3 scripts/init_qdrant.py --project myproject"
echo "     python3 scripts/ingest_vuln.py --project myproject --dir /path/to/reports"
echo "     python3 scripts/ingest_code.py --project myproject --path /path/to/src --lang python"
