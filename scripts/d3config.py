#!/usr/bin/env python3
"""
d3config.py —— D3 自动化套件统一配置加载器（Python 侧）

所有 Python 脚本统一通过本模块读取资源标识与运行参数，避免把 Base/Table/
群 ID/机器人编码硬编码进各个文件。敏感的 D3 登录密码不放在这里。

配置来源优先级（后者覆盖前者）：
  1. 内置占位默认值（真实值通过 scripts/config.env 提供，仓库不含任何组织信息）；
  2. scripts/config.env（部署时由 deploy/config.env.example 复制并填写）；
  3. 同名环境变量（便于临时覆盖 / CI）。

注意：钉钉多维表字段 ID（各表列的 field id）仍保留在各业务脚本顶部，
因为它们与具体多维表强绑定、属于结构定义；迁移到全新多维表时需按新表
实际字段 ID 调整（README 有说明）。
"""
import os

_HERE = os.path.dirname(os.path.abspath(__file__))


def _load_env_file():
    """从 config.env（或模板）读取 KEY=VALUE 到 os.environ（不覆盖已有环境变量）。"""
    candidates = [
        os.path.join(_HERE, "config.env"),
        os.path.join(_HERE, "..", "deploy", "config.env.example"),
    ]
    for path in candidates:
        path = os.path.abspath(path)
        if not os.path.isfile(path):
            continue
        try:
            with open(path, encoding="utf-8") as f:
                for raw in f:
                    line = raw.strip()
                    if not line or line.startswith("#") or "=" not in line:
                        continue
                    if line.startswith("export "):
                        line = line[len("export "):]
                    key, _, val = line.partition("=")
                    key = key.strip()
                    val = val.strip()
                    # 正确处理引号与引号外的行内注释
                    if val[:1] in ('"', "'"):
                        q = val[0]
                        end = val.find(q, 1)
                        val = val[1:end] if end >= 0 else val[1:]
                    else:
                        # 无引号值：遇到空格+# 视为注释开始
                        idx = val.find("  #")
                        if idx >= 0:
                            val = val[:idx]
                        val = val.strip()
                    # 不覆盖已存在的真实环境变量
                    if key and key not in os.environ:
                        os.environ[key] = val
        except Exception:
            pass
        # 读到第一个存在的文件即停（config.env 优先于模板）
        break


_load_env_file()


def _cfg(key, default):
    return os.environ.get(key, default)


# ---- D3 OMS ----------------------------------------------------------------
D3_BASE_URL = _cfg("D3_BASE_URL", "https://d3.diansan.com")
D3_ORDER_CHECK_URL = _cfg(
    "D3_ORDER_CHECK_URL",
    D3_BASE_URL + "/omni/order/order-check/indexFeature/index.html")
D3_PLAN_URL = _cfg(
    "D3_PLAN_URL",
    D3_BASE_URL + "/omni/3rd-warehousing/stock-out-plan/index.html"
                  "?stockPlanStatus=NOTIFY_SUCCESS")
D3_AUDIT_POLICY_URL = _cfg(
    "D3_AUDIT_POLICY_URL",
    D3_BASE_URL + "/omni/setting/policy/new-auto-audit/save/index.html"
                  "?id=678962&action=edit")
D3_TENANT = _cfg("D3_TENANT", "REPLACE_WITH_YOUR_D3_TENANT")
D3_USERNAME = _cfg("D3_USERNAME", "REPLACE_WITH_YOUR_D3_USERNAME")
# 密码仅在显式提供时读取，默认空（浏览器通常已保存登录态）
D3_PASSWORD = _cfg("D3_PASSWORD", "")

# ---- 钉钉机器人 / 通知群 ----------------------------------------------------
ROBOT_CODE = _cfg("D3_ROBOT_CODE", "REPLACE_WITH_YOUR_ROBOT_CODE")
NOTIFY_GROUP = _cfg("D3_NOTIFY_GROUP", "REPLACE_WITH_YOUR_GROUP_CONVERSATION_ID")
DEFAULT_AT_USER = _cfg("D3_DEFAULT_AT_USER", "")

# ---- 钉钉多维表 ------------------------------------------------------------
ATABLE_BASE = _cfg("D3_ATABLE_BASE", "REPLACE_WITH_YOUR_BASE_ID")
TABLE_AUDIT = _cfg("D3_TABLE_AUDIT", "REPLACE_WITH_TABLE_ID_AUDIT")
TABLE_BUDAN = _cfg("D3_TABLE_BUDAN", "REPLACE_WITH_TABLE_ID_BUDAN")
TABLE_SHORTAGE = _cfg("D3_TABLE_SHORTAGE", "REPLACE_WITH_TABLE_ID_SHORTAGE")
TABLE_STAFF = _cfg("D3_TABLE_STAFF", "REPLACE_WITH_TABLE_ID_STAFF")

# ---- 业务常量 ---------------------------------------------------------------
REPLACEMENT_SKU = _cfg("D3_REPLACEMENT_SKU", "FF000748")
SHORTAGE_TAG_ID = _cfg("D3_SHORTAGE_TAG_ID", "613013")
SELLER_MEMO = _cfg("D3_SELLER_MEMO", "0000")
RUN_DIR = _cfg("D3_RUN_DIR", "/tmp")

# ---- 运行态目录（台账/去重/PID/日志，自包含、不入库）------------------------
# 优先环境变量 D3_STATE_DIR；否则用项目内 .state（可写时），再退回 /tmp。
_DEFAULT_STATE = os.path.join(os.path.dirname(_HERE), ".state")
STATE_DIR = os.environ.get("D3_STATE_DIR") or _DEFAULT_STATE
try:
    os.makedirs(STATE_DIR, exist_ok=True)
except Exception:
    try:
        os.makedirs(_DEFAULT_STATE, exist_ok=True)
        STATE_DIR = _DEFAULT_STATE
    except Exception:
        STATE_DIR = RUN_DIR


def _state(name):
    return os.path.join(STATE_DIR, name)


# 各类运行态文件统一位置
FAIL_STATE_FILE = _state(".audit-failstate.json")
BATCH_STATE_FILE = _state(".batch_state")
PEOPLE_FILE = _state("audit-people.json")
BUDAN_LEDGER_FILE = _state("budan-ledger.json")
RETRY_STATE_FILE = _state("budan-retry.json")
STALE_STATE_FILE = _state("budan-stale-alert.json")
NOTIFY_SENT_FILE = _state("budan-notify-sent.json")
NOTIFY_LEDGER_FILE = _state("notify-keys.jsonl")
LISTENER_PID_FILE = _state("d3-audit-listener.pid")
LISTENER_LOG_FILE = _state("d3-audit-listener.log")
PROCESSED_FILE = _state("d3-audit-processed.json")


def summary():
    """返回脱敏后的配置摘要，供启动日志/排障打印。"""
    return {
        "base_url": D3_BASE_URL,
        "tenant": D3_TENANT,
        "username": D3_USERNAME,
        "password_set": bool(D3_PASSWORD),
        "robot_code": ROBOT_CODE,
        "notify_group": NOTIFY_GROUP,
        "atable_base": ATABLE_BASE,
        "tables": {
            "audit": TABLE_AUDIT,
            "budan": TABLE_BUDAN,
            "shortage": TABLE_SHORTAGE,
            "staff": TABLE_STAFF,
        },
    }


if __name__ == "__main__":
    import json
    print(json.dumps(summary(), ensure_ascii=False, indent=2))
