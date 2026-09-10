#!/usr/bin/env bash
# d3-coldchain.sh — D3 OMS 冷链异常单自动处理 (Mac/Linux bash 版)
# 依赖: opencli browser + Browser Bridge Chrome 扩展
set -euo pipefail

SESSION="d3-coldchain"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/lib-config.sh"
BASE_URL="$D3_BASE_URL"
TIMEOUT_MS=30000
EXCEPTION_REASON="冷链"
SKU_FILE="$SCRIPT_DIR/d3-coldchain-skus.txt"
SKU_CODES=""

# D3 登录凭据（从 config.env / 环境读取；旧 opencli 版，推荐用 ego 版 d3-coldchain-ego.sh）
# 不再硬编码密码；D3_TENANT/D3_USERNAME/D3_PASSWORD 已由 lib-config.sh 提供
: "${D3_TENANT:=亿民盛世}"
: "${D3_USERNAME:=}"

# ---------- colors ----------
if [[ -t 1 ]]; then
  CYAN='\033[0;36m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
  RED='\033[0;31m'; WHITE='\033[1;37m'; NC='\033[0m'
else
  CYAN=''; GREEN=''; YELLOW=''; RED=''; WHITE=''; NC=''
fi
step()  { echo -e "${CYAN}[*] $*${NC}"; }
ok()    { echo -e "${GREEN}[OK] $*${NC}"; }
warn()  { echo -e "${YELLOW}[!] $*${NC}"; }
err()   { echo -e "${RED}[ERR] $*${NC}"; }

# ---------- args ----------
usage() {
  cat <<EOF
用法: $0 [选项]
  -s, --skus CODES       逗号分隔的 SKU 编码
  -f, --sku-file FILE    SKU 文件路径 (默认: 脚本同目录 d3-coldchain-skus.txt)
  -r, --reason REASON    异常原因 (默认: 冷链)
      --session NAME     opencli 会话名 (默认: d3-coldchain)
      --base-url URL     D3 地址 (默认: https://d3.diansan.com)
  -h, --help             显示帮助
EOF
  exit 0
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -s|--skus)      SKU_CODES="$2"; shift 2;;
    -f|--sku-file)  SKU_FILE="$2"; shift 2;;
    -r|--reason)    EXCEPTION_REASON="$2"; shift 2;;
    --session)      SESSION="$2"; shift 2;;
    --base-url)     BASE_URL="$2"; shift 2;;
    -h|--help)      usage;;
    *) err "未知参数: $1"; usage;;
  esac
done

# ---------- opencli wrapper ----------
oc() {
  opencli browser "$SESSION" "$@" 2>&1
}

wait_s() { sleep "$1"; }

# ---------- normalize SKU ----------
if [[ -n "$SKU_CODES" ]]; then
  SKU_LIST="$SKU_CODES"
  SKU_COUNT=$(echo "$SKU_CODES" | tr ',' '\n' | grep -c . || true)
elif [[ -f "$SKU_FILE" ]]; then
  step "未指定 SKU 参数，从文件读取: $SKU_FILE"
  SKU_LIST=$(grep -v '^\s*#' "$SKU_FILE" | grep -v '^\s*$' | tr '\n' ',' | sed 's/,$//')
  SKU_COUNT=$(grep -v '^\s*#' "$SKU_FILE" | grep -vc '^\s*$' || true)
else
  err "未提供 SKU 编码，且默认文件不存在: $SKU_FILE"
  exit 1
fi

if [[ -z "$SKU_LIST" ]]; then
  err "SKU 列表为空，请检查参数或文件内容"
  exit 1
fi

echo ""
echo -e "${WHITE}========================================${NC}"
echo -e "${WHITE} D3 冷链异常单自动处理${NC}"
echo -e "${WHITE} SKU 数量: $SKU_COUNT${NC}"
echo -e "${WHITE} 异常原因: $EXCEPTION_REASON${NC}"
echo -e "${WHITE}========================================${NC}"
echo ""

# ---------- 1. open order review page ----------
ORDER_PAGE_URL="$BASE_URL/omni/order/order-check/indexFeature/index.html"
step "打开 D3 订单客审页面 ..."
oc tab new "$ORDER_PAGE_URL" >/dev/null || true
wait_s 5

CURRENT_URL=$(oc get url 2>/dev/null || echo "")
if echo "$CURRENT_URL" | grep -q "/login/"; then
  step "需要登录，执行登录 ..."
  # 填租户
  oc fill "#tenantName" "$D3_TENANT" >/dev/null || true
  wait_s 1
  # 填账号
  oc fill "#userName" "$D3_USERNAME" >/dev/null || true
  wait_s 1
  # 填密码
  oc fill "#userPass" "$D3_PASSWORD" >/dev/null || true
  wait_s 1
  # 点击登录
  oc click ".app-login-form-submit" >/dev/null || true
  wait_s 6
  # 检查是否有密码过期提示
  STATE=$(oc state 2>/dev/null || echo "")
  if echo "$STATE" | grep -q "我知道了"; then
    step "关闭密码过期提示 ..."
    oc click --text "我知道了，继续登录" >/dev/null || true
    wait_s 5
  fi
  # 检查是否登录成功
  LOGIN_URL=$(oc get url 2>/dev/null || echo "")
  if echo "$LOGIN_URL" | grep -q "/login/"; then
    err "登录失败，仍在登录页: $LOGIN_URL"
    err "请检查租户/账号/密码是否正确，或在浏览器中手动登录一次后重试"
    exit 1
  fi
  ok "登录成功"
  step "导航到订单客审 ..."
  oc tab new "$ORDER_PAGE_URL" >/dev/null || true
  wait_s 6
fi

CURRENT_URL=$(oc get url 2>/dev/null || echo "")
TITLE=$(oc get title 2>/dev/null || echo "")
if ! echo "$CURRENT_URL" | grep -q "order-check"; then
  err "未能到达订单客审页面，当前URL: $CURRENT_URL"
  exit 1
fi
ok "已进入: $TITLE"

# ---------- 2. set product field to SKU code ----------
step "设置货品信息字段为「货品sku编码」..."
oc click '[title=货品名称]' >/dev/null || true
wait_s 1
oc click --role option --text "货品sku编码" >/dev/null 2>&1 || \
  oc click "li.ant-select-dropdown-menu-item:nth-child(2)" >/dev/null || true
wait_s 1
ok "字段已设置为货品sku编码"

# ---------- 3. set match mode ----------
step "设置匹配方式为「包含任一」..."
oc click '[title=全包含]' >/dev/null || true
wait_s 1
oc click --role option --text "包含任一" >/dev/null || true
wait_s 1
oc keys Escape >/dev/null || true
ok "匹配方式已设置为包含任一"

# ---------- 4. fill SKU codes ----------
step "填入 $SKU_COUNT 个 SKU 编码 ..."
oc fill "input[placeholder=货品信息]" "$SKU_LIST" >/dev/null || true
ok "SKU 编码已填入"

# ---------- 5. search ----------
step "点击查询按钮 ..."
oc click "button.ant-btn-primary" >/dev/null || true
wait_s 5

# ---------- 6. check result ----------
PAGE_TEXT=$(oc eval "document.body.innerText" 2>/dev/null || echo "")
TOTAL_COUNT=0
if echo "$PAGE_TEXT" | grep -qoE '共[0-9]+条'; then
  TOTAL_COUNT=$(echo "$PAGE_TEXT" | grep -oE '共[0-9]+条' | head -1 | grep -oE '[0-9]+')
fi

echo ""
if [[ "$TOTAL_COUNT" -eq 0 ]]; then
  warn "查询结果：共0条订单，无需处理。"
  echo ""
  exit 0
fi
ok "查询结果：共 $TOTAL_COUNT 条待审核订单"
echo ""

# ---------- 7. select all (canvas table via Vue method) ----------
step "全选 $TOTAL_COUNT 条订单 ..."
CHECK_ALL_JS="(function(){var st=document.querySelectorAll('.spreadtable')[0];if(!st||!st.__vue__)return'no-table';st.__vue__._onCheckAll();return'ok';})()"
CHECK_RESULT=$(oc eval "$CHECK_ALL_JS" 2>/dev/null || echo "fail")
if [[ "$CHECK_RESULT" != "ok" ]]; then
  warn "Vue 全选返回: $CHECK_RESULT，尝试 Ctrl+A ..."
  oc click canvas >/dev/null || true
  oc keys Control+a >/dev/null || true
fi
wait_s 1
PAGE_TEXT2=$(oc eval "document.body.innerText" 2>/dev/null || echo "")
SEL_COUNT=""
if echo "$PAGE_TEXT2" | grep -qoE '已勾选[0-9]+条'; then
  SEL_COUNT=$(echo "$PAGE_TEXT2" | grep -oE '已勾选[0-9]+条' | head -1 | grep -oE '[0-9]+')
  ok "已勾选 $SEL_COUNT 条订单"
else
  warn "无法确认勾选数量"
fi

# ---------- 8. mark exception ----------
step "点击「标记异常」按钮 ..."
oc click --text "标记异常" >/dev/null || true
wait_s 2

# ---------- 9. select reason ----------
step "选择异常原因：$EXCEPTION_REASON ..."
oc click ".ant-modal .ant-select" >/dev/null || true
wait_s 1
oc click --role option --text "$EXCEPTION_REASON" >/dev/null || true
wait_s 1
ok "异常原因已选择：$EXCEPTION_REASON"

# ---------- 10. confirm ----------
step "点击「确定」提交 ..."
oc click ".ant-modal button.ant-btn-primary" >/dev/null || true
wait_s 5

# ---------- 11. verify ----------
FINAL_TEXT=$(oc eval "document.body.innerText" 2>/dev/null || echo "")
FINAL_COUNT=0
if echo "$FINAL_TEXT" | grep -qoE '共[0-9]+条'; then
  FINAL_COUNT=$(echo "$FINAL_TEXT" | grep -oE '共[0-9]+条' | head -1 | grep -oE '[0-9]+')
fi
MODAL_CHECK=$(oc eval "(function(){var m=document.querySelector('.ant-modal-wrap');return m?getComputedStyle(m).display:'none';})()" 2>/dev/null || echo "unknown")

echo ""
echo -e "${WHITE}========================================${NC}"
if [[ "$MODAL_CHECK" == "none" && "$FINAL_COUNT" -ge 0 ]]; then
  echo -e "${GREEN} 处理完成!${NC}"
  echo -e "${WHITE} 原查询结果: $TOTAL_COUNT 条${NC}"
  echo -e "${WHITE} 剩余待审核: $FINAL_COUNT 条${NC}"
  HANDLED=$((TOTAL_COUNT - FINAL_COUNT))
  if [[ "$HANDLED" -gt 0 ]]; then
    echo -e "${GREEN} 成功标记异常: $HANDLED 条 ($EXCEPTION_REASON)${NC}"
  fi
else
  echo -e "${YELLOW} 操作可能未完全成功，请检查浏览器${NC}"
  echo -e "${YELLOW} modal=$MODAL_CHECK final=$FINAL_COUNT${NC}"
fi
echo -e "${WHITE}========================================${NC}"
echo ""
