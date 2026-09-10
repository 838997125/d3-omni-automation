#!/usr/bin/env bash
# =============================================================================
# lib-config.sh —— D3 自动化套件统一配置加载器（shell 侧）
#
# 用法：在各脚本顶部  SCRIPT_DIR 确定之后：
#       source "$SCRIPT_DIR/lib-config.sh"
#
# 作用：
#   1. 加载 scripts/config.env（不存在则加载 deploy/config.env.example 的默认值）；
#   2. 导出全部 D3_* 配置给后续命令 / Python 子进程；
#   3. 提供 write_d3_credentials / cleanup_d3_credentials，
#      把 D3 地址与登录凭据写成 chmod 600 的临时 JSON，供浏览器 JS 读取，
#      脚本退出时自动删除（密码不落仓库、尽量不留磁盘）。
# =============================================================================

# 定位脚本目录（调用方已定义 SCRIPT_DIR 时直接用，否则自行推断）
if [ -z "${SCRIPT_DIR:-}" ]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fi

D3_CONFIG_FILE="${D3_CONFIG_FILE:-$SCRIPT_DIR/config.env}"
if [ ! -f "$D3_CONFIG_FILE" ]; then
  # 仓库首次克隆、尚未 cp config.env 时，用模板里的非密钥默认值
  D3_CONFIG_FILE="$SCRIPT_DIR/../deploy/config.env.example"
fi
# shellcheck disable=SC1090
set -a
# shellcheck disable=SC1090
[ -f "$D3_CONFIG_FILE" ] && source "$D3_CONFIG_FILE"
set +a

# 兜底默认（即使配置文件缺失也能跑通非密钥部分）
: "${D3_BASE_URL:=https://d3.diansan.com}"
: "${D3_ORDER_CHECK_URL:=$D3_BASE_URL/omni/order/order-check/indexFeature/index.html}"
: "${D3_PLAN_URL:=$D3_BASE_URL/omni/3rd-warehousing/stock-out-plan/index.html?stockPlanStatus=NOTIFY_SUCCESS}"
: "${D3_ROBOT_CODE:=REPLACE_WITH_YOUR_ROBOT_CODE}"
: "${D3_NOTIFY_GROUP:=REPLACE_WITH_YOUR_GROUP_CONVERSATION_ID}"
: "${D3_DEFAULT_AT_USER:=}"
: "${D3_ATABLE_BASE:=REPLACE_WITH_YOUR_BASE_ID}"
: "${D3_TABLE_AUDIT:=REPLACE_WITH_TABLE_ID_AUDIT}"
: "${D3_TABLE_BUDAN:=REPLACE_WITH_TABLE_ID_BUDAN}"
: "${D3_TABLE_SHORTAGE:=REPLACE_WITH_TABLE_ID_SHORTAGE}"
: "${D3_TABLE_STAFF:=REPLACE_WITH_TABLE_ID_STAFF}"
: "${D3_REPLACEMENT_SKU:=FF000748}"
: "${D3_SHORTAGE_TAG_ID:=613013}"
: "${D3_SELLER_MEMO:=0000}"
: "${D3_RUN_DIR:=/tmp}"
export D3_BASE_URL D3_ORDER_CHECK_URL D3_PLAN_URL D3_ROBOT_CODE D3_NOTIFY_GROUP
export D3_DEFAULT_AT_USER D3_ATABLE_BASE D3_TABLE_AUDIT D3_TABLE_BUDAN
export D3_TABLE_SHORTAGE D3_TABLE_STAFF D3_REPLACEMENT_SKU D3_SHORTAGE_TAG_ID
export D3_SELLER_MEMO D3_RUN_DIR D3_TENANT D3_USERNAME D3_PASSWORD D3_AUDIT_POLICY_URL

# 浏览器 JS 读取的凭据/地址文件
D3_CRED_FILE="${D3_CRED_FILE:-$D3_RUN_DIR/d3-credentials.json}"

write_d3_credentials() {
  umask 077
  D3_CRED_FILE="$D3_CRED_FILE" python3 - <<'PYEOF'
import os, json
p = os.environ.get("D3_CRED_FILE", "/tmp/d3-credentials.json")
cfg = {
    "baseUrl":        os.environ.get("D3_BASE_URL", ""),
    "orderCheckUrl":  os.environ.get("D3_ORDER_CHECK_URL", ""),
    "planUrl":        os.environ.get("D3_PLAN_URL", ""),
    "auditPolicyUrl": os.environ.get("D3_AUDIT_POLICY_URL", ""),
    "tenant":         os.environ.get("D3_TENANT", ""),
    "username":       os.environ.get("D3_USERNAME", ""),
    "password":       os.environ.get("D3_PASSWORD", ""),
    "replacementSku": os.environ.get("D3_REPLACEMENT_SKU", "FF000748"),
    "shortageTagId":  os.environ.get("D3_SHORTAGE_TAG_ID", "613013"),
    "sellerMemo":     os.environ.get("D3_SELLER_MEMO", "0000"),
}
tmp = p + ".tmp"
with open(tmp, "w") as f:
    json.dump(cfg, f, ensure_ascii=False)
os.chmod(tmp, 0o600)
os.replace(tmp, p)
PYEOF
  # 注册一次性清理（同一脚本多次 source 也只挂一次）
  if [ -z "${_D3_CRED_TRAP_SET:-}" ]; then
    trap 'cleanup_d3_credentials' EXIT TERM INT
    _D3_CRED_TRAP_SET=1
  fi
}

cleanup_d3_credentials() {
  [ -n "${D3_CRED_FILE:-}" ] && rm -f "$D3_CRED_FILE" "$D3_CRED_FILE.tmp" 2>/dev/null || true
}
