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
from typing import Optional

from mcp.server import Server
from mcp.types import Tool, TextContent
from mcp.server.stdio import stdio_server

# ── Qdrant + FastEmbed 직접 연결 (Tool API와 동일) ──
from fastembed import TextEmbedding
from qdrant_client import QdrantClient
from qdrant_client.models import (
    Filter,
    FieldCondition,
    MatchValue,
    ScoredPoint,
)

QDRANT_HOST = os.getenv("QDRANT_HOST", "localhost")
QDRANT_PORT = os.getenv("QDRANT_PORT", "6333")
QDRANT_API_KEY = os.getenv("QDRANT_API_KEY", "")
EMBEDDING_MODEL = "BAAI/bge-small-en-v1.5"
VALID_TYPES = ("vuln", "code", "exploit", "bugbounty")

qdrant = QdrantClient(
    url=f"http://{QDRANT_HOST}:{QDRANT_PORT}",
    api_key=QDRANT_API_KEY or None,
)
embedder = TextEmbedding(model_name=EMBEDDING_MODEL)


def get_embedding(text: str) -> list[float]:
    return list(next(embedder.embed([text])))


def scored_to_dict(p: ScoredPoint) -> dict:
    return {
        "id": str(p.id),
        "score": round(p.score, 4),
        "payload": p.payload,
    }


def get_projects() -> dict[str, list[str]]:
    collections = [c.name for c in qdrant.get_collections().collections]
    projects = {}
    for name in collections:
        parts = name.rsplit("_", 1)
        if len(parts) == 2 and parts[1] in VALID_TYPES:
            projects.setdefault(parts[0], []).append(parts[1])
    return projects


def do_search(project: str, ctype: str, query: str, limit: int = 5, filters: dict | None = None) -> list[dict]:
    cname = f"{project}_{ctype}"
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
            return [TextContent(type="text", text=json.dumps({"count": len(results), "results": results}, ensure_ascii=False, indent=2))]

        elif name == "search_code":
            filters = {}
            if arguments.get("language"):
                filters["language"] = arguments["language"]
            results = do_search(
                arguments["project"], "code", arguments["query"],
                arguments.get("limit", 5), filters or None,
            )
            return [TextContent(type="text", text=json.dumps({"count": len(results), "results": results}, ensure_ascii=False, indent=2))]

        elif name == "search_exploit":
            filters = {}
            if arguments.get("cve_id"):
                filters["cve_id"] = arguments["cve_id"]
            results = do_search(
                arguments["project"], "exploit", arguments["query"],
                arguments.get("limit", 5), filters or None,
            )
            return [TextContent(type="text", text=json.dumps({"count": len(results), "results": results}, ensure_ascii=False, indent=2))]

        elif name == "search_bugbounty":
            filters = {}
            if arguments.get("severity"):
                filters["severity"] = arguments["severity"]
            results = do_search(
                arguments["project"], "bugbounty", arguments["query"],
                arguments.get("limit", 5), filters or None,
            )
            return [TextContent(type="text", text=json.dumps({"count": len(results), "results": results}, ensure_ascii=False, indent=2))]

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
            return [TextContent(type="text", text=json.dumps(result, ensure_ascii=False, indent=2))]

        else:
            return [TextContent(type="text", text=f"Unknown tool: {name}")]

    except Exception as e:
        return [TextContent(type="text", text=f"Error: {str(e)}")]


async def main():
    async with stdio_server() as (read_stream, write_stream):
        await server.run(read_stream, write_stream, server.create_initialization_options())


if __name__ == "__main__":
    import asyncio
    asyncio.run(main())
