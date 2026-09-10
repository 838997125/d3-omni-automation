#!/usr/bin/env python3
"""
D3 缺货跟踪表管理工具
负责: 查询/创建/更新钉钉缺货跟踪记录
被 d3-out-of-stock.sh 调用
"""
import sys, json, subprocess, datetime, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
try:
    from d3config import ATABLE_BASE as BASE_ID, TABLE_SHORTAGE as TABLE_ID
except Exception:
    BASE_ID = "jb9Y4gmKWrALBykmTe2A2g3l8GXn6lpz"
    TABLE_ID = "8FWt8wz"

# 字段 ID 映射
F_ORDER_CODE = "lcgC35P"
F_PLATFORM = "WjB6F0H"
F_SHOP = "0HSYlbu"
F_SKU = "aZX7cKb"
F_PRODUCT = "yAjlOF4"
F_QTY = "BAsCinP"
F_STOCK = "idkaY0A"
F_STATUS = "7xCQMVu"
F_FIRST_DETECT = "BPwVYGl"
F_ETA = "K32jEQ3"
F_ARRIVAL_NOTIFY = "Ifk83PR"
F_AUDIT_TIME = "8eynitS"
F_REMARK = "dgSQqTz"
F_D3_ID = "Oj7xZug"

STATUS_WAITING = "缺货待到货"
STATUS_ARRIVED = "已到货待审"
STATUS_AUDITED = "已审核"


def dws(*args):
    r = subprocess.run(["dws", "aitable", *args], capture_output=True, text=True, timeout=30)
    try:
        return json.loads(r.stdout)
    except:
        return {"raw": r.stdout, "stderr": r.stderr}


def fetch_active_records():
    """获取所有非'已审核'的跟踪记录"""
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
        # 注意：dws CLI 不返回 hasMore 字段，只能靠 nextCursor 判断是否有下一页
        # （旧逻辑判断 hasMore 导致永远只读第一页 100 条，第二页以后记录不可见）
        cursor = data.get("data", {}).get("nextCursor")
        if not cursor:
            break

    # 构建 orderCode+SKU -> record 映射
    result = {}
    for r in all_records:
        cells = r.get("cells", {})
        order_raw = cells.get(F_ORDER_CODE, "")
        if isinstance(order_raw, list) and order_raw:
            order_code = order_raw[0].get("text", "") if isinstance(order_raw[0], dict) else str(order_raw[0])
        else:
            order_code = str(order_raw) if order_raw else ""
        sku_raw = cells.get(F_SKU, "")
        sku = str(sku_raw) if sku_raw else ""
        status_raw = cells.get(F_STATUS, "")
        if isinstance(status_raw, dict):
            status = status_raw.get("name", "")
        elif isinstance(status_raw, list) and status_raw:
            status = status_raw[0].get("name", "") if isinstance(status_raw[0], dict) else str(status_raw[0])
        else:
            status = str(status_raw)
        if status and status != STATUS_AUDITED:
            key = f"{order_code}|{sku}"
            result[key] = {
                "recordId": r.get("recordId"),
                "orderCode": order_code,
                "sku": sku,
                "status": status,
                "cells": cells,
            }
    return result


def _update_record(record_id, fields):
    records = [{"recordId": record_id, "cells": fields}]
    cmd = ["record", "update", "--base-id", BASE_ID, "--table-id", TABLE_ID,
           "--records", json.dumps(records, ensure_ascii=False), "--format", "json"]
    return dws(*cmd)


def create_record(order_code, platform, shop, sku, product, qty, stock, d3_id):
    """新建缺货跟踪记录（同订单号+SKU 已存在时转为更新，避免重复记录）"""
    now = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    # 去重：查询同 orderCode + SKU 的未审核记录
    existing = fetch_active_records()
    match_key = f"{order_code}|{sku}"
    if match_key in existing:
        old = existing[match_key]
        # 已存在：更新库存、店铺、商品等字段，状态保持原状（不重置到货状态）
        fields = {
            F_PLATFORM: platform or "",
            F_SHOP: shop or "",
            F_PRODUCT: (product or "")[:100],
            F_QTY: qty,
            F_STOCK: stock,
            F_D3_ID: d3_id,
        }
        result = _update_record(old["recordId"], fields)
        # 标记为更新而非新建
        if isinstance(result, dict):
            result["updatedExisting"] = True
            result["existingRecordId"] = old["recordId"]
        return result

    fields = {
        F_ORDER_CODE: order_code,
        F_PLATFORM: platform or "",
        F_SHOP: shop or "",
        F_SKU: sku,
        F_PRODUCT: (product or "")[:100],
        F_QTY: qty,
        F_STOCK: stock,
        F_STATUS: STATUS_WAITING,
        F_FIRST_DETECT: now,
        F_D3_ID: d3_id,
    }
    records = [{"cells": fields}]
    cmd = ["record", "create", "--base-id", BASE_ID, "--table-id", TABLE_ID,
           "--records", json.dumps(records, ensure_ascii=False), "--format", "json"]
    return dws(*cmd)


def update_stock(record_id, stock):
    fields = {F_STOCK: stock}
    records = [{"recordId": record_id, "cells": fields}]
    cmd = ["record", "update", "--base-id", BASE_ID, "--table-id", TABLE_ID,
           "--records", json.dumps(records, ensure_ascii=False), "--format", "json"]
    return dws(*cmd)


def mark_arrived(record_id, stock=None):
    now = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    fields = {F_STATUS: STATUS_ARRIVED, F_ARRIVAL_NOTIFY: now}
    if stock is not None:
        fields[F_STOCK] = stock
    records = [{"recordId": record_id, "cells": fields}]
    cmd = ["record", "update", "--base-id", BASE_ID, "--table-id", TABLE_ID,
           "--records", json.dumps(records, ensure_ascii=False), "--format", "json"]
    return dws(*cmd)


def mark_audited(record_id):
    now = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    fields = {F_STATUS: STATUS_AUDITED, F_AUDIT_TIME: now}
    records = [{"recordId": record_id, "cells": fields}]
    cmd = ["record", "update", "--base-id", BASE_ID, "--table-id", TABLE_ID,
           "--records", json.dumps(records, ensure_ascii=False), "--format", "json"]
    return dws(*cmd)


def mark_waiting(record_id):
    """改回缺货待到货状态（用于纠正误判）"""
    fields = {F_STATUS: STATUS_WAITING, F_ARRIVAL_NOTIFY: ""}
    records = [{"recordId": record_id, "cells": fields}]
    cmd = ["record", "update", "--base-id", BASE_ID, "--table-id", TABLE_ID,
           "--records", json.dumps(records, ensure_ascii=False), "--format", "json"]
    return dws(*cmd)


if __name__ == "__main__":
    action = sys.argv[1] if len(sys.argv) > 1 else ""
    if action == "fetch":
        records = fetch_active_records()
        print(json.dumps(records, ensure_ascii=False))
    elif action == "create":
        data = json.load(sys.stdin)
        result = create_record(**data)
        print(json.dumps(result, ensure_ascii=False))
    elif action == "update-stock":
        rid = sys.argv[2]
        stock = int(sys.argv[3])
        result = update_stock(rid, stock)
        print(json.dumps(result, ensure_ascii=False))
    elif action == "mark-arrived":
        stock_val = None
        if len(sys.argv) > 3:
            try:
                stock_val = int(sys.argv[3])
            except ValueError:
                pass
        result = mark_arrived(sys.argv[2], stock_val)
        print(json.dumps(result, ensure_ascii=False))
    elif action == "mark-audited":
        result = mark_audited(sys.argv[2])
        print(json.dumps(result, ensure_ascii=False))
    elif action == "mark-waiting":
        result = mark_waiting(sys.argv[2])
        print(json.dumps(result, ensure_ascii=False))
    else:
        print(f"Unknown action: {action}", file=sys.stderr)
        sys.exit(1)
