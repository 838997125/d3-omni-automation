#!/usr/bin/env bash
# =============================================================================
# install.sh —— D3 OMS 自动化套件 一键安装（macOS）
# 作用：
#   1. 检查依赖 dws / ego-browser / python3 / node；
#   2. 首次运行从 deploy/config.env.example 生成 scripts/config.env（不覆盖已有）；
#   3. 赋予脚本执行权限、创建 .state 运行态目录；
#   4. 渲染并安装 launchd 看门狗（群消息监听器，崩溃/开机自动拉起）。
# 定时任务（补单/缺货/冷链/拦截策略）需要在 OpenClaw 里按
# deploy/cron-jobs.json 创建，见 README。
# =============================================================================
set -euo pipefail

INSTALL_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$INSTALL_DIR"

CYAN='\033[0;36m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
step() { echo -e "${CYAN}[*] $*${NC}"; }
ok()   { echo -e "${GREEN}[OK] $*${NC}"; }
warn() { echo -e "${YELLOW}[!] $*${NC}"; }
err()  { echo -e "${RED}[ERR] $*${NC}"; }

# ---------- 1. 依赖检查 ----------
step "检查运行依赖..."
MISSING=0
need() { command -v "$1" >/dev/null 2>&1 && ok "$1: $(command -v "$1")" || { err "缺少依赖: $1"; MISSING=1; }; }
need python3
need node
need dws
need ego-browser
[ "$MISSING" = "1" ] && { err "请先安装缺失依赖（dws / ego-browser 见 README），再重跑本脚本。"; exit 1; }

PYTHON3="$(command -v python3)"

# ---------- 2. 生成 config.env ----------
if [ ! -f scripts/config.env ]; then
  step "生成 scripts/config.env（用模板默认值）..."
  cp deploy/config.env.example scripts/config.env
  warn "已生成 scripts/config.env：如需填写 D3 密码或改用别的钉钉组织，请编辑它。"
else
  ok "scripts/config.env 已存在，保留不覆盖。"
fi

# ---------- 3. 权限 + 运行态目录 ----------
step "赋予脚本执行权限、创建 .state 目录..."
chmod +x scripts/*.sh 2>/dev/null || true
mkdir -p .state
ok "运行态目录: $INSTALL_DIR/.state"

# ---------- 4. 语法自检 ----------
step "脚本语法自检..."
for f in scripts/*.sh; do bash -n "$f" || { err "bash 语法错误: $f"; exit 1; }; done
for f in scripts/*.py; do python3 -m py_compile "$f" || { err "python 语法错误: $f"; exit 1; }; done
for f in scripts/*.js scripts/*.mjs; do node --check "$f" || { err "node 语法错误: $f"; exit 1; }; done
ok "全部脚本语法通过。"

# ---------- 5. 安装 launchd 看门狗 ----------
LABEL="com.d3omni.audit-listener"
PLIST_DST="$HOME/Library/LaunchAgents/${LABEL}.plist"
mkdir -p "$HOME/Library/LaunchAgents"
step "渲染并安装 launchd 看门狗 -> $PLIST_DST"
sed \
  -e "s#__INSTALL_DIR__#$INSTALL_DIR#g" \
  -e "s#__HOME_DIR__#$HOME#g" \
  -e "s#__PYTHON3__#$PYTHON3#g" \
  deploy/com.d3omni.audit-listener.plist.template > "$PLIST_DST"

UID_NUM="$(id -u)"
launchctl bootout "gui/${UID_NUM}/${LABEL}" 2>/dev/null || true
launchctl bootstrap "gui/${UID_NUM}" "$PLIST_DST" 2>/dev/null || launchctl load "$PLIST_DST"
sleep 2
if launchctl list "$LABEL" >/dev/null 2>&1; then
  ok "监听器已由 launchd 托管（开机自启、崩溃自动拉起）。"
else
  warn "launchd 加载可能未成功，可稍后手动执行：scripts/audit-listener-ctl.sh start"
fi

echo
ok "安装完成。下一步："
echo "  1) 编辑 scripts/config.env（至少确认 D3_TENANT/D3_USERNAME，必要时填 D3_PASSWORD）"
echo "  2) 确认 dws 已登录：dws auth status"
echo "  3) 在 OpenClaw 按 deploy/cron-jobs.json 创建 4 个定时任务（把 <INSTALL_DIR> 替换为 $INSTALL_DIR）"
echo "  4) 手动验证：bash scripts/d3-audit-policy.sh --dry-run"
echo "  监听器管理：scripts/audit-listener-ctl.sh {start|stop|kick|status|log}"
