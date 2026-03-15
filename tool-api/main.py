"""Tool / Skill API — 보안 연구용 벡터 검색 및 데이터 관리 API.

프로젝트 기반 컬렉션 구조:
  {project}_vuln, {project}_code, {project}_exploit, {project}_bugbounty

FastEmbed 내장 — 외부 API 키 불필요.
"""

import os
import uuid
from typing import Optional

from fastembed import TextEmbedding
from fastapi import FastAPI, HTTPException, Query
from pydantic import BaseModel, Field
from qdrant_client import QdrantClient
from qdrant_client.models import (
    Filter,
    FieldCondition,
    MatchValue,
    PointStruct,
    ScoredPoint,
)

app = FastAPI(title="AI Security Research Tool API", version="2.0.0")

# ── Clients ──
_qdrant_host = os.getenv("QDRANT_HOST", "localhost")
_qdrant_port = os.getenv("QDRANT_PORT", "6333")
qdrant = QdrantClient(
    url=f"http://{_qdrant_host}:{_qdrant_port}",
    api_key=os.getenv("QDRANT_API_KEY"),
)

# 로컬 임베딩 모델 (API 키 불필요)
EMBEDDING_MODEL_NAME = "BAAI/bge-small-en-v1.5"
EMBEDDING_DIM = 384
embedder = TextEmbedding(model_name=EMBEDDING_MODEL_NAME)

VALID_TYPES = ("vuln", "code", "exploit", "bugbounty")


# ── Helpers ──
def collection_name(project: str, ctype: str) -> str:
    if ctype not in VALID_TYPES:
        raise HTTPException(400, f"Invalid type: {ctype}. Must be one of {VALID_TYPES}")
    return f"{project}_{ctype}"


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


def get_projects() -> dict[str, list[str]]:
    collections = [c.name for c in qdrant.get_collections().collections]
    projects = {}
    for name in collections:
        parts = name.rsplit("_", 1)
        if len(parts) == 2 and parts[1] in VALID_TYPES:
            projects.setdefault(parts[0], []).append(parts[1])
    return projects


# ── Models ──
class SearchRequest(BaseModel):
    query: str = Field(..., description="검색 쿼리 (자연어)")
    project: str = Field(..., description="프로젝트명 (예: n8n, chromium)")
    type: str = Field(..., description="vuln | code | exploit | bugbounty")
    limit: int = Field(10, ge=1, le=50)
    filters: Optional[dict] = Field(None, description="payload 필터")


class IngestRequest(BaseModel):
    project: str
    type: str = Field(..., description="vuln | code | exploit | bugbounty")
    text: str = Field(..., description="임베딩할 텍스트")
    metadata: dict = Field(..., description="payload 메타데이터")


class IngestBatchRequest(BaseModel):
    project: str
    type: str = Field(..., description="vuln | code | exploit | bugbounty")
    items: list[dict] = Field(
        ..., description='[{"text": "...", "metadata": {...}}, ...]'
    )


# ── Endpoints ──

@app.get("/health")
def health():
    collections = [c.name for c in qdrant.get_collections().collections]
    return {"status": "ok", "embedding_model": EMBEDDING_MODEL_NAME, "collections": collections}


@app.get("/projects")
def list_projects():
    """등록된 프로젝트 목록 및 컬렉션별 문서 수"""
    projects = get_projects()
    result = {}
    for proj, types in projects.items():
        result[proj] = {}
        for t in types:
            info = qdrant.get_collection(f"{proj}_{t}")
            result[proj][t] = info.points_count
    return result


@app.post("/search")
def search(req: SearchRequest):
    """벡터 유사도 검색."""
    cname = collection_name(req.project, req.type)
    query_vec = get_embedding(req.query)

    qdrant_filter = None
    if req.filters:
        conditions = [
            FieldCondition(key=k, match=MatchValue(value=v))
            for k, v in req.filters.items()
        ]
        qdrant_filter = Filter(must=conditions)

    results = qdrant.search(
        collection_name=cname,
        query_vector=query_vec,
        query_filter=qdrant_filter,
        limit=req.limit,
    )

    return {
        "query": req.query,
        "project": req.project,
        "type": req.type,
        "count": len(results),
        "results": [scored_to_dict(r) for r in results],
    }


@app.post("/ingest")
def ingest(req: IngestRequest):
    """단일 문서 인제스트."""
    cname = collection_name(req.project, req.type)
    vec = get_embedding(req.text)
    point_id = str(uuid.uuid4())
    payload = {**req.metadata, "text": req.text}

    qdrant.upsert(
        collection_name=cname,
        points=[PointStruct(id=point_id, vector=vec, payload=payload)],
    )

    return {"id": point_id, "project": req.project, "type": req.type, "status": "ingested"}


@app.post("/ingest/batch")
def ingest_batch(req: IngestBatchRequest):
    """배치 인제스트."""
    cname = collection_name(req.project, req.type)
    texts = [item["text"] for item in req.items]
    vecs = get_embeddings(texts)

    points = []
    for i, item in enumerate(req.items):
        point_id = str(uuid.uuid4())
        payload = {**item["metadata"], "text": item["text"]}
        points.append(
            PointStruct(id=point_id, vector=vecs[i], payload=payload)
        )

    qdrant.upsert(collection_name=cname, points=points)

    return {
        "project": req.project,
        "type": req.type,
        "count": len(points),
        "status": "ingested",
    }


# ── 보안 연구 전용 Tool 함수들 (OpenWebUI Function Calling 호환) ──

@app.get("/tools/search_vuln")
def search_vuln(
    project: str = Query(..., description="프로젝트명 (예: n8n)"),
    query: str = Query(..., description="취약점 검색 쿼리"),
    severity: Optional[str] = Query(None, description="critical|high|medium|low"),
    limit: int = Query(5, ge=1, le=20),
):
    """프로젝트 취약점 분석 결과 검색"""
    filters = {}
    if severity:
        filters["severity"] = severity

    return search(
        SearchRequest(
            query=query, project=project, type="vuln",
            limit=limit, filters=filters or None,
        )
    )


@app.get("/tools/search_code")
def search_code(
    project: str = Query(..., description="프로젝트명"),
    query: str = Query(..., description="코드 검색 쿼리"),
    language: Optional[str] = Query(None, description="프로그래밍 언어"),
    limit: int = Query(5, ge=1, le=20),
):
    """프로젝트 소스코드 유사 검색"""
    filters = {}
    if language:
        filters["language"] = language

    return search(
        SearchRequest(
            query=query, project=project, type="code",
            limit=limit, filters=filters or None,
        )
    )


@app.get("/tools/search_exploit")
def search_exploit(
    project: str = Query(..., description="프로젝트명"),
    query: str = Query(..., description="exploit 검색 쿼리"),
    cve_id: Optional[str] = Query(None, description="CVE ID"),
    limit: int = Query(5, ge=1, le=20),
):
    """프로젝트 exploit / PoC 검색"""
    filters = {}
    if cve_id:
        filters["cve_id"] = cve_id

    return search(
        SearchRequest(
            query=query, project=project, type="exploit",
            limit=limit, filters=filters or None,
        )
    )


@app.get("/tools/search_bugbounty")
def search_bugbounty(
    project: str = Query(..., description="프로젝트명"),
    query: str = Query(..., description="버그바운티 노트 검색"),
    severity: Optional[str] = Query(None, description="severity"),
    limit: int = Query(5, ge=1, le=20),
):
    """프로젝트 버그바운티 노트/리포트 검색"""
    filters = {}
    if severity:
        filters["severity"] = severity

    return search(
        SearchRequest(
            query=query, project=project, type="bugbounty",
            limit=limit, filters=filters or None,
        )
    )


@app.get("/tools/stats")
def collection_stats(
    project: Optional[str] = Query(None, description="특정 프로젝트만 조회 (생략 시 전체)"),
):
    """프로젝트별 컬렉션 통계"""
    all_projects = get_projects()
    if project:
        if project not in all_projects:
            raise HTTPException(404, f"Project '{project}' not found")
        all_projects = {project: all_projects[project]}

    result = {}
    for proj, types in all_projects.items():
        result[proj] = {}
        for t in types:
            info = qdrant.get_collection(f"{proj}_{t}")
            result[proj][t] = {
                "points": info.points_count,
                "vectors": info.vectors_count,
            }
    return result
