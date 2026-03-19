#!/usr/bin/env python3
"""CLI for the local security research vector database."""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import uuid
import warnings
from pathlib import Path
from typing import Any

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

warnings.filterwarnings(
    "ignore",
    message="Api key is used with an insecure connection.",
)

VALID_TYPES = ("vuln", "code", "exploit", "bugbounty")
COLLECTION_TYPES = {
    "vuln": ["cve_id", "severity", "type", "source"],
    "code": ["file", "language", "function_name"],
    "exploit": ["target", "type", "cve_id", "platform"],
    "bugbounty": ["program", "severity", "status", "type"],
}
EMBEDDING_MODEL = "BAAI/bge-small-en-v1.5"
EMBEDDING_DIM = 384

QDRANT_HOST = os.getenv("QDRANT_HOST", "localhost")
QDRANT_PORT = os.getenv("QDRANT_PORT", "6333")
QDRANT_API_KEY = os.getenv("QDRANT_API_KEY") or None

qdrant = QdrantClient(
    url=f"http://{QDRANT_HOST}:{QDRANT_PORT}",
    api_key=QDRANT_API_KEY,
)
embedder = TextEmbedding(model_name=EMBEDDING_MODEL)


def fail(message: str, code: int = 1) -> int:
    print(message, file=sys.stderr)
    return code


def emit(data: dict[str, Any]) -> int:
    print(json.dumps(data, ensure_ascii=False, indent=2))
    return 0


def validate_project_name(project: str) -> None:
    if not re.match(r"^[a-z0-9][a-z0-9_-]*$", project):
        raise ValueError(f"invalid project name: {project}")


def collection_exists(name: str) -> bool:
    return name in {c.name for c in qdrant.get_collections().collections}


def collection_name(project: str, ctype: str) -> str:
    validate_project_name(project)
    if ctype not in VALID_TYPES:
        raise ValueError(f"invalid type: {ctype}")
    return f"{project}_{ctype}"


def ensure_collection(project: str, ctype: str) -> str:
    cname = collection_name(project, ctype)
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

    for field in COLLECTION_TYPES[ctype]:
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


def get_embedding(text: str) -> list[float]:
    return list(next(embedder.embed([text])))


def get_embeddings(texts: list[str]) -> list[list[float]]:
    return [list(v) for v in embedder.embed(texts)]


def scored_to_dict(point: ScoredPoint) -> dict[str, Any]:
    return {
        "id": str(point.id),
        "score": round(point.score, 4),
        "payload": point.payload,
    }


def get_projects() -> dict[str, list[str]]:
    projects: dict[str, list[str]] = {}
    for item in qdrant.get_collections().collections:
        parts = item.name.rsplit("_", 1)
        if len(parts) == 2 and parts[1] in VALID_TYPES:
            projects.setdefault(parts[0], []).append(parts[1])
    return projects


def list_projects(args: argparse.Namespace) -> int:
    projects = get_projects()
    result: dict[str, dict[str, int]] = {}
    selected = [args.project] if args.project else sorted(projects)

    for project in selected:
        if project not in projects:
            continue
        result[project] = {}
        for ctype in sorted(projects[project]):
            info = qdrant.get_collection(collection_name(project, ctype))
            result[project][ctype] = info.points_count or 0

    return emit(result if not args.project else {args.project: result.get(args.project, {})})


def parse_filter_pairs(pairs: list[str] | None) -> dict[str, str] | None:
    if not pairs:
        return None
    filters: dict[str, str] = {}
    for pair in pairs:
        if "=" not in pair:
            raise ValueError(f"invalid filter: {pair} (expected key=value)")
        key, value = pair.split("=", 1)
        key = key.strip()
        value = value.strip()
        if not key:
            raise ValueError(f"invalid filter key in: {pair}")
        filters[key] = value
    return filters or None


def do_search(project: str, ctype: str, query: str, limit: int, filters: dict[str, str] | None) -> dict[str, Any]:
    cname = collection_name(project, ctype)
    if not collection_exists(cname):
        raise ValueError(f"collection not found: {cname}")

    qdrant_filter = None
    if filters:
        qdrant_filter = Filter(
            must=[FieldCondition(key=key, match=MatchValue(value=value)) for key, value in filters.items()]
        )

    result = qdrant.query_points(
        collection_name=cname,
        query=get_embedding(query),
        query_filter=qdrant_filter,
        limit=limit,
    )

    return {
        "query": query,
        "project": project,
        "type": ctype,
        "count": len(result.points),
        "results": [scored_to_dict(point) for point in result.points],
    }


def search(args: argparse.Namespace) -> int:
    filters = parse_filter_pairs(args.filter)
    return emit(do_search(args.project, args.type, args.query, args.limit, filters))


def search_vuln(args: argparse.Namespace) -> int:
    filters = {}
    if args.severity:
        filters["severity"] = args.severity
    return emit(do_search(args.project, "vuln", args.query, args.limit, filters or None))


def search_code(args: argparse.Namespace) -> int:
    filters = {}
    if args.language:
        filters["language"] = args.language
    return emit(do_search(args.project, "code", args.query, args.limit, filters or None))


def search_exploit(args: argparse.Namespace) -> int:
    filters = {}
    if args.cve_id:
        filters["cve_id"] = args.cve_id
    return emit(do_search(args.project, "exploit", args.query, args.limit, filters or None))


def search_bugbounty(args: argparse.Namespace) -> int:
    filters = {}
    if args.severity:
        filters["severity"] = args.severity
    return emit(do_search(args.project, "bugbounty", args.query, args.limit, filters or None))


def load_json_file(path: str) -> Any:
    return json.loads(Path(path).read_text(encoding="utf-8"))


def load_metadata(args: argparse.Namespace) -> dict[str, Any]:
    if args.metadata_json and args.metadata_file:
        raise ValueError("use either --metadata-json or --metadata-file")
    if args.metadata_file:
        data = load_json_file(args.metadata_file)
    elif args.metadata_json:
        data = json.loads(args.metadata_json)
    else:
        data = {}

    if not isinstance(data, dict):
        raise ValueError("metadata must be a JSON object")
    return data


def load_text(args: argparse.Namespace) -> str:
    candidates = [
        bool(args.text),
        bool(args.text_file),
        bool(args.stdin),
    ]
    if sum(candidates) != 1:
        raise ValueError("use exactly one of --text, --text-file, or --stdin")
    if args.text:
        return args.text
    if args.text_file:
        return Path(args.text_file).read_text(encoding="utf-8")
    return sys.stdin.read()


def ingest_document(args: argparse.Namespace) -> int:
    text = load_text(args)
    metadata = load_metadata(args)
    cname = ensure_collection(args.project, args.type)
    point_id = str(uuid.uuid4())

    qdrant.upsert(
        collection_name=cname,
        points=[
            PointStruct(
                id=point_id,
                vector=get_embedding(text),
                payload={**metadata, "text": text},
            )
        ],
    )

    return emit(
        {
            "id": point_id,
            "project": args.project,
            "type": args.type,
            "collection": cname,
            "status": "ingested",
        }
    )


def ingest_batch(args: argparse.Namespace) -> int:
    raw = load_json_file(args.items_file)
    items = raw.get("items") if isinstance(raw, dict) else raw
    if not isinstance(items, list) or not items:
        raise ValueError("items file must contain a non-empty JSON array or {\"items\": [...]}")

    normalized: list[dict[str, Any]] = []
    for index, item in enumerate(items, start=1):
        if not isinstance(item, dict):
            raise ValueError(f"item #{index} must be an object")
        text = item.get("text")
        metadata = item.get("metadata", {})
        if not isinstance(text, str) or not text.strip():
            raise ValueError(f"item #{index} is missing non-empty text")
        if not isinstance(metadata, dict):
            raise ValueError(f"item #{index} metadata must be an object")
        normalized.append({"text": text, "metadata": metadata})

    cname = ensure_collection(args.project, args.type)
    vectors = get_embeddings([item["text"] for item in normalized])
    points = []
    for index, item in enumerate(normalized):
        points.append(
            PointStruct(
                id=str(uuid.uuid4()),
                vector=vectors[index],
                payload={**item["metadata"], "text": item["text"]},
            )
        )

    qdrant.upsert(collection_name=cname, points=points)

    return emit(
        {
            "project": args.project,
            "type": args.type,
            "collection": cname,
            "count": len(points),
            "status": "ingested",
        }
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="security-vectordb", description="Local Qdrant security research CLI")
    subparsers = parser.add_subparsers(dest="command", required=True)

    list_cmd = subparsers.add_parser("list-projects", help="List registered projects and point counts")
    list_cmd.add_argument("--project", help="Filter to a single project")
    list_cmd.set_defaults(func=list_projects)

    search_cmd = subparsers.add_parser("search", help="Generic vector search")
    search_cmd.add_argument("--project", required=True)
    search_cmd.add_argument("--type", required=True, choices=VALID_TYPES)
    search_cmd.add_argument("--query", required=True)
    search_cmd.add_argument("--limit", type=int, default=5)
    search_cmd.add_argument("--filter", action="append", help="Filter in key=value form")
    search_cmd.set_defaults(func=search)

    vuln_cmd = subparsers.add_parser("search-vuln", help="Search vuln collection")
    vuln_cmd.add_argument("--project", required=True)
    vuln_cmd.add_argument("--query", required=True)
    vuln_cmd.add_argument("--severity", choices=["critical", "high", "medium", "low"])
    vuln_cmd.add_argument("--limit", type=int, default=5)
    vuln_cmd.set_defaults(func=search_vuln)

    code_cmd = subparsers.add_parser("search-code", help="Search code collection")
    code_cmd.add_argument("--project", required=True)
    code_cmd.add_argument("--query", required=True)
    code_cmd.add_argument("--language")
    code_cmd.add_argument("--limit", type=int, default=5)
    code_cmd.set_defaults(func=search_code)

    exploit_cmd = subparsers.add_parser("search-exploit", help="Search exploit collection")
    exploit_cmd.add_argument("--project", required=True)
    exploit_cmd.add_argument("--query", required=True)
    exploit_cmd.add_argument("--cve-id")
    exploit_cmd.add_argument("--limit", type=int, default=5)
    exploit_cmd.set_defaults(func=search_exploit)

    bounty_cmd = subparsers.add_parser("search-bugbounty", help="Search bugbounty collection")
    bounty_cmd.add_argument("--project", required=True)
    bounty_cmd.add_argument("--query", required=True)
    bounty_cmd.add_argument("--severity")
    bounty_cmd.add_argument("--limit", type=int, default=5)
    bounty_cmd.set_defaults(func=search_bugbounty)

    ingest_doc = subparsers.add_parser("ingest-document", help="Ingest a single document")
    ingest_doc.add_argument("--project", required=True)
    ingest_doc.add_argument("--type", required=True, choices=VALID_TYPES)
    ingest_doc.add_argument("--text")
    ingest_doc.add_argument("--text-file")
    ingest_doc.add_argument("--stdin", action="store_true", help="Read document text from stdin")
    ingest_doc.add_argument("--metadata-json")
    ingest_doc.add_argument("--metadata-file")
    ingest_doc.set_defaults(func=ingest_document)

    ingest_batch_cmd = subparsers.add_parser("ingest-batch", help="Ingest documents from a JSON file")
    ingest_batch_cmd.add_argument("--project", required=True)
    ingest_batch_cmd.add_argument("--type", required=True, choices=VALID_TYPES)
    ingest_batch_cmd.add_argument("--items-file", required=True, help="JSON array or {\"items\": [...]}")
    ingest_batch_cmd.set_defaults(func=ingest_batch)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return args.func(args)
    except KeyboardInterrupt:
        return fail("interrupted", 130)
    except Exception as exc:
        return fail(f"error: {exc}")


if __name__ == "__main__":
    raise SystemExit(main())
