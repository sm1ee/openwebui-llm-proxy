"""OpenWebUI Tool 정의 — 프로젝트 기반 보안 연구 벡터 검색 도구.

OpenWebUI Admin > Tools 에서 이 파일의 내용을 붙여넣어 등록한다.
Tool API 서버(http://tool-api:8000)와 통신한다.
"""

import json
import requests
from pydantic import BaseModel, Field
from typing import Optional


class Tools:
    class Valves(BaseModel):
        tool_api_url: str = Field(
            default="http://tool-api:8000",
            description="Tool API 서버 URL",
        )

    def __init__(self):
        self.valves = self.Valves()

    def _api(self, path: str, params: dict) -> str:
        url = f"{self.valves.tool_api_url}{path}"
        resp = requests.get(url, params=params, timeout=30)
        resp.raise_for_status()
        data = resp.json()
        results = data.get("results", [])
        if not results:
            return "검색 결과 없음"

        lines = []
        for r in results:
            p = r.get("payload", {})
            score = r.get("score", 0)
            summary = p.get("text", p.get("summary", ""))[:200]
            meta = {k: v for k, v in p.items() if k != "text"}
            lines.append(
                f"[score: {score}] {summary}\n  metadata: {json.dumps(meta, ensure_ascii=False)}"
            )
        return "\n\n".join(lines)

    def search_vuln(
        self,
        project: str,
        query: str,
        severity: Optional[str] = None,
    ) -> str:
        """프로젝트의 취약점 분석 결과를 벡터 검색합니다.
        :param project: 프로젝트명 (예: n8n, chromium, keycloak)
        :param query: 검색 쿼리 (자연어)
        :param severity: 심각도 필터 (critical, high, medium, low)
        :return: 관련 취약점 분석 결과
        """
        params = {"project": project, "query": query, "limit": 5}
        if severity:
            params["severity"] = severity
        return self._api("/tools/search_vuln", params)

    def search_code(
        self,
        project: str,
        query: str,
        language: Optional[str] = None,
    ) -> str:
        """프로젝트의 소스코드를 의미 기반으로 검색합니다.
        :param project: 프로젝트명
        :param query: 코드 검색 쿼리 (자연어, 함수명, 패턴 등)
        :param language: 프로그래밍 언어 필터
        :return: 관련 소스코드 조각
        """
        params = {"project": project, "query": query, "limit": 5}
        if language:
            params["language"] = language
        return self._api("/tools/search_code", params)

    def search_exploit(
        self,
        project: str,
        query: str,
        cve_id: Optional[str] = None,
    ) -> str:
        """프로젝트의 exploit/PoC 코드를 검색합니다.
        :param project: 프로젝트명
        :param query: exploit 검색 쿼리
        :param cve_id: CVE ID 필터
        :return: 관련 exploit/PoC 정보
        """
        params = {"project": project, "query": query, "limit": 5}
        if cve_id:
            params["cve_id"] = cve_id
        return self._api("/tools/search_exploit", params)

    def search_bugbounty(
        self,
        project: str,
        query: str,
        severity: Optional[str] = None,
    ) -> str:
        """프로젝트의 버그바운티 노트/리포트를 검색합니다.
        :param project: 프로젝트명
        :param query: 검색 쿼리
        :param severity: 심각도 필터
        :return: 관련 버그바운티 리포트
        """
        params = {"project": project, "query": query, "limit": 5}
        if severity:
            params["severity"] = severity
        return self._api("/tools/search_bugbounty", params)

    def list_projects(self) -> str:
        """등록된 프로젝트 목록과 각 컬렉션의 문서 수를 조회합니다.
        :return: 프로젝트별 통계
        """
        url = f"{self.valves.tool_api_url}/projects"
        resp = requests.get(url, timeout=10)
        resp.raise_for_status()
        data = resp.json()
        if not data:
            return "등록된 프로젝트 없음"
        lines = []
        for proj, types in data.items():
            parts = [f"{t}: {count}" for t, count in types.items()]
            lines.append(f"  {proj} — {', '.join(parts)}")
        return "Projects:\n" + "\n".join(lines)
