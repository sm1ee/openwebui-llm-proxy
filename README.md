# openwebui-llm-proxy

Use **Codex CLI** and **Claude Code** inside **[OpenWebUI](https://github.com/open-webui/open-webui)** like OpenAI-compatible models, while keeping a security-research-friendly stack around them.

This repo combines:

- OpenAI-compatible proxies for **Codex** and **Claude**
- **Qdrant + FastEmbed** vector search for project memory / RAG
- **OpenWebUI runtime patches** for better tool / code-interpreter behavior
- A same-origin **signed local file viewer** for model-generated file references
- Utilities to keep long OpenWebUI chats responsive

If you want the convenience of OpenWebUI with the power of CLI-based coding agents, this is the setup.

## Highlights

- **Bring plan-based CLIs into OpenWebUI**
  Codex CLI and Claude Code show up as normal OpenAI-style models, so you can use them from the OpenWebUI interface without swapping to direct API billing.

- **Streaming that feels native**
  Both proxies translate their native event streams into OpenAI-compatible streaming responses, including reasoning/thinking output when enabled.

- **Parallel Codex turns**
  Codex requests are no longer forced through a single global queue, so multiple chats can make progress at the same time.

- **Runtime display controls**
  Turn thinking, reasoning, tool headers, and tool bodies on or off without editing code.

- **Signed local file viewer**
  Model outputs can link to local workspace files through signed same-origin URLs, with:
  - line anchors
  - syntax highlighting
  - theme switching
  - syntax theme switching
  - markdown preview
  - copy button

- **Built for research workflows**
  Vector DB storage, MCP access, OpenWebUI tools, and ingestion scripts make it easy to store and retrieve:
  - vulnerability notes
  - source code chunks
  - exploit/PoC snippets
  - bug bounty notes

- **OpenWebUI UX fixes**
  Includes runtime patches and maintenance scripts for:
  - code interpreter truncation issues
  - overly heavy historical reasoning/tool artifacts
  - backup cleanup

## Who is this for?

- People using **Codex CLI** or **Claude Code** as their primary coding/research interface
- Users who like **OpenWebUI** as a chat frontend
- Security researchers who want a lightweight local RAG layer for notes, code, exploits, and reports
- Anyone who wants local-file references in chat to open cleanly in-browser instead of breaking into 404s

## Architecture

```text
┌────────────────────────────────────────────────────────────────────┐
│                          nginx / same-origin                      │
│  /                → OpenWebUI (:3000)                             │
│  /local-file/*    → local-file-viewer (:8301)                     │
│  /api/tools/*     → Tool API (:8100)                              │
│  /qdrant/*        → Qdrant (:6333)                                │
└───────────────────────────────┬────────────────────────────────────┘
                                │
                ┌───────────────▼────────────────┐
                │        OpenWebUI (Docker)      │
                │  runtime-patched for local-file│
                │  routing + code-interpreter UX │
                └───────────────┬────────────────┘
                                │
              ┌─────────────────┴─────────────────┐
              │                                   │
      ┌───────▼────────┐                 ┌────────▼───────┐
      │ codex-proxy    │                 │ claude-proxy   │
      │ :8200          │                 │ :8201          │
      │ OpenAI-style   │                 │ OpenAI-style   │
      │ SSE bridge     │                 │ SSE bridge     │
      └───────┬────────┘                 └────────┬───────┘
              │                                   │
      ┌───────▼────────┐                 ┌────────▼───────┐
      │ Codex CLI      │                 │ Claude Code    │
      │ app-server     │                 │ stream-json    │
      └────────────────┘                 └────────────────┘

      ┌──────────────────┐              ┌──────────────────┐
      │ Tool API         │─────────────►│ Qdrant           │
      │ FastAPI + MCP    │              │ vector database  │
      │ + ingest/search  │              │ + FastEmbed data │
      └──────────────────┘              └──────────────────┘

      ┌──────────────────┐
      │ local-file-viewer│
      │ signed links     │
      │ syntax highlight │
      │ markdown preview │
      └──────────────────┘
```

## Quick Start

### Prerequisites

- Node.js 18+
- Docker / Docker Compose
- [Codex CLI](https://github.com/openai/codex)
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code)

### 1. Clone and configure

```bash
git clone https://github.com/sm1ee/openwebui-llm-proxy.git
cd openwebui-llm-proxy

cp .env.example .env
```

Minimum recommended `.env` values:

```bash
QDRANT_API_KEY=your-qdrant-api-key
OPENCLAW_WORKSPACE_DIR=/absolute/path/to/your/openclaw/workspace
LOCAL_FILE_URL_PREFIX=/absolute/path/to/your/openclaw/workspace
LOCAL_FILE_VIEWER_BASE_URL=https://ai.yourdomain.com
```

### 2. Start Docker services

```bash
docker compose up -d --build
```

This starts:

- `open-webui`
- `tool-api`
- `qdrant`
- `local-file-viewer`

### 3. Start the proxies

```bash
./start.sh
```

Or individually:

```bash
node codex-proxy.mjs
node claude-proxy.mjs
```

### 4. Connect from OpenWebUI

In OpenWebUI, add OpenAI-compatible connections:

- Codex: `http://host.docker.internal:8200/v1`
- Claude: `http://host.docker.internal:8201/v1`
- API key: any placeholder string such as `dummy`

## What You Get

### 1. OpenAI-compatible Codex / Claude endpoints

Both proxies expose:

| Endpoint | Method | Description |
|---|---|---|
| `/v1/models` | `GET` | Available models |
| `/v1/chat/completions` | `POST` | Streaming and non-streaming chat completions |
| `/health` | `GET` | Health check |

### 2. Runtime display control

You can change what OpenWebUI sees without editing source code.

```bash
npm run config -- show
npm run config -- fast
npm run config -- balanced
npm run config -- verbose
```

Examples:

```bash
npm run config -- set codex.reasoning on
npm run config -- set codex.toolDisplay on
npm run config -- set codex.toolBodyDisplay off

npm run config -- set claude.thinking off
npm run config -- set claude.toolDisplay on
npm run config -- set claude.toolBodyDisplay off
```

Main toggles:

- `codex.reasoning`
- `codex.toolDisplay`
- `codex.toolBodyDisplay`
- `claude.thinking`
- `claude.toolDisplay`
- `claude.toolBodyDisplay`

This lets you choose between:

- cleaner/faster chat history
- verbose debugging visibility
- title-only tool traces
- full collapsible tool bodies

### 3. Signed local file viewer

One of the nicest quality-of-life features in this repo.

When a model emits a local workspace file reference, the proxies can rewrite it to a signed same-origin link like:

```text
https://ai.yourdomain.com/local-file/t/<signed-token>#L17
```

That viewer supports:

- line anchors like `#L17`
- syntax highlighting with multiple themes
- page theme switching
- markdown code/preview toggle
- one-click copy
- same-origin browser opening instead of dead `/Users/...` links

By default the viewer also supports direct authenticated browsing when enabled behind OpenWebUI, and signed links have a TTL.

Relevant settings:

| Variable | Description |
|---|---|
| `OPENCLAW_WORKSPACE_DIR` | Host workspace directory mounted read-only into the viewer |
| `LOCAL_FILE_URL_PREFIX` | Absolute path prefix that should be recognized as local file links |
| `LOCAL_FILE_VIEWER_BASE_URL` | Public base URL used when generating signed links |
| `LOCAL_FILE_REQUIRE_ADMIN` | Restrict direct browsing to admins |
| `LOCAL_FILE_MAX_INLINE_BYTES` | Max inline preview size |
| `LOCAL_FILE_LINK_TTL_SECONDS` | Signed-link expiration |

### 4. Vector DB for research memory

Qdrant collections are organized per project:

| Collection | Purpose |
|---|---|
| `{project}_vuln` | advisories, CVEs, findings |
| `{project}_code` | source code chunks |
| `{project}_exploit` | exploit and PoC data |
| `{project}_bugbounty` | bug bounty notes / reports |

Useful scripts:

```bash
python3 scripts/init_qdrant.py --project myproject
python3 scripts/ingest_vuln.py --project myproject --dir /path/to/reports
python3 scripts/ingest_code.py --project myproject --path /path/to/src --lang python
```

Supported access modes:

- OpenWebUI custom tools via `openwebui-tools/security_research_tools.py`
- MCP from Codex / Claude via `tool-api/mcp_server.py`
- Direct CLI ingestion/search through `tool-api/vectordb_cli.py`

### 5. MCP read/write tools

The MCP server supports both search and ingest flows.

Read tools:

- `list_projects`
- `search_vuln`
- `search_code`
- `search_exploit`
- `search_bugbounty`

Write tools:

- `ingest_document`
- `ingest_batch`

Collections are created automatically when needed.

## OpenWebUI Runtime Patches

This repo includes runtime patches to make OpenWebUI behave better for coding-agent usage.

Current patch areas include:

- better handling of code-interpreter output
- preserving assistant text after code execution blocks
- same-origin `/local-file/*` pass-through routing

Files:

- `open-webui-runtime-patches/main.py`
- `open-webui-runtime-patches/middleware.py`

## Performance / History Maintenance

Long reasoning and tool-heavy chats can make OpenWebUI sluggish. This repo includes helper scripts to keep things usable.

Included utilities:

- `scripts/compact_openwebui_reasoning.py`
  - compacts old reasoning / tool / code-interpreter artifacts from chat history
- `scripts/cleanup_openwebui_backups.sh`
  - prunes old backup DB files

Good companion workflow:

- keep recent turns verbose
- compact older turns
- keep signed file links for evidence and reports

## Nginx and macOS launchd

### Nginx

The repo includes a reverse-proxy template with:

- OpenWebUI routing
- `/local-file/*` viewer routing
- `/api/tools/*` routing
- `/qdrant/*` routing
- optional geo filtering

Template:

- `nginx/conf.d/ai-server.conf`

### launchd

Template plists are included for:

- Codex proxy
- Claude proxy
- backup cleanup

See:

- `launchd/README.md`

## How the proxies behave

### Codex proxy

- translates Codex `app-server` notifications into OpenAI-style streaming chunks
- supports reasoning output in OpenWebUI
- supports parallel turns instead of forcing a single serialized queue
- rewrites eligible local-file markdown links into signed viewer links
- can hide tool bodies while still showing compact tool headers

### Claude proxy

- translates `claude -p --output-format stream-json` into OpenAI-style SSE
- supports thinking output in OpenWebUI
- keeps long-running streams alive
- rewrites eligible local-file markdown links into signed viewer links
- can hide tool bodies while still showing compact tool headers

## Files to care about first

- `codex-proxy.mjs`
- `claude-proxy.mjs`
- `config.json`
- `configure.mjs`
- `docker-compose.yml`
- `local-file-viewer/main.py`
- `tool-api/mcp_server.py`
- `open-webui-runtime-patches/main.py`
- `open-webui-runtime-patches/middleware.py`

## Why this repo is useful

If you like OpenWebUI but do most of your serious work in Codex CLI or Claude Code, this repo gives you:

- a better frontend
- a shared research memory layer
- cleaner tool/reasoning controls
- clickable local evidence links
- less UI pain when chats get large

It turns OpenWebUI from “generic chat frontend” into something much closer to a practical coding and security-research workspace.

## License

MIT
