#!/bin/bash
# 기존 audit/ 디렉토리의 분석 결과를 프로젝트별로 벡터 DB에 인제스트
set -euo pipefail

WORKSPACE="${WORKSPACE:-$(cd "$(dirname "$0")/../.." && pwd)}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

export TOOL_API_URL="http://localhost:8100"

echo "=== 기존 감사 결과 프로젝트별 인제스트 ==="

# 1. 프로젝트 컬렉션 생성
echo ""
echo "--- 프로젝트 컬렉션 생성 ---"
for proj in keycloak kops kubelet pdfjs apisix; do
    python3 "$SCRIPT_DIR/init_qdrant.py" --project "$proj"
done

# 2. 프로젝트별 취약점 인제스트
if [ -d "$WORKSPACE/audit/keycloak" ]; then
    echo ""
    echo "--- keycloak ---"
    python3 "$SCRIPT_DIR/ingest_vuln.py" --project keycloak --dir "$WORKSPACE/audit/keycloak"
fi

if [ -d "$WORKSPACE/audit/kops" ]; then
    echo ""
    echo "--- kops ---"
    python3 "$SCRIPT_DIR/ingest_vuln.py" --project kops --dir "$WORKSPACE/audit/kops"
fi

if [ -d "$WORKSPACE/audit/kubelet" ]; then
    echo ""
    echo "--- kubelet ---"
    python3 "$SCRIPT_DIR/ingest_vuln.py" --project kubelet --dir "$WORKSPACE/audit/kubelet"
fi

if [ -d "$WORKSPACE/audit/pdfjs" ]; then
    echo ""
    echo "--- pdfjs ---"
    python3 "$SCRIPT_DIR/ingest_vuln.py" --project pdfjs --dir "$WORKSPACE/audit/pdfjs"
fi

# audit/ 루트의 apisix 관련 파일
if ls "$WORKSPACE/audit"/apisix*.md 1>/dev/null 2>&1; then
    echo ""
    echo "--- apisix ---"
    for f in "$WORKSPACE/audit"/apisix*.md; do
        python3 "$SCRIPT_DIR/ingest_vuln.py" --project apisix --file "$f"
    done
fi

echo ""
echo "=== 인제스트 완료 ==="
python3 "$SCRIPT_DIR/init_qdrant.py" --list
