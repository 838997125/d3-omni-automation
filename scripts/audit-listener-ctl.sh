#!/usr/bin/env bash
# audit-listener-ctl.sh — 监听服务管理（launchd 看门狗版）
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/lib-config.sh"
STATE_DIR="${D3_STATE_DIR:-$SCRIPT_DIR/../.state}"
mkdir -p "$STATE_DIR" 2>/dev/null || STATE_DIR="${D3_RUN_DIR:-/tmp}"
LISTENER="$SCRIPT_DIR/audit-listener.py"
PID_FILE="$STATE_DIR/d3-audit-listener.pid"
LOG_FILE="$STATE_DIR/d3-audit-listener.log"
LAUNCHD_ERR_LOG="$STATE_DIR/d3-audit-listener.launchd.err.log"
AUDIT_SCRIPT="$SCRIPT_DIR/d3-audit-policy.sh"

LABEL="${D3_LISTENER_LABEL:-com.d3omni.audit-listener}"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
UID_NUM="$(id -u)"
LAUNCHD_DOMAIN="gui/${UID_NUM}/${LABEL}"

# 输出颜色
if [[ -t 1 ]]; then
  CYAN='\033[0;36m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
else
  CYAN=''; GREEN=''; YELLOW=''; RED=''; NC=''
fi
step() { echo -e "${CYAN}[*] $*${NC}"; }
ok()   { echo -e "${GREEN}[OK] $*${NC}"; }
warn() { echo -e "${YELLOW}[!] $*${NC}"; }
err()  { echo -e "${RED}[ERR] $*${NC}"; }

launchd_loaded() {
  launchctl list "$LABEL" >/dev/null 2>&1
}

# launchctl list <label> 输出为 plist 风格：`"PID" = 58806;`
launchd_field() {
  launchctl list "$LABEL" 2>/dev/null | awk -F'= ' '/"'"$1"'"/{print $2}' | tr -d ' ;\t'
}

# 停掉任何游离的（非 launchd 托管）nohup 进程，避免双开
kill_orphans() {
  if [ -f "$PID_FILE" ]; then
    local opid
    opid="$(cat "$PID_FILE" 2>/dev/null || true)"
    if [ -n "$opid" ] && kill -0 "$opid" 2>/dev/null; then
      # 仅当该进程不是 launchd 托管时才手动杀（launchd 托管的由 bootout 处理）
      if ! launchd_loaded; then
        warn "发现游离监听进程 PID $opid，停止它..."
        kill "$opid" 2>/dev/null || true
        sleep 1
        kill -9 "$opid" 2>/dev/null || true
      fi
    fi
    rm -f "$PID_FILE"
  fi
}

case "${1:-status}" in
  start)
    if launchd_loaded; then
      pid="$(launchd_field PID)"
      ok "看门狗(launchd)已在托管，监听运行中 (PID ${pid:-?})"
      exit 0
    fi
    if [ ! -f "$PLIST" ]; then
      err "找不到 plist: $PLIST"
      exit 1
    fi
    kill_orphans
    step "加载 launchd 看门狗并启动..."
    launchctl bootstrap "gui/${UID_NUM}" "$PLIST" 2>/dev/null || launchctl load "$PLIST"
    sleep 2
    if launchd_loaded; then
      pid="$(launchd_field PID)"
      ok "✅ 监听服务已由 launchd 托管 (PID ${pid:-?})，崩溃/重启后自动拉起"
      echo "   日志: tail -f $LOG_FILE"
    else
      err "启动失败，查看: $LAUNCHD_ERR_LOG"
      exit 1
    fi
    ;;

  stop)
    if launchd_loaded; then
      step "卸载 launchd 看门狗（停止自动拉起）..."
      launchctl bootout "$LAUNCHD_DOMAIN" 2>/dev/null || launchctl unload "$PLIST" 2>/dev/null || true
      sleep 1
      ok "✅ 看门狗已卸载，监听服务停止（不会自动重启）"
    else
      warn "launchd 未托管该服务"
    fi
    kill_orphans
    ;;

  restart)
    "$0" stop
    sleep 1
    "$0" start
    ;;

  # 看门狗在跑时，进程若崩会被自动拉起；kickstart 强制立即重启一次
  kick)
    step "立即重启监听进程（看门狗保持托管）..."
    launchctl kickstart -k "$LAUNCHD_DOMAIN" 2>/dev/null || { err "kickstart 失败，服务可能未加载"; exit 1; }
    sleep 2
    "$0" status
    ;;

  status)
    if launchd_loaded; then
      pid="$(launchd_field PID)"
      last="$(launchd_field LastExitStatus)"
      if [ -n "$pid" ] && [ "$pid" != "-" ]; then
        echo -e "${GREEN}✅ 监听服务运行中 (PID $pid)，launchd 看门狗托管中${NC}"
      else
        echo -e "${YELLOW}⚠️  看门狗已加载但进程未在运行（LastExitStatus=$last），将自动重启${NC}"
      fi
    else
      echo -e "${RED}❌ 监听服务未运行（launchd 未托管）${NC}"
    fi
    echo ""
    echo "最近日志:"
    tail -5 "$LOG_FILE" 2>/dev/null || echo "  (无日志)"
    ;;

  log)
    tail -f "$LOG_FILE" 2>/dev/null || echo "无日志文件"
    ;;

  # 手动触发一次 D3 拦截/恢复处理（不等 cron）
  process)
    echo "执行 D3 拦截/恢复处理..."
    bash "$AUDIT_SCRIPT" "${@:2}"
    ;;

  *)
    echo "用法: $0 {start|stop|restart|kick|status|log|process}"
    echo ""
    echo "  start    加载 launchd 看门狗并启动监听（崩溃/开机自动拉起）"
    echo "  stop     卸载看门狗并停止（不会自动重启）"
    echo "  restart  重启服务"
    echo "  kick     看门狗保持托管，立即重启一次进程"
    echo "  status   查看运行状态"
    echo "  log      实时查看日志"
    echo "  process  手动执行一次 D3 拦截/恢复处理"
    exit 1
    ;;
esac
