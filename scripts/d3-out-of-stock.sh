#!/usr/bin/env bash
# d3-out-of-stock.sh — D3 缺货订单自动检测、打标、跟踪
# 流程: 加载待审核订单 → 逐单加载货品明细比对库存
#       → 缺货订单打"缺货"标签（不转异常单）
#       → 写入钉钉缺货跟踪表
#       → 检查已有跟踪记录：到货了就@客服审核，已审核了就闭环
# 依赖: opencli browser (Browser Bridge), dws CLI, python3
set -euo pipefail

SESSION="d3-shortage"
BASE_URL=${BASE_URL:-"https://d3.diansan.com"}
DRY_RUN=0
LOAD_WAIT=${LOAD_WAIT:-600}
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/lib-config.sh"
TRACKER="$SCRIPT_DIR/d3-shortage-tracker.py"

NOTIFY_GROUP="$D3_NOTIFY_GROUP"
ROBOT_CODE="$D3_ROBOT_CODE"
DEFAULT_AT_USER="$D3_DEFAULT_AT_USER"
STAFF_BASE_ID="$D3_ATABLE_BASE"
STAFF_TABLE_ID="$D3_TABLE_STAFF"
STAFF_PLATFORM_FIELD="6O9aB0Z"
STAFF_USER_FIELD="pbTluRY"

# 临时文件
TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT
NEW_SHOWCASE="$TMPDIR/new_shortage.json"
TAGGED_SHOWCASE="$TMPDIR/tagged_status.json"

if [[ -t 1 ]]; then
  CYAN='\033[0;36m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
else
  CYAN=''; GREEN=''; YELLOW=''; RED=''; NC=''
fi
step()  { echo -e "${CYAN}[*] $*${NC}"; }
ok()    { echo -e "${GREEN}[OK] $*${NC}"; }
warn()  { echo -e "${YELLOW}[!] $*${NC}"; }
err()   { echo -e "${RED}[ERR] $*${NC}"; }

usage() { echo "用法: $0 [--dry-run] [--load-wait MS] [--session NAME]"; exit 0; }
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift;;
    --load-wait) LOAD_WAIT="$2"; shift 2;;
    --session) SESSION="$2"; shift 2;;
    -h|--help) usage;;
    *) err "未知参数: $1"; usage;;
  esac
done

oc() { opencli browser "$SESSION" "$@" 2>&1; }

# 从部门-人员对应表获取客服人员 userId 列表（逗号分隔）
get_cs_user_ids() {
  STAFF_PLATFORM_FIELD="$STAFF_PLATFORM_FIELD" STAFF_USER_FIELD="$STAFF_USER_FIELD" \
  dws aitable record query \
    --base-id "$STAFF_BASE_ID" --table-id "$STAFF_TABLE_ID" \
    --format json 2>/dev/null | STAFF_PLATFORM_FIELD="$STAFF_PLATFORM_FIELD" STAFF_USER_FIELD="$STAFF_USER_FIELD" python3 -c "
import sys,json,os
d=json.load(sys.stdin)
pf=os.environ['STAFF_PLATFORM_FIELD']
uf=os.environ['STAFF_USER_FIELD']
uids=[]
for r in d.get('data',{}).get('records',[]):
    cells=r.get('cells',{})
    if cells.get(pf)=='客服':
        for u in cells.get(uf,[]):
            uid=u.get('userId','')
            if uid: uids.append(uid)
print(','.join(uids))
" 2>/dev/null
}

notify_group() {
  local title="$1" body="$2" at_user="${3:-$DEFAULT_AT_USER}"
  local at_args=()
  local msg_body="$body"
  if [ -n "$at_user" ]; then
    at_args=(--at-user-ids "$at_user")
    msg_body="@$at_user
$body"
  fi
  local output
  output=$(dws chat message send-by-bot \
    --robot-code "$ROBOT_CODE" --group "$NOTIFY_GROUP" \
    "${at_args[@]+"${at_args[@]}"}" \
    --title "$title" --text "$msg_body" 2>&1)
  local rc=$?
  if [ $rc -eq 0 ] && echo "$output" | grep -q '"success"[[:space:]]*:[[:space:]]*true'; then
    ok "群通知已发送: $title"
  else
    warn "群通知失败 (rc=$rc): $output"
  fi
}

# ---------- 1. 进入订单客审页 ----------
ORDER_PAGE_URL="$BASE_URL/omni/order/order-check/indexFeature/index.html"
CURRENT_URL=$(oc get url 2>/dev/null || echo "")
step "检查订单客审页 ..."
if ! echo "$CURRENT_URL" | grep -q "order-check"; then
  step "打开 D3 订单客审页面 ..."
  oc tab new "$ORDER_PAGE_URL" >/dev/null || true
  sleep 6
fi
ok "已在订单客审页"

# ---------- 2. 加载全部订单 ----------
step "加载订单列表 ..."
oc eval "(function(){var b=document.querySelectorAll('button.ant-btn-primary');for(var i=0;i<b.length;i++){if(b[i].innerText.indexOf('查')>=0&&b[i].innerText.indexOf('询')>=0){b[i].click();return'ok';}}})()" >/dev/null || true
sleep 4
oc eval "(function(){var os=document.querySelectorAll('.spreadtable')[0].__vue__.\$parent;os.\$data.tableProps.pagination.pageSize=200;os.\$data.tableProps.pagination.current=1;os.query();return'ok';})()" >/dev/null || true
sleep 6
ORDER_COUNT=$(oc eval "(function(){var os=document.querySelectorAll('.spreadtable')[0].__vue__.\$parent;return(os.\$data.tableProps.dataSource||[]).length;})()" 2>/dev/null || echo "0")
ok "已加载 $ORDER_COUNT 条订单"

# ---------- 3. 一次遍历同时完成：新缺货检测 + 已有标签到货检查 ----------
step "扫描缺货和到货状态 ..."
SCAN_JS="
(async function() {
  var LOAD_WAIT = $LOAD_WAIT;
  var osTable = document.querySelectorAll('.spreadtable')[0].__vue__.\$parent;
  var lineTable = document.querySelectorAll('.spreadtable')[1].__vue__.\$parent;
  var ds = osTable.\$data.tableProps.dataSource;
  if (!ds || !ds.length) return JSON.stringify({newShortage:[], arrived:[], audited:[]});

  function hasShortageTag(row) {
    if (row.tags && row.tags.length) {
      for (var t=0;t<row.tags.length;t++){
        if(row.tags[t].tagName==='缺货') return true;
      }
    }
    return false;
  }

  var newShortage = [];
  var arrived = [];
  var audited = [];

  for (var i = 0; i < ds.length; i++) {
    var row = ds[i];
    if (row.lockAllowOperation === false) continue;
    var tagged = hasShortageTag(row);

    // 已审核的缺货单（不在待审核状态）
    if (tagged && row.status && row.status.name !== '待审核') {
      audited.push({id:row.id, code:row.code});
      continue;
    }

    // 加载货品明细
    try { osTable._onRowClick(row, true); } catch(e) {}
    await new Promise(function(r){ setTimeout(r, LOAD_WAIT); });
    var lines = lineTable.\$data.tableProps.dataSource;
    if (!lines) continue;

    var shortageItems = [];
    var allLinesArrived = true;
    lines.forEach(function(l) {
      var avail = l.availableNum, num = l.num;
      if (typeof avail === 'number' && typeof num === 'number') {
        if (avail < num) {
          shortageItems.push({sku:l.outerId, title:(l.title||'').substring(0,60), avail:avail, num:num});
          allLinesArrived = false;
        }
      }
    });

    if (!tagged && shortageItems.length > 0) {
      // 新缺货
      newShortage.push({
        id:row.id, code:row.code,
        platform:(row.platform&&row.platform.name)||'',
        shopName:row.shopName||'',
        shortage:shortageItems
      });
    } else if (tagged && allLinesArrived) {
      // 已打缺货标签但所有商品已到货
      // 收集主要商品信息（排除运费链接）用于通知和补录跟踪表
      var mainLines = lines.filter(function(l){
        return l.outerId && l.outerId.indexOf('FF00') !== 0;
      }).map(function(l){
        return {sku:l.outerId, title:(l.title||'').substring(0,40), num:l.num};
      });
      arrived.push({
        id:row.id, code:row.code,
        platform:(row.platform&&row.platform.name)||'',
        shopName:row.shopName||'',
        items:mainLines
      });
    }
  }
  return JSON.stringify({newShortage:newShortage, arrived:arrived, audited:audited});
})()
"
SCAN_RAW=$(oc eval "$SCAN_JS" 2>&1)
# 提取 JSON 行（opencli 可能在输出后追加更新提示）
SCAN_RESULT=$(echo "$SCAN_RAW" | grep -E '^\{.*\}$' | head -1)
if [ -z "$SCAN_RESULT" ]; then
  # fallback: 尝试提取第一个 { 到最后一个 } 的内容
  SCAN_RESULT=$(echo "$SCAN_RAW" | python3 -c "import sys,re; t=sys.stdin.read(); m=re.search(r'\{.*\}', t, re.S); print(m.group(0) if m else '')" 2>/dev/null)
fi
if [ -z "$SCAN_RESULT" ]; then
  err "无法从输出中提取 JSON 结果"
  echo "$SCAN_RAW"
  exit 1
fi

echo "$SCAN_RESULT" > "$NEW_SHOWCASE"
echo ""
echo "=== 扫描结果 ==="
echo "$SCAN_RESULT" | python3 -c "
import sys,json
d=json.load(sys.stdin)
print(f\"新缺货: {len(d.get('newShortage',[]))} 单\")
print(f\"已到货: {len(d.get('arrived',[]))} 单\")
print(f\"已审核: {len(d.get('audited',[]))} 单\")
" 2>/dev/null || echo "$SCAN_RESULT"

NEW_COUNT=$(echo "$SCAN_RESULT" | python3 -c "import sys,json;print(len(json.load(sys.stdin).get('newShortage',[])))" 2>/dev/null || echo "0")
ARRIVED_COUNT=$(echo "$SCAN_RESULT" | python3 -c "import sys,json;print(len(json.load(sys.stdin).get('arrived',[])))" 2>/dev/null || echo "0")
AUDITED_COUNT=$(echo "$SCAN_RESULT" | python3 -c "import sys,json;print(len(json.load(sys.stdin).get('audited',[])))" 2>/dev/null || echo "0")

if [[ "$DRY_RUN" -eq 1 ]]; then
  warn "DRY-RUN 模式，不做任何操作"
  echo "$SCAN_RESULT" | python3 -m json.tool 2>/dev/null
  exit 0
fi

# ---------- 4. 对新缺货订单打标 ----------
if [[ "$NEW_COUNT" -gt 0 ]]; then
  step "对 $NEW_COUNT 个缺货订单打标 ..."

  # 选中新缺货订单
  oc eval "(function(){
    var osTable=document.querySelectorAll('.spreadtable')[0].__vue__.\$parent;
    var ds=osTable.\$data.tableProps.dataSource;
    var scan=$SCAN_RESULT;
    var ids=scan.newShortage.map(function(o){return o.id;});
    var rows=ds.filter(function(r){return ids.indexOf(r.id)>=0;});
    osTable._onSelectRows(ids,rows);
    return 'selected '+rows.length;
  })()" 2>&1
  sleep 1

  # 打开打标弹窗
  oc eval "(function(){var os=document.querySelectorAll('.spreadtable')[0].__vue__.\$parent;var top=os.\$parent.\$parent;top.mark();return 'ok';})()" >/dev/null
  sleep 2

  # 选"缺货"
  oc eval "(function(){
    var modals=document.querySelectorAll('.ant-modal-wrap');
    for(var i=0;i<modals.length;i++){
      if(getComputedStyle(modals[i]).display!=='none'){
        var radios=modals[i].querySelectorAll('.ant-radio-wrapper');
        if(radios.length>=3){radios[2].click();return 'ok';}
      }
    }
  })()" >/dev/null
  sleep 1

  # 确认
  oc eval "(function(){
    var modals=document.querySelectorAll('.ant-modal-wrap');
    for(var i=0;i<modals.length;i++){
      if(getComputedStyle(modals[i]).display!=='none'){
        var btns=modals[i].querySelectorAll('button.ant-btn-primary');
        for(var j=0;j<btns.length;j++){
          if(btns[j].innerText.trim()==='打 标'){btns[j].click();return 'ok';}
        }
      }
    }
  })()" >/dev/null
  sleep 3
  ok "缺货标签已打"

  # 写跟踪表
  echo "$SCAN_RESULT" | python3 -c "
import sys, json, subprocess
d = json.load(sys.stdin)
tracker = '$TRACKER'
for o in d.get('newShortage',[]):
    for s in o['shortage']:
        data = {
            'order_code': o['code'],
            'platform': o.get('platform',''),
            'shop': o.get('shopName',''),
            'sku': s['sku'],
            'product': s['title'],
            'qty': s['num'],
            'stock': s['avail'],
            'd3_id': o['id']
        }
        r = subprocess.run(['python3', tracker, 'create'], input=json.dumps(data), capture_output=True, text=True, timeout=30)
        resp = json.loads(r.stdout) if r.stdout.strip() else {}
        status = 'OK' if resp.get('success') else 'FAIL'
        print(f'  [{status}] {o[\"code\"]} {s[\"sku\"]} {s[\"title\"][:25]}')
" 2>&1

  # 发群通知
  NOTIFY_BODY=$(echo "$SCAN_RESULT" | python3 -c "
import sys, json
d = json.load(sys.stdin)
lines = []
total = 0
for o in d.get('newShortage',[]):
    for s in o['shortage']:
        total += 1
        lines.append(f\"- {o['code']} [{o.get('platform','')}] {s['sku']} {s['title'][:20]} 需{s['num']}件/库存{s['avail']}\")
body = f'### 🔴 检测到 {total} 个缺货品种\n\n' + '\n'.join(lines[:20])
body += '\n\n已打缺货标签，请在跟踪表中填写预计到货时间。'
print(body)
" 2>/dev/null)
  if [ -n "$NOTIFY_BODY" ]; then
    CS_USER_IDS=$(get_cs_user_ids)
    if [ -z "$CS_USER_IDS" ]; then
      CS_USER_IDS="$DEFAULT_AT_USER"
    fi
    CS_AT_TEXT=$(echo "$CS_USER_IDS" | tr ',' '\n' | sed 's/^/@/' | tr '\n' ' ' | sed 's/ $//')
    dws chat message send-by-bot \
      --robot-code "$ROBOT_CODE" --group "$NOTIFY_GROUP" \
      --at-user-ids "$CS_USER_IDS" \
      --title "🔴 缺货检测通知" --text "${CS_AT_TEXT}
${NOTIFY_BODY}" 2>&1 | \
      python3 -c "import sys,json;d=json.load(sys.stdin);print('  缺货通知已发送' if d.get('success') else '  缺货通知失败: '+str(d))" 2>/dev/null || echo '  缺货通知发送异常'
  fi
fi

# ---------- 5. 已到货：更新跟踪表 + 补录 + 通知 ----------
if [[ "$ARRIVED_COUNT" -gt 0 ]]; then
  step "检查到货订单跟踪表状态 ..."
  TRACKED=$(python3 "$TRACKER" fetch 2>/dev/null || echo "{}")
  ARRIVED_NOTIFY_FILE="$TMPDIR/arrived_notify.txt"

  echo "$SCAN_RESULT" | TRACKED="$TRACKED" TRACKER="$TRACKER" ARRIVED_NOTIFY_FILE="$ARRIVED_NOTIFY_FILE" python3 -c "
import sys, json, subprocess, os
d = json.load(sys.stdin)
tracked = json.loads(os.environ['TRACKED'])
tracker = os.environ['TRACKER']
notify_items = []  # [(code, platform, items)]
for o in d.get('arrived',[]):
    code = o['code']
    platform = o.get('platform','')
    items = o.get('items', [])
    # 查找跟踪表中是否有记录
    existing = None
    for key, r in tracked.items():
        if r['orderCode'] == code:
            existing = r
            break
    if existing:
        if existing['status'] == '缺货待到货':
            subprocess.run(['python3', tracker, 'mark-arrived', existing['recordId']],
                          capture_output=True, text=True, timeout=30)
            notify_items.append((code, platform, items))
            print(f'  [OK] {code} → 已更新为已到货待审')
        # 已到货待审或已审核的不重复通知
    else:
        # 跟踪表中无记录（可能之前手动打标），补录并标记到货
        if items:
            for it in items:
                data = {
                    'order_code': code,
                    'platform': platform,
                    'shop': o.get('shopName',''),
                    'sku': it['sku'],
                    'product': it.get('title',''),
                    'qty': it.get('num',1),
                    'stock': 999,  # 已到货，库存充足
                    'd3_id': o['id']
                }
                r = subprocess.run(['python3', tracker, 'create'],
                    input=json.dumps(data, ensure_ascii=False),
                    capture_output=True, text=True, timeout=30)
                resp = json.loads(r.stdout) if r.stdout.strip() else {}
                if resp.get('success'):
                    rid = resp['data']['newRecordIds'][0]
                    subprocess.run(['python3', tracker, 'mark-arrived', rid],
                                  capture_output=True, text=True, timeout=30)
            notify_items.append((code, platform, items))
            print(f'  [补录] {code} → 已补录跟踪表并标记到货')
        else:
            # 无商品信息，仍通知
            notify_items.append((code, platform, []))
            print(f'  [通知] {code} → 已到货（无商品明细）')

# 输出通知列表
if notify_items:
    with open(os.environ.get('ARRIVED_NOTIFY_FILE','/dev/null'),'w') as f:
        for code, platform, items in notify_items:
            item_str = '; '.join([f\"{it['sku']} {it.get('title','')[:15]}\" for it in items]) if items else ''
            f.write(f'{code}|{platform}|{item_str}\n')
" 2>&1
  if [ -f "$TMPDIR/arrived_notify.txt" ] && [ -s "$TMPDIR/arrived_notify.txt" ]; then
    # 构建通知消息
    NOTIFY_LINES=$(while IFS='|' read -r code platform items; do
      if [ -n "$items" ]; then
        echo "- $code [$platform] $items"
      else
        echo "- $code [$platform]"
      fi
    done < "$TMPDIR/arrived_notify.txt")
    ARRIVED_COUNT_NOTIFY=$(wc -l < "$TMPDIR/arrived_notify.txt" | tr -d ' ')
    # 动态获取客服人员
    CS_USER_IDS=$(get_cs_user_ids)
    if [ -z "$CS_USER_IDS" ]; then
      CS_USER_IDS="$DEFAULT_AT_USER"  # fallback 兜底用户
    fi
    # 构建 @文本（每个 userId 单独 @）
    CS_AT_TEXT=$(echo "$CS_USER_IDS" | tr ',' '\n' | sed 's/^/@/' | tr '\n' ' ' | sed 's/ $//')
    ARRIVED_BODY="${CS_AT_TEXT}
### 🟢 缺货订单已到货，请及时审核（${ARRIVED_COUNT_NOTIFY}单）

以下订单缺货商品已到货：
${NOTIFY_LINES}

请尽快在 D3 中完成审核。"
    dws chat message send-by-bot \
      --robot-code "$ROBOT_CODE" --group "$NOTIFY_GROUP" \
      --at-user-ids "$CS_USER_IDS" \
      --title "🟢 缺货已到货，请审单" --text "$ARRIVED_BODY" 2>&1 | \
      python3 -c "import sys,json;d=json.load(sys.stdin);print('  到货通知已发送' if d.get('success') else '  到货通知失败: '+str(d))" 2>/dev/null || echo '  到货通知发送异常'
  fi
fi

# ---------- 6. 已审核：闭环跟踪表 ----------
if [[ "$AUDITED_COUNT" -gt 0 ]]; then
  step "更新已审核订单状态 ..."
  TRACKED=$(python3 "$TRACKER" fetch 2>/dev/null || echo "{}")

  echo "$SCAN_RESULT" | TRACKED="$TRACKED" TRACKER="$TRACKER" python3 -c "
import sys, json, subprocess, os
d = json.load(sys.stdin)
tracked = json.loads(os.environ['TRACKED'])
tracker = os.environ['TRACKER']
for o in d.get('audited',[]):
    code = o['code']
    for key, r in tracked.items():
        if r['orderCode'] == code and r['status'] != '已审核':
            subprocess.run(['python3', tracker, 'mark-audited', r['recordId']],
                          capture_output=True, text=True, timeout=30)
            print(f'  [闭环] {code} → 已审核')
" 2>&1
fi

# ---------- 7. 汇总 ----------
echo ""
echo "========================================="
ok "本轮完成: 新缺货 $NEW_COUNT 单, 已到货 $ARRIVED_COUNT 单, 已审核 $AUDITED_COUNT 单"
echo "========================================="
