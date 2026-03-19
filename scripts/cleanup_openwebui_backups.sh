#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${0}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"

BACKUP_DIR="${OPENWEBUI_BACKUP_DIR:-$REPO_ROOT/backups/open-webui}"
RETENTION_DAYS="${OPENWEBUI_BACKUP_RETENTION_DAYS:-7}"
LOG_FILE="${OPENWEBUI_BACKUP_CLEANUP_LOG:-$REPO_ROOT/logs/openwebui-backup-cleanup.log}"

mkdir -p "$(dirname "$LOG_FILE")"

timestamp="$(date '+%Y-%m-%d %H:%M:%S %Z')"

if [[ ! -d "$BACKUP_DIR" ]]; then
  printf '[%s] skip: backup dir missing: %s\n' "$timestamp" "$BACKUP_DIR" >> "$LOG_FILE"
  exit 0
fi

deleted=0

while IFS= read -r file; do
  [[ -n "$file" ]] || continue
  rm -f -- "$file"
  deleted=$((deleted + 1))
  printf '[%s] deleted: %s\n' "$timestamp" "$file" >> "$LOG_FILE"
done < <(
  find "$BACKUP_DIR" -type f -name 'webui-*.db' -mtime +"$RETENTION_DAYS" -print | sort
)

printf '[%s] complete: retention_days=%s deleted=%s dir=%s\n' \
  "$timestamp" "$RETENTION_DAYS" "$deleted" "$BACKUP_DIR" >> "$LOG_FILE"
