#!/usr/bin/env python3
"""MCP Server — Qdrant 벡터 DB 보안 연구 도구.

Claude Desktop, Codex, Claude Code 에서 MCP 프로토콜로 벡터 검색 사용 가능.
Tool API (FastAPI)의 Qdrant 연동 로직을 직접 재사용.

Usage:
  python mcp_server.py                    # stdio 모드 (Claude Desktop / Codex)
  python mcp_server.py --port 8150        # SSE 모드 (HTTP)
"""

import os
import sys
import json
import argparse
import re
import uuid
from typing import Optional

from mcp.server import Server
from mcp.types import CallToolResult, Tool, TextContent
from mcp.server.stdio import stdio_server

# ── Qdrant + FastEmbed 직접 연결 (Tool API와 동일) ──
from fastembed import TextEmbedding
from qdrant_client import QdrantClient
from qdrant_client.models import (
    Distance,
    Filter,
    FieldCondition,
    MatchValue,
    PayloadSchemaType,
    PointStruct,
    ScoredPoint,
    VectorParams,
)

QDRANT_HOST = os.getenv("QDRANT_HOST", "localhost")
QDRANT_PORT = os.getenv("QDRANT_PORT", "6333")
QDRANT_API_KEY = os.getenv("QDRANT_API_KEY", "")
EMBEDDING_MODEL = "BAAI/bge-small-en-v1.5"
EMBEDDING_DIM = 384
VALID_TYPES = ("vuln", "code", "exploit", "bugbounty")
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

qdrant = QdrantClient(
    url=f"http://{QDRANT_HOST}:{QDRANT_PORT}",
    api_key=QDRANT_API_KEY or None,
)
embedder = TextEmbedding(model_name=EMBEDDING_MODEL)


def get_embedding(text: str) -> list[float]:
    return list(next(embedder.embed([text])))


def get_embeddings(texts: list[str]) -> list[list[float]]:
    return [list(v) for v in embedder.embed(texts)]


def scored_to_dict(p: ScoredPoint) -> dict:
    return {
        "id": str(p.id),
        "score": round(p.score, 4),
        "payload": p.payload,
    }


def collection_exists(name: str) -> bool:
    return name in {c.name for c in qdrant.get_collections().collections}


def ok_result(payload: dict) -> CallToolResult:
    return CallToolResult(
        content=[TextContent(type="text", text=json.dumps(payload, ensure_ascii=False, indent=2))],
        structuredContent=payload,
    )


def error_result(message: str) -> CallToolResult:
    return CallToolResult(
        content=[TextContent(type="text", text=message)],
        isError=True,
    )


def get_projects() -> dict[str, list[str]]:
    collections = [c.name for c in qdrant.get_collections().collections]
    projects = {}
    for name in collections:
        parts = name.rsplit("_", 1)
        if len(parts) == 2 and parts[1] in VALID_TYPES:
            projects.setdefault(parts[0], []).append(parts[1])
    return projects


def validate_project_name(project: str) -> None:
    if not re.match(r"^[a-z0-9][a-z0-9_-]*$", project):
        raise ValueError(f"invalid project name: {project}")


def ensure_collection(project: str, ctype: str) -> str:
    validate_project_name(project)
    if ctype not in VALID_TYPES:
        raise ValueError(f"invalid type: {ctype}")

    cname = f"{project}_{ctype}"
    if collection_exists(cname):
        return cname

    try:
        qdrant.create_collection(
            collection_name=cname,
            vectors_config=VectorParams(
                size=EMBEDDING_DIM,
                distance=Distance.COSINE,
            ),
        )
    except Exception:
        if not collection_exists(cname):
            raise

    for field in COLLECTION_TYPES[ctype]["indexes"]:
        try:
            qdrant.create_payload_index(
                collection_name=cname,
                field_name=field,
                field_schema=PayloadSchemaType.KEYWORD,
            )
        except Exception:
            if not collection_exists(cname):
                raise

    return cname


def do_search(project: str, ctype: str, query: str, limit: int = 5, filters: dict | None = None) -> list[dict]:
    validate_project_name(project)
    if ctype not in VALID_TYPES:
        raise ValueError(f"invalid type: {ctype}")

    cname = f"{project}_{ctype}"
    if not collection_exists(cname):
        raise ValueError(f"collection not found: {cname}")

    query_vec = get_embedding(query)

    qdrant_filter = None
    if filters:
        conditions = [
            FieldCondition(key=k, match=MatchValue(value=v))
            for k, v in filters.items()
        ]
        qdrant_filter = Filter(must=conditions)

    result = qdrant.query_points(
        collection_name=cname,
        query=query_vec,
        query_filter=qdrant_filter,
        limit=limit,
    )
    return [scored_to_dict(r) for r in result.points]


# ── MCP Server ──
server = Server("security-research-vectordb")


@server.list_tools()
async def list_tools():
    return [
        Tool(
            name="search_vuln",
            description="프로젝트 취약점 분석 결과를 벡터 검색합니다. 프로젝트: n8n, rails, django, rack, jira, confluence, meta_quest3",
            inputSchema={
                "type": "object",
                "properties": {
                    "project": {"type": "string", "description": "프로젝트명 (예: n8n, meta_quest3)"},
                    "query": {"type": "string", "description": "검색 쿼리 (자연어)"},
                    "severity": {"type": "string", "description": "severity 필터 (critical/high/medium/low)", "enum": ["critical", "high", "medium", "low"]},
                    "limit": {"type": "integer", "description": "결과 수 (기본 5)", "default": 5},
                },
                "required": ["project", "query"],
            },
        ),
        Tool(
            name="search_code",
            description="프로젝트 소스코드를 벡터 유사도로 검색합니다.",
            inputSchema={
                "type": "object",
                "properties": {
                    "project": {"type": "string", "description": "프로젝트명"},
                    "query": {"type": "string", "description": "코드 검색 쿼리"},
                    "language": {"type": "string", "description": "프로그래밍 언어 필터"},
                    "limit": {"type": "integer", "default": 5},
                },
                "required": ["project", "query"],
            },
        ),
        Tool(
            name="search_exploit",
            description="프로젝트 exploit/PoC를 벡터 검색합니다.",
            inputSchema={
                "type": "object",
                "properties": {
                    "project": {"type": "string", "description": "프로젝트명"},
                    "query": {"type": "string", "description": "exploit 검색 쿼리"},
                    "cve_id": {"type": "string", "description": "CVE ID 필터"},
                    "limit": {"type": "integer", "default": 5},
                },
                "required": ["project", "query"],
            },
        ),
        Tool(
            name="search_bugbounty",
            description="프로젝트 버그바운티 노트/리포트를 벡터 검색합니다.",
            inputSchema={
                "type": "object",
                "properties": {
                    "project": {"type": "string", "description": "프로젝트명"},
                    "query": {"type": "string", "description": "버그바운티 검색 쿼리"},
                    "severity": {"type": "string", "description": "severity 필터"},
                    "limit": {"type": "integer", "default": 5},
                },
                "required": ["project", "query"],
            },
        ),
        Tool(
            name="list_projects",
            description="등록된 프로젝트 목록과 컬렉션별 문서 수를 조회합니다.",
            inputSchema={
                "type": "object",
                "properties": {
                    "project": {"type": "string", "description": "특정 프로젝트만 조회 (생략 시 전체)"},
                },
            },
        ),
        Tool(
            name="ingest_document",
            description="단일 문서를 벡터DB에 저장합니다. 컬렉션이 없으면 자동 생성합니다.",
            inputSchema={
                "type": "object",
                "properties": {
                    "project": {"type": "string", "description": "프로젝트명"},
                    "type": {"type": "string", "description": "vuln | code | exploit | bugbounty", "enum": list(VALID_TYPES)},
                    "text": {"type": "string", "description": "임베딩할 본문 텍스트"},
                    "metadata": {"type": "object", "description": "저장할 payload 메타데이터", "default": {}},
                },
                "required": ["project", "type", "text"],
            },
        ),
        Tool(
            name="ingest_batch",
            description="여러 문서를 배치로 벡터DB에 저장합니다. 컬렉션이 없으면 자동 생성합니다.",
            inputSchema={
                "type": "object",
                "properties": {
                    "project": {"type": "string", "description": "프로젝트명"},
                    "type": {"type": "string", "description": "vuln | code | exploit | bugbounty", "enum": list(VALID_TYPES)},
                    "items": {
                        "type": "array",
                        "description": '[{"text":"...", "metadata": {...}}, ...]',
                        "items": {
                            "type": "object",
                            "properties": {
                                "text": {"type": "string"},
                                "metadata": {"type": "object", "default": {}},
                            },
                            "required": ["text"],
                        },
                    },
                },
                "required": ["project", "type", "items"],
            },
        ),
    ]


@server.call_tool()
async def call_tool(name: str, arguments: dict):
    try:
        if name == "search_vuln":
            filters = {}
            if arguments.get("severity"):
                filters["severity"] = arguments["severity"]
            results = do_search(
                arguments["project"], "vuln", arguments["query"],
                arguments.get("limit", 5), filters or None,
            )
            return ok_result({"count": len(results), "results": results})

        elif name == "search_code":
            filters = {}
            if arguments.get("language"):
                filters["language"] = arguments["language"]
            results = do_search(
                arguments["project"], "code", arguments["query"],
                arguments.get("limit", 5), filters or None,
            )
            return ok_result({"count": len(results), "results": results})

        elif name == "search_exploit":
            filters = {}
            if arguments.get("cve_id"):
                filters["cve_id"] = arguments["cve_id"]
            results = do_search(
                arguments["project"], "exploit", arguments["query"],
                arguments.get("limit", 5), filters or None,
            )
            return ok_result({"count": len(results), "results": results})

        elif name == "search_bugbounty":
            filters = {}
            if arguments.get("severity"):
                filters["severity"] = arguments["severity"]
            results = do_search(
                arguments["project"], "bugbounty", arguments["query"],
                arguments.get("limit", 5), filters or None,
            )
            return ok_result({"count": len(results), "results": results})

        elif name == "list_projects":
            projects = get_projects()
            proj_filter = arguments.get("project")
            if proj_filter:
                projects = {k: v for k, v in projects.items() if k == proj_filter}

            result = {}
            for proj, types in projects.items():
                result[proj] = {}
                for t in types:
                    info = qdrant.get_collection(f"{proj}_{t}")
                    result[proj][t] = info.points_count
            return ok_result(result)

        elif name == "ingest_document":
            project = arguments["project"]
            ctype = arguments["type"]
            text = arguments["text"]
            metadata = arguments.get("metadata") or {}
            if not isinstance(metadata, dict):
                raise ValueError("metadata must be an object")

            cname = ensure_collection(project, ctype)
            point_id = str(uuid.uuid4())
            payload = {**metadata, "text": text}
            qdrant.upsert(
                collection_name=cname,
                points=[PointStruct(id=point_id, vector=get_embedding(text), payload=payload)],
            )
            result = {
                "status": "ingested",
                "collection": cname,
                "id": point_id,
            }
            return ok_result(result)

        elif name == "ingest_batch":
            project = arguments["project"]
            ctype = arguments["type"]
            items = arguments["items"]
            if not items:
                raise ValueError("items must not be empty")
            if not all(isinstance(item, dict) for item in items):
                raise ValueError("items must be objects")

            cname = ensure_collection(project, ctype)
            texts = [item["text"] for item in items]
            vectors = get_embeddings(texts)
            points = []
            ids = []
            for idx, item in enumerate(items):
                point_id = str(uuid.uuid4())
                ids.append(point_id)
                metadata = item.get("metadata") or {}
                if not isinstance(metadata, dict):
                    raise ValueError("item metadata must be an object")
                payload = {**metadata, "text": item["text"]}
                points.append(PointStruct(id=point_id, vector=vectors[idx], payload=payload))

            qdrant.upsert(collection_name=cname, points=points)
            result = {
                "status": "ingested",
                "collection": cname,
                "count": len(points),
                "ids": ids,
            }
            return ok_result(result)

        else:
            return error_result(f"Unknown tool: {name}")

    except Exception as e:
        return error_result(str(e))


async def main():
    async with stdio_server() as (read_stream, write_stream):
        await server.run(read_stream, write_stream, server.create_initialization_options())


if __name__ == "__main__":
    import asyncio
    asyncio.run(main())
