#!/usr/bin/env bash
# d3-coldchain-ego.sh — D3 冷链异常单自动处理 (ego-browser 版)
# 固定 task space ID: 25 (d3-coldchain-auto)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/lib-config.sh"
SKU_FILE="$SCRIPT_DIR/d3-coldchain-skus.txt"
JS_FILE="$SCRIPT_DIR/ego-coldchain.mjs"
EXCEPTION_REASON="冷链"
PARAM_FILE="$D3_RUN_DIR/d3-coldchain-params.json"

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
    -s|--skus)      SKU_CODES="$2"; shift 2;;
    -f|--sku-file)  SKU_FILE="$2"; shift 2;;
    -r|--reason)    EXCEPTION_REASON="$2"; shift 2;;
    -h|--help)      echo "用法: $0 [--skus CODES] [--sku-file FILE] [--reason REASON]"; exit 0;;
    *) err "未知参数: $1"; exit 1;;
  esac
done

if [[ -n "${SKU_CODES:-}" ]]; then
  SKU_LIST="$SKU_CODES"
  SKU_COUNT=$(echo "$SKU_CODES" | tr ',' '\n' | grep -c . || true)
elif [[ -f "$SKU_FILE" ]]; then
  SKU_LIST=$(grep -v '^\s*#' "$SKU_FILE" | grep -v '^\s*$' | tr '\n' ',' | sed 's/,$//')
  SKU_COUNT=$(grep -v '^\s*#' "$SKU_FILE" | grep -vc '^\s*$' || true)
else
  err "未找到 SKU 文件: $SKU_FILE"; exit 1
fi

if [[ -z "$SKU_LIST" ]]; then err "SKU 列表为空"; exit 1; fi

echo ""
echo "========================================"
echo " D3 冷链异常单 (ego-browser)"
echo " SKU: $SKU_COUNT 个 | 原因: $EXCEPTION_REASON"
echo "========================================"
echo ""

# 写参数文件（含登录/地址配置；密码从 config.env 读取，不入库）
CRED_FILE="$D3_RUN_DIR/d3-credentials.json"
write_d3_credentials
ORDER_URL="$D3_ORDER_CHECK_URL"
TENANT="$D3_TENANT" USER="$D3_USERNAME" PASS="$D3_PASSWORD" URL="$ORDER_URL" CRED="$CRED_FILE" \
SKU_LIST="$SKU_LIST" REASON="$EXCEPTION_REASON" N="$SKU_COUNT" PARAM="$PARAM_FILE" python3 - <<'PYEOF'
import os, json
json.dump({
    "skuList": os.environ["SKU_LIST"],
    "exceptionReason": os.environ["REASON"],
    "skuCount": int(os.environ["N"]),
    "orderPageUrl": os.environ["URL"],
    "tenant": os.environ["TENANT"],
    "username": os.environ["USER"],
    "password": os.environ["PASS"],
    "credFile": os.environ["CRED"],
}, open(os.environ["PARAM"], "w"), ensure_ascii=False)
PYEOF

step "执行浏览器操作 ..."
ego-browser nodejs < "$JS_FILE" 2>&1 || true