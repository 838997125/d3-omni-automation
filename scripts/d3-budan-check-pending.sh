#!/usr/bin/env bash
# d3-budan-check-pending.sh — 轻量检查钉钉补单表是否有待处理记录
# 由 cron trigger 调用，不启动 LLM，返回 {fire:true/false} JSON
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/lib-config.sh"
ATABLE_BASE="$D3_ATABLE_BASE"
ATABLE_TABLE="$D3_TABLE_BUDAN"
F_STATUS="VJQCRFk"

# 确保 PATH 包含 dws（Gateway 进程可能没有）
export PATH="$HOME/.local/bin:$PATH"
DWS=$(command -v dws || echo "$HOME/.local/bin/dws")

PENDING=$($DWS aitable record query \
  --base-id "$ATABLE_BASE" \
  --table-id "$ATABLE_TABLE" \
  --all 2>/dev/null | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    records = data.get('data', {}).get('records', []) or []
    count = 0
    for r in records:
        cells = r.get('cells', {})
        status_val = cells.get('$F_STATUS', '')
        if isinstance(status_val, dict):
            status_val = status_val.get('name', '')
        elif isinstance(status_val, list) and status_val:
            status_val = status_val[0].get('name','') if isinstance(status_val[0], dict) else str(status_val[0])
        if not status_val or status_val == '待处理':
            count += 1
    print(count)
except Exception:
    print(0)
" 2>/dev/null || echo "0")

if [ "$PENDING" -gt 0 ]; then
  echo "{\"pending\":$PENDING}"
else
  echo '{"pending":0}'
fi
