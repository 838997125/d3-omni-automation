#!/usr/bin/env python3
"""从 /tmp/d3-shortage-result.json 生成钉钉群通知 Markdown 文本"""
import sys, json, datetime

with open('/tmp/d3-shortage-result.json') as f:
    d = json.load(f)

now = datetime.datetime.now().strftime('%Y-%m-%d %H:%M')
lines = []
lines.append('### 🚨 D3 缺货订单提醒')
lines.append(f'检测时间：{now}')
lines.append(f'缺货订单数：**{d["count"]}** 笔')
lines.append('')
lines.append('| 订单号 | 平台 | SKU | 商品 | 库存/数量 |')
lines.append('|--------|------|-----|------|-----------|')
for o in d['orders']:
    for s in o['shortage']:
        title = (s.get('title') or '')[:20]
        lines.append(f"| {o['code']} | {o['platform']} | {s['sku']} | {title} | {s['avail']}/{s['num']} |")
lines.append('')
lines.append('请运营尽快核实库存并处理，客服将联系客户引导退款。')

print('\n'.join(lines))
