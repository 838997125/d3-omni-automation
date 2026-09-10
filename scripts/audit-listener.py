#!/usr/bin/env python3
"""
钉钉群消息轮询监听服务
- 每 15 秒拉取配置的通知群（D3_NOTIFY_GROUP）最近消息
- 识别 SKU 列表 → 写入拦截表 → 回复确认
- 识别恢复指令 → 更新状态 → 回复确认
- 不走 LLM，零 token 消耗
"""
import sys, os, json, subprocess, re, time, signal, datetime, urllib.parse

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
TRACKER = os.path.join(SCRIPT_DIR, "audit-tracker.py")
PEOPLE = os.path.join(SCRIPT_DIR, "audit-people.py")
sys.path.insert(0, SCRIPT_DIR)
try:
    import notify_ledger
except Exception:
    notify_ledger = None

try:
    from d3config import (
        NOTIFY_GROUP as GROUP_ID, ROBOT_CODE,
        LISTENER_PID_FILE as PID_FILE,
        LISTENER_LOG_FILE as LOG_FILE,
        PROCESSED_FILE,
    )
except Exception:
    GROUP_ID = "REPLACE_WITH_YOUR_GROUP_CONVERSATION_ID"
    ROBOT_CODE = "REPLACE_WITH_YOUR_ROBOT_CODE"
    PID_FILE = "/tmp/d3-audit-listener.pid"
    LOG_FILE = "/tmp/d3-audit-listener.log"
    PROCESSED_FILE = "/tmp/d3-audit-processed.json"

POLL_INTERVAL = 15  # 秒

# 已知的 SKU 正则
SKU_SEGMENT = r'[A-Z][A-Z0-9]*(?:\*[0-9]+)?'
SKU_FULL = re.compile(r'^' + SKU_SEGMENT + r'(?:\+' + SKU_SEGMENT + r')*$')
SKU_IN_LINE = re.compile(r'^(' + SKU_SEGMENT + r'(?:\+' + SKU_SEGMENT + r')*)')

# 空格分隔的多 SKU 行：token 必须整体匹配，且同时含字母和数字
# （排除纯数字订单号、纯字母英文词、含小写/中文/标点的商品名片段）
SKU_TOKEN = re.compile(r'^[A-Z0-9][A-Z0-9]*(?:\*[0-9]+)?(?:\+[A-Z0-9][A-Z0-9]*(?:\*[0-9]+)?)*$')


# 套装段数量后缀：YPH0516*2 中带 *2 的段
_SEG_QTY = re.compile(r'\*([0-9]+)$')


def is_combo_sku(sku):
    """判断 SKU 是否为套装。
    套装两种形态：
      1. 多品组合：A+B+C（含 + 号）
      2. 同品多件：单编码带 *N（N>1），如 YPH0516*2（2盒装）、YPH0530*2
    """
    if '+' in sku:
        return True
    m = _SEG_QTY.search(sku.strip())
    return bool(m and int(m.group(1)) > 1)


def is_sku_token(tok):
    """判断一个空白分隔的 token 是否为 SKU（含套装 A+B 形式）。"""
    if not tok or len(tok) < 3:
        return False
    if not SKU_TOKEN.match(tok):
        return False
    if not re.search(r'[A-Z]', tok) or not re.search(r'[0-9]', tok):
        return False
    return True

running = True


def log(msg):
    ts = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    line = f"[{ts}] {msg}"
    print(line, flush=True)
    with open(LOG_FILE, "a") as f:
        f.write(line + "\n")


def run(cmd, timeout=30, **kwargs):
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, **kwargs)
        return r.stdout, r.stderr, r.returncode
    except subprocess.TimeoutExpired:
        return "", "timeout", 1


def load_processed():
    try:
        with open(PROCESSED_FILE, "r") as f:
            return set(json.load(f).get("ids", []))
    except:
        return set()


def save_processed(ids):
    with open(PROCESSED_FILE, "w") as f:
        json.dump({"ids": list(ids)[-500:], "updated": datetime.datetime.now().isoformat()}, f)


def send_group_message(text, at_open_ids=None):
    args = ["dws", "chat", "message", "send-by-bot",
            "--robot-code", ROBOT_CODE,
            "--group", GROUP_ID,
            "--title", "自动客审拦截",
            "--text", text]
    if at_open_ids:
        if isinstance(at_open_ids, (list, tuple)):
            at_open_ids = ",".join(at_open_ids)
        # 群消息 @ 人：轮询拿到的是 senderOpenDingTalkId，用 --at-open-dingtalk-ids
        # （--at-user-ids 要数字 userId，类型不匹配会静默不生效）
        args.extend(["--at-open-dingtalk-ids", at_open_ids])
        # 文本里也要有 @id 对应文本，钉钉才会渲染成 @人
        at_prefix = " ".join(f"@{oid}" for oid in at_open_ids.split(",") if oid)
        if at_prefix and not text.startswith("@"):
            text = at_prefix + "\n" + text
            args[-1] = text
    out, err, rc = run(args)
    ok = rc == 0 and '"success"' in out.replace(" ", "")
    # 记录 processQueryKey 到账本，以备日后撤回
    if notify_ledger:
        try:
            notify_ledger.append(
                notify_ledger.extract_key(out), text=text, source="audit-listener",
                title="自动客审拦截", group=GROUP_ID, robot=ROBOT_CODE,
                at_ids=at_open_ids or "", ok=ok)
        except Exception:
            pass
    return ok


def people_cmd(action, payload):
    """调用 audit-people.py，返回解析后的 JSON（失败返回 None）"""
    try:
        r = subprocess.run(["python3", PEOPLE, action],
                           input=json.dumps(payload, ensure_ascii=False),
                           capture_output=True, text=True, timeout=15)
        if r.stdout.strip():
            return json.loads(r.stdout)
    except Exception as e:
        log(f"people 错误 ({action}): {e}")
    return None


def fetch_recent_messages(since_time):
    """拉取 since_time 之后的群消息"""
    out, err, rc = run([
        "dws", "chat", "message", "list",
        "--group", GROUP_ID,
        "--time", since_time,
        "--direction", "newer",
        "--limit", "20",
        "--format", "json"
    ])
    if rc != 0:
        return []
    try:
        data = json.loads(out)
        return data.get("result", {}).get("messages", [])
    except:
        return []


def parse_skus_from_text(text):
    """从文本中提取 SKU 列表和批次备注。
    支持两种排版：
      - 每行一个 SKU（SKU 后跟品名）
      - 同一行多个 SKU 用空格分隔（SKU 品名 SKU 品名 ...）
    """
    items = []
    batch_remark_parts = []
    seen = set()

    def add_item(sku, name, remark):
        if sku in seen:
            return
        seen.add(sku)
        items.append({
            "sku": sku,
            "product_name": name,
            "is_combo": is_combo_sku(sku),
            "remark": remark,
        })

    for line in text.split("\n"):
        line = line.strip()
        if not line:
            continue
        # 去掉前导符号
        clean = line.lstrip("-•·*▪►▸→ ")
        tokens = clean.split()
        sku_positions = [i for i, t in enumerate(tokens) if is_sku_token(t)]

        if not sku_positions:
            # 无 SKU 的中文说明行 → 批次备注
            if re.search(r'[\u4e00-\u9fff]', clean):
                if not clean.startswith("@") and len(clean) < 200:
                    batch_remark_parts.append(clean)
            continue

        # 逐个 SKU：品名 = 该 SKU token 到下一个 SKU token 之间的文本
        for pos, idx in enumerate(sku_positions):
            sku = tokens[idx]
            end = sku_positions[pos + 1] if pos + 1 < len(sku_positions) else len(tokens)
            name_tokens = tokens[idx + 1:end]
            remark = ""
            for j, t in enumerate(name_tokens):
                if t.startswith("=="):
                    remark = " ".join(name_tokens[j:]).lstrip("=").strip()
                    name_tokens = name_tokens[:j]
                    break
            add_item(sku, " ".join(name_tokens).strip(), remark)

    batch_remark = "；".join(batch_remark_parts) if batch_remark_parts else ""
    item_remarks = [it["remark"] for it in items if it.get("remark")]
    if item_remarks:
        combined = item_remarks[:]
        if batch_remark:
            combined.append(batch_remark)
        batch_remark = "；".join(combined)

    return items, batch_remark


def tracker_cmd(action, *args, stdin_data=None):
    cmd = ["python3", TRACKER, action] + list(args)
    try:
        r = subprocess.run(cmd, input=stdin_data, capture_output=True,
                           text=True, timeout=30)
        if r.stdout.strip():
            return json.loads(r.stdout)
    except Exception as e:
        log(f"Tracker 错误 ({action}): {e}")
    return None


def handle_sku_message(text, sender_name, sender_open_id):
    items, batch_remark = parse_skus_from_text(text)
    if not items:
        return

    single_count = sum(1 for i in items if not i["is_combo"])
    combo_count = sum(1 for i in items if i["is_combo"])

    # 批次号不再提前取：交给 tracker 在“确实有新记录要建”时懒分配，
    # 避免重复 SKU / 告警误判等空触发白白耗号导致跳号。
    create_data = {
        "items": items,
        "batch_remark": batch_remark,
        "submitter": sender_name or "",
    }
    result = tracker_cmd("create", stdin_data=json.dumps(create_data, ensure_ascii=False))

    # 记录提交人（按 SKU），供日后拦截/恢复通知 @ 用
    # 注意：只记录本次新建的 SKU；已存在被跳过的保留原提交人，不要被重发者覆盖
    people_cmd("set-submitter", {
        "skus": [it["sku"] for it in items if it["sku"] in set(result.get("created", []) if result else [])],
        "name": sender_name or "",
        "open_id": sender_open_id or "",
    })

    if result:
        created = result.get("created", [])
        skipped = result.get("skipped", [])
        skipped_detail = result.get("skipped_detail", [])
        batch_no = result.get("batch_no")  # 本轮实际分配到的批次号（无新建时为 None）
        if not created:
            # 全是已存在的 SKU。能走到这里的都是真人提交（系统告警已被 is_system_alert 拦掉），
            # 给提交人一句轻量反馈，避免“发了没反应”被误以为机器人漏检；不分配批次号、不刷批次。
            if skipped_detail:
                head = skipped_detail[0]
                more = f"等 {len(skipped_detail)} 个" if len(skipped_detail) > 1 else ""
                btxt = f"（批次 #{head['batch']}）" if head.get("batch") else ""
                nm = f" {head['name']}" if head.get("name") else ""
                send_group_message(
                    f"ℹ️ {head['sku']}{nm}{more} 已在自动客审拦截列表中{btxt}，状态：{head.get('status','')}，无需重复提交。\n"
                    f"如需放开拦截，回复「恢复 #{head['batch']}」即可。",
                    at_open_ids=sender_open_id)
                log(f"重复提交反馈: 录入 0 个, 跳过 {len(skipped)} 个（已在拦截列表，已提示提交人，不耗批次号）")
            else:
                log(f"提交处理: 录入 0 个, 跳过 {len(skipped)} 个（无明细，不发群）")
            return
        lines = [
            f"✅ 已录入 {len(created)} 个商品到拦截列表（批次 #{batch_no}）",
            f"单品 {single_count} 个 / 套装 {combo_count} 个",
        ]
        if batch_remark:
            lines.append(f"备注：{batch_remark}")
        if skipped:
            lines.append(f"已存在跳过：{len(skipped)} 个")
        lines.append("")
        lines.append(f"处理完成后回复「恢复 #{batch_no}」即可删除拦截规则")
        send_group_message("\n".join(lines), at_open_ids=sender_open_id)
        log(f"批次 #{batch_no}: 录入 {len(created)} 个, 跳过 {len(skipped)} 个")


def handle_restore_message(text, sender_name, sender_open_id):
    def note_restorer(skus):
        """记录恢复发起人（按本次涉及的 SKU），供恢复完成通知 @ 用"""
        if skus:
            people_cmd("set-restorer", {
                "skus": skus,
                "name": sender_name or "",
                "open_id": sender_open_id or "",
            })

    # 恢复全部
    if re.search(r'恢复\s*(全部|所有|all)', text, re.IGNORECASE):
        result = tracker_cmd("mark-restore-pending")
        if result:
            skus = result.get("skus", [])
            if skus:
                note_restorer(skus)
                send_group_message(
                    f"🔓 已将 {len(skus)} 个商品标记为待恢复，将在下次轮询时从自动客审规则中删除",
                    at_open_ids=sender_open_id)
                log(f"恢复全部: {len(skus)} 个 (by {sender_name})")
            else:
                # 检查是否有已在待恢复中的
                pending = tracker_cmd("fetch", "待恢复")
                pending_count = len(pending) if pending else 0
                if pending_count > 0:
                    send_group_message(f"已有 {pending_count} 个商品在待恢复队列中，无需重复操作", at_open_ids=sender_open_id)
                else:
                    send_group_message("当前没有需要恢复的商品（待拦截/已拦截）", at_open_ids=sender_open_id)
        return

    # 恢复批次 #N
    m = re.search(r'恢复\s*[##]?\s*(\d+)', text)
    if m:
        batch_no = int(m.group(1))
        result = tracker_cmd("mark-restore-pending", f"#{batch_no}")
        if result:
            skus = result.get("skus", [])
            if skus:
                note_restorer(skus)
                send_group_message(f"🔓 批次 #{batch_no} 的 {len(skus)} 个商品已标记待恢复", at_open_ids=sender_open_id)
                log(f"恢复批次 #{batch_no}: {len(skus)} 个 (by {sender_name})")
            else:
                send_group_message(f"批次 #{batch_no} 没有已拦截的商品", at_open_ids=sender_open_id)
        return

    # 恢复指定 SKU
    if text.strip().startswith("恢复"):
        rest = text.strip()[2:].strip().lstrip("：:").strip()
        if rest:
            sku_list = [s.strip() for s in re.split(r'[，,；;\s]+', rest) if s.strip()]
            valid = [s for s in sku_list if SKU_FULL.match(s)]
            if valid:
                result = tracker_cmd("mark-restore-pending", ",".join(valid))
                if result:
                    n = len(result.get("skus", []))
                    if n:
                        note_restorer(result.get("skus", []))
                        send_group_message(f"🔓 已将 {n} 个商品标记待恢复", at_open_ids=sender_open_id)
                    else:
                        send_group_message("指定的商品不在已拦截列表中", at_open_ids=sender_open_id)


def is_restore_command(text):
    return bool(re.match(r'^\s*恢复', text.strip()))


# 系统告警 / 机器人回声 / 通知类消息的特征词：这些消息正文里可能带 SKU 编码，
# 但绝不是运营在提交拦截，绝不能当成人工提交（否则会白耗批次号、误建记录）。
_ALERT_MARKERS = (
    '报错', '告警', 'cron', '⚠️', '⚠', '待拦截', '待恢复', '删除失败', '添加失败',
    '执行失败', '执行报错', '拦截失败', '恢复失败', '恢复操作失败', 'row not found',
    'exact match', '已录入', '已拦截', '已恢复', '标记待恢复', '自动客审拦截', '客审拦截',
    'd3-audit', '脚本', '巡检', '熔断', '批次 #', 'D3客审', 'D3 客审',
)


def is_system_alert(text):
    """判断是否为系统告警/机器人通知类消息（含 SKU 也不是人工提交）。"""
    t = text or ''
    hit = sum(1 for m in _ALERT_MARKERS if m in t)
    # 命中 2 个及以上特征词，基本可判定为告警/通知
    return hit >= 2


def has_sku(text):
    for line in text.split("\n"):
        clean = line.strip().lstrip("-•·*▪►▸→ ")
        for tok in clean.split():
            if is_sku_token(tok):
                return True
    return False


def main_loop():
    global running
    processed = load_processed()
    # 启动时记录当前时间，只处理之后的新消息
    last_check = datetime.datetime.now() - datetime.timedelta(seconds=10)
    log(f"轮询监听启动，间隔 {POLL_INTERVAL}s，从 {last_check.strftime('%H:%M:%S')} 开始")

    while running:
        try:
            since = last_check.strftime("%Y-%m-%d %H:%M:%S")
            messages = fetch_recent_messages(since)

            # 水位线优先推进：无论消息是否机器人/是否已处理，都用本页最新消息时间戳推进
            # last_check。否则机器人消息占满分页窗口（newer 返回 since 之后最早的 N 条）
            # 时，水位线会永久卡死，后续人类消息被挡在窗口外永远拉不到。
            for msg in messages:
                ct_str = msg.get("createTime", "")
                try:
                    ct = datetime.datetime.strptime(ct_str, "%Y-%m-%d %H:%M:%S")
                    if ct > last_check:
                        last_check = ct
                except:
                    pass

            for msg in messages:
                msg_id = msg.get("openMessageId", "")
                if not msg_id or msg_id in processed:
                    continue

                content = msg.get("content", "")
                sender = msg.get("sender", "")
                sender_open_id = msg.get("senderOpenDingTalkId", "")

                # 跳过机器人自己发的消息
                if sender and ("MAC糖果" in sender or "糖果" in sender):
                    processed.add(msg_id)
                    continue

                processed.add(msg_id)

                if not content:
                    continue

                log(f"消息: [{sender}] {content[:80]}")

                if is_restore_command(content):
                    handle_restore_message(content, sender, sender_open_id)
                elif is_system_alert(content):
                    # 系统告警/机器人通知即便带 SKU 也不是人工提交，直接忽略
                    log(f"忽略系统/告警消息（含 SKU 字样但非人工提交）: [{sender}] {content[:50]}")
                elif has_sku(content):
                    handle_sku_message(content, sender, sender_open_id)

            save_processed(processed)

        except Exception as e:
            log(f"轮询异常: {e}")

        # 等待
        for _ in range(POLL_INTERVAL):
            if not running:
                break
            time.sleep(1)

    save_processed(processed)
    log("轮询监听已停止")


def signal_handler(signum, frame):
    global running
    log(f"收到信号 {signum}，停止...")
    running = False


def main():
    signal.signal(signal.SIGTERM, signal_handler)
    signal.signal(signal.SIGINT, signal_handler)

    with open(PID_FILE, "w") as f:
        f.write(str(os.getpid()))

    log("=== 自动客审拦截监听服务启动（轮询模式）===")
    main_loop()

    try:
        os.remove(PID_FILE)
    except:
        pass
    log("=== 服务已停止 ===")


if __name__ == "__main__":
    main()
