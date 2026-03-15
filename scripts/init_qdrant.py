#!/usr/bin/env python3
"""Qdrant 프로젝트별 컬렉션 초기화 스크립트.

사용법:
    python init_qdrant.py --project n8n          # n8n 프로젝트 컬렉션 4개 생성
    python init_qdrant.py --project chromium      # chromium 프로젝트 컬렉션 4개 생성
    python init_qdrant.py --list                  # 등록된 프로젝트/컬렉션 조회
"""

import argparse
import os
import re
from qdrant_client import QdrantClient
from qdrant_client.models import (
    Distance,
    VectorParams,
    PayloadSchemaType,
)

QDRANT_HOST = os.getenv("QDRANT_HOST", "localhost")
QDRANT_PORT = int(os.getenv("QDRANT_PORT", "6333"))
QDRANT_API_KEY = os.getenv("QDRANT_API_KEY")

EMBEDDING_DIM = 384  # BAAI/bge-small-en-v1.5 (FastEmbed 로컬)

# 프로젝트당 생성되는 컬렉션 타입 4개
COLLECTION_TYPES = {
    "vuln": {
        "description": "취약점 분석, CVE, advisory, patch diff",
        "indexes": ["cve_id", "severity", "type", "source"],
    },
    "code": {
        "description": "소스코드 chunk 임베딩 (함수/클래스 단위)",
        "indexes": ["file", "language", "function_name"],
    },
    "exploit": {
        "description": "exploit 코드, PoC, payload",
        "indexes": ["target", "type", "cve_id", "platform"],
    },
    "bugbounty": {
        "description": "버그바운티 노트, 리포트, writeup",
        "indexes": ["program", "severity", "status", "type"],
    },
}


def get_client():
    return QdrantClient(
        url=f"http://{QDRANT_HOST}:{QDRANT_PORT}",
        api_key=QDRANT_API_KEY,
    )


def create_project(client, project: str):
    existing = {c.name for c in client.get_collections().collections}

    for ctype, config in COLLECTION_TYPES.items():
        name = f"{project}_{ctype}"
        if name in existing:
            print(f"[skip] {name} already exists")
            continue

        client.create_collection(
            collection_name=name,
            vectors_config=VectorParams(
                size=EMBEDDING_DIM,
                distance=Distance.COSINE,
            ),
        )

        for field in config["indexes"]:
            client.create_payload_index(
                collection_name=name,
                field_name=field,
                field_schema=PayloadSchemaType.KEYWORD,
            )

        print(f"[created] {name} — {config['description']}")


def list_projects(client):
    collections = sorted(c.name for c in client.get_collections().collections)
    if not collections:
        print("No collections found.")
        return

    # 프로젝트별 그룹핑
    projects = {}
    for name in collections:
        parts = name.rsplit("_", 1)
        if len(parts) == 2 and parts[1] in COLLECTION_TYPES:
            projects.setdefault(parts[0], []).append(parts[1])
        else:
            projects.setdefault("_other", []).append(name)

    print("=== Registered Projects ===")
    for proj, types in sorted(projects.items()):
        if proj == "_other":
            continue
        info_parts = []
        for t in types:
            cname = f"{proj}_{t}"
            cinfo = client.get_collection(cname)
            info_parts.append(f"{t}({cinfo.points_count})")
        print(f"  {proj}: {', '.join(info_parts)}")

    if "_other" in projects:
        print("\n=== Other Collections ===")
        for name in projects["_other"]:
            print(f"  {name}")


def main():
    parser = argparse.ArgumentParser(description="프로젝트별 Qdrant 컬렉션 관리")
    parser.add_argument("--project", help="프로젝트명 (예: n8n, chromium)")
    parser.add_argument("--list", action="store_true", help="등록된 프로젝트 목록 조회")
    args = parser.parse_args()

    client = get_client()

    if args.list:
        list_projects(client)
    elif args.project:
        if not re.match(r"^[a-z0-9][a-z0-9_-]*$", args.project):
            print(f"Error: project name must be lowercase alphanumeric (got: {args.project})")
            return
        create_project(client, args.project)
        print(f"\nProject '{args.project}' ready.")
    else:
        parser.print_help()


if __name__ == "__main__":
    main()
