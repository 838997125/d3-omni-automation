#!/usr/bin/env python3
"""
一次性迁移：为存量拦截记录回填「是否最新记录」单选字段（默认 是/否）。

前置：先在拦截多维表新建单选字段「是否最新记录」（选项：是、否），
      并把该字段的 field id 配到 config.env 的 D3_FIELD_LATEST
      （未配置时使用 audit-tracker.py 内 F_LATEST 默认值）。

规则：
- 按 SKU 分组；组内在「非已恢复」行中按
  状态优先级(已拦截>待拦截>待恢复) + 批次最大 选唯一活跃行 → 是
- 其余行 → 否；全组均已恢复 → 全部否

用法：
  python3 migrate-latest-flag.py dry-run   # 只打印清单，不写
  python3 migrate-latest-flag.py apply     # 执行回填
"""
import sys, os, json, importlib.util
from collections import defaultdict

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)

_spec = importlib.util.spec_from_file_location(
    "audit_tracker", os.path.join(_HERE, "audit-tracker.py"))
_at = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_at)

fetch_all_raw = _at.fetch_all_raw
_batch_int = _at._batch_int
_STATUS_RANK = _at._STATUS_RANK
F_LATEST = _at.F_LATEST
LATEST_YES = _at.LATEST_YES
LATEST_NO = _at.LATEST_NO
dws = _at.dws
BASE_ID = _at.BASE_ID
TABLE_ID = _at.TABLE_ID

mode = sys.argv[1] if len(sys.argv) > 1 else "dry-run"

groups = defaultdict(list)
for rec in fetch_all_raw():
    if not rec["sku"]:
        continue
    groups[rec["sku"]].append(rec)

plan = []
summary = {"yes": 0, "no": 0}
dup_groups = 0
for sku, recs in groups.items():
    if len(recs) > 1:
        dup_groups += 1
    candidates = [r for r in recs if r["status"] != "已恢复"]
    if candidates:
        active = sorted(candidates,
                        key=lambda r: (_STATUS_RANK.get(r["status"], 0), _batch_int(r), r["recordId"]),
                        reverse=True)[0]
    else:
        active = None
    for r in recs:
        target = LATEST_YES if active is not None and r["recordId"] == active["recordId"] else LATEST_NO
        plan.append({"recordId": r["recordId"], "sku": sku, "target": target,
                     "status": r["status"], "batch": _batch_int(r),
                     "name": r["name"], "already": r["latest"]})
        summary["yes" if target == LATEST_YES else "no"] += 1

print(f"总记录 {sum(len(v) for v in groups.values())}，唯一SKU {len(groups)}，重复SKU组 {dup_groups}")
print(f"回填计划：置是 {summary['yes']} 行，置否 {summary['no']} 行")
if BASE_ID.startswith("REPLACE_WITH"):
    print("\n[警告] 当前未配置真实多维表（BASE_ID 仍是占位符），请先填写 config.env。")
for sku, recs in sorted(groups.items()):
    rows = [p for p in plan if p["sku"] == sku]
    if len(rows) > 1:
        for r in rows:
            print(f"  {sku:14} -> {r['target']}  {r['status']:4} #{r['batch']:<3} {r['name'][:28]} ({r['recordId']})")

if mode != "apply":
    print("\n[dry-run] 未写入。确认后执行: python3 migrate-latest-flag.py apply")
    sys.exit(0)

updates = [{"recordId": p["recordId"], "cells": {F_LATEST: p["target"]}} for p in plan]
ok = True
for i in range(0, len(updates), 100):
    resp = dws("record", "update", "--base-id", BASE_ID, "--table-id", TABLE_ID,
               "--records", json.dumps(updates[i:i+100], ensure_ascii=False), "--format", "json")
    if not resp.get("success"):
        ok = False
        print("失败:", json.dumps(resp, ensure_ascii=False)[:400])
print("\n[apply] 回填完成" if ok else "\n[apply] 存在失败", f"共 {len(updates)} 行")
