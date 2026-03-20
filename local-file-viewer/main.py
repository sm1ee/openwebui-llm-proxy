import html
import hashlib
import hmac
import json
import os
import re
import time
from base64 import urlsafe_b64decode
from pathlib import Path

import bleach
import httpx
from fastapi import FastAPI, Header, HTTPException, Request, Response
from fastapi.responses import HTMLResponse, JSONResponse, PlainTextResponse
from markdown_it import MarkdownIt
from pygments import lex
from pygments.formatters import HtmlFormatter
from pygments.lexers import TextLexer, get_lexer_for_filename, guess_lexer, guess_lexer_for_filename
from pygments.util import ClassNotFound


URL_PREFIX = (
    os.environ.get("LOCAL_FILE_URL_PREFIX")
    or os.environ.get("OPENCLAW_WORKSPACE_DIR")
    or "/Users/bugclaw/.openclaw/workspace"
).rstrip("/")
MOUNT_ROOT = Path(os.environ.get("LOCAL_FILE_MOUNT_ROOT", "/workspace-host")).resolve()
OPENWEBUI_AUTH_URL = os.environ.get(
    "OPENWEBUI_AUTH_URL", "http://open-webui:8080/api/v1/auths/"
)
REQUIRE_ADMIN = os.environ.get("LOCAL_FILE_REQUIRE_ADMIN", "true").lower() == "true"
MAX_INLINE_BYTES = int(os.environ.get("LOCAL_FILE_MAX_INLINE_BYTES", str(1024 * 1024)))
REQUEST_TIMEOUT = float(os.environ.get("LOCAL_FILE_AUTH_TIMEOUT_SECONDS", "5"))
SIGNING_KEY_FILE = os.environ.get(
    "LOCAL_FILE_SIGNING_KEY_FILE", "/llm-proxy/.local-file-signing.key"
)
SIGNED_LINK_TTL_SECONDS = int(
    os.environ.get("LOCAL_FILE_LINK_TTL_SECONDS", str(60 * 60 * 24 * 30))
)

MARKDOWN_SUFFIXES = {
    ".md",
    ".markdown",
    ".mdown",
    ".mkd",
    ".mkdn",
    ".mdx",
}
MARKDOWN_RENDERER = MarkdownIt(
    "commonmark",
    {
        "html": False,
        "linkify": False,
        "typographer": False,
        "breaks": False,
    },
).enable(["table", "strikethrough"])
MARKDOWN_ALLOWED_TAGS = set(bleach.sanitizer.ALLOWED_TAGS).union(
    {
        "p",
        "pre",
        "code",
        "blockquote",
        "hr",
        "h1",
        "h2",
        "h3",
        "h4",
        "h5",
        "h6",
        "table",
        "thead",
        "tbody",
        "tr",
        "th",
        "td",
        "del",
    }
)
MARKDOWN_ALLOWED_ATTRIBUTES = {
    "a": ["href", "title"],
    "code": ["class"],
    "th": ["align"],
    "td": ["align"],
}
MARKDOWN_ALLOWED_PROTOCOLS = set(bleach.sanitizer.ALLOWED_PROTOCOLS).union(
    {"mailto"}
)
PAGE_THEMES = {
    "black": {
        "label": "Black",
        "vars": {
            "bg": "#030406",
            "bg-accent": "#08090d",
            "panel": "rgba(10, 11, 15, 0.96)",
            "text": "#f2f4f8",
            "muted": "#8e95a3",
            "border": "rgba(255, 255, 255, 0.08)",
            "line-number": "#6f7684",
            "line-highlight": "rgba(255, 255, 255, 0.055)",
            "button": "rgba(255, 255, 255, 0.045)",
            "button-hover": "rgba(255, 255, 255, 0.085)",
            "button-active": "rgba(255, 255, 255, 0.11)",
            "button-border": "rgba(255, 255, 255, 0.16)",
            "preview-surface": "rgba(255, 255, 255, 0.018)",
            "shadow": "0 30px 80px rgba(0, 0, 0, 0.55)",
            "link": "#d7dde9",
            "body-glow-top": "rgba(255, 255, 255, 0.04)",
            "body-glow-bottom": "rgba(255, 255, 255, 0.02)",
            "page-border": "rgba(255, 255, 255, 0.05)",
            "page-sheen": "rgba(255, 255, 255, 0.02)",
            "page-fill-top": "rgba(8, 9, 12, 0.98)",
            "page-fill-bottom": "rgba(3, 4, 6, 0.98)",
            "ln-bg-left": "rgba(9, 11, 16, 0.995)",
            "ln-bg-right": "rgba(9, 11, 16, 0.82)",
            "preview-pre-bg": "rgba(6, 8, 12, 0.96)",
            "preview-code-bg": "rgba(255, 255, 255, 0.05)",
            "preview-head-bg": "rgba(255, 255, 255, 0.03)",
            "blockquote-border": "rgba(255, 255, 255, 0.22)",
            "blockquote-text": "#e1e5ee",
            "notice-border": "rgba(255, 255, 255, 0.16)",
            "notice-bg": "rgba(255, 255, 255, 0.05)",
            "notice-text": "#ebeef6",
        },
    },
    "graphite": {
        "label": "Graphite",
        "vars": {
            "bg": "#0a0a0b",
            "bg-accent": "#111214",
            "panel": "rgba(21, 22, 24, 0.96)",
            "text": "#f3f3f1",
            "muted": "#a4a39c",
            "border": "rgba(210, 205, 190, 0.11)",
            "line-number": "#828078",
            "line-highlight": "rgba(255, 248, 220, 0.065)",
            "button": "rgba(255, 248, 220, 0.05)",
            "button-hover": "rgba(255, 248, 220, 0.085)",
            "button-active": "rgba(255, 248, 220, 0.11)",
            "button-border": "rgba(255, 248, 220, 0.16)",
            "preview-surface": "rgba(255, 248, 220, 0.018)",
            "shadow": "0 30px 80px rgba(0, 0, 0, 0.52)",
            "link": "#ebe4d3",
            "body-glow-top": "rgba(255, 248, 220, 0.035)",
            "body-glow-bottom": "rgba(255, 248, 220, 0.02)",
            "page-border": "rgba(255, 248, 220, 0.055)",
            "page-sheen": "rgba(255, 248, 220, 0.018)",
            "page-fill-top": "rgba(18, 19, 22, 0.985)",
            "page-fill-bottom": "rgba(9, 9, 10, 0.985)",
            "ln-bg-left": "rgba(15, 15, 17, 0.995)",
            "ln-bg-right": "rgba(15, 15, 17, 0.82)",
            "preview-pre-bg": "rgba(14, 14, 16, 0.96)",
            "preview-code-bg": "rgba(255, 248, 220, 0.05)",
            "preview-head-bg": "rgba(255, 248, 220, 0.03)",
            "blockquote-border": "rgba(255, 248, 220, 0.24)",
            "blockquote-text": "#ebe5d8",
            "notice-border": "rgba(255, 248, 220, 0.16)",
            "notice-bg": "rgba(255, 248, 220, 0.05)",
            "notice-text": "#f2eee4",
        },
    },
    "obsidian": {
        "label": "Obsidian",
        "vars": {
            "bg": "#040609",
            "bg-accent": "#0a0d12",
            "panel": "rgba(11, 14, 19, 0.96)",
            "text": "#eef4ff",
            "muted": "#8c98aa",
            "border": "rgba(167, 187, 255, 0.1)",
            "line-number": "#707d92",
            "line-highlight": "rgba(123, 147, 255, 0.11)",
            "button": "rgba(123, 147, 255, 0.08)",
            "button-hover": "rgba(123, 147, 255, 0.12)",
            "button-active": "rgba(123, 147, 255, 0.16)",
            "button-border": "rgba(123, 147, 255, 0.22)",
            "preview-surface": "rgba(123, 147, 255, 0.028)",
            "shadow": "0 30px 80px rgba(0, 0, 0, 0.58)",
            "link": "#c8d9ff",
            "body-glow-top": "rgba(123, 147, 255, 0.08)",
            "body-glow-bottom": "rgba(88, 118, 214, 0.04)",
            "page-border": "rgba(167, 187, 255, 0.08)",
            "page-sheen": "rgba(123, 147, 255, 0.03)",
            "page-fill-top": "rgba(10, 13, 18, 0.985)",
            "page-fill-bottom": "rgba(4, 6, 9, 0.985)",
            "ln-bg-left": "rgba(9, 12, 18, 0.995)",
            "ln-bg-right": "rgba(9, 12, 18, 0.82)",
            "preview-pre-bg": "rgba(8, 11, 18, 0.965)",
            "preview-code-bg": "rgba(123, 147, 255, 0.08)",
            "preview-head-bg": "rgba(123, 147, 255, 0.05)",
            "blockquote-border": "rgba(145, 170, 255, 0.33)",
            "blockquote-text": "#dfe9ff",
            "notice-border": "rgba(123, 147, 255, 0.18)",
            "notice-bg": "rgba(123, 147, 255, 0.07)",
            "notice-text": "#e7eeff",
        },
    },
    "ink": {
        "label": "Ink",
        "vars": {
            "bg": "#020504",
            "bg-accent": "#07100d",
            "panel": "rgba(8, 14, 12, 0.96)",
            "text": "#eff8f3",
            "muted": "#8fa59b",
            "border": "rgba(153, 197, 177, 0.1)",
            "line-number": "#70897f",
            "line-highlight": "rgba(140, 217, 176, 0.095)",
            "button": "rgba(140, 217, 176, 0.07)",
            "button-hover": "rgba(140, 217, 176, 0.11)",
            "button-active": "rgba(140, 217, 176, 0.16)",
            "button-border": "rgba(140, 217, 176, 0.22)",
            "preview-surface": "rgba(140, 217, 176, 0.024)",
            "shadow": "0 30px 80px rgba(0, 0, 0, 0.56)",
            "link": "#c7f1db",
            "body-glow-top": "rgba(140, 217, 176, 0.06)",
            "body-glow-bottom": "rgba(140, 217, 176, 0.028)",
            "page-border": "rgba(140, 217, 176, 0.075)",
            "page-sheen": "rgba(140, 217, 176, 0.02)",
            "page-fill-top": "rgba(8, 15, 13, 0.985)",
            "page-fill-bottom": "rgba(2, 5, 4, 0.985)",
            "ln-bg-left": "rgba(7, 12, 11, 0.995)",
            "ln-bg-right": "rgba(7, 12, 11, 0.82)",
            "preview-pre-bg": "rgba(6, 11, 9, 0.96)",
            "preview-code-bg": "rgba(140, 217, 176, 0.07)",
            "preview-head-bg": "rgba(140, 217, 176, 0.04)",
            "blockquote-border": "rgba(140, 217, 176, 0.28)",
            "blockquote-text": "#dff7e8",
            "notice-border": "rgba(140, 217, 176, 0.16)",
            "notice-bg": "rgba(140, 217, 176, 0.06)",
            "notice-text": "#ecfbf2",
        },
    },
}
DEFAULT_PAGE_THEME = "black"
DEFAULT_PAGE_THEME_VARS = PAGE_THEMES[DEFAULT_PAGE_THEME]["vars"]
SYNTAX_THEMES = {
    "monokai": "Monokai",
    "github-dark": "GitHub Dark",
    "dracula": "Dracula",
    "nord": "Nord",
    "gruvbox-dark": "Gruvbox Dark",
    "one-dark": "One Dark",
    "native": "Native",
    "zenburn": "Zenburn",
}
DEFAULT_SYNTAX_THEME = "monokai"
TOKEN_CLASS_FORMATTER = HtmlFormatter(style=DEFAULT_SYNTAX_THEME)


def _build_page_theme_css() -> str:
    blocks = []
    for key, config in PAGE_THEMES.items():
        lines = [f"body.page-theme-{key} {{"]
        for var_name, value in config["vars"].items():
            lines.append(f"      --{var_name}: {value};")
        lines.append("    }")
        blocks.append("\n".join(lines))
    return "\n".join(blocks)


def _build_syntax_theme_css() -> str:
    return "\n".join(
        HtmlFormatter(style=style_name).get_style_defs(
            f"body.syntax-{style_name} .source-view"
        )
        for style_name in SYNTAX_THEMES
    )


PAGE_THEME_CSS = _build_page_theme_css()
SYNTAX_THEME_CSS = _build_syntax_theme_css()


def _load_signing_key() -> bytes:
    env_value = os.environ.get("LOCAL_FILE_SIGNING_KEY", "").strip()
    if env_value:
        return env_value.encode("utf-8")

    try:
        file_value = Path(SIGNING_KEY_FILE).read_text(encoding="utf-8").strip()
        if file_value:
            return file_value.encode("utf-8")
    except FileNotFoundError:
        pass

    return b""


SIGNING_KEY = _load_signing_key()

app = FastAPI(title="local-file-viewer")


def _no_store_headers() -> dict[str, str]:
    return {"Cache-Control": "no-store"}


def _resolve_candidate(relative_path: str) -> Path:
    candidate = (MOUNT_ROOT / relative_path).resolve()
    if not candidate.is_relative_to(MOUNT_ROOT):
        raise HTTPException(status_code=403, detail="Path traversal blocked")
    if not candidate.exists():
        raise HTTPException(status_code=404, detail="File not found")
    if not candidate.is_file():
        raise HTTPException(status_code=404, detail="Directories are not browsable")
    return candidate


def _read_text_file(candidate: Path) -> tuple[str, bool]:
    size = candidate.stat().st_size
    clipped = size > MAX_INLINE_BYTES

    with candidate.open("rb") as fh:
        raw = fh.read(MAX_INLINE_BYTES + 1 if clipped else MAX_INLINE_BYTES)

    if b"\x00" in raw:
        raise HTTPException(status_code=415, detail="Binary files are not supported")

    text = raw[:MAX_INLINE_BYTES].decode("utf-8", errors="replace")
    return text, clipped


def _decode_base64url(data: str) -> bytes:
    padding = "=" * (-len(data) % 4)
    return urlsafe_b64decode(data + padding)


def _verify_signed_token(token: str) -> dict:
    if not SIGNING_KEY:
        raise HTTPException(status_code=503, detail="Signed links are not configured")

    try:
        payload_b64, signature_b64 = token.split(".", 1)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="Malformed signed token") from exc

    expected = hmac.new(SIGNING_KEY, payload_b64.encode("utf-8"), hashlib.sha256).digest()

    try:
        provided = _decode_base64url(signature_b64)
    except Exception as exc:
        raise HTTPException(status_code=400, detail="Malformed token signature") from exc

    if not hmac.compare_digest(expected, provided):
        raise HTTPException(status_code=403, detail="Invalid signed token")

    try:
        payload = json.loads(_decode_base64url(payload_b64))
    except Exception as exc:
        raise HTTPException(status_code=400, detail="Malformed signed token payload") from exc

    expires_at = int(payload.get("exp", 0))
    if expires_at <= int(time.time()):
        raise HTTPException(status_code=410, detail="Signed link expired")

    relative_path = str(payload.get("path", "")).lstrip("/")
    if not relative_path:
        raise HTTPException(status_code=400, detail="Signed token missing file path")

    return {"relative_path": relative_path, "expires_at": expires_at}


async def _authenticate(authorization: str | None, cookie_header: str | None) -> dict:
    headers = {}
    if authorization:
        headers["Authorization"] = authorization
    if cookie_header:
        headers["Cookie"] = cookie_header

    if not headers:
        raise HTTPException(status_code=401, detail="Authentication required")

    try:
        async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT) as client:
            response = await client.get(OPENWEBUI_AUTH_URL, headers=headers)
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=503, detail="OpenWebUI auth check failed") from exc

    if response.status_code == 401:
        raise HTTPException(status_code=401, detail="Invalid OpenWebUI session")
    if response.status_code != 200:
        raise HTTPException(status_code=503, detail="OpenWebUI auth unavailable")

    identity = response.json()
    if REQUIRE_ADMIN and identity.get("role") != "admin":
        raise HTTPException(status_code=403, detail="Admin role required")
    return identity


def _is_markdown_path(display_path: str) -> bool:
    return Path(display_path).suffix.lower() in MARKDOWN_SUFFIXES


def _detect_lexer(display_path: str, content: str):
    file_name = Path(display_path).name or display_path
    attempts = [
        lambda: get_lexer_for_filename(file_name, content),
        lambda: guess_lexer_for_filename(file_name, content) if content.strip() else None,
        lambda: guess_lexer(content) if content.strip() else None,
    ]

    for attempt in attempts:
        try:
            lexer = attempt()
        except ClassNotFound:
            continue
        if lexer is not None:
            return lexer

    return TextLexer()


def _render_source_lines(content: str, display_path: str) -> tuple[str, str]:
    lexer = _detect_lexer(display_path, content)
    rows: list[str] = []
    current_parts: list[str] = []

    for token_type, value in lex(content or "\n", lexer):
        css_class = TOKEN_CLASS_FORMATTER._get_css_class(token_type) or ""
        segments = value.splitlines(keepends=True)
        if not segments:
            continue

        for segment in segments:
            has_newline = segment.endswith("\n")
            text_segment = segment[:-1] if has_newline else segment

            if text_segment:
                escaped = html.escape(text_segment)
                if css_class:
                    current_parts.append(
                        f'<span class="{css_class}">{escaped}</span>'
                    )
                else:
                    current_parts.append(escaped)

            if has_newline:
                rows.append("".join(current_parts) or "&nbsp;")
                current_parts = []

    if current_parts or not rows:
        rows.append("".join(current_parts) or "&nbsp;")

    lines_html = []
    for idx, line_html in enumerate(rows, start=1):
        lines_html.append(
            f'<div class="line" id="L{idx}">'
            f'<a class="ln" href="#L{idx}">{idx}</a>'
            f'<div class="code-cell"><span class="code-line">{line_html}</span></div>'
            f"</div>"
        )

    return "\n".join(lines_html), html.escape(lexer.name)


def _render_markdown_preview(content: str) -> str:
    rendered = MARKDOWN_RENDERER.render(content)
    safe_html = bleach.clean(
        rendered,
        tags=MARKDOWN_ALLOWED_TAGS,
        attributes=MARKDOWN_ALLOWED_ATTRIBUTES,
        protocols=MARKDOWN_ALLOWED_PROTOCOLS,
        strip=True,
    )
    safe_html = re.sub(
        r"<a\s",
        '<a target="_blank" rel="noopener noreferrer" ',
        safe_html,
    )
    return safe_html


def _build_html(
    display_path: str, content: str, clipped: bool, user_name: str | None
) -> str:
    source_rows_html, language_name = _render_source_lines(content, display_path)
    is_markdown = _is_markdown_path(display_path)
    preview_html = _render_markdown_preview(content) if is_markdown else ""
    clip_notice = (
        f'<div class="notice">Preview truncated at {MAX_INLINE_BYTES:,} bytes.</div>'
        if clipped
        else ""
    )
    viewer_name = html.escape(user_name or "authenticated user")
    title = html.escape(display_path)
    viewer_meta_pill = (
        '<span class="meta-pill meta-pill-strong">'
        '<span class="meta-key">viewer</span>'
        f'<span class="meta-value">{viewer_name}</span>'
        "</span>"
    )
    language_meta_pill = (
        '<span class="meta-pill meta-pill-strong">'
        '<span class="meta-key">language</span>'
        f'<span class="meta-value">{language_name}</span>'
        "</span>"
    )
    markdown_meta_pill = (
        '<span class="meta-pill meta-pill-secondary">'
        '<span class="meta-key">mode</span>'
        '<span class="meta-value">markdown preview</span>'
        "</span>"
        if is_markdown
        else ""
    )
    code_button = (
        '<button id="code-view-button" class="toolbar-button is-active" type="button">Code</button>'
        if is_markdown
        else ""
    )
    preview_button = (
        '<button id="preview-view-button" class="toolbar-button" type="button">Preview</button>'
        if is_markdown
        else ""
    )
    preview_panel = (
        f'<section id="preview-view-panel" class="preview-view" hidden>{preview_html}</section>'
        if is_markdown
        else ""
    )
    raw_copy_value = html.escape(content)
    page_theme_options = "".join(
        f'<option value="{html.escape(key)}">{html.escape(config["label"])}</option>'
        for key, config in PAGE_THEMES.items()
    )
    syntax_theme_options = "".join(
        f'<option value="{html.escape(key)}">{html.escape(label)}</option>'
        for key, label in SYNTAX_THEMES.items()
    )
    page_theme_json = json.dumps(list(PAGE_THEMES.keys()))
    syntax_theme_json = json.dumps(list(SYNTAX_THEMES.keys()))

    return f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{title}</title>
  <style>
    :root {{
      color-scheme: dark;
      --bg: {DEFAULT_PAGE_THEME_VARS["bg"]};
      --bg-accent: {DEFAULT_PAGE_THEME_VARS["bg-accent"]};
      --panel: {DEFAULT_PAGE_THEME_VARS["panel"]};
      --text: {DEFAULT_PAGE_THEME_VARS["text"]};
      --muted: {DEFAULT_PAGE_THEME_VARS["muted"]};
      --border: {DEFAULT_PAGE_THEME_VARS["border"]};
      --line-number: {DEFAULT_PAGE_THEME_VARS["line-number"]};
      --line-highlight: {DEFAULT_PAGE_THEME_VARS["line-highlight"]};
      --button: {DEFAULT_PAGE_THEME_VARS["button"]};
      --button-hover: {DEFAULT_PAGE_THEME_VARS["button-hover"]};
      --button-active: {DEFAULT_PAGE_THEME_VARS["button-active"]};
      --button-border: {DEFAULT_PAGE_THEME_VARS["button-border"]};
      --preview-surface: {DEFAULT_PAGE_THEME_VARS["preview-surface"]};
      --shadow: {DEFAULT_PAGE_THEME_VARS["shadow"]};
      --link: {DEFAULT_PAGE_THEME_VARS["link"]};
      --body-glow-top: {DEFAULT_PAGE_THEME_VARS["body-glow-top"]};
      --body-glow-bottom: {DEFAULT_PAGE_THEME_VARS["body-glow-bottom"]};
      --page-border: {DEFAULT_PAGE_THEME_VARS["page-border"]};
      --page-sheen: {DEFAULT_PAGE_THEME_VARS["page-sheen"]};
      --page-fill-top: {DEFAULT_PAGE_THEME_VARS["page-fill-top"]};
      --page-fill-bottom: {DEFAULT_PAGE_THEME_VARS["page-fill-bottom"]};
      --ln-bg-left: {DEFAULT_PAGE_THEME_VARS["ln-bg-left"]};
      --ln-bg-right: {DEFAULT_PAGE_THEME_VARS["ln-bg-right"]};
      --preview-pre-bg: {DEFAULT_PAGE_THEME_VARS["preview-pre-bg"]};
      --preview-code-bg: {DEFAULT_PAGE_THEME_VARS["preview-code-bg"]};
      --preview-head-bg: {DEFAULT_PAGE_THEME_VARS["preview-head-bg"]};
      --blockquote-border: {DEFAULT_PAGE_THEME_VARS["blockquote-border"]};
      --blockquote-text: {DEFAULT_PAGE_THEME_VARS["blockquote-text"]};
      --notice-border: {DEFAULT_PAGE_THEME_VARS["notice-border"]};
      --notice-bg: {DEFAULT_PAGE_THEME_VARS["notice-bg"]};
      --notice-text: {DEFAULT_PAGE_THEME_VARS["notice-text"]};
    }}
    * {{
      box-sizing: border-box;
    }}
    html {{
      scroll-behavior: smooth;
    }}
    body {{
      margin: 0;
      min-height: 100vh;
      background:
        radial-gradient(circle at top center, var(--body-glow-top), transparent 24%),
        radial-gradient(circle at bottom right, var(--body-glow-bottom), transparent 22%),
        linear-gradient(180deg, var(--bg-accent) 0%, var(--bg) 56%);
      color: var(--text);
      font: 14px/1.6 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    }}
    {PAGE_THEME_CSS}
    a {{
      color: var(--link);
    }}
    .page {{
      width: min(1800px, calc(100vw - 36px));
      margin: 18px auto 28px;
      padding: 18px;
      border: 1px solid var(--page-border);
      border-radius: 22px;
      background:
        linear-gradient(180deg, var(--page-sheen), transparent 18%),
        linear-gradient(180deg, var(--page-fill-top), var(--page-fill-bottom));
      box-shadow: var(--shadow);
    }}
    .topbar {{
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 18px;
      margin-bottom: 16px;
    }}
    .title-wrap {{
      min-width: 0;
      flex: 1;
    }}
    h1 {{
      margin: 0;
      font-size: 16px;
      font-weight: 700;
      letter-spacing: -0.01em;
      word-break: break-all;
    }}
    .meta {{
      margin-top: 8px;
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      color: var(--muted);
      font-size: 12px;
    }}
    .meta-pill {{
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 6px 11px;
      border-radius: 999px;
      background: linear-gradient(180deg, rgba(255, 255, 255, 0.08), rgba(255, 255, 255, 0.04));
      border: 1px solid rgba(255, 255, 255, 0.12);
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.04);
    }}
    .meta-pill-strong {{
      background: linear-gradient(180deg, rgba(255, 255, 255, 0.1), rgba(255, 255, 255, 0.045));
      border-color: rgba(255, 255, 255, 0.16);
    }}
    .meta-pill-secondary {{
      background: rgba(255, 255, 255, 0.03);
      border-color: rgba(255, 255, 255, 0.08);
    }}
    .meta-key {{
      color: var(--muted);
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      white-space: nowrap;
    }}
    .meta-value {{
      color: var(--text);
      font-size: 12px;
      font-weight: 700;
      line-height: 1.15;
    }}
    .toolbar {{
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 8px;
      flex-wrap: wrap;
    }}
    .toolbar-group {{
      display: inline-flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }}
    .toolbar-field {{
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 6px 10px;
      border-radius: 12px;
      background: rgba(255, 255, 255, 0.035);
      border: 1px solid rgba(255, 255, 255, 0.05);
      color: var(--muted);
      font-size: 12px;
      line-height: 1;
    }}
    .toolbar-label {{
      white-space: nowrap;
    }}
    .toolbar-select {{
      appearance: none;
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 9px;
      background: rgba(255, 255, 255, 0.04);
      color: var(--text);
      padding: 7px 26px 7px 10px;
      font: inherit;
      font-size: 12px;
      cursor: pointer;
    }}
    .toolbar-select:hover {{
      background: rgba(255, 255, 255, 0.065);
    }}
    .toolbar-button {{
      appearance: none;
      border: 1px solid transparent;
      border-radius: 11px;
      background: var(--button);
      color: var(--text);
      padding: 8px 12px;
      font: inherit;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      transition: background 140ms ease, border-color 140ms ease, transform 140ms ease;
    }}
    .toolbar-button:hover {{
      background: var(--button-hover);
      border-color: rgba(255, 255, 255, 0.08);
    }}
    .toolbar-button:active {{
      transform: translateY(1px);
    }}
    .toolbar-button.is-active {{
      background: var(--button-active);
      border-color: var(--button-border);
    }}
    .toolbar-feedback {{
      min-width: 54px;
      color: var(--muted);
      font-size: 12px;
      text-align: right;
    }}
    .notice {{
      margin-bottom: 14px;
      padding: 11px 13px;
      border: 1px solid var(--notice-border);
      border-radius: 12px;
      background: var(--notice-bg);
      color: var(--notice-text);
      font-size: 13px;
    }}
    .surface {{
      border: 1px solid var(--border);
      border-radius: 18px;
      background:
        linear-gradient(180deg, rgba(255, 255, 255, 0.012), transparent 12%),
        var(--panel);
      overflow: hidden;
      backdrop-filter: blur(10px);
    }}
    .source-view {{
      overflow: auto;
      padding: 0;
      font-size: 13px;
      line-height: 1.7;
      tab-size: 4;
      color: var(--text);
    }}
    {SYNTAX_THEME_CSS}
    .line {{
      display: grid;
      grid-template-columns: 74px minmax(0, 1fr);
      align-items: stretch;
      gap: 0;
      scroll-margin-top: 24px;
    }}
    .line:first-child .ln,
    .line:first-child .code-cell {{
      padding-top: 14px;
    }}
    .line:last-child .ln,
    .line:last-child .code-cell {{
      padding-bottom: 14px;
    }}
    .line:target {{
      background: var(--line-highlight);
    }}
    .ln {{
      position: sticky;
      left: 0;
      z-index: 1;
      display: flex;
      align-items: flex-start;
      justify-content: flex-end;
      padding: 0 14px 0 10px;
      color: var(--line-number);
      text-decoration: none;
      background: linear-gradient(90deg, var(--ln-bg-left), var(--ln-bg-right));
      user-select: none;
    }}
    .code-cell {{
      min-width: 0;
      padding-right: 20px;
    }}
    .code-line {{
      display: block;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }}
    .preview-view {{
      padding: 26px 28px 34px;
      background: var(--preview-surface);
      font: 15px/1.72 ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: var(--text);
    }}
    .preview-view > *:first-child {{
      margin-top: 0;
    }}
    .preview-view > *:last-child {{
      margin-bottom: 0;
    }}
    .preview-view h1,
    .preview-view h2,
    .preview-view h3,
    .preview-view h4,
    .preview-view h5,
    .preview-view h6 {{
      margin: 1.4em 0 0.55em;
      line-height: 1.2;
      letter-spacing: -0.01em;
    }}
    .preview-view p,
    .preview-view ul,
    .preview-view ol,
    .preview-view blockquote,
    .preview-view table,
    .preview-view pre {{
      margin: 0 0 1em;
    }}
    .preview-view ul,
    .preview-view ol {{
      padding-left: 1.4em;
    }}
    .preview-view blockquote {{
      padding-left: 1em;
      margin-left: 0;
      border-left: 3px solid var(--blockquote-border);
      color: var(--blockquote-text);
    }}
    .preview-view pre,
    .preview-view code {{
      font: 13px/1.65 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    }}
    .preview-view pre {{
      overflow: auto;
      padding: 14px 16px;
      border-radius: 14px;
      background: var(--preview-pre-bg);
      border: 1px solid rgba(255, 255, 255, 0.06);
    }}
    .preview-view :not(pre) > code {{
      padding: 2px 6px;
      border-radius: 8px;
      background: var(--preview-code-bg);
    }}
    .preview-view table {{
      width: 100%;
      border-collapse: collapse;
      border-spacing: 0;
      overflow: hidden;
      border-radius: 14px;
      border: 1px solid rgba(255, 255, 255, 0.08);
    }}
    .preview-view th,
    .preview-view td {{
      padding: 10px 12px;
      text-align: left;
      border-bottom: 1px solid rgba(255, 255, 255, 0.06);
    }}
    .preview-view tr:last-child td {{
      border-bottom: 0;
    }}
    .preview-view thead {{
      background: var(--preview-head-bg);
    }}
    .raw-copy-buffer {{
      position: fixed;
      left: -9999px;
      top: 0;
      width: 1px;
      height: 1px;
      opacity: 0;
      pointer-events: none;
    }}
    @media (max-width: 980px) {{
      .page {{
        width: min(100vw - 18px, 100%);
        margin: 10px auto 22px;
        padding: 14px;
        border-radius: 18px;
      }}
      .topbar {{
        flex-direction: column;
      }}
      .toolbar {{
        width: 100%;
        justify-content: flex-start;
      }}
      .line {{
        grid-template-columns: 60px minmax(0, 1fr);
      }}
      .preview-view {{
        padding: 20px 18px 26px;
      }}
    }}
  </style>
</head>
<body class="page-theme-{DEFAULT_PAGE_THEME} syntax-{DEFAULT_SYNTAX_THEME}">
  <main class="page">
    <section class="topbar">
      <div class="title-wrap">
        <h1>{title}</h1>
        <div class="meta">
          {viewer_meta_pill}
          {language_meta_pill}
          {markdown_meta_pill}
        </div>
      </div>
      <div class="toolbar">
        <div class="toolbar-group">
          <label class="toolbar-field" for="page-theme-select">
            <span class="toolbar-label">Theme</span>
            <select id="page-theme-select" class="toolbar-select">{page_theme_options}</select>
          </label>
          <label class="toolbar-field" for="syntax-theme-select">
            <span class="toolbar-label">Syntax</span>
            <select id="syntax-theme-select" class="toolbar-select">{syntax_theme_options}</select>
          </label>
        </div>
        {code_button}
        {preview_button}
        <button id="copy-button" class="toolbar-button" type="button">Copy</button>
        <span id="copy-feedback" class="toolbar-feedback" aria-live="polite"></span>
      </div>
    </section>
    {clip_notice}
    <section class="surface">
      <section id="source-view-panel" class="source-view">
        {source_rows_html}
      </section>
      {preview_panel}
    </section>
  </main>
  <textarea id="raw-copy-buffer" class="raw-copy-buffer" readonly tabindex="-1" aria-hidden="true" spellcheck="false">{raw_copy_value}</textarea>
  <script>
    const PAGE_THEMES = {page_theme_json};
    const SYNTAX_THEMES = {syntax_theme_json};
    const DEFAULT_PAGE_THEME = '{DEFAULT_PAGE_THEME}';
    const DEFAULT_SYNTAX_THEME = '{DEFAULT_SYNTAX_THEME}';
    const PAGE_THEME_STORAGE_KEY = 'local-file-viewer.page-theme';
    const SYNTAX_THEME_STORAGE_KEY = 'local-file-viewer.syntax-theme';
    const pageThemeSelect = document.getElementById('page-theme-select');
    const syntaxThemeSelect = document.getElementById('syntax-theme-select');
    const rawCopyBuffer = document.getElementById('raw-copy-buffer');
    const copyButton = document.getElementById('copy-button');
    const copyFeedback = document.getElementById('copy-feedback');
    const codeButton = document.getElementById('code-view-button');
    const previewButton = document.getElementById('preview-view-button');
    const sourcePanel = document.getElementById('source-view-panel');
    const previewPanel = document.getElementById('preview-view-panel');

    function setStoredValue(key, value) {{
      try {{
        window.localStorage.setItem(key, value);
      }} catch (error) {{
      }}
    }}

    function getStoredValue(key) {{
      try {{
        return window.localStorage.getItem(key);
      }} catch (error) {{
        return null;
      }}
    }}

    function applyPageTheme(theme) {{
      const nextTheme = PAGE_THEMES.includes(theme) ? theme : DEFAULT_PAGE_THEME;
      PAGE_THEMES.forEach((key) => document.body.classList.remove(`page-theme-${{key}}`));
      document.body.classList.add(`page-theme-${{nextTheme}}`);
      if (pageThemeSelect) pageThemeSelect.value = nextTheme;
      setStoredValue(PAGE_THEME_STORAGE_KEY, nextTheme);
    }}

    function applySyntaxTheme(theme) {{
      const nextTheme = SYNTAX_THEMES.includes(theme) ? theme : DEFAULT_SYNTAX_THEME;
      SYNTAX_THEMES.forEach((key) => document.body.classList.remove(`syntax-${{key}}`));
      document.body.classList.add(`syntax-${{nextTheme}}`);
      if (syntaxThemeSelect) syntaxThemeSelect.value = nextTheme;
      setStoredValue(SYNTAX_THEME_STORAGE_KEY, nextTheme);
    }}

    function setFeedback(message) {{
      if (!copyFeedback) return;
      copyFeedback.textContent = message;
      window.clearTimeout(setFeedback.timeoutId);
      if (message) {{
        setFeedback.timeoutId = window.setTimeout(() => {{
          copyFeedback.textContent = '';
        }}, 1800);
      }}
    }}

    async function copyRawText() {{
      const rawText = rawCopyBuffer ? rawCopyBuffer.value : '';
      try {{
        await navigator.clipboard.writeText(rawText);
        setFeedback('Copied');
        return;
      }} catch (error) {{
        if (!rawCopyBuffer) {{
          setFeedback('Copy failed');
          return;
        }}
        rawCopyBuffer.focus();
        rawCopyBuffer.select();
        try {{
          document.execCommand('copy');
          setFeedback('Copied');
        }} catch (fallbackError) {{
          setFeedback('Copy failed');
        }}
      }}
    }}

    function setMode(mode) {{
      if (!sourcePanel || !previewPanel || !codeButton || !previewButton) return;
      const previewActive = mode === 'preview';
      previewPanel.hidden = !previewActive;
      sourcePanel.hidden = previewActive;
      codeButton.classList.toggle('is-active', !previewActive);
      previewButton.classList.toggle('is-active', previewActive);
    }}

    if (copyButton) {{
      copyButton.addEventListener('click', copyRawText);
    }}

    if (pageThemeSelect) {{
      pageThemeSelect.addEventListener('change', (event) => applyPageTheme(event.target.value));
    }}

    if (syntaxThemeSelect) {{
      syntaxThemeSelect.addEventListener('change', (event) => applySyntaxTheme(event.target.value));
    }}

    if (codeButton && previewButton) {{
      codeButton.addEventListener('click', () => setMode('code'));
      previewButton.addEventListener('click', () => setMode('preview'));
    }}

    applyPageTheme(getStoredValue(PAGE_THEME_STORAGE_KEY) || DEFAULT_PAGE_THEME);
    applySyntaxTheme(getStoredValue(SYNTAX_THEME_STORAGE_KEY) || DEFAULT_SYNTAX_THEME);
  </script>
</body>
</html>"""


@app.get("/health")
async def health() -> JSONResponse:
    return JSONResponse(
        {
            "ok": True,
            "url_prefix": URL_PREFIX,
            "mount_root": str(MOUNT_ROOT),
            "require_admin": REQUIRE_ADMIN,
            "signed_links": bool(SIGNING_KEY),
            "signed_link_ttl_seconds": SIGNED_LINK_TTL_SECONDS,
        },
        headers=_no_store_headers(),
    )


@app.get("/local-file/health")
async def prefixed_health() -> JSONResponse:
    return await health()


@app.get(f"{URL_PREFIX}" + "/{relative_path:path}")
async def view_file(
    request: Request,
    relative_path: str,
    authorization: str | None = Header(default=None),
    cookie: str | None = Header(default=None),
) -> Response:
    identity = await _authenticate(authorization, cookie)
    candidate = _resolve_candidate(relative_path)
    content, clipped = _read_text_file(candidate)

    response = HTMLResponse(
        _build_html(
            display_path=f"{URL_PREFIX}/{relative_path}",
            content=content,
            clipped=clipped,
            user_name=identity.get("name") or identity.get("email"),
        )
    )
    response.headers.update(_no_store_headers())
    return response


@app.get("/local-file/t/{token}")
async def view_signed_file(token: str) -> Response:
    payload = _verify_signed_token(token)
    relative_path = payload["relative_path"]
    candidate = _resolve_candidate(relative_path)
    content, clipped = _read_text_file(candidate)

    response = HTMLResponse(
        _build_html(
            display_path=f"{URL_PREFIX}/{relative_path}",
            content=content,
            clipped=clipped,
            user_name="signed local link",
        )
    )
    response.headers.update(_no_store_headers())
    return response


@app.get("/local-file")
@app.get("/local-file/")
async def prefixed_index() -> PlainTextResponse:
    return await index()


@app.get("/")
async def index() -> PlainTextResponse:
    return PlainTextResponse(
        "local-file-viewer is running. Open a workspace file path via the proxied /Users/... URL or /local-file/t/<signed-token>.",
        headers=_no_store_headers(),
    )
