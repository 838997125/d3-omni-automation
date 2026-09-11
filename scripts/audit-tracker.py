#!/usr/bin/env python3
"""
自动客审拦截商品表管理工具
负责: 查询/批量创建/更新拦截商品记录
被 audit-listener.py 和 d3-audit-policy.sh 调用

唯一索引模型（2026-09-11）：
- SKU编码 是唯一业务索引，商品名仅展示、不参与任何逻辑。
- 需在拦截表额外创建单选字段「是否最新记录」（选项：是/否），field id 见 F_LATEST。
  全新部署时该字段 id 会不同，请在钉钉表建好后把实际 field id 填到下方 F_LATEST，
  并运行 scripts/migrate-latest-flag.py 回填存量记录。
- 一个 SKU 同一时刻只有一行 = 是（活跃行），状态在 待拦截/已拦截/待恢复 间流转。
  * D3 恢复成功 → 已恢复 + 是否最新=否，成为历史行。
  * 恢复连续失败熔断 → 状态保持待恢复 + 是否最新=否（人工处理，cron 不再捡拾）。
- 同一 SKU 再次提交：不新建行，活跃行追加提交人；若活跃行处于待恢复，则撤销恢复回到已拦截。
"""
import sys, os, json, subprocess, datetime, tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
try:
    from d3config import (
        ATABLE_BASE as BASE_ID, TABLE_AUDIT as TABLE_ID,
        FAIL_STATE_FILE, BATCH_STATE_FILE,
    )
except Exception:
    BASE_ID = "REPLACE_WITH_YOUR_BASE_ID"
    TABLE_ID = "REPLACE_WITH_TABLE_ID_AUDIT"
    _d = os.path.dirname(os.path.abspath(__file__))
    FAIL_STATE_FILE = os.path.join(_d, ".audit-failstate.json")
    BATCH_STATE_FILE = os.path.join(_d, ".batch_state")

# 字段 ID（与具体多维表强绑定，迁移到全新表时按实际 field id 调整）
F_SKU = "5TH6gCx"
F_NAME = "LWMH1H6"
F_TYPE = "A9gpH5b"
F_STATUS = "3Bfd2eW"
F_BATCH = "pTAYZcr"
F_BATCH_REMARK = "s3XRRH7"
F_SUBMITTER = "83QAPal"
F_SUBMIT_TIME = "cWVWN8x"
F_INTERCEPT_TIME = "MUsMxuj"
F_RESTORE_TIME = "60XfWwi"
F_D3_GOODS_ID = "U89ORbU"
F_ERROR = "okBCsmC"
_fld_latest = os.environ.get("D3_FIELD_LATEST", "").strip()
# 未配置或仍是占位符时，退回随原环境导出的 field id；全新部署务必改成自己的字段 id
F_LATEST = _fld_latest if _fld_latest and not _fld_latest.startswith("REPLACE_WITH") else "wb36Dnu"  # 是否最新记录（单选 是/否）

STATUS_WAITING = "待拦截"
STATUS_INTERCEPTED = "已拦截"
STATUS_PENDING_RESTORE = "待恢复"
STATUS_RESTORED = "已恢复"

LATEST_YES = "是"
LATEST_NO = "否"

# 活跃行状态优先级（重复行容错时挑主行用）
_STATUS_RANK = {
    STATUS_INTERCEPTED: 4,
    STATUS_WAITING: 3,
    STATUS_PENDING_RESTORE: 2,
    STATUS_RESTORED: 1,
}

# 连续失败熔断阈值：同一 SKU 失败 N 次后停止自动重试/群发，等人工处理
FAIL_THRESHOLD = 3


def _load_failstate():
    try:
        with open(FAIL_STATE_FILE, "r") as f:
            return json.load(f)
    except Exception:
        return {}


def _save_failstate(state):
    try:
        d = os.path.dirname(FAIL_STATE_FILE)
        os.makedirs(d, exist_ok=True) if d else None
        fd, tmp = tempfile.mkstemp(dir=d or ".", suffix=".tmp")
        with os.fdopen(fd, "w") as f:
            json.dump(state, f, ensure_ascii=False, indent=1)
        os.replace(tmp, FAIL_STATE_FILE)
    except Exception:
        pass


def fail_incr(sku, phase, error_msg=""):
    """记录一次失败。返回 {count, broken: 是否刚达到熔断阈值}"""
    state = _load_failstate()
    now = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    ent = state.get(sku, {})
    count = int(ent.get("count", 0)) + 1
    ent.update({"count": count, "phase": phase, "last": now,
                "error": error_msg[:300], "broken": count >= FAIL_THRESHOLD,
                "notified": ent.get("notified", False)})
    if "first" not in ent:
        ent["first"] = now
    state[sku] = ent
    _save_failstate(state)
    return {"sku": sku, "count": count, "broken": count >= FAIL_THRESHOLD,
            "already_broken": count > FAIL_THRESHOLD}


def fail_reset(sku):
    """成功后或人工重提时清除失败计数"""
    state = _load_failstate()
    if sku in state:
        del state[sku]
        _save_failstate(state)
        return True
    return False


def fail_broken_skus():
    """返回已熔断（应跳过）的 SKU 列表"""
    return [s for s, e in _load_failstate().items() if e.get("broken")]


def dws(*args):
    r = subprocess.run(["dws", "aitable", *args], capture_output=True, text=True, timeout=30)
    try:
        return json.loads(r.stdout)
    except Exception:
        return {"raw": r.stdout, "stderr": r.stderr, "rc": r.returncode}


def _get_cell_str(cells, field_id):
    v = cells.get(field_id, "")
    if isinstance(v, list) and v:
        return v[0].get("text", "") if isinstance(v[0], dict) else str(v[0])
    if isinstance(v, dict):
        return v.get("name", "") or v.get("text", "")
    return str(v) if v else ""


def _record_from_raw(r):
    cells = r.get("cells", {})
    return {
        "recordId": r.get("recordId"),
        "sku": _get_cell_str(cells, F_SKU),
        "name": _get_cell_str(cells, F_NAME),
        "type": _get_cell_str(cells, F_TYPE),
        "status": _get_cell_str(cells, F_STATUS),
        "latest": _get_cell_str(cells, F_LATEST),
        "batch": cells.get(F_BATCH, ""),
        "submitter": _get_cell_str(cells, F_SUBMITTER),
        "cells": cells,
    }


def fetch_all_raw():
    """拉全表（不过滤），返回 record dict 列表"""
    out = []
    cursor = None
    while True:
        cmd = ["record", "query", "--base-id", BASE_ID, "--table-id", TABLE_ID,
               "--page-size", "100", "--format", "json"]
        if cursor:
            cmd.extend(["--cursor", cursor])
        data = dws(*cmd)
        out.extend(data.get("data", {}).get("records", []) or [])
        if not data.get("data", {}).get("hasMore"):
            break
        cursor = data.get("data", {}).get("nextCursor")
        if not cursor:
            break
    return [_record_from_raw(r) for r in out]


def _batch_int(rec):
    try:
        return int(rec.get("batch"))
    except (TypeError, ValueError):
        return 0


def fetch_records(status_filter=None, active_only=True):
    """获取记录，可按状态过滤。返回 {sku: record}。

    active_only=True（默认）：只返回「是否最新记录=是」的活跃行；
    同一 SKU 若脏数据出现多行活跃，按状态优先级+批次最大挑一行，保证唯一索引。
    active_only=False：同 SKU 多行时同样挑主行（迁移/排障用）。
    """
    groups = {}
    for rec in fetch_all_raw():
        sku = rec["sku"]
        if not sku:
            continue
        if status_filter is not None and rec["status"] != status_filter:
            continue
        groups.setdefault(sku, []).append(rec)

    result = {}
    for sku, recs in groups.items():
        if active_only:
            actives = [r for r in recs if r["latest"] == LATEST_YES]
            if not actives:
                continue
            pool = actives
        else:
            pool = recs
        best = sorted(pool, key=lambda r: (_STATUS_RANK.get(r["status"], 0),
                                           _batch_int(r), r["recordId"]), reverse=True)[0]
        result[sku] = best
    return result


def get_next_batch_no():
    """获取下一个批次号（全局递增，不依赖表中现有数据）"""
    file_max = 0
    try:
        with open(BATCH_STATE_FILE, 'r') as f:
            file_max = int(f.read().strip())
    except Exception:
        pass

    # 同时查表中最大值（防多实例或文件丢失）；批次读回可能是字符串，需强转 int
    table_max = 0
    for rec in fetch_all_raw():
        b = _batch_int(rec)
        if b > table_max:
            table_max = b

    next_no = max(file_max, table_max) + 1
    try:
        d = os.path.dirname(BATCH_STATE_FILE)
        if d:
            os.makedirs(d, exist_ok=True)
        with open(BATCH_STATE_FILE, 'w') as f:
            f.write(str(next_no))
    except Exception:
        pass
    return next_no


def _append_submitter(old, new):
    """提交人文本累加去重（支持 、,，/空格 分隔的既有写法）"""
    names = []
    for raw in (old or "").replace("，", "、").replace(",", "、").replace("/", "、").split("、"):
        n = raw.strip()
        if n and n not in names:
            names.append(n)
    for raw in (new or "").replace("，", "、").replace(",", "、").replace("/", "、").split("、"):
        n = raw.strip()
        if n and n not in names:
            names.append(n)
    return "、".join(names)


def _update_records(updates):
    """批量更新记录。updates: [{recordId, cells:{fieldId: value}}]，自动每批 100 条"""
    ok_all = True
    for i in range(0, len(updates), 100):
        batch = updates[i:i + 100]
        resp = dws("record", "update", "--base-id", BASE_ID, "--table-id", TABLE_ID,
                   "--records", json.dumps(batch, ensure_ascii=False), "--format", "json")
        if not resp.get("success"):
            print(f"更新失败: {json.dumps(resp, ensure_ascii=False)[:300]}", file=sys.stderr)
            ok_all = False
    return ok_all


def batch_create(items, batch_no, batch_remark, submitter):
    """
    提交拦截。items: [{"sku","product_name","is_combo"}, ...]
    只在 SKU 没有活跃行（是否最新=是）时新建；已有活跃行则跳过并追加提交人；
    活跃行正处于「待恢复」时撤销恢复（回到已拦截，D3 规则此时尚未删除）。

    返回:
      created / skipped / restored_cancelled
      skipped_detail: [{sku,batch,status,name,submitters,reason}]
      batch_no: 本轮实际批次号（无新建为 None，懒分配防跳号）
    """
    existing = fetch_records()
    now = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    to_create = []
    seen = set()
    skipped = []
    restored_cancelled = []
    skipped_detail = []
    updates = []

    for item in items:
        sku = item["sku"]
        if sku in seen:
            continue
        seen.add(sku)
        rec = existing.get(sku)
        if rec is None:
            to_create.append(item)
            continue

        reason = "exists"
        if rec["status"] == STATUS_PENDING_RESTORE:
            updates.append({"recordId": rec["recordId"], "cells": {
                F_STATUS: STATUS_INTERCEPTED,
                F_LATEST: LATEST_YES,
                F_ERROR: "",
            }})
            restored_cancelled.append(sku)
            reason = "restore_cancelled"

        new_submitters = _append_submitter(rec.get("submitter", ""), submitter)
        if new_submitters != rec.get("submitter", ""):
            updates.append({"recordId": rec["recordId"], "cells": {
                F_SUBMITTER: new_submitters[:200],
            }})

        skipped.append(sku)
        skipped_detail.append({
            "sku": sku,
            "batch": _batch_int(rec) or rec.get("batch", ""),
            "status": rec["status"] if reason == "exists" else STATUS_INTERCEPTED,
            "name": rec.get("name", ""),
            "submitters": new_submitters,
            "reason": reason,
        })

    if updates:
        _update_records(updates)

    created = []
    actual_batch = None
    if to_create:
        if not batch_no:
            batch_no = get_next_batch_no()
        actual_batch = batch_no
        records = []
        for item in to_create:
            fields = {
                F_SKU: item["sku"],
                F_NAME: (item.get("product_name") or "")[:100],
                F_TYPE: "套装" if item.get("is_combo") else "单品",
                F_STATUS: STATUS_WAITING,
                F_LATEST: LATEST_YES,
                F_BATCH: batch_no,
                F_BATCH_REMARK: batch_remark or "",
                F_SUBMITTER: submitter or "",
                F_SUBMIT_TIME: now,
            }
            records.append({"cells": fields})

        for i in range(0, len(records), 100):
            batch = records[i:i + 100]
            resp = dws("record", "create", "--base-id", BASE_ID, "--table-id", TABLE_ID,
                       "--records", json.dumps(batch, ensure_ascii=False), "--format", "json")
            if resp.get("success"):
                for item in to_create[i:i + len(batch)]:
                    created.append(item["sku"])
                    fail_reset(item["sku"])
            else:
                print(f"创建失败: {json.dumps(resp, ensure_ascii=False)[:300]}", file=sys.stderr)

    return {"created": created, "skipped": skipped,
            "restored_cancelled": restored_cancelled,
            "skipped_detail": skipped_detail, "batch_no": actual_batch}


def mark_intercepted(sku, d3_goods_id=""):
    """活跃行标记为已拦截（是否最新保持是）"""
    records = fetch_records(STATUS_WAITING)
    if sku not in records:
        records.update(fetch_records(STATUS_PENDING_RESTORE))
    if sku not in records:
        return False
    now = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    fields = {F_STATUS: STATUS_INTERCEPTED, F_INTERCEPT_TIME: now, F_LATEST: LATEST_YES}
    if d3_goods_id:
        fields[F_D3_GOODS_ID] = str(d3_goods_id)
    rec = [{"recordId": records[sku]["recordId"], "cells": fields}]
    return _update_records(rec)


def mark_restore_pending(skus=None, batch_no=None):
    """活跃行（待拦截/已拦截）标记为待恢复，是否最新保持「是」。"""
    records = {}
    records.update(fetch_records(STATUS_WAITING))
    records.update(fetch_records(STATUS_INTERCEPTED))
    to_restore = []
    update_records = []

    for sku, rec in records.items():
        if skus and sku not in skus:
            continue
        if batch_no is not None and _batch_int(rec) != batch_no:
            continue
        to_restore.append(sku)
        update_records.append({"recordId": rec["recordId"],
                               "cells": {F_STATUS: STATUS_PENDING_RESTORE, F_LATEST: LATEST_YES}})

    if update_records:
        _update_records(update_records)
    return to_restore


def mark_restored(skus):
    """待恢复活跃行 → 已恢复 + 是否最新=否。返回处理条数"""
    records = fetch_records(STATUS_PENDING_RESTORE)
    now = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    update_records = []
    for sku in skus:
        if sku in records:
            update_records.append({"recordId": records[sku]["recordId"], "cells": {
                F_STATUS: STATUS_RESTORED,
                F_LATEST: LATEST_NO,
                F_RESTORE_TIME: now,
                F_ERROR: "",
            }})
    if update_records:
        _update_records(update_records)
    return len(update_records)


def mark_stale(skus, error_msg=""):
    """恢复连续失败熔断：状态保持待恢复，是否最新置否，等待人工处理。"""
    records = fetch_records(STATUS_PENDING_RESTORE)
    update_records = []
    hit = []
    for sku in skus:
        if sku in records:
            cells = {F_LATEST: LATEST_NO}
            if error_msg:
                cells[F_ERROR] = error_msg[:500]
            update_records.append({"recordId": records[sku]["recordId"], "cells": cells})
            hit.append(sku)
    if update_records:
        _update_records(update_records)
    return hit


def set_error(sku, error_msg):
    """记录错误信息到活跃行"""
    records = fetch_records()
    if sku not in records:
        return False
    rec = [{"recordId": records[sku]["recordId"], "cells": {F_ERROR: error_msg[:500]}}]
    return _update_records(rec)


if __name__ == "__main__":
    action = sys.argv[1] if len(sys.argv) > 1 else ""

    if action == "fetch":
        status = sys.argv[2] if len(sys.argv) > 2 else None
        active = "--all" not in sys.argv
        print(json.dumps(fetch_records(status, active_only=active), ensure_ascii=False))

    elif action == "next-batch":
        print(get_next_batch_no())

    elif action == "create":
        data = json.load(sys.stdin)
        result = batch_create(
            data["items"], data.get("batch_no"),
            data.get("batch_remark", ""), data.get("submitter", "")
        )
        print(json.dumps(result, ensure_ascii=False))

    elif action == "mark-intercepted":
        sku = sys.argv[2]
        goods_id = sys.argv[3] if len(sys.argv) > 3 else ""
        ok = mark_intercepted(sku, goods_id)
        print(json.dumps({"ok": ok}))

    elif action == "mark-restore-pending":
        if len(sys.argv) > 2 and sys.argv[2].startswith("#"):
            batch_no = int(sys.argv[2][1:])
            skus = mark_restore_pending(batch_no=batch_no)
        elif len(sys.argv) > 2:
            sku_list = [s.strip() for s in sys.argv[2].split(",") if s.strip()]
            skus = mark_restore_pending(skus=sku_list)
        else:
            skus = mark_restore_pending()
        print(json.dumps({"skus": skus}))

    elif action == "mark-restored":
        skus = json.load(sys.stdin)
        count = mark_restored(skus)
        print(json.dumps({"restored": count}))

    elif action == "mark-stale":
        payload = json.load(sys.stdin)
        hit = mark_stale(payload.get("skus", []), payload.get("error", ""))
        print(json.dumps({"stale": hit}, ensure_ascii=False))

    elif action == "set-error":
        sku = sys.argv[2]
        msg = sys.stdin.read()
        set_error(sku, msg)
        print(json.dumps({"ok": True}))

    elif action == "fail-incr":
        sku = sys.argv[2]
        phase = sys.argv[3] if len(sys.argv) > 3 else "add"
        msg = sys.stdin.read()
        print(json.dumps(fail_incr(sku, phase, msg), ensure_ascii=False))

    elif action == "fail-reset":
        sku = sys.argv[2]
        print(json.dumps({"ok": fail_reset(sku)}))

    elif action == "fail-list":
        print(json.dumps(_load_failstate(), ensure_ascii=False))

    else:
        print(f"Unknown action: {action}", file=sys.stderr)
        sys.exit(1)
