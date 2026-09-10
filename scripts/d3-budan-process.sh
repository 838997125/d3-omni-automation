#!/usr/bin/env bash
# d3-budan-process.sh — 补单/占单自动处理（ego-browser 版本）
set -euo pipefail
export PATH="$HOME/.local/bin:$PATH"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/lib-config.sh"
EGO_JS="$SCRIPT_DIR/ego-budan.js"
POST_PY="$SCRIPT_DIR/budan-postprocess.py"

# 防并发（2026-09-07 修订）：【必须全局互斥】。
# 旧设计“不用锁、超时轮次换一个 ego task space 继续跑”会导致两个浏览器 tab 同时
# 操作同一批 D3 订单：一个 tab 已换货/审核，另一个 tab 读到中间态报“换货弹窗未打开/
# 货品行未变运费链接2”的假失败，甚至在换货未完成时订单被放行审核（原货流出）。
# 现改为：拿不到锁说明上一轮还在跑，本轮直接跳过，等下一个 5 分钟轮，绝不并发。
LOCK_DIR="$D3_RUN_DIR/d3-budan.lock"
_lwarn() { echo "[!] $*" >&2; }
# 杀掉上一轮残留的 ego-browser 进程组（cron 超时 SIGKILL shell 后，ego 子进程可能成孤儿继续跑，
# 与新一轮并发操作同一批 D3 单、还会互相覆盖台账）。锁目录里 ego.pgid 记录其独立进程组 ID。
_kill_ego_group() {
  local pgid
  pgid=$(cat "$LOCK_DIR/ego.pgid" 2>/dev/null || echo "")
  if [ -n "$pgid" ] && [ "$pgid" != "$$" ]; then
    kill -TERM -"$pgid" 2>/dev/null || true
    sleep 0.3
    kill -KILL -"$pgid" 2>/dev/null || true
  fi
}
_cleanup() {
  _kill_ego_group
  rm -rf "$LOCK_DIR"
}
acquire_lock() {
  for _ in 1 2 3; do
    if mkdir "$LOCK_DIR" 2>/dev/null; then
      echo "$$" > "$LOCK_DIR/pid"
      echo "$(date +%s)" > "$LOCK_DIR/start"
      # shell 正常退出/被终止都杀掉 ego 进程组并释放锁；SIGKILL 残留由下轮 stale 检测清理
      trap '_cleanup' EXIT TERM INT
      return 0
    fi
    local lpid
    lpid=$(cat "$LOCK_DIR/pid" 2>/dev/null || echo "")
    if [ -n "$lpid" ] && kill -0 "$lpid" 2>/dev/null; then
      _lwarn "上一轮补单仍在运行(PID $lpid)，本轮跳过，等下一轮"
      exit 0
    fi
    # 持锁 shell 已不在：锁里记的 ego 进程组必是孤儿（正常结束时已随 wait 退出，kill 无副作用）。
    # 无论锁龄多少都先杀掉孤儿 ego，防止它与后续轮次并发、互相覆盖台账。
    _kill_ego_group
    # 可能是 stale 锁（超时被 SIGKILL）。安全起见再等一轮，锁龄超 10 分钟才判 stale 清理重建。
    local lstart now age
    lstart=$(cat "$LOCK_DIR/start" 2>/dev/null || echo 0)
    now=$(date +%s); age=$(( now - lstart ))
    if [ "$age" -lt 600 ]; then
      _lwarn "锁存在但持锁进程已结束(锁龄 ${age}s)，已杀残留 ego，本轮保守跳过"
      exit 0
    fi
    _lwarn "发现 stale 锁(锁龄 ${age}s)，清理后重建"
    rm -rf "$LOCK_DIR"
  done
  _lwarn "多次获取锁失败，本轮跳过"
  exit 0
}
acquire_lock

SPACE_INDEX=$(( $(date +%s) / 300 % 3 ))
case "$SPACE_INDEX" in
  0) TASK_SPACE="d3-budan" ;;
  1) TASK_SPACE="d3-budan-2" ;;
  2) TASK_SPACE="d3-budan-3" ;;
esac
export TASK_SPACE

ATABLE_BASE="$D3_ATABLE_BASE"
ATABLE_TABLE="$D3_TABLE_BUDAN"

F_ORDER_CODE="01ZM8y7"
F_TYPE="8ieSYcc"
F_SUBMITTER="LHyIW6D"
F_STATUS="VJQCRFk"
F_SUBMIT_TIME="g6Tme2D"   # 提交时间（自补单 30 分钟未完成提醒用）

step() { echo "[*] $*" >&2; }
ok()   { echo "[OK] $*" >&2; }
warn() { echo "[!] $*" >&2; }

# 1. 查询钉钉表格待处理记录
# 服务端过滤：只取“待处理”或状态为空的记录（or + eq/un_exist），并用 --field-ids 裁剪返回列。
# 这样每轮读回的只有活跃待处理记录（个位数），读量恒定、不随登记表历史总量增长；
# 回写本就是按 recordId 定点 update，同样与表总量无关。
FILTERS='{"operator":"or","operands":[{"operator":"eq","operands":["VJQCRFk","待处理"]},{"operator":"un_exist","operands":["VJQCRFk"]}]}'
FIELD_IDS="01ZM8y7,8ieSYcc,LHyIW6D,VJQCRFk,g6Tme2D"
step "查询钉钉表格待处理记录..."
STATE_DIR="${D3_STATE_DIR:-$SCRIPT_DIR/../.state}"
mkdir -p "$STATE_DIR" 2>/dev/null || STATE_DIR="$D3_RUN_DIR"
export D3_STATE_DIR="$STATE_DIR"
PENDING_JSON=$(dws aitable record query \
  --base-id "$ATABLE_BASE" \
  --table-id "$ATABLE_TABLE" \
  --field-ids "$FIELD_IDS" \
  --filters "$FILTERS" \
  --all 2>/dev/null | python3 -c "
import sys, json, re
F_ORDER_CODE='$F_ORDER_CODE'
F_TYPE='$F_TYPE'
F_SUBMITTER='$F_SUBMITTER'
F_STATUS='$F_STATUS'
F_SUBMIT_TIME='$F_SUBMIT_TIME'
data = json.load(sys.stdin)
records = data.get('data', {}).get('records', []) or []
if records is None:
    records = []
pending = []
for r in records:
    cells = r.get('cells', {})
    status = cells.get(F_STATUS, '')
    if isinstance(status, dict): status = status.get('name', '')
    elif isinstance(status, list) and status: status = status[0].get('name','')
    if status and status != '待处理': continue
    order_raw = cells.get(F_ORDER_CODE, '')
    if isinstance(order_raw, list) and order_raw:
        order_raw = order_raw[0].get('text','') if isinstance(order_raw[0], dict) else str(order_raw[0])
    elif not isinstance(order_raw, str):
        order_raw = str(order_raw) if order_raw else ''
    # 净化复制带入的异常字符（2026-09-08）：
    # ① NFKC 归一化：全角数字/全角字母/全角标点 → 半角（如 １２３→123，；→;）；
    # ② 删除所有 Unicode「格式控制符」(category Cf)：零宽空格 U+200B、BOM U+FEFF、
    #    零宽连接/软连字符/双向控制符等肉眼不可见字符——它们会粘在单号前导致 D3 精确匹配失败、
    #    单一直卡待审核（在 D3 搜索框粘贴后按一下删除键删掉的就是这类字符）；
    # ③ 剩余异常空白（全角空格 U+3000、不间断空格 U+00A0、行/段分隔符）统一换成换行，
    #    避免把两个单号连在一起。按 Unicode 类别处理，不枚举单个字符，一网打尽未来变种。
    import unicodedata as _ud
    order_raw = _ud.normalize('NFKC', order_raw)
    order_raw = ''.join(ch for ch in order_raw if _ud.category(ch) != 'Cf')
    order_raw = re.sub(r'[\u00a0\u3000\u2028\u2029]', '\n', order_raw)
    codes = [c.strip() for c in re.split(r'[\n\r,，;；\s\t]+', order_raw) if c.strip()]
    rtype = cells.get(F_TYPE, '')
    if isinstance(rtype, dict): rtype = rtype.get('name', '')
    elif isinstance(rtype, list) and rtype: rtype = rtype[0].get('name','')
    submitter = cells.get(F_SUBMITTER, [])
    sid = submitter[0].get('userId','') if isinstance(submitter, list) and submitter else ''
    # 提交时间：钉钉返回 ISO 字符串（2026-09-05T17:32:10+08:00），原样透传，由 postprocess 算龄期
    submit_time = cells.get(F_SUBMIT_TIME, '') or ''
    if not isinstance(submit_time, str):
        submit_time = str(submit_time)
    if codes:
        pending.append({'recordId': r['recordId'], 'orderCodes': codes, 'type': rtype, 'submitterId': sid, 'submitTime': submit_time})
print(json.dumps(pending, ensure_ascii=False))
")

PENDING_COUNT=$(echo "$PENDING_JSON" | python3 -c "import sys,json;print(len(json.load(sys.stdin)))")
if [ "$PENDING_COUNT" -eq 0 ]; then
  ok "没有待处理记录"
  exit 0
fi
ok "找到 $PENDING_COUNT 条待处理记录"

# 2. 通过 ego-browser 执行D3操作
step "通过 ego-browser 执行D3操作（task space $TASK_SPACE）..."
write_d3_credentials
LEDGER_FILE="$STATE_DIR/budan-ledger.json"
# 每轮独立临时输入文件，避免并发轮次互写临时文件
INPUT_FILE="$D3_RUN_DIR/budan-pending-$$-$RANDOM.json"
python3 -c "import json,sys; print(json.dumps({'taskSpace': '$TASK_SPACE', 'ledgerPath': '$LEDGER_FILE', 'credFile': '$D3_CRED_FILE', 'records': json.loads(sys.stdin.read())}, ensure_ascii=False))" <<< "$PENDING_JSON" > "$INPUT_FILE"
EGO_OUT="$D3_RUN_DIR/budan-ego-$$-$RANDOM.out"
EGO_RUNJS="$D3_RUN_DIR/budan-run-$$-$RANDOM.js"
{ echo "globalThis.__BUDAN_INPUT__='$INPUT_FILE';"; cat "$EGO_JS"; } > "$EGO_RUNJS"
# 关键：用带 `set -m` 的子 shell 让 ego 在【独立进程组】后台运行，并把其 PID(=进程组 PGID) 写入锁目录。
# cron 超时杀 shell 时，trap（或下轮 stale 接管）能 `kill -PGID` 把 ego-browser 及其子孙整组杀光，
# 杜绝孤儿 ego 与新一轮并发、互相覆盖台账。
bash -c '
  set -m
  OUT="$1"; JS="$2"; PGF="$3"
  ego-browser nodejs < "$JS" > "$OUT" 2>&1 &
  echo $! > "$PGF"   # set -m 下后台单命令 PID 即其新进程组 PGID
  wait
' _ "$EGO_OUT" "$EGO_RUNJS" "$LOCK_DIR/ego.pgid" &
EGO_WRAP=$!
wait "$EGO_WRAP" || true
EGO_OUTPUT=$(cat "$EGO_OUT" 2>/dev/null || true)
rm -f "$EGO_OUT" "$EGO_RUNJS" "$INPUT_FILE" "$LOCK_DIR/ego.pgid" "$D3_CRED_FILE" 2>/dev/null || true
echo "$EGO_OUTPUT" >&2

RESULT_JSON=$(echo "$EGO_OUTPUT" | grep '^RESULT_JSON:' | sed 's/^RESULT_JSON://')
if [ -z "$RESULT_JSON" ]; then
  warn "未获取到处理结果"
  exit 1
fi

# 3. 回写表格 + 发群通知
TMP_RESULT="$D3_RUN_DIR/budan-result-$$-$RANDOM.json"
echo "$RESULT_JSON" > "$TMP_RESULT"
python3 "$POST_PY" "$TMP_RESULT"
rm -f "$TMP_RESULT"

ok "本轮处理完成"
