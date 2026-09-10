#!/usr/bin/env python3
"""
自动客审拦截商品表管理工具
负责: 查询/批量创建/更新拦截商品记录
被 audit-listener.py 和 d3-audit-policy.sh 调用
"""
import sys, os, json, subprocess, datetime

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

# 字段 ID
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

STATUS_WAITING = "待拦截"
STATUS_INTERCEPTED = "已拦截"
STATUS_PENDING_RESTORE = "待恢复"
STATUS_RESTORED = "已恢复"

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
        with open(FAIL_STATE_FILE, "w") as f:
            json.dump(state, f, ensure_ascii=False, indent=1)
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
    except:
        return {"raw": r.stdout, "stderr": r.stderr, "rc": r.returncode}


def _get_cell_str(cells, field_id):
    v = cells.get(field_id, "")
    if isinstance(v, list) and v:
        return v[0].get("text", "") if isinstance(v[0], dict) else str(v[0])
    if isinstance(v, dict):
        return v.get("name", "")
    return str(v) if v else ""


def fetch_records(status_filter=None):
    """获取记录，可按状态过滤。返回 recordId -> record dict"""
    all_records = []
    cursor = None
    while True:
        cmd = ["record", "query", "--base-id", BASE_ID, "--table-id", TABLE_ID,
               "--page-size", "100", "--format", "json"]
        if cursor:
            cmd.extend(["--cursor", cursor])
        data = dws(*cmd)
        records = data.get("data", {}).get("records", []) or []
        all_records.extend(records)
        if not data.get("data", {}).get("hasMore"):
            break
        cursor = data.get("data", {}).get("nextCursor")
        if not cursor:
            break

    result = {}
    for r in all_records:
        cells = r.get("cells", {})
        sku = _get_cell_str(cells, F_SKU)
        status = _get_cell_str(cells, F_STATUS)
        if status_filter is None or status == status_filter:
            result[sku] = {
                "recordId": r.get("recordId"),
                "sku": sku,
                "name": _get_cell_str(cells, F_NAME),
                "type": _get_cell_str(cells, F_TYPE),
                "status": status,
                "batch": cells.get(F_BATCH, ""),
                "cells": cells,
            }
    return result


def get_next_batch_no():
    """获取下一个批次号（全局递增，不依赖表中现有数据）"""
    # 优先用本地持久化文件记录最大值
    state_file = BATCH_STATE_FILE
    file_max = 0
    try:
        with open(state_file, 'r') as f:
            file_max = int(f.read().strip())
    except:
        pass

    # 同时查表中最大值（防止多实例或文件丢失）
    # 注意：表中批次号读回来可能是字符串（如 "12"），需强转 int，否则 table_max 恒为 0、会撞号
    records = fetch_records()
    table_max = 0
    for r in records.values():
        b = r.get("batch")
        try:
            b = int(b)
        except (TypeError, ValueError):
            continue
        if b > table_max:
            table_max = b

    next_no = max(file_max, table_max) + 1

    # 持久化
    try:
        with open(state_file, 'w') as f:
            f.write(str(next_no))
    except:
        pass

    return next_no


def batch_create(items, batch_no, batch_remark, submitter):
    """
    批量创建拦截记录。
    items: [{"sku","product_name","is_combo"}, ...]
    batch_no: 批次号；传 None/0 时"懒分配"——只有真有新记录要建时才取下一个号，
              避免空触发（重复 SKU / 告警误判）白白消耗批次号导致跳号。
    返回: {"created":[...], "skipped":[...], "batch_no":<本轮实际批次号或None>}
    """
    existing = fetch_records()
    now = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    to_create = []
    skipped = []
    skipped_detail = []

    for item in items:
        sku = item["sku"]
        if sku in existing:
            rec = existing[sku]
            # 如果已恢复，重新激活
            if rec["status"] == STATUS_RESTORED:
                to_create.append(item)
            else:
                skipped.append(sku)
                # 记录已存在 SKU 的批次/状态，供监听器给提交人一句反馈
                skipped_detail.append({
                    "sku": sku,
                    "batch": rec.get("batch", ""),
                    "status": rec.get("status", ""),
                    "name": rec.get("name", ""),
                })
            continue
        to_create.append(item)

    created = []
    actual_batch = None
    if to_create:
        # 只有真有新记录时才分配批次号（懒分配，防止跳号）
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
                F_BATCH: batch_no,
                F_BATCH_REMARK: batch_remark or "",
                F_SUBMITTER: submitter or "",
                F_SUBMIT_TIME: now,
            }
            records.append({"cells": fields})

        # 分批创建，每次最多 100 条
        for i in range(0, len(records), 100):
            batch = records[i:i+100]
            resp = dws("record", "create", "--base-id", BASE_ID, "--table-id", TABLE_ID,
                       "--records", json.dumps(batch, ensure_ascii=False), "--format", "json")
            if resp.get("success"):
                for item in to_create[i:i+len(batch)]:
                    created.append(item["sku"])
                    # 新的提交周期：清除历史失败熔断，允许重新自动处理
                    fail_reset(item["sku"])
            else:
                print(f"创建失败: {json.dumps(resp, ensure_ascii=False)[:300]}", file=sys.stderr)

    return {"created": created, "skipped": skipped,
            "skipped_detail": skipped_detail, "batch_no": actual_batch}


def mark_intercepted(sku, d3_goods_id=""):
    """标记为已拦截"""
    records = fetch_records(STATUS_WAITING)
    if sku not in records:
        # 也查待恢复的
        records.update(fetch_records(STATUS_PENDING_RESTORE))
    if sku not in records:
        return False
    now = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    fields = {F_STATUS: STATUS_INTERCEPTED, F_INTERCEPT_TIME: now}
    if d3_goods_id:
        fields[F_D3_GOODS_ID] = str(d3_goods_id)
    rec = [{"recordId": records[sku]["recordId"], "cells": fields}]
    resp = dws("record", "update", "--base-id", BASE_ID, "--table-id", TABLE_ID,
               "--records", json.dumps(rec, ensure_ascii=False), "--format", "json")
    return resp.get("success", False)


def mark_restore_pending(skus=None, batch_no=None):
    """
    标记为待恢复。支持从"待拦截"和"已拦截"状态恢复。
    skus: 指定 SKU 列表
    batch_no: 指定批次号
    返回待恢复的 SKU 列表
    """
    # 查待拦截 + 已拦截（不含已恢复）
    records = {}
    records.update(fetch_records(STATUS_WAITING))
    records.update(fetch_records(STATUS_INTERCEPTED))
    to_restore = []
    update_records = []

    for sku, rec in records.items():
        if skus and sku not in skus:
            continue
        if batch_no is not None:
            b = rec["cells"].get(F_BATCH)
            try:
                b = int(b)
            except (TypeError, ValueError):
                continue
            if b != batch_no:
                continue
        to_restore.append(sku)
        update_records.append({"recordId": rec["recordId"], "cells": {F_STATUS: STATUS_PENDING_RESTORE}})

    if update_records:
        for i in range(0, len(update_records), 100):
            batch = update_records[i:i+100]
            dws("record", "update", "--base-id", BASE_ID, "--table-id", TABLE_ID,
                "--records", json.dumps(batch, ensure_ascii=False), "--format", "json")

    return to_restore


def mark_restored(skus):
    """标记为已恢复"""
    records = fetch_records(STATUS_PENDING_RESTORE)
    now = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    update_records = []
    for sku in skus:
        if sku in records:
            update_records.append({
                "recordId": records[sku]["recordId"],
                "cells": {F_STATUS: STATUS_RESTORED, F_RESTORE_TIME: now}
            })
    if update_records:
        for i in range(0, len(update_records), 100):
            batch = update_records[i:i+100]
            dws("record", "update", "--base-id", BASE_ID, "--table-id", TABLE_ID,
                "--records", json.dumps(batch, ensure_ascii=False), "--format", "json")
    return len(update_records)


def set_error(sku, error_msg):
    """记录错误信息"""
    records = fetch_records()
    if sku not in records:
        return False
    rec = [{"recordId": records[sku]["recordId"], "cells": {F_ERROR: error_msg[:500]}}]
    dws("record", "update", "--base-id", BASE_ID, "--table-id", TABLE_ID,
        "--records", json.dumps(rec, ensure_ascii=False), "--format", "json")
    return True


if __name__ == "__main__":
    action = sys.argv[1] if len(sys.argv) > 1 else ""

    if action == "fetch":
        status = sys.argv[2] if len(sys.argv) > 2 else None
        print(json.dumps(fetch_records(status), ensure_ascii=False))

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
        # 按 SKU 列表或批次号
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
