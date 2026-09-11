#!/usr/bin/env python3
"""
拦截相关人员信息本地存储（按 SKU 维度，一个拦截周期内可多人）
- submitters: 提交拦截的人列表（同一活跃 SKU 被多人重复提交时累加去重）
- restorers: 发起恢复的人列表

为什么用本地文件而不是多维表：
- 群消息轮询能直接拿到 senderOpenDingTalkId，@ 人用 --at-open-dingtalk-ids 即可，
  不需要姓名→userId 映射表，也不用改多维表结构。
- openId 属于会话技术标识，不适合落业务表。

CLI:
  set-submitter   stdin: {"skus":["YPH001",...], "name":"张三", "open_id":"DtWC..."}
                    新一轮拦截（新建活跃行）时调用：重置提交人列表、清空恢复人
  add-submitter   同结构；活跃行被重复提交时调用：追加提交人（按 open_id 去重）
  set-restorer    同结构；追加恢复人（按 open_id 去重）
  targets         stdin: ["YPH001",...]
                    → stdout: [{"name":"张三","open_id":"DtWC..."}, ...]（去重）
                    也支持 {"skus":[...], "roles":["submitters","restorers"]}
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
            data = json.load(f)
    except Exception:
        return {}
    # 兼容旧格式：submitter/submitter_open_id 单值 → 列表
    for sku, e in data.items():
        if not isinstance(e, dict):
            continue
        if "submitters" not in e and e.get("submitter_open_id"):
            e["submitters"] = [{"name": e.get("submitter", ""),
                                "open_id": e.get("submitter_open_id", "")}]
        if "restorers" not in e and e.get("restorer_open_id"):
            e["restorers"] = [{"name": e.get("restorer", ""),
                               "open_id": e.get("restorer_open_id", "")}]
        e.setdefault("submitters", [])
        e.setdefault("restorers", [])
    return data


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


def _person(name, open_id):
    return {"name": name or "", "open_id": open_id or ""}


def _append(lst, name, open_id):
    """按 open_id 去重追加；无 open_id 时按姓名去重"""
    key = open_id or name
    if not key:
        return
    for p in lst:
        if (p.get("open_id") or p.get("name")) == key:
            # 补齐可能缺失的名字
            if name and not p.get("name"):
                p["name"] = name
            return
    lst.append(_person(name, open_id))


def reset_submitter(skus, name, open_id):
    """新一轮拦截：提交人列表重置为当前一人，清空恢复人"""
    if not skus:
        return
    data = _load()
    for sku in skus:
        data[sku] = {"submitters": [_person(name, open_id)] if (name or open_id) else [],
                     "restorers": []}
    _save(data)


def add_submitter(skus, name, open_id, clear_restorers=False):
    """活跃行重复提交：追加提交人。
    clear_restorers=True 用于「待恢复中又被提交、撤销恢复」：
    恢复没发生，旧恢复人作废，避免日后真正恢复时误 @。
    """
    if not skus:
        return
    data = _load()
    for sku in skus:
        e = data.setdefault(sku, {"submitters": [], "restorers": []})
        e.setdefault("submitters", [])
        e.setdefault("restorers", [])
        _append(e["submitters"], name, open_id)
        if clear_restorers:
            e["restorers"] = []
    _save(data)


def add_restorer(skus, name, open_id):
    if not skus:
        return
    data = _load()
    for sku in skus:
        e = data.setdefault(sku, {"submitters": [], "restorers": []})
        e.setdefault("submitters", [])
        e.setdefault("restorers", [])
        _append(e["restorers"], name, open_id)
    _save(data)


def get_targets(skus, roles=("submitters", "restorers")):
    """跨多个 SKU 汇总去重后的人员，按 roles 顺序（提交人在前，恢复人在后）"""
    data = _load()
    seen = set()
    out = []
    for role in roles:
        for sku in skus:
            for p in data.get(sku, {}).get(role, []):
                key = p.get("open_id") or p.get("name")
                if key and key not in seen:
                    seen.add(key)
                    out.append({"name": p.get("name", ""), "open_id": p.get("open_id", "")})
    return out


def main():
    action = sys.argv[1] if len(sys.argv) > 1 else ""
    payload = json.load(sys.stdin) if not sys.stdin.isatty() else {}

    if action == "set-submitter":
        reset_submitter(payload.get("skus", []),
                        payload.get("name", ""), payload.get("open_id", ""))
        print(json.dumps({"ok": True}, ensure_ascii=False))
    elif action == "add-submitter":
        add_submitter(payload.get("skus", []),
                      payload.get("name", ""), payload.get("open_id", ""),
                      bool(payload.get("clear_restorers")))
        print(json.dumps({"ok": True}, ensure_ascii=False))
    elif action == "set-restorer":
        add_restorer(payload.get("skus", []),
                     payload.get("name", ""), payload.get("open_id", ""))
        print(json.dumps({"ok": True}, ensure_ascii=False))
    elif action == "targets":
        if isinstance(payload, list):
            skus, roles = payload, ("submitters", "restorers")
        else:
            skus = payload.get("skus", [])
            r = payload.get("roles")
            # 兼容旧角色名单数写法
            roles = tuple(x if x.endswith("s") else x + "s" for x in (r or ("submitters", "restorers")))
        print(json.dumps(get_targets(skus, roles), ensure_ascii=False))
    else:
        print(f"Unknown action: {action}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
