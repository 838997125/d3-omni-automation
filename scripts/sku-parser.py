#!/usr/bin/env python3
"""
SKU 解析器：从运营群消息中提取 SKU 编码和商品名称。

单品示例：
  PP014023
  YPH0422 施美力健苯磺酸左氨氯地平片2.5mg*14片/板*2板
  YPH0043捷诺维磷酸西格列汀片 100mg*28
  PP016899甲钴胺片(瑞尔)

套装示例：
  YPH0436+YPH0529+QT0020+QT0019 [蔓迪]米诺地尔泡沫剂5%(60g:3g)*60g/瓶/盒
  YPH0437+YPH0529*2+QT0019*2+QT0020+FF000748
"""
import re
import sys
import json

# SKU 段：大写字母开头，字母数字组合，可选 *N 数量
# 如 PP014023, YPH0436, QT0020*2
SKU_SEGMENT = r'[A-Z][A-Z0-9]*(?:\*[0-9]+)?'

# 完整 SKU 编码：单品一段，套装多段用 + 连接
SKU_PATTERN = re.compile(
    r'^(' + SKU_SEGMENT + r'(?:\+' + SKU_SEGMENT + r')*)'
)

# 匹配消息开头的"批量拦截："等引导语
PREFIX_PATTERN = re.compile(r'^(?:批量拦截[：:]\s*|拦截[：:]\s*|加入拦截[：:]\s*)', re.IGNORECASE)

# 套装段数量后缀：YPH0516*2 中带 *2 的段
SEG_QTY = re.compile(r'\*([0-9]+)$')


def is_combo_sku(sku):
    """判断 SKU 是否为套装。
    套装两种形态：
      1. 多品组合：A+B+C（含 + 号）
      2. 同品多件：单编码带 *N（N>1），如 YPH0516*2（2盒装）、YPH0530*2
    """
    if '+' in sku:
        return True
    seg = sku.strip()
    m = SEG_QTY.search(seg)
    if m and int(m.group(1)) > 1:
        return True
    return False


def is_sku_line(line):
    """判断一行是否以 SKU 编码开头"""
    line = line.strip()
    if not line:
        return False
    # 去掉前导符号
    line = line.lstrip('-•·*▪►▸→ ').strip()
    m = SKU_PATTERN.match(line)
    if not m:
        return False
    sku = m.group(1)
    # SKU 至少 3 个字符，避免误匹配普通单词
    if len(sku) < 3:
        return False
    return True


def parse_sku(line):
    """
    解析一行 SKU 文本，返回 (sku_code, product_name, remark) 或 None。
    """
    line = line.strip()
    if not line:
        return None

    # 去掉前导列表符号
    line = line.lstrip('-•·*▪►▸→ ').strip()

    # 匹配 SKU
    m = SKU_PATTERN.match(line)
    if not m:
        return None
    sku = m.group(1)
    if len(sku) < 3:
        return None

    rest = line[m.end():].strip()

    # 提取 == 后面的备注
    remark = ''
    if '==' in rest:
        parts = rest.split('==', 1)
        rest = parts[0].strip()
        remark = parts[1].strip()

    # 商品名就是 SKU 后面到行尾的内容（去掉前导空格）
    product_name = rest.strip()

    return {
        'sku': sku,
        'product_name': product_name,
        'remark': remark,
        'is_combo': is_combo_sku(sku),
    }


def parse_message(text):
    """
    解析整段群消息，返回：
    {
        'items': [{'sku', 'product_name', 'remark', 'is_combo'}, ...],
        'batch_remark': '批次级备注（末尾的中文说明行）',
        'has_sku': bool
    }
    """
    items = []
    batch_remark_parts = []
    seen_skus = set()

    # 去掉引导语
    text = PREFIX_PATTERN.sub('', text.strip(), count=1)

    # 处理同一行内多个 SKU 用大量空格分隔的情况
    # 在每个新的 SKU 编码前插入换行（前面有2+空格且后面紧跟 SKU 模式）
    text = re.sub(
        r' {2,}(?=[A-Z][A-Z0-9]*(?:\*[0-9]+)?(?:\+[A-Z][A-Z0-9]*(?:\*[0-9]+)?)*\s)',
        '\n',
        text
    )

    lines = text.split('\n')
    for line in lines:
        line = line.strip()
        if not line:
            continue

        parsed = parse_sku(line)
        if parsed:
            if parsed['sku'] not in seen_skus:
                seen_skus.add(parsed['sku'])
                items.append(parsed)
        else:
            # 非 SKU 行：检查是否是末尾的批次说明
            # 包含中文且长度合理的说明行，归为批次备注
            if re.search(r'[\u4e00-\u9fff]', line) and not is_sku_line(line):
                # 去掉 == 前面可能残留的 SKU 行的备注
                cleaned = line.strip()
                if cleaned:
                    batch_remark_parts.append(cleaned)

    # 合并批次备注
    batch_remark = '；'.join(batch_remark_parts) if batch_remark_parts else ''

    # 如果某个 item 有自己的 remark，拼入批次备注
    item_remarks = [it['remark'] for it in items if it.get('remark')]
    if item_remarks:
        combined_remarks = item_remarks[:]
        if batch_remark:
            combined_remarks.append(batch_remark)
        batch_remark = '；'.join(combined_remarks)

    return {
        'items': items,
        'batch_remark': batch_remark,
        'has_sku': len(items) > 0,
    }


def parse_restore_command(text):
    """
    解析恢复指令。返回：
    - {'action': 'batch', 'batch_no': N}
    - {'action': 'all'}
    - {'action': 'skus', 'skus': [...]}
    - None
    """
    text = text.strip()

    # 恢复全部
    if re.search(r'恢复\s*(全部|所有|all)', text, re.IGNORECASE):
        return {'action': 'all'}

    # 恢复批次 #N
    m = re.search(r'恢复\s*[##]?\s*(\d+)', text)
    if m:
        return {'action': 'batch', 'batch_no': int(m.group(1))}

    # 恢复指定 SKU
    if text.startswith('恢复'):
        rest = text[2:].strip().lstrip('：:').strip()
        if rest:
            skus = [s.strip() for s in re.split(r'[，,；;\s]+', rest) if s.strip()]
            valid_skus = [s for s in skus if SKU_PATTERN.match(s)]
            if valid_skus:
                return {'action': 'skus', 'skus': valid_skus}

    return None


# ============ 测试 ============
TEST_CASES = [
    # 样例1：两个套装，带 == 备注
    """YPH0436+YPH0529+QT0020+QT0019 [蔓迪]米诺地尔泡沫剂5%(60g:3g)*60g/瓶/盒
P010635+YPH0529+QT0018 [蔓迪]米诺地尔酊5％(90ml:4.5g)*90ml/瓶/盒 == 美团今晚补单品种，已加入自动不客审""",

    # 样例2：12个单品，末尾备注
    """YPH0422 施美力健苯磺酸左氨氯地平片2.5mg*14片/板*2板
YPH0483 欣昆甲钴胺片0.5mg*48片
YPH0359 复合乳酸菌肠溶胶囊6粒
P011761 欧维甲钴胺片0.5mg*20片
P012940 维生素C片 0.1g*100片
YPH0084 复方氨酚烷胺片（鲁西）12片
YPZ0242 小儿感冒颗粒（北京同仁堂）6g*6袋
YPH0043捷诺维磷酸西格列汀片 100mg*28
YPH0192 甲泰康 盐酸阿莫罗芬搽剂 5％*2.5ml
PP016899甲钴胺片(瑞尔)
YPH0074 富马酸比索洛尔片
P000325 云丰玄麦甘桔颗粒

以上品种今天抖店（示例店铺名）补单，已加入不自动客审。""",

    # 样例3：7个套装，末尾备注
    """YPH0436+PP014316+QT0019+QT0020
YPH0437+YPH0529+QT0019*2+QT0020+FF000748
YPH0436+PP014316+QT0019+QT0021
YPH0436+YPH0529+QT0019+QT0020+FF000748
YPH0437+YPH0529*2+QT0019*2+QT0020+FF000748
YPH0438+YPH0529+QT0019*3+QT0020+FF000748
YPH0438+YPH0529*2+QT0019*3+QT0020+FF000748

蔓迪泡沫剂60g 天猫众药堂今日补单品种 已加入不自动客审""",

    # 样例4：同样例1重复
    """YPH0436+YPH0529+QT0020+QT0019 [蔓迪]米诺地尔泡沫剂5%(60g:3g)*60g/瓶/盒
P010635+YPH0529+QT0018 [蔓迪]米诺地尔酊5％(90ml:4.5g)*90ml/瓶/盒 == 美团今晚补单品种，已加入自动不客审""",
]

if __name__ == '__main__':
    if len(sys.argv) > 1 and sys.argv[1] == '--test':
        for i, test in enumerate(TEST_CASES):
            print(f"\n{'='*60}")
            print(f"测试样例 {i+1}:")
            print(f"{'='*60}")
            result = parse_message(test)
            print(f"商品数: {len(result['items'])}")
            for item in result['items']:
                typ = '套装' if item['is_combo'] else '单品'
                print(f"  [{typ}] {item['sku']:45s} | {item['product_name'][:35]}")
            print(f"批次备注: {result['batch_remark']}")

        print(f"\n{'='*60}")
        print("恢复指令测试:")
        print(f"{'='*60}")
        for cmd in ['恢复 #5', '恢复全部', '恢复 PP014023,YPH0422', '恢复5', '恢复 12']:
            print(f"  '{cmd}' → {parse_restore_command(cmd)}")
    else:
        # 从 stdin 读取消息
        text = sys.stdin.read()
        result = parse_message(text)
        print(json.dumps(result, ensure_ascii=False, indent=2))
