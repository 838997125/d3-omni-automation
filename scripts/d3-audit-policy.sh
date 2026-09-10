#!/usr/bin/env bash
# d3-audit-policy.sh — D3 自动客审拦截策略管理
# 从钉钉拦截商品表读取"待拦截"/"待恢复"记录，在 D3 自动客审页面操作
# 依赖: ego-browser, python3
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/lib-config.sh"
TRACKER="$SCRIPT_DIR/audit-tracker.py"
EXEC_SCRIPT="$SCRIPT_DIR/d3-audit-policy-exec.mjs"

# 统一配置（由 lib-config.sh 从 config.env 加载）
NOTIFY_GROUP="$D3_NOTIFY_GROUP"
ROBOT_CODE="$D3_ROBOT_CODE"

DRY_RUN=0

if [[ -t 1 ]]; then
  CYAN='\033[0;36m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
else
  CYAN=''; GREEN=''; YELLOW=''; RED=''; NC=''
fi
step() { echo -e "${CYAN}[*] $*${NC}"; }
ok()   { echo -e "${GREEN}[OK] $*${NC}"; }
warn() { echo -e "${YELLOW}[!] $*${NC}"; }
err()  { echo -e "${RED}[ERR] $*${NC}"; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift;;
    -h|--help) echo "用法: $0 [--dry-run]"; exit 0;;
    *) shift;;
  esac
done

notify() {
  dws chat message send-by-bot \
    --robot-code "$ROBOT_CODE" --group "$NOTIFY_GROUP" \
    --title "自动客审拦截" --text "$1" >/dev/null 2>&1 || true
}

# ========== 读取待处理数据 ==========
step "查询待拦截/待恢复商品 ..."
WAITING=$(python3 "$TRACKER" fetch "待拦截" 2>/dev/null || echo "{}")
PENDING_RESTORE=$(python3 "$TRACKER" fetch "待恢复" 2>/dev/null || echo "{}")

WAITING_COUNT=$(echo "$WAITING" | python3 -c "import sys,json;print(len(json.load(sys.stdin)))" 2>/dev/null || echo "0")
RESTORE_COUNT=$(echo "$PENDING_RESTORE" | python3 -c "import sys,json;print(len(json.load(sys.stdin)))" 2>/dev/null || echo "0")
step "待拦截: $WAITING_COUNT, 待恢复: $RESTORE_COUNT"

if [[ "$WAITING_COUNT" -eq 0 && "$RESTORE_COUNT" -eq 0 ]]; then
  ok "无待处理商品"
  exit 0
fi

# Build payload directly via python (avoid shell escaping issues)
PAYLOAD=$(TRACKER_PATH="$TRACKER" python3 <<'PYEOF'
import json, os, subprocess, sys
tracker = os.environ['TRACKER_PATH']
def fetch(status):
    r = subprocess.run([sys.executable, tracker, 'fetch', status],
                       capture_output=True, text=True, timeout=30)
    return json.loads(r.stdout) if r.stdout.strip() else {}
waiting = fetch('待拦截')
restore = fetch('待恢复')

# 熔断过滤：连续失败已熔断的 SKU 不再自动重试（防每5分钟刷屏），等人工处理或重新提交
try:
    fr = subprocess.run([sys.executable, tracker, 'fail-list'], capture_output=True, text=True, timeout=30)
    failstate = json.loads(fr.stdout) if fr.stdout.strip() else {}
    broken = {k for k, v in failstate.items() if v.get('broken')}
except Exception:
    broken = set()

add_list = [{'sku': sku, 'type': rec.get('type','单品')} for sku, rec in waiting.items() if sku not in broken]
delete_list = [sku for sku in restore.keys() if sku not in broken]
skipped_broken = sorted((set(waiting.keys()) | set(restore.keys())) & broken)
print(json.dumps({'add': add_list, 'delete': delete_list, '_skipped_broken': skipped_broken}, ensure_ascii=False))
PYEOF
)

echo "$PAYLOAD" | python3 -c "
import sys,json
d=json.load(sys.stdin)
print('待添加:', [x['sku'] for x in d['add']])
print('待删除:', d['delete'])
if d.get('_skipped_broken'): print('熔断跳过(不重试):', d['_skipped_broken'])
"

if [[ "$DRY_RUN" -eq 1 ]]; then
  ok "[DRY-RUN] 跳过 D3 操作"
  exit 0
fi

# ========== 执行 D3 操作 ==========
step "执行 D3 操作 ..."
printf '%s' "$PAYLOAD" > /tmp/d3-audit-payload.json
write_d3_credentials
RESULT=$(ego-browser nodejs < "$EXEC_SCRIPT" 2>&1) || true
rm -f /tmp/d3-audit-payload.json

echo "$RESULT"

# Extract results
RESULTS_JSON=$(echo "$RESULT" | grep '^RESULTS:' | sed 's/^RESULTS://' || echo '{}')

if [[ -z "$RESULTS_JSON" || "$RESULTS_JSON" == "{}" ]]; then
  err "未获取到执行结果"
  notify "自动客审拦截执行失败，未获取到结果"
  exit 1
fi

# ========== 失败熔断：同一 SKU 连续失败 3 次后停止重试，只群发一次通知 ==========
step "失败熔断检查 ..."
FAIL_SUMMARY=$(RESULTS_JSON="$RESULTS_JSON" TRACKER_PATH="$TRACKER" ROBOT="$ROBOT_CODE" GROUP="$NOTIFY_GROUP" python3 <<'PYEOF'
import json, os, subprocess, sys

tracker = os.environ['TRACKER_PATH']
results = json.loads(os.environ['RESULTS_JSON'])

def tracker_cmd(*args, stdin_data=None):
    try:
        r = subprocess.run([sys.executable, tracker] + list(args),
                           input=stdin_data, capture_output=True, text=True, timeout=30)
        return json.loads(r.stdout) if r.stdout.strip() else {}
    except Exception:
        return {}

# 成功/已存在的 SKU 清除失败计数
for sku in results.get('added', []) + results.get('deleted', []) + results.get('skipped', []):
    tracker_cmd('fail-reset', sku)

# 错误 SKU 累计失败次数
newly_broken = []
err_skus = []
for err in results.get('errors', []):
    sku = err.split(':', 1)[0].strip()
    if not sku:
        continue
    err_skus.append(sku)
    # 错误信息写入钉钉拦截表备注字段，便于人工排查
    tracker_cmd('set-error', sku, stdin_data=err)
    res = tracker_cmd('fail-incr', sku, 'op', stdin_data=err)
    if res.get('broken') and not res.get('already_broken'):
        newly_broken.append({'sku': sku, 'error': err, 'count': res.get('count')})

all_broken = bool(err_skus) and all(
    (tracker_cmd('fail-list').get(s, {}) or {}).get('broken') for s in err_skus)

# 刚达到熔断阈值：只发这一次群通知，之后静默直到人工处理/重新提交
if newly_broken:
    lines = ['⚠️ 自动客审拦截连续失败，已暂停自动重试，需人工处理：', '']
    for it in newly_broken:
        lines.append(f"• {it['sku']}（连续 {it['count']} 次失败）")
        lines.append(f"  {it['error'][:120]}")
    lines.append('')
    lines.append('常见原因：D3 中无此编码（SKU*数量 格式的套装 D3 常未建档）。请在 D3 自动客审页面确认编码后手动添加，或在拦截表中调整该记录；重新提交后会自动恢复重试。')
    try:
        subprocess.run(['dws', 'chat', 'message', 'send-by-bot',
                        '--robot-code', os.environ['ROBOT'], '--group', os.environ['GROUP'],
                        '--title', '自动客审拦截熔断通知', '--text', '  \n'.join(lines)],
                       capture_output=True, text=True, timeout=15)
    except Exception:
        pass

print(json.dumps({'newly_broken': len(newly_broken), 'all_broken': all_broken}, ensure_ascii=False))
PYEOF
)
echo "  $FAIL_SUMMARY"

# ========== 回写钉钉表 ==========
step "更新钉钉拦截表 ..."

# Build results with submitter info for notifications
NOTIFY_DATA=$(RESULTS_JSON="$RESULTS_JSON" TRACKER_PATH="$TRACKER" python3 <<'PYEOF'
import json, os, subprocess, sys

tracker = os.environ['TRACKER_PATH']
results = json.loads(os.environ['RESULTS_JSON'])

def run_tracker(*args, stdin_data=None):
    r = subprocess.run(
        [sys.executable, tracker] + list(args),
        input=stdin_data, capture_output=True, text=True, timeout=30
    )
    return r

# Mark intercepted
for sku in results.get('added', []):
    run_tracker('mark-intercepted', sku)
    print(f'  已拦截: {sku}', file=sys.stderr)

# Mark restored
for sku in results.get('deleted', []):
    pass  # batch below

deleted = results.get('deleted', [])
if deleted:
    run_tracker('mark-restored', stdin_data=json.dumps(deleted))
    print(f'  已恢复: {len(deleted)} 个', file=sys.stderr)

# Fetch all records to get submitter info for notifications
r = run_tracker('fetch')
try:
    all_records = json.loads(r.stdout)
except:
    all_records = {}

# Build notification info
notify_added = []
added_batch = 0
for sku in results.get('added', []):
    rec = all_records.get(sku, {})
    cells = rec.get('cells', {})
    submitter = cells.get('83QAPal', '张一钦')
    gtype = rec.get('type', '单品')
    pname = rec.get('name', '')
    batch = cells.get('pTAYZcr', 0)
    try: batch = int(batch)
    except: batch = 0
    if batch > added_batch: added_batch = batch
    notify_added.append({'sku': sku, 'type': gtype, 'submitter': str(submitter), 'name': pname, 'batch': batch})

notify_deleted = []
deleted_batch = 0
for sku in results.get('deleted', []):
    rec = all_records.get(sku, {})
    cells = rec.get('cells', {})
    submitter = cells.get('83QAPal', '张一钦')
    gtype = rec.get('type', '单品')
    pname = rec.get('name', '')
    batch = cells.get('pTAYZcr', 0)
    try: batch = int(batch)
    except: batch = 0
    if batch > deleted_batch: deleted_batch = batch
    notify_deleted.append({'sku': sku, 'type': gtype, 'submitter': str(submitter), 'name': pname, 'batch': batch})

print(json.dumps({
    'added': notify_added,
    'deleted': notify_deleted,
    'added_batch': added_batch,
    'deleted_batch': deleted_batch
}, ensure_ascii=False))
PYEOF
)

ADDED=$(echo "$RESULTS_JSON" | python3 -c "import sys,json;print(len(json.load(sys.stdin).get('added',[])))" 2>/dev/null || echo 0)
DELETED=$(echo "$RESULTS_JSON" | python3 -c "import sys,json;print(len(json.load(sys.stdin).get('deleted',[])))" 2>/dev/null || echo 0)
ERRORS=$(echo "$RESULTS_JSON" | python3 -c "import sys,json;print(len(json.load(sys.stdin).get('errors',[])))" 2>/dev/null || echo 0)

echo ""
echo "========================================="
ok "完成: 添加 $ADDED, 删除 $DELETED, 错误 $ERRORS"
echo "========================================="

# ========== 发送群通知 ==========
if [[ "$ADDED" -gt 0 || "$DELETED" -gt 0 ]]; then
  step "发送群通知 ..."
  NOTIFY_DATA_FILE=$(mktemp /tmp/d3-notify.XXXXXX.json)
  echo "$NOTIFY_DATA" > "$NOTIFY_DATA_FILE"
  
  NOTIFY_RESULT=$(NOTIFY_FILE="$NOTIFY_DATA_FILE" ROBOT="$ROBOT_CODE" GROUP="$NOTIFY_GROUP" SCRIPTS_DIR="$SCRIPT_DIR" python3 <<'PYEOF'
import json, os, subprocess, sys

with open(os.environ['NOTIFY_FILE']) as f:
    data = json.load(f)

lines = []

# @ 名单：拦截成功只 @提交人；恢复完成 @提交人+恢复发起人（多数是同一人，已去重）
# openId 来自 audit-listener 轮询群消息时记录的 senderOpenDingTalkId
def people_targets(skus, roles):
    try:
        r = subprocess.run(
            [sys.executable, os.path.join(os.environ['SCRIPTS_DIR'], 'audit-people.py'), 'targets'],
            input=json.dumps({'skus': skus, 'roles': roles}, ensure_ascii=False),
            capture_output=True, text=True, timeout=15)
        return json.loads(r.stdout) if r.stdout.strip() else []
    except Exception:
        return []

added_skus = [it['sku'] for it in data.get('added', [])]
deleted_skus = [it['sku'] for it in data.get('deleted', [])]
targets = []
_seen = set()
for _t in people_targets(added_skus, ['submitter']) + people_targets(deleted_skus, ['submitter', 'restorer']):
    _oid = _t.get('open_id', '')
    if _oid and _oid not in _seen:
        _seen.add(_oid)
        targets.append(_t)

# 文本里需包含 @<openId> 对应文本，钉钉才会渲染成 @人
if targets:
    at_parts = [f'@{t["open_id"]}' for t in targets]
    lines.append(' '.join(at_parts))
    lines.append('')

for item in data.get('added', []):
    name = item.get('name', '')
    name_str = f' {name}' if name else ''
    b = item.get('batch', 0)
    bstr = f' · 批次 #{b}' if b else ''
    lines.append(f"✅ 已拦截: {item['sku']}（{item['type']}）{name_str}{bstr}")
for item in data.get('deleted', []):
    name = item.get('name', '')
    name_str = f' {name}' if name else ''
    b = item.get('batch', 0)
    bstr = f' · 批次 #{b}' if b else ''
    lines.append(f"🔓 已恢复: {item['sku']}（{item['type']}）{name_str}{bstr}")

# Add restore hint with batch numbers (collect all batches involved, not just max)
added_batches = sorted({it.get('batch', 0) for it in data.get('added', []) if it.get('batch', 0)})
if added_batches:
    lines.append('')
    if len(added_batches) == 1:
        lines.append(f'处理完成后回复「恢复 #{added_batches[0]}」即可自动解开拦截')
    else:
        lines.append('处理完成后回复「恢复 #批次号」即可自动解开拦截（本批涉及批次: ' +
                     '、'.join(f'#{b}' for b in added_batches) + '）')

deleted_batches = sorted({it.get('batch', 0) for it in data.get('deleted', []) if it.get('batch', 0)})
if deleted_batches:
    lines.append('')
    lines.append('批次 ' + '、'.join(f'#{b}' for b in deleted_batches) + ' 已恢复')

text = '  \n'.join(lines)  # Markdown line break: two trailing spaces

at_open_ids = ','.join(t['open_id'] for t in targets) if targets else ''

cmd = [
    'dws', 'chat', 'message', 'send-by-bot',
    '--robot-code', os.environ['ROBOT'],
    '--group', os.environ['GROUP'],
    '--title', '自动客审拦截通知',
    '--text', text,
]
if at_open_ids:
    cmd.extend(['--at-open-dingtalk-ids', at_open_ids])

r = subprocess.run(cmd, capture_output=True, text=True, timeout=15)
ok = '"success":true' in r.stdout or '"success": true' in r.stdout

# 记录 processQueryKey 到账本，以备日后撤回
try:
    sys.path.insert(0, os.environ.get('SCRIPTS_DIR', ''))
    import notify_ledger
    notify_ledger.append(
        notify_ledger.extract_key(r.stdout), text=text, source='d3-audit-policy',
        title='自动客审拦截通知', group=os.environ['GROUP'], robot=os.environ['ROBOT'],
        at_ids=at_open_ids, ok=ok)
except Exception:
    pass

print(json.dumps({'sent': ok, 'at_ids': at_open_ids, 'text': text[:200]}))
PYEOF
)
  rm -f "$NOTIFY_DATA_FILE"
  echo "  $NOTIFY_RESULT"
  ok "通知已发送"
fi

if [[ "$ERRORS" -gt 0 ]]; then
  ALL_BROKEN=$(echo "$FAIL_SUMMARY" | python3 -c "import sys,json;print(json.load(sys.stdin).get('all_broken',False))" 2>/dev/null || echo "False")
  if [[ "$ALL_BROKEN" != "True" ]]; then
    exit 1
  fi
  warn "所有错误项均已熔断，本轮不再触发报错通知"
fi
