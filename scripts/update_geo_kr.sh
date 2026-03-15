#!/bin/bash
# 한국 IP 대역 자동 업데이트 (ipdeny.com 기반)
# crontab: 0 3 * * 0 /path/to/update_geo_kr.sh
set -euo pipefail

CONF_DIR="/opt/homebrew/etc/nginx/conf.d"
TMP="/tmp/kr_cidrs.txt"

echo "[$(date)] Updating Korean IP geo blocks..."

curl -sfL "https://www.ipdeny.com/ipblocks/data/countries/kr.zone" -o "$TMP"
COUNT=$(wc -l < "$TMP")

if [ "$COUNT" -lt 100 ]; then
    echo "Error: Only $COUNT CIDRs downloaded, aborting (expected 2000+)"
    exit 1
fi

{
    echo "# Korean IP ranges — auto-generated from ipdeny.com"
    echo "# Updated: $(date +%Y-%m-%d)"
    echo "# Total: $COUNT CIDR blocks"
    echo ""
    echo "geo \$is_korean {"
    echo "    default 0;"
    echo ""
    echo "    # Loopback / Private"
    echo "    127.0.0.0/8 1;"
    echo "    10.0.0.0/8 1;"
    echo "    172.16.0.0/12 1;"
    echo "    192.168.0.0/16 1;"
    echo ""
    echo "    # South Korea (KR)"
    while read -r cidr; do
        [ -n "$cidr" ] && echo "    $cidr 1;"
    done < "$TMP"
    echo "}"
} > "$CONF_DIR/geo-kr.conf"

# nginx 설정 테스트 후 리로드
if nginx -t 2>/dev/null; then
    nginx -s reload
    echo "[$(date)] Updated: $COUNT Korean CIDR blocks, nginx reloaded"
else
    echo "Error: nginx config test failed"
    exit 1
fi
