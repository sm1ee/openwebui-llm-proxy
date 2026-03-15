#!/usr/bin/env python3
"""취약점 분석 결과 인제스트 스크립트 (프로젝트 기반).

사용법:
    python ingest_vuln.py --project n8n --dir /path/to/audit/n8n
    python ingest_vuln.py --project n8n --file /path/to/report.md
"""

import argparse
import os
import re
import sys

import requests

TOOL_API = os.getenv("TOOL_API_URL", "http://localhost:8100")
CHUNK_SIZE = 1500
BATCH_SIZE = 10


def parse_markdown_sections(content: str) -> list[dict]:
    sections = []
    current_title = "untitled"
    current_lines = []

    for line in content.split("\n"):
        if line.startswith("#"):
            if current_lines:
                text = "\n".join(current_lines).strip()
                if len(text) > 50:
                    sections.append({"title": current_title, "text": text})
            current_title = line.lstrip("#").strip()
            current_lines = [line]
        else:
            current_lines.append(line)

    if current_lines:
        text = "\n".join(current_lines).strip()
        if len(text) > 50:
            sections.append({"title": current_title, "text": text})

    return sections


def detect_severity(text: str) -> str:
    text_lower = text.lower()
    if any(w in text_lower for w in ["critical", "rce", "remote code execution"]):
        return "critical"
    if any(w in text_lower for w in ["high", "injection", "bypass", "overflow"]):
        return "high"
    if any(w in text_lower for w in ["medium", "xss", "csrf"]):
        return "medium"
    return "low"


def detect_vuln_type(text: str) -> str:
    patterns = {
        "injection": ["injection", "sqli", "crlf", "header injection"],
        "overflow": ["overflow", "buffer", "oob", "out-of-bounds"],
        "xss": ["xss", "cross-site scripting"],
        "rce": ["rce", "remote code execution", "command execution"],
        "auth_bypass": ["bypass", "authentication", "authorization"],
        "ssrf": ["ssrf", "server-side request"],
        "path_traversal": ["path traversal", "directory traversal", "lfi"],
    }
    text_lower = text.lower()
    for vtype, keywords in patterns.items():
        if any(k in text_lower for k in keywords):
            return vtype
    return "other"


def extract_cve(text: str) -> str:
    match = re.search(r"CVE-\d{4}-\d+", text)
    return match.group(0) if match else ""


def parse_json_evidence(content: str, filename: str) -> list[dict]:
    """JSON evidence 파일을 텍스트 chunk로 변환."""
    import json as jsonlib
    try:
        data = jsonlib.loads(content)
    except Exception:
        return [{"title": filename, "text": content}]

    sections = []
    if isinstance(data, dict):
        text = jsonlib.dumps(data, indent=2, ensure_ascii=False)
        title = data.get("title", data.get("name", filename))
        sections.append({"title": str(title), "text": text})
    elif isinstance(data, list):
        for i, item in enumerate(data):
            text = jsonlib.dumps(item, indent=2, ensure_ascii=False) if isinstance(item, dict) else str(item)
            title = item.get("title", f"{filename}[{i}]") if isinstance(item, dict) else f"{filename}[{i}]"
            sections.append({"title": str(title), "text": text})
    return sections


def ingest_file(filepath: str, project: str, source: str, col_type: str = "vuln"):
    with open(filepath, "r", encoding="utf-8", errors="ignore") as f:
        content = f.read()

    if not content.strip() or len(content.strip()) < 50:
        return 0

    filename = os.path.basename(filepath)
    ext = os.path.splitext(filepath)[1].lower()

    if ext == ".json":
        sections = parse_json_evidence(content, filename)
    elif ext in (".md", ".txt"):
        sections = parse_markdown_sections(content)
        if not sections:
            sections = [{"title": filename, "text": content}]
    else:
        sections = [{"title": filename, "text": content}]

    items = []
    for sec in sections:
        text = sec["text"]
        if len(text) > CHUNK_SIZE:
            for i in range(0, len(text), CHUNK_SIZE):
                chunk = text[i : i + CHUNK_SIZE]
                if len(chunk.strip()) > 50:
                    items.append({
                        "text": chunk,
                        "metadata": {
                            "source": source,
                            "file": filename,
                            "section": sec["title"],
                            "severity": detect_severity(chunk),
                            "type": detect_vuln_type(chunk),
                            "cve_id": extract_cve(chunk),
                        },
                    })
        else:
            items.append({
                "text": text,
                "metadata": {
                    "source": source,
                    "file": filename,
                    "section": sec["title"],
                    "severity": detect_severity(text),
                    "type": detect_vuln_type(text),
                    "cve_id": extract_cve(text),
                },
            })

    total = 0
    for i in range(0, len(items), BATCH_SIZE):
        batch = items[i : i + BATCH_SIZE]
        resp = requests.post(
            f"{TOOL_API}/ingest/batch",
            json={"project": project, "type": col_type, "items": batch},
            timeout=120,
        )
        resp.raise_for_status()
        total += resp.json()["count"]

    print(f"  {filename}: {total} chunks → {project}_{col_type}")
    return total


def main():
    parser = argparse.ArgumentParser(description="취약점 분석 결과를 프로젝트 벡터 DB에 인제스트")
    parser.add_argument("--project", required=True, help="프로젝트명 (예: n8n)")
    parser.add_argument("--file", help="단일 Markdown 파일")
    parser.add_argument("--dir", help="Markdown 파일이 있는 디렉토리")
    parser.add_argument("--source", default="audit", help="데이터 소스 (audit, bugbounty)")
    parser.add_argument("--col-type", default="vuln", choices=["vuln", "exploit", "bugbounty"], help="컬렉션 타입")
    args = parser.parse_args()

    if args.file:
        ingest_file(args.file, args.project, args.source, args.col_type)
    elif args.dir:
        total = 0
        exts = (".md", ".json", ".txt", ".py", ".sh", ".js", ".mjs", ".html")
        for root, _dirs, files in os.walk(args.dir):
            for f in sorted(files):
                if f.endswith(exts):
                    total += ingest_file(os.path.join(root, f), args.project, args.source, args.col_type)
        print(f"\nTotal: {total} chunks → {args.project}_{args.col_type}")
    else:
        parser.print_help()
        sys.exit(1)


if __name__ == "__main__":
    main()
