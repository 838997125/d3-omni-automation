#!/usr/bin/env bash
# 检查钉钉拦截表是否有"待拦截"或"待恢复"记录
# 输出 JSON: {"pending": N}
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TRACKER="$SCRIPT_DIR/audit-tracker.py"

TRACKER_PATH="$TRACKER" python3 <<'PYEOF'
import json, subprocess, sys, os
tracker = os.environ['TRACKER_PATH']
def fetch(status):
    r = subprocess.run([sys.executable, tracker, 'fetch', status],
                       capture_output=True, text=True, timeout=30)
    try:
        return json.loads(r.stdout)
    except:
        return {}
w = fetch('待拦截')
p = fetch('待恢复')
print(json.dumps({'pending': len(w) + len(p)}))
PYEOF
