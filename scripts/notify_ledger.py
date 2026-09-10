#!/usr/bin/env python3
"""
机器人群消息 processQueryKey 账本
- 每次机器人发群通知后，把返回的 processQueryKey 连同元数据追加到 notify-keys.jsonl
- 日后若需撤回某条发错的消息（换行错误、@错人、内容有误），可按时间/内容查 key，
  再用 `dws chat message recall-by-bot --robot-code <code> --group <cid> --keys <key>` 精准撤回。
注意：钉钉机器人撤回必须用发送时返回的 processQueryKey，不能用消息列表里的 openMessageId。
"""
import os
import json
import datetime

try:
    from d3config import NOTIFY_LEDGER_FILE as LEDGER
except Exception:
    LEDGER = os.path.join(os.path.dirname(os.path.abspath(__file__)), "notify-keys.jsonl")


def extract_key(stdout):
    """从 dws send-by-bot 的 stdout JSON 中提取 processQueryKey。"""
    try:
        d = json.loads(stdout)
        return (d.get("result") or {}).get("processQueryKey") or ""
    except Exception:
        return ""


def append(key, text="", source="", title="", group="", robot="", at_ids="", ok=None):
    """追加一条发送记录。key 为空则跳过（没有 key 就无法撤回，无记录价值）。"""
    if not key:
        return None
    rec = {
        "ts": datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "key": key,
        "group": group,
        "robot": robot,
        "source": source,
        "title": title,
        "at_ids": at_ids,
        "ok": ok,
        "text": (text or "")[:300],
    }
    try:
        with open(LEDGER, "a") as f:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
    except Exception:
        pass
    return rec


if __name__ == "__main__":
    # 简单查询：python3 notify_ledger.py [关键字]  -> 打印最近匹配记录
    import sys
    kw = sys.argv[1] if len(sys.argv) > 1 else ""
    if not os.path.exists(LEDGER):
        print("(账本为空)")
        sys.exit(0)
    rows = []
    with open(LEDGER) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                r = json.loads(line)
            except Exception:
                continue
            if kw and kw not in (r.get("text", "") + r.get("title", "") + r.get("source", "")):
                continue
            rows.append(r)
    for r in rows[-20:]:
        print(f"{r['ts']} [{r.get('source','')}] {r.get('title','')} key={r['key']}")
        print(f"   {r.get('text','')[:80]}")
