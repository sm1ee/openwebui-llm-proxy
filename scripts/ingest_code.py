#!/usr/bin/env python3
"""소스코드 인제스트 스크립트 (프로젝트 기반).

사용법:
    python ingest_code.py --project n8n --path /path/to/n8n --lang javascript
    python ingest_code.py --project chromium --path /path/to/src --lang cpp
"""

import argparse
import os
import sys

import requests

TOOL_API = os.getenv("TOOL_API_URL", "http://localhost:8100")

LANG_EXTS = {
    "c": [".c", ".h"],
    "cpp": [".cc", ".cpp", ".cxx", ".h", ".hpp", ".hxx"],
    "python": [".py"],
    "rust": [".rs"],
    "go": [".go"],
    "java": [".java"],
    "javascript": [".js", ".jsx", ".ts", ".tsx"],
    "ruby": [".rb"],
}

MAX_CHUNK_SIZE = 2000
BATCH_SIZE = 20


def find_files(path: str, exts: list[str]) -> list[str]:
    files = []
    skip_dirs = {".", "vendor", "node_modules", "__pycache__", "build", "out", "dist", ".git"}
    for root, dirs, filenames in os.walk(path):
        dirs[:] = [d for d in dirs if d not in skip_dirs and not d.startswith(".")]
        for f in filenames:
            if any(f.endswith(ext) for ext in exts):
                files.append(os.path.join(root, f))
    return files


def chunk_file(filepath: str, base_path: str) -> list[dict]:
    rel_path = os.path.relpath(filepath, base_path)
    try:
        with open(filepath, "r", encoding="utf-8", errors="ignore") as f:
            content = f.read()
    except Exception:
        return []

    if len(content) < 50:
        return []

    chunks = []
    lines = content.split("\n")
    current_chunk = []
    current_size = 0

    for line in lines:
        current_chunk.append(line)
        current_size += len(line) + 1
        if current_size >= MAX_CHUNK_SIZE:
            text = "\n".join(current_chunk)
            chunks.append({
                "text": text,
                "metadata": {
                    "file": rel_path,
                    "chunk_index": len(chunks),
                },
            })
            current_chunk = []
            current_size = 0

    if current_chunk:
        text = "\n".join(current_chunk)
        if len(text.strip()) > 50:
            chunks.append({
                "text": text,
                "metadata": {
                    "file": rel_path,
                    "chunk_index": len(chunks),
                },
            })

    return chunks


def ingest_batch(items: list[dict], project: str, language: str):
    for item in items:
        item["metadata"]["language"] = language

    resp = requests.post(
        f"{TOOL_API}/ingest/batch",
        json={"project": project, "type": "code", "items": items},
        timeout=120,
    )
    resp.raise_for_status()
    return resp.json()


def main():
    parser = argparse.ArgumentParser(description="소스코드를 프로젝트 벡터 DB에 인제스트")
    parser.add_argument("--project", required=True, help="프로젝트명 (예: n8n)")
    parser.add_argument("--path", required=True, help="소스코드 경로")
    parser.add_argument("--lang", required=True, choices=list(LANG_EXTS.keys()))
    args = parser.parse_args()

    exts = LANG_EXTS[args.lang]
    files = find_files(args.path, exts)
    print(f"Found {len(files)} {args.lang} files in {args.path}")

    total_chunks = 0
    batch = []

    for i, filepath in enumerate(files):
        chunks = chunk_file(filepath, args.path)
        batch.extend(chunks)

        while len(batch) >= BATCH_SIZE:
            result = ingest_batch(batch[:BATCH_SIZE], args.project, args.lang)
            total_chunks += result["count"]
            batch = batch[BATCH_SIZE:]
            print(f"  [{i+1}/{len(files)}] ingested {total_chunks} chunks...")

    if batch:
        result = ingest_batch(batch, args.project, args.lang)
        total_chunks += result["count"]

    print(f"\nDone. {total_chunks} chunks → {args.project}_code")


if __name__ == "__main__":
    main()
