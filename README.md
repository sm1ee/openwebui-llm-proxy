# openwebui-llm-proxy

OpenAI-compatible proxy that bridges **Codex CLI** and **Claude Code** to **[OpenWebUI](https://github.com/open-webui/open-webui)**, with an integrated vector database for RAG workflows.

Use Codex and Claude Code as if they were OpenAI API endpoints — complete with **reasoning/thinking visualization** in OpenWebUI.

## Features

- **Codex Proxy** — Translates Codex `app-server` JSON-RPC into OpenAI-compatible SSE streams
  - Reasoning summaries (`summary: 'detailed'`) → `reasoning_content` chunks
  - XML tool-call stripping (`<code_interpreter>print("...")</code_interpreter>` → text)
  - Thread caching, request queue serialization, 600s timeout
- **Claude Code Proxy** — Translates `claude -p --output-format stream-json` into OpenAI SSE
  - Extended thinking (`thinking_delta`) → `reasoning_content` chunks
  - 15s keepalive for slow models (e.g. Opus)
- **Vector DB** — Qdrant + FastEmbed for project-based RAG (vulnerability reports, source code, exploits)
- **OpenWebUI Tools** — Custom tools for vector search directly from chat
- **Geo-filtering** — Optional Korean-only IP restriction via nginx `geo` module

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    nginx (HTTPS :443)                     │
│  /           → OpenWebUI (:3000)                         │
│  /api/tools/ → Tool API  (:8100)                         │
│  /qdrant/    → Qdrant    (:6333)                         │
└───────────────────────┬─────────────────────────────────┘
                        │
    ┌───────────────────▼───────────────────┐
    │            OpenWebUI (:3000)           │
    │               (Docker)                 │
    └──────┬────────────────────┬───────────┘
           │                    │
  ┌────────▼────────┐  ┌───────▼─────────┐
  │ codex-proxy     │  │ claude-proxy    │
  │ :8200           │  │ :8201           │
  │                 │  │                 │
  │ Codex CLI       │  │ Claude Code CLI │
  │ app-server      │  │ -p --stream-json│
  │ JSON-RPC(stdio) │  │                 │
  └─────────────────┘  └─────────────────┘

  ┌─────────────┐  ┌──────────────┐
  │  Tool API   │  │   Qdrant     │
  │  :8100      ├──►   :6333      │
  │  FastAPI    │  │  Vector DB   │
  │  FastEmbed  │  │              │
  └─────────────┘  └──────────────┘
```

## Quick Start

### Prerequisites

- **Node.js** ≥ 18
- **Docker** & Docker Compose
- [**Codex CLI**](https://github.com/openai/codex) (for codex-proxy)
- [**Claude Code**](https://docs.anthropic.com/en/docs/claude-code) (for claude-proxy)

### 1. Clone & Configure

```bash
git clone https://github.com/sm1ee/openwebui-llm-proxy.git
cd openwebui-llm-proxy

cp .env.example .env
# Edit .env → set QDRANT_API_KEY
```

### 2. Start Docker Services

```bash
docker compose up -d --build
# Starts: Qdrant (:6333) + Tool API (:8100) + OpenWebUI (:3000)
```

### 3. Start LLM Proxies

```bash
./start.sh
# Starts: codex-proxy (:8200) + claude-proxy (:8201)
```

Or run individually:

```bash
node codex-proxy.mjs   # :8200
node claude-proxy.mjs  # :8201
```

### 4. Connect OpenWebUI

1. Visit http://localhost:3000
2. Admin → Settings → Connections → OpenAI API
3. Add connections:
   - **Codex**: URL `http://host.docker.internal:8200/v1` / Key: `dummy`
   - **Claude**: URL `http://host.docker.internal:8201/v1` / Key: `dummy`

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `QDRANT_API_KEY` | *(required)* | Qdrant API key |
| `CODEX_PROXY_PORT` | `8200` | Codex proxy port |
| `CODEX_BIN` | `codex` | Path to Codex CLI binary |
| `CODEX_MODEL` | `gpt-5.4` | Default Codex model |
| `CODEX_CWD` | `./codex-sandbox` | Codex working directory |
| `CLAUDE_PROXY_PORT` | `8201` | Claude proxy port |
| `CLAUDE_BIN` | `claude` | Path to Claude Code binary |
| `CLAUDE_MODEL` | `sonnet` | Default Claude model |
| `TOOL_API_URL` | `http://localhost:8100` | Tool API URL (for ingest scripts) |

## Vector Database (Qdrant + FastEmbed)

Each project gets 4 collections:

| Collection | Description | Indexed Fields |
|------------|-------------|----------------|
| `{project}_vuln` | Vulnerability reports, CVEs, advisories | cve_id, severity, type, source |
| `{project}_code` | Source code chunks (function-level) | file, language, function_name |
| `{project}_exploit` | Exploit/PoC code | target, type, cve_id, platform |
| `{project}_bugbounty` | Bug bounty notes/reports | program, severity, status, type |

### Data Ingestion

```bash
# Create project collections
python3 scripts/init_qdrant.py --project myproject

# Ingest vulnerability reports (Markdown, JSON, text)
python3 scripts/ingest_vuln.py --project myproject --dir /path/to/reports

# Ingest source code
python3 scripts/ingest_code.py --project myproject --path /path/to/src --lang python

# List all projects
python3 scripts/init_qdrant.py --list
```

Supported languages for code ingestion: `c`, `cpp`, `python`, `rust`, `go`, `java`, `javascript`, `ruby`

## OpenWebUI Custom Tools

Register `openwebui-tools/security_research_tools.py` in OpenWebUI Admin → Tools to enable:

- `search_vuln` — Search vulnerability analysis results
- `search_code` — Semantic code search
- `search_exploit` — Search exploits/PoCs
- `search_bugbounty` — Search bug bounty notes
- `list_projects` — List registered projects with stats

## Nginx + Geo-filtering

Optional reverse proxy with Korean-only IP restriction:

```bash
# Generate Korean IP CIDR list
./scripts/update_geo_kr.sh

# Copy configs
cp nginx/conf.d/geo-kr.conf /etc/nginx/conf.d/
cp nginx/conf.d/ai-server.conf /etc/nginx/sites-enabled/

# Edit ai-server.conf:
#   - Replace YOURDOMAIN
#   - Uncomment geo-filtering lines
#   - Set SSL certificate paths

nginx -t && nginx -s reload
```

Weekly auto-update via crontab:
```
0 3 * * 0 /path/to/scripts/update_geo_kr.sh >> /tmp/geo-update.log 2>&1
```

## macOS launchd (Auto-start)

See `launchd/README.md` for service configuration templates.

## API Endpoints

Both proxies expose:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/v1/models` | GET | List available models |
| `/v1/chat/completions` | POST | Chat completion (streaming & non-streaming) |
| `/health` | GET | Health check |

## How It Works

### Codex Proxy

1. Receives OpenAI-format `/v1/chat/completions` request
2. Manages persistent `codex app-server` process via JSON-RPC over stdio
3. Creates/reuses threads per model, sends `turn/start` with `summary: 'detailed'`
4. Converts `item/reasoning/summaryTextDelta` → `reasoning_content` SSE chunks
5. Strips XML tool wrappers, extracts `print()` content
6. Serializes concurrent requests to prevent notification cross-talk

### Claude Code Proxy

1. Spawns `claude -p --output-format stream-json --verbose` per request
2. Parses `thinking_delta` events → `reasoning_content` SSE chunks
3. Parses `text_delta` events → `content` SSE chunks
4. Sends keepalive comments every 15s to prevent timeout

## License

MIT
