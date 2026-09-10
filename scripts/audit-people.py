#!/usr/bin/env python3
"""
拦截相关人员信息本地存储（按 SKU 维度）
- submitter: 提交拦截的人（listener 解析到 SKU 消息时记录）
- restorer: 发起恢复的人（listener 解析到"恢复"指令时记录）

为什么用本地文件而不是多维表：
- 群消息轮询能直接拿到 senderOpenDingTalkId，@ 人用 --at-open-dingtalk-ids 即可，
  不需要姓名→userId 映射表，也不用改多维表结构。
- openId 属于会话技术标识，不适合落业务表。

CLI:
  set-submitter   stdin: {"skus":["YPH001",...], "name":"张三", "open_id":"DtWC..."}
  set-restorer    stdin: 同上
  targets         stdin: ["YPH001",...]  → stdout: [{"name":"张三","open_id":"DtWC..."}, ...]（去重）
"""
import sys, os, json, tempfile
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
try:
    from d3config import PEOPLE_FILE
except Exception:
    PEOPLE_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "audit-people.json")


def _load():
    try:
        with open(PEOPLE_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def _save(data):
    d = os.path.dirname(PEOPLE_FILE)
    fd, tmp = tempfile.mkstemp(dir=d, suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=1)
        os.replace(tmp, PEOPLE_FILE)
    except Exception:
        try:
            os.remove(tmp)
        except OSError:
            pass


def set_role(role, skus, name, open_id):
    """role: 'submitter' | 'restorer'"""
    if not skus:
        return
    data = _load()
    for sku in skus:
        e = data.setdefault(sku, {})
        if name:
            e[role] = name
        if open_id:
            e[role + "_open_id"] = open_id
        # 新一轮拦截（重新提交）时，清空上一轮的恢复人，避免脏数据残留
        if role == "submitter":
            e.pop("restorer", None)
            e.pop("restorer_open_id", None)
    _save(data)


def get_targets(skus, roles=("submitter", "restorer")):
    """返回去重后的 [{name, open_id}]，按 roles 顺序，submitter 在前 restorer 在后"""
    data = _load()
    seen = set()
    out = []
    for role in roles:
        for sku in skus:
            e = data.get(sku, {})
            oid = e.get(role + "_open_id")
            if oid and oid not in seen:
                seen.add(oid)
                out.append({"name": e.get(role, ""), "open_id": oid})
    return out


def main():
    action = sys.argv[1] if len(sys.argv) > 1 else ""
    payload = json.load(sys.stdin) if not sys.stdin.isatty() else {}

    if action == "set-submitter":
        set_role("submitter", payload.get("skus", []),
                 payload.get("name", ""), payload.get("open_id", ""))
        print(json.dumps({"ok": True}, ensure_ascii=False))
    elif action == "set-restorer":
        set_role("restorer", payload.get("skus", []),
                 payload.get("name", ""), payload.get("open_id", ""))
        print(json.dumps({"ok": True}, ensure_ascii=False))
    elif action == "targets":
        if isinstance(payload, list):
            skus, roles = payload, ("submitter", "restorer")
        else:
            skus = payload.get("skus", [])
            roles = tuple(payload.get("roles") or ("submitter", "restorer"))
        print(json.dumps(get_targets(skus, roles), ensure_ascii=False))
    else:
        print(f"Unknown action: {action}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
