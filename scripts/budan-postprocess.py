#!/usr/bin/env python3
"""回写补单结果到钉钉表格并发群通知"""
import sys, json, subprocess, datetime, os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
try:
    from d3config import (
        ATABLE_BASE, TABLE_BUDAN as ATABLE_TABLE, NOTIFY_GROUP, ROBOT_CODE,
        TABLE_STAFF as STAFF_TABLE, RETRY_STATE_FILE, STALE_STATE_FILE,
        NOTIFY_SENT_FILE,
    )
except Exception:
    ATABLE_BASE = "jb9Y4gmKWrALBykmTe2A2g3l8GXn6lpz"
    ATABLE_TABLE = "hERWDMS"
    NOTIFY_GROUP = "cid5wfiNs3aPtM7DpL050FRUQ=="
    ROBOT_CODE = "dingsshadsm8rt5h7ruv"
    STAFF_TABLE = "y89Wute"
    _d = os.path.dirname(os.path.abspath(__file__))
    RETRY_STATE_FILE = os.path.join(_d, "budan-retry.json")
    STALE_STATE_FILE = os.path.join(_d, "budan-stale-alert.json")
    NOTIFY_SENT_FILE = os.path.join(_d, "budan-notify-sent.json")
# 部门-人员对应表（取平台=客服 的全员，补单失败时需 @客服组介入）
STAFF_PLATFORM_FIELD = "6O9aB0Z"
STAFF_USER_FIELD = "pbTluRY"

# 临时性失败（换货/审核失败、审核后仍在列表）连续失败多少次后才置「处理失败」并 @客服。
# 在此之前保持「待处理」，让下一轮（5分钟后）自动重试：人工取消审核后订单重回待审核，
# 下一轮即可换货成功并发成功通知。
MAX_TRANSIENT_RETRY = 3

# 自补单超时人工介入（2026-09-09 代总要求；当日 17:22 由 30 分钟放宽为 45 分钟；
# 2026-09-10 改为二次核实闭环：45 分钟由 ego 自动出库计划单核实分流，此处只负责满 60 分钟
# 待审核+出库计划单两列表皆无的单号，才 @ 人——疑处方单异常卡在异常单）。
STALE_AFTER_MIN = 40   # 仅保留参考；实际 @ 阈值用下面的 60 分钟
PLAN_ALERT_AGE_MIN = 60
STALE_ALERTED_TYPE = "自补单"   # 仅精确命中自补单；三方补单/占单不触发
# 失败人工告警去重（2026-09-09 代总要求“只提醒一次”）：正常失败记录当轮即置「处理失败」、
# cron 只捞「待处理」故不会重复发；此文件是第二道保险，防回写失败/记录被复位/过滤变动后每轮重复 @。

now = datetime.datetime.now().strftime("%Y-%m-%d %H:%M")

def load_retry():
    """读取临时失败重试计数：{orderCode: {count, lastErr, ts}}。失败/缺失返回 {}。"""
    try:
        with open(RETRY_STATE_FILE) as f:
            return json.load(f)
    except Exception:
        return {}

def save_retry(state):
    try:
        with open(RETRY_STATE_FILE, "w") as f:
            json.dump(state, f, ensure_ascii=False, indent=2)
    except Exception:
        pass

def load_stale():
    """读取已超时提醒记录：{recordId: {ts, codes, ageMin}}。缺失返回 {}。"""
    try:
        with open(STALE_STATE_FILE) as f:
            return json.load(f)
    except Exception:
        return {}

def save_stale(state):
    try:
        with open(STALE_STATE_FILE, "w") as f:
            json.dump(state, f, ensure_ascii=False, indent=2)
    except Exception:
        pass

def prune_stale(state):
    """清掉 2 天前的提醒记录，避免状态文件无限增长。"""
    try:
        cutoff = datetime.datetime.now().timestamp() - 2 * 24 * 3600
        return {k: v for k, v in state.items()
                if datetime.datetime.strptime(v.get("ts", ""), "%Y-%m-%d %H:%M").timestamp() >= cutoff}
    except Exception:
        return state

def load_notify_sent():
    """读取已发失败告警记录：{recordId: {ts}}。缺失返回 {}。"""
    try:
        with open(NOTIFY_SENT_FILE) as f:
            return json.load(f)
    except Exception:
        return {}

def save_notify_sent(state):
    try:
        with open(NOTIFY_SENT_FILE, "w") as f:
            json.dump(state, f, ensure_ascii=False, indent=2)
    except Exception:
        pass

def submit_age_min(submit_time):
    """解析提交时间(ISO)，返回距今年龄（分钟，int）；无法解析返回 None。"""
    if not submit_time:
        return None
    try:
        st = datetime.datetime.fromisoformat(submit_time.strip().replace("Z", "+00:00"))
    except Exception:
        return None
    if st.tzinfo is not None:
        now = datetime.datetime.now(st.tzinfo)
    else:
        now = datetime.datetime.now()
    return int((now - st).total_seconds() // 60)

def send_stale_alert(rec, age, cs_ids, all_codes, detail):
    """发送自补单超时人工介入提醒，@提交人+客服组。"""
    sid = rec.get("submitterId", "") or ""
    at_ids = []
    if sid:
        at_ids.append(sid)
    for uid in cs_ids:
        if uid not in at_ids:
            at_ids.append(uid)
    at_prefix = (" ".join("@" + x for x in at_ids) + "\n\n") if at_ids else ""
    submit_time = rec.get("submitTime", "") or ""
    submit_show = submit_time.replace("T", " ").split("+")[0] if submit_time else "未知"
    lines = [
        "### ⏰ 自补单提交超1小时仍未进 D3，请人工核对",
        "",
        f"- **订单号**: {', '.join(all_codes)}",
        f"- **提交时间**: {submit_show}（已等待约 {age} 分钟）",
        f"- **当前状态**: {detail}",
        "- **可能原因**: 订单一直未同步进 D3（待审核、出库计划单都查不到），疑似审处方单异常、订单卡在异常单里；",
        "  请到 D3/异常单人工确认并手动处理，避免漏发。（已核实：非原货被放行，无需拦截仓库。）",
        "",
        f"提醒时间: {now}",
    ]
    body = at_prefix + "\n".join(lines)
    dws_notify("⏰ 自补单超1小时未进D3，需人工核对", body, ",".join(at_ids))

_cs_user_cache = None
def get_cs_user_ids():
    """查部门-人员对应表中平台为“客服”的全部 userId。失败返回 []（不影响 @提交人）。"""
    global _cs_user_cache
    if _cs_user_cache is not None:
        return _cs_user_cache
    try:
        r = subprocess.run(
            ["dws", "aitable", "record", "query",
             "--base-id", ATABLE_BASE, "--table-id", STAFF_TABLE,
             "--format", "json"],
            capture_output=True, text=True, timeout=60
        )
        data = json.loads(r.stdout or "{}")
        uids = []
        for rec in data.get("data", {}).get("records", []) or []:
            cells = rec.get("cells", {})
            if cells.get(STAFF_PLATFORM_FIELD) == "客服":
                for u in cells.get(STAFF_USER_FIELD, []) or []:
                    uid = u.get("userId") if isinstance(u, dict) else None
                    if uid and uid not in uids:
                        uids.append(uid)
        _cs_user_cache = uids
    except Exception:
        _cs_user_cache = []
    return _cs_user_cache

def dws_update(record_id, cells):
    payload = json.dumps([{"recordId": record_id, "cells": cells}], ensure_ascii=False)
    r = subprocess.run(
        ["dws", "aitable", "record", "update",
         "--base-id", ATABLE_BASE, "--table-id", ATABLE_TABLE,
         "--records", payload],
        capture_output=True, text=True
    )
    return r.returncode == 0

def dws_notify(title, body, at_user=""):
    cmd = ["dws", "chat", "message", "send-by-bot",
           "--robot-code", ROBOT_CODE, "--group", NOTIFY_GROUP,
           "--title", title, "--text", body]
    if at_user:
        cmd.extend(["--at-user-ids", at_user])
    subprocess.run(cmd, capture_output=True, text=True)

def main():
    result_file = sys.argv[1]
    with open(result_file) as f:
        results = json.load(f)

    stale_state = prune_stale(load_stale())
    notify_sent = load_notify_sent()

    for rec in results:
        rid = rec["recordId"]
        rtype = rec.get("type", "")
        sid = rec.get("submitterId", "")
        orders = rec.get("orderResults", [])
        success_orders = [o for o in orders if o.get("success")]
        failed_orders = [o for o in orders if not o.get("success")]
        record_becomes_failed = False   # 本轮是否被置「处理失败」（已发失败告警，超时提醒不重复发）

        if rec.get("allSuccess"):
            result_val = "已转异常单" if rtype == "占单" else "已改商品+审核通过"
            # 新脚本：d3Ids / origSku / origName 在记录级
            d3_ids = [str(x) for x in rec.get("d3Ids", [])]
            orig_skus = rec.get("origSku", "")
            orig_names = rec.get("origName", "")
            # 兼容订单级字段
            for o in success_orders:
                if o.get("d3Id") and str(o["d3Id"]) not in d3_ids:
                    d3_ids.append(str(o["d3Id"]))
                if o.get("origSku") and not orig_skus:
                    orig_skus = o["origSku"]
                if o.get("origName") and not orig_names:
                    orig_names = o["origName"]
            update_cells = {
                "VJQCRFk": "已处理",
                "oBXrNaL": result_val,
                "ZMKkIPe": now,
                "LdCaaFe": "自动化",
                "wRrLjD0": "0000",
                "2xILcAW": ""
            }
            if d3_ids:
                update_cells["qm5T89b"] = ",".join(sorted(set(d3_ids)))
            if orig_skus:
                update_cells["nkU69dW"] = orig_skus
            if orig_names:
                update_cells["ZcJrdDs"] = orig_names
            dws_update(rid, update_cells)
            # 办结成功：清除失败告警去重标记
            notify_sent.pop(rid, None)
            # 全部成功：清掉这些单号的临时失败重试计数
            try:
                _rs = load_retry()
                for o in orders:
                    _rs.pop(o["orderCode"], None)
                save_retry(_rs)
            except Exception:
                pass
        else:
            # 分类失败原因：
            #   notfound       = D3待审核中未找到（未同步/已处理）→ 保持待处理，下轮补
            #   hardfail       = 事故/永久：vanished(换货前消失疑被自动客审放行)、类型冲突、类型未知
            #                    → 立即置“处理失败” + @客服 + 发群，不等重试
            #   transientfail  = 换货/审核临时失败（异步延迟/抖动/人工取消后重试中）
            #                    → 重试计数 < MAX 时保持“待处理”静默重试；达阈值才置“处理失败”@客服
            notfound = [o for o in failed_orders if o.get("notFound")]
            hardfail = [o for o in failed_orders
                        if not o.get("notFound") and (o.get("vanished") or o.get("conflict") or o.get("unknownType"))]
            transientfail = [o for o in failed_orders
                             if not o.get("notFound") and not o.get("vanished")
                             and not o.get("conflict") and not o.get("unknownType")]

            retry_state = load_retry()
            # 成功的订单清掉重试计数
            for o in success_orders:
                retry_state.pop(o["orderCode"], None)
            # 未同步（D3中未出现）的单本轮未被真正重试，不计失败次数，重置计数
            for o in notfound:
                retry_state.pop(o["orderCode"], None)

            # 临时失败累计重试
            over_quota = []
            still_retrying = []
            for o in transientfail:
                code = o["orderCode"]
                st = retry_state.get(code, {"count": 0})
                st["count"] = int(st.get("count", 0)) + 1
                st["lastErr"] = o.get("error", "")
                st["ts"] = now
                retry_state[code] = st
                if st["count"] >= MAX_TRANSIENT_RETRY:
                    over_quota.append(o)
                else:
                    still_retrying.append(o)

            err_msgs = "; ".join(
                f"{o['orderCode']}:{o.get('error', '未知')}" for o in failed_orders
            )
            cells = {"2xILcAW": err_msgs[:500]}
            # 已成功的 D3 单，先把 D3ID/原SKU 落上
            if rec.get("d3Ids"):
                cells["qm5T89b"] = ",".join(sorted(set(str(x) for x in rec["d3Ids"])))
            if rec.get("origSku"):
                cells["nkU69dW"] = rec["origSku"]
            if rec.get("origName"):
                cells["ZcJrdDs"] = rec["origName"]

            if hardfail or over_quota:
                # 事故/永久 或 临时失败重试达阈值：置“处理失败”，停静默重试，等人工。
                # 注意：达阈值的计数【不要】在此清除——通知块还要读它判定 over_quota；
                # 该单状态已是“处理失败”不会再轮询，后续人工复位处理成功时会清计数。
                record_becomes_failed = True
                cells["VJQCRFk"] = "处理失败"
                cells["oBXrNaL"] = "部分失败需人工" if success_orders else "处理失败"
            else:
                # 仅未同步 或 临时失败仍在重试窗口：保持待处理，等下轮自动补/重试
                cells["VJQCRFk"] = "待处理"
                if still_retrying and not notfound:
                    n = retry_state[still_retrying[0]["orderCode"]]["count"]
                    cells["oBXrNaL"] = f"自动重试中({n}/{MAX_TRANSIENT_RETRY})"
            save_retry(retry_state)
            dws_update(rid, cells)

        # 发群通知判定（与上面回写分类一致，重新算一遍用于通知）
        notfound = [o for o in failed_orders if o.get("notFound")]
        hardfail = [o for o in failed_orders
                    if not o.get("notFound") and (o.get("vanished") or o.get("conflict") or o.get("unknownType"))]
        transientfail = [o for o in failed_orders
                         if not o.get("notFound") and not o.get("vanished")
                         and not o.get("conflict") and not o.get("unknownType")]
        retry_state = load_retry()
        over_quota = [o for o in transientfail if retry_state.get(o["orderCode"], {}).get("count", 0) >= MAX_TRANSIENT_RETRY]
        # 需通知的失败 = 事故/永久 + 重试达阈值；仍在重试窗口的临时失败静默（不刷屏）
        notify_fail = hardfail + over_quota
        if notify_fail or rec.get("allSuccess"):
            realfail = notify_fail  # 复用下游变量名
            # @名单：成功只 @提交人；失败（需人工）额外 @客服组全员
            at_ids = []
            if sid:
                at_ids.append(sid)
            if realfail:
                for uid in get_cs_user_ids():
                    if uid not in at_ids:
                        at_ids.append(uid)
            at_prefix = (" ".join("@" + x for x in at_ids) + "\n\n") if at_ids else ""
            # 记录级原始SKU/品名（v2 合并单多个单号共享同一套 SKU）
            rec_sku = rec.get("origSku", "") or ""
            rec_name = rec.get("origName", "") or ""
            is_zhandan = "占单" in (rtype or "")
            is_budan = "补单" in (rtype or "")
            # 只有三方补单才需要去平台后台删补单品种规则；自补单/自营补单无平台规则，不提醒
            is_sanfang_budan = "三方" in (rtype or "") and is_budan
            lines = []
            head_icon = "🔒" if is_zhandan else "🛒"
            head = f"### {head_icon} {rtype or '未知类型'}处理结果"
            if realfail and not success_orders:
                head = f"### ⚠️ {rtype or '未知类型'}处理失败（需人工）"
            elif realfail:
                head = f"### ⚠️ {rtype or '未知类型'}部分处理失败（需人工）"
            lines.append(head)
            lines.append(f"- **订单总数**: {len(orders)}")
            if success_orders:
                lines.append(f"- **成功**: {len(success_orders)} 笔")
            if realfail:
                lines.append(f"- **失败**: {len(realfail)} 笔")
            if notfound:
                lines.append(f"- **待同步（下轮自动补）**: {len(notfound)} 笔")
            lines.append("")
            if success_orders:
                lines.append("**成功明细**:")
                for o in success_orders:
                    oc = o["orderCode"]
                    if is_zhandan:
                        lines.append(f"- {oc} 已转异常单")
                    else:
                        orig = o.get("origSku") or rec_sku or "原SKU"
                        lines.append(f"- ✅ {oc}({orig} → 运费链接2)")
                if is_budan and rec_name:
                    lines.append(f"- 原品名: {rec_name}")
            if realfail:
                lines.append("")
                lines.append("**失败明细（需人工处理）**:")
                for o in realfail:
                    lines.append(f"- ❌ {o['orderCode']}: {o.get('error', '未知')}")
            lines.append("")
            lines.append(f"处理时间: {now}")
            if is_sanfang_budan and success_orders and not realfail:
                lines.append("请运营确认并及时删除补单品种规则。")

            body = at_prefix + "\n".join(lines)
            title = f"{head_icon} {rtype or '未知类型'}处理结果"
            if realfail and not success_orders:
                title = f"⚠️ {rtype or '未知类型'}处理失败需人工"
            elif realfail:
                title = f"⚠️ {rtype or '未知类型'}部分失败需人工"
            # 失败人工告警只发一次：该记录已 @ 过则不再重复（防回写失败/复位/过滤变动后每轮刷屏）
            already_notified = bool(realfail) and rid in notify_sent
            if not already_notified:
                dws_notify(title, body, ",".join(at_ids))
                if realfail:
                    notify_sent[rid] = {"ts": now}


        # ------- 自补单超1小时仍未进 D3 的人工提醒（仅一次）-------
        # 45分钟那轮 ego 已自动做出库计划单二次核实：全FF→补台账闭环；原货→取消计划单拉回重做。
        # 只有满 60 分钟、待审核与出库计划单两列表皆无（ego 置 unsyncedOver60）才 @，疑处方单异常需人工。
        # 记录办结（全部成功 / 置处理失败）：清除标记，人工复位后再卡可重新提醒。
        record_closed = bool(rec.get("allSuccess")) or record_becomes_failed
        if record_closed:
            stale_state.pop(rid, None)
        elif (rec.get("type", "") == STALE_ALERTED_TYPE
              and rec.get("unsyncedOver60") and rid not in stale_state):
            age = submit_age_min(rec.get("submitTime", ""))
            # 只 @ 仍未同步(notFound)的单号，已成功的不列入
            stuck = [o.get("orderCode", "") for o in notfound]
            stuck = [c for c in stuck if c]
            if stuck:
                detail = f"{len(stuck)} 笔在 D3 待审核、出库计划单(通知成功)中均未找到"
                send_stale_alert(rec, age if age is not None else PLAN_ALERT_AGE_MIN, get_cs_user_ids(), stuck, detail)
                stale_state[rid] = {"ts": now, "codes": stuck, "ageMin": age}

        print(f"[OK] 记录 {rid}: {len(success_orders)}成功 {len(notify_fail)}需人工 {len(locals().get('still_retrying', []))}重试中 {len(notfound)}待同步")

    save_stale(stale_state)
    save_notify_sent(prune_stale(notify_sent))

if __name__ == "__main__":
    main()
