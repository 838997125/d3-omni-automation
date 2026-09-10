#!/usr/bin/env bash
# d3-out-of-stock-ego.sh — D3 缺货检测/打标/跟踪 (ego-browser 版)
# 独立 task space: d3-shortage-auto，翻页扫描全部待审核订单
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/lib-config.sh"
TRACKER="$SCRIPT_DIR/d3-shortage-tracker.py"
JS_FILE="$SCRIPT_DIR/ego-shortage.mjs"
DRY_RUN=0

NOTIFY_GROUP="$D3_NOTIFY_GROUP"
ROBOT_CODE="$D3_ROBOT_CODE"
DEFAULT_AT_USER="$D3_DEFAULT_AT_USER"
STAFF_BASE_ID="$D3_ATABLE_BASE"
STAFF_TABLE_ID="$D3_TABLE_STAFF"
STAFF_PLATFORM_FIELD="6O9aB0Z"
STAFF_USER_FIELD="pbTluRY"
SHORTAGE_TAG_ID="$D3_SHORTAGE_TAG_ID"

if [[ -t 1 ]]; then
  CYAN='\033[0;36m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[1;31m'; NC='\033[0m'
else
  CYAN=''; GREEN=''; YELLOW=''; RED=''; NC=''
fi
step()  { echo -e "${CYAN}[*] $*${NC}"; }
ok()    { echo -e "${GREEN}[OK] $*${NC}"; }
warn()  { echo -e "${YELLOW}[!] $*${NC}"; }
err()   { echo -e "${RED}[ERR] $*${NC}"; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift;;
    -h|--help) echo "用法: $0 [--dry-run]"; exit 0;;
    *) err "未知参数: $1"; exit 1;;
  esac
done

TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT
SCAN_FILE="$TMPDIR/scan.json"

get_cs_user_ids() {
  dws aitable record query \
    --base-id "$STAFF_BASE_ID" --table-id "$STAFF_TABLE_ID" \
    --format json 2>/dev/null | STAFF_PLATFORM_FIELD="$STAFF_PLATFORM_FIELD" STAFF_USER_FIELD="$STAFF_USER_FIELD" python3 -c "
import sys,json,os
d=json.load(sys.stdin)
pf=os.environ['STAFF_PLATFORM_FIELD']; uf=os.environ['STAFF_USER_FIELD']
uids=[]
for r in d.get('data',{}).get('records',[]):
    c=r.get('cells',{})
    if c.get(pf)=='客服':
        for u in c.get(uf,[]):
            if u.get('userId'): uids.append(u['userId'])
print(','.join(uids))
" 2>/dev/null
}

notify_group() {
  local title="$1" body="$2"
  local cs_ids; cs_ids=$(get_cs_user_ids)
  [ -z "$cs_ids" ] && cs_ids="$DEFAULT_AT_USER"
  local at_text; at_text=$(echo "$cs_ids" | tr ',' '\n' | sed 's/^/@/' | tr '\n' ' ' | sed 's/ $//')
  dws chat message send-by-bot \
    --robot-code "$ROBOT_CODE" --group "$NOTIFY_GROUP" \
    --at-user-ids "$cs_ids" \
    --title "$title" --text "${at_text}
${body}" 2>&1 | python3 -c "import sys,json;d=json.load(sys.stdin);print('  通知已发送' if d.get('success') else '  通知失败')" 2>/dev/null || echo '  通知发送异常'
}

echo ""
echo "========================================"
echo " D3 缺货检测 (ego-browser)"
echo "========================================"
echo ""

# ========== 阶段 1: 浏览器扫描 + 打标 ==========
step "启动浏览器扫描 ..."
write_d3_credentials
EGO_OUTPUT=$(ego-browser nodejs < "$JS_FILE" 2>&1 || true)
echo "$EGO_OUTPUT"
echo "$EGO_OUTPUT" > "$SCAN_FILE"

# 提取 JSON
JSON_LINE=$(grep '^JSON_RESULT:' "$SCAN_FILE" | tail -1 | sed 's/^JSON_RESULT://')
if [ -z "$JSON_LINE" ]; then
  err "无法提取 JSON 结果"
  exit 1
fi

NEW_COUNT=$(echo "$JSON_LINE" | python3 -c "import sys,json;print(len(json.load(sys.stdin)['scan']['newShortage']))")
ARRIVED_COUNT=$(echo "$JSON_LINE" | python3 -c "import sys,json;print(len(json.load(sys.stdin)['scan']['arrived']))")
AUDITED_COUNT=$(echo "$JSON_LINE" | python3 -c "import sys,json;print(len(json.load(sys.stdin)['scan']['audited']))")
TAGGED_COUNT=$(echo "$JSON_LINE" | python3 -c "import sys,json;print(json.load(sys.stdin)['tagged'])")

echo ""
echo "=== 扫描结果 ==="
echo "新缺货: $NEW_COUNT 单 | 已到货: $ARRIVED_COUNT 单 | 已审核: $AUDITED_COUNT 单 | 已打标: $TAGGED_COUNT 单"

if [[ "$DRY_RUN" -eq 1 ]]; then
  warn "DRY-RUN 模式"
  echo "$JSON_LINE" | python3 -m json.tool 2>/dev/null
  exit 0
fi

# ========== 阶段 2: 跟踪表 + 通知 ==========
if [[ "$NEW_COUNT" -gt 0 ]]; then
  step "写入缺货跟踪表 ..."
  echo "$JSON_LINE" | TRACKER="$TRACKER" python3 -c "
import sys,json,subprocess,os
d=json.load(sys.stdin)
tracker=os.environ['TRACKER']
for o in d['scan']['newShortage']:
    for s in o['shortage']:
        data={'order_code':o['code'],'platform':o.get('platform',''),'shop':o.get('shopName',''),'sku':s['sku'],'product':s['title'],'qty':s['num'],'stock':s['avail'],'d3_id':o['id']}
        r=subprocess.run(['python3',tracker,'create'],input=json.dumps(data,ensure_ascii=False),capture_output=True,text=True,timeout=30)
        resp=json.loads(r.stdout) if r.stdout.strip() else {}
        st='OK' if resp.get('success') else 'FAIL'
        print(f'  [{st}] {o[\"code\"]} {s[\"sku\"]} {s[\"title\"][:25]}')
" 2>&1

  step "发送缺货通知 ..."
  NOTIFY_BODY=$(echo "$JSON_LINE" | python3 -c "
import sys,json
d=json.load(sys.stdin)
lines=[]; total=0
for o in d['scan']['newShortage']:
    for s in o['shortage']:
        total+=1
        lines.append(f'- {o[\"code\"]} [{o.get(\"platform\",\"\")}] {s[\"sku\"]} {s[\"title\"][:20]} 需{s[\"num\"]}件/库存{s[\"avail\"]}')
body=f'### 🔴 检测到 {total} 个缺货品种\n\n'+'\n'.join(lines[:20])
body+='\n\n请及时联系对应运营和采销安排补货、补库存。'
print(body)
" 2>/dev/null)
  notify_group "🔴 缺货检测通知" "$NOTIFY_BODY"
fi

# ========== 阶段 3: 到货 ==========
if [[ "$ARRIVED_COUNT" -gt 0 ]]; then
  step "处理到货订单 ..."
  TRACKED=$(python3 "$TRACKER" fetch 2>/dev/null || echo "{}")
  echo "$JSON_LINE" | TRACKED="$TRACKED" TRACKER="$TRACKER" ARRIVED_FILE="$TMPDIR/arrived.txt" python3 -c "
import sys,json,subprocess,os
d=json.load(sys.stdin)
tracked=json.loads(os.environ['TRACKED'])
tracker=os.environ['TRACKER']
af=os.environ['ARRIVED_FILE']
notify=[]
for o in d['scan']['arrived']:
    code=o['code']; platform=o.get('platform',''); items=o.get('items',[])
    existing=None
    for k,r in tracked.items():
        if r['orderCode']==code: existing=r; break
    if existing:
        if existing['status']=='缺货待到货':
            # 取主要商品的当前库存更新跟踪表
            cur_stock = items[0].get('avail') if items else None
            cmd = ['python3',tracker,'mark-arrived',existing['recordId']]
            if cur_stock is not None: cmd.append(str(int(cur_stock)))
            subprocess.run(cmd,capture_output=True,text=True,timeout=30)
            notify.append((code,platform,items))
            print(f'  [OK] {code} → 已到货待审 (库存{cur_stock})')
    else:
        if items:
            for it in items:
                data={'order_code':code,'platform':platform,'shop':o.get('shopName',''),'sku':it['sku'],'product':it.get('title',''),'qty':it.get('num',1),'stock':999,'d3_id':o['id']}
                r=subprocess.run(['python3',tracker,'create'],input=json.dumps(data,ensure_ascii=False),capture_output=True,text=True,timeout=30)
                resp=json.loads(r.stdout) if r.stdout.strip() else {}
                if resp.get('success'):
                    rid=resp['data']['newRecordIds'][0]
                    cur_stock = it.get('avail',999)
                    if cur_stock is not None: cur_stock = int(cur_stock)
                    subprocess.run(['python3',tracker,'mark-arrived',rid,str(cur_stock) if cur_stock is not None else ''],capture_output=True,text=True,timeout=30)
            notify.append((code,platform,items))
            print(f'  [补录] {code}')
        else:
            notify.append((code,platform,[]))
            print(f'  [通知] {code}')
if notify:
    with open(af,'w') as f:
        for code,platform,items in notify:
            istr='; '.join([f\"{it['sku']} {it.get('title','')[:15]}\" for it in items]) if items else ''
            f.write(f'{code}|{platform}|{istr}\n')
" 2>&1

  if [ -f "$TMPDIR/arrived.txt" ] && [ -s "$TMPDIR/arrived.txt" ]; then
    NOTIFY_LINES=$(while IFS='|' read -r code platform items; do
      [ -n "$items" ] && echo "- $code [$platform] $items" || echo "- $code [$platform]"
    done < "$TMPDIR/arrived.txt")
    ANUM=$(wc -l < "$TMPDIR/arrived.txt" | tr -d ' ')
    notify_group "🟢 缺货已到货，请审单" "### 🟢 缺货订单已到货，请及时审核（${ANUM}单）

以下订单缺货商品已到货：
${NOTIFY_LINES}

请尽快在 D3 中完成审核。"
  fi
fi

# ========== 阶段 4: 已审核闭环 ==========
# 两种情况标记为已审核：
# 1) 扫描时直接发现缺货标签订单状态已非待审核（audited）
# 2) 状态为“已到货待审”的跟踪记录，其订单号已不在待审核队列（pendingCodes）中，说明已审核离队
step "闭环已审核订单 ..."
TRACKED=$(python3 "$TRACKER" fetch 2>/dev/null || echo "{}")
echo "$JSON_LINE" | TRACKED="$TRACKED" TRACKER="$TRACKER" python3 -c "
import sys,json,subprocess,os
d=json.load(sys.stdin); tracked=json.loads(os.environ['TRACKED']); tracker=os.environ['TRACKER']
pending=set(d.get('pendingCodes',[]))
def mark_audited(recordId, code, reason):
    r=subprocess.run(['python3',tracker,'mark-audited',recordId],capture_output=True,text=True,timeout=30)
    resp=json.loads(r.stdout) if r.stdout.strip() else {}
    if resp.get('success'):
        print(f'  [闭环] {code} → 已审核（{reason}）')
    else:
        print(f'  [FAIL] {code}')

# 1) 扫描直接发现的
audited_codes=set()
for o in d['scan'].get('audited',[]):
    audited_codes.add(o['code'])
    for k,r in tracked.items():
        if r['orderCode']==o['code'] and r['status']!='已审核':
            mark_audited(r['recordId'], o['code'], '状态变更')

# 2) 已到货待审但已离开待审核队列的
for k,r in tracked.items():
    code=r['orderCode']
    if r['status']=='已到货待审' and code not in audited_codes:
        # 订单号或其 refOid 是否在当前待审核队列
        if code not in pending:
            mark_audited(r['recordId'], code, '已审核离队')
" 2>&1

echo ""
echo "========================================"
ok "本轮完成: 新缺货 $NEW_COUNT | 已到货 $ARRIVED_COUNT | 已审核 $AUDITED_COUNT"
echo "========================================"