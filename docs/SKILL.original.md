---
name: d3-coldchain
description: >-
  D3 OMS 订单异常自动处理。包含两个场景：
  1) 冷链异常单：当用户提到「冷链订单」「处理冷链」「冷链转异常」时，按 SKU 编码查询待审核订单并批量标记为「冷链」异常；
  2) 缺货异常单：当用户提到「缺货订单」「处理缺货」「缺货转异常」时，自动遍历当天+昨天的待审核订单，
  逐单加载货品明细比对「可用库存 < 货品数量」，将缺货订单通过「标记异常」弹窗转为「缺货」异常，
  并通过 MAC糖果机器人在战略部消息群 @运营 通知。
  依赖 opencli browser（Browser Bridge 扩展已连接）+ dws CLI。
---

# D3 冷链异常单自动处理

## 触发词

当用户表达以下意图时加载本 skill：
- "处理冷链订单" / "冷链转异常" / "冷链单标异常"
- "D3 标记异常" / "批量标记异常"
- "待审核订单批量转异常"
- 提供了一批 SKU 编码并要求在 D3/OMS 中操作

**重要：用户未提供 SKU 编码时，直接使用默认列表 `d3-coldchain-skus.txt`，
不要追问 SKU。** 只有用户明确要求更换 SKU 或提供了新列表时才使用 `--skus` 参数。

## 前置条件

1. **opencli 已安装且 Browser Bridge 扩展已连接**
   - 先运行 `opencli doctor`，确认三项全绿（Daemon / Extension / Connectivity）
   - 如果扩展未连接，提示用户安装或启用 Browser Bridge 扩展，不要继续

2. **D3 登录凭据已在浏览器中保存或用户已提供**
   - 系统会自动填充租户/账号/密码；若未保存则需要用户手动登录一次

## 自动化脚本

脚本路径（Mac）：`~/.openclaw/workspace/skills/d3-coldchain/scripts/d3-coldchain.sh`

### 用法

```bash
# 默认用法：不指定 SKU，自动读取同目录 d3-coldchain-skus.txt（15个默认SKU）
~/.openclaw/workspace/skills/d3-coldchain/scripts/d3-coldchain.sh

# 临时指定 SKU（逗号分隔）
~/.openclaw/workspace/skills/d3-coldchain/scripts/d3-coldchain.sh --skus "24P3839,P008580,PP016726"

# 指定其他异常原因
~/.openclaw/workspace/skills/d3-coldchain/scripts/d3-coldchain.sh --reason "缺货"

# 指定其他 SKU 文件
~/.openclaw/workspace/skills/d3-coldchain/scripts/d3-coldchain.sh --sku-file "/path/to/skus.txt"
```

### 参数

| 参数 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| -s, --skus | 否 | 从文件读取 | 货品 SKU 编码，逗号分隔 |
| -f, --sku-file | 否 | 脚本同目录 d3-coldchain-skus.txt | SKU 列表文件，每行一个，# 开头为注释 |
| -r, --reason | 否 | 冷链 | 异常原因（冷链/缺货/补单/运营通知添加异常/不发货/顺丰特快+冰袋） |
| --session | 否 | d3-coldchain | opencli 浏览器会话名 |
| --base-url | 否 | https://d3.diansan.com | D3 系统地址 |

### 默认 SKU 列表文件

`d3-coldchain-skus.txt` 与脚本同目录，当前包含 15 个 SKU：
24P3839, P008580, PP016726, PP016725, YPH0070, YPH0068, YPH0211, YPH0210,
YPH0209, YPH0208, YPS0007, PP016066, PP016875, YPS0009, P009141。
需要增减时直接编辑该文件，脚本下次运行自动生效。

## 脚本执行的完整流程

1. **打开订单客审页** — 直接打开 iframe URL（避免跨 iframe ref 失效）
   `/omni/order/order-check/indexFeature/index.html`
2. **自动登录** — 若被重定向到登录页，自动填入租户/账号/密码并登录，处理密码过期弹窗
3. **设置查询字段** — 货品信息第二下拉框 → 货品sku编码
4. **设置匹配方式** — 第一下拉框 → 包含任一（关键：不是默认的全包含）
5. **填入 SKU** — 逗号分隔填入货品信息输入框
6. **点击查询** — 等待结果加载
7. **检查结果数** — 若 0 条则直接结束
8. **全选订单** — 通过 canvas 表格的 Vue 内部方法 `_onCheckAll()`
   （普通 DOM click 对 canvas 表格无效；这是关键技术点）
9. **点击标记异常** — 弹出异常原因对话框
10. **选择异常原因** — 默认冷链，可参数化
11. **点击确定** — 提交
12. **验证结果** — 对比操作前后数量，确认弹窗已关闭

## 关键技术细节

- **iframe 问题**：D3 主页面将订单客审嵌入 iframe，直接在主页操作 iframe 内元素会
  出现 ref not found。脚本直接打开 iframe URL 作为顶层页面，绕过此问题。
- **Canvas 表格**：订单列表使用 canvas 渲染（spreadtable 组件），没有 DOM checkbox。
  必须通过 Vue 实例方法 `__vue__._onCheckAll()` 来全选。
- **匹配方式**：默认是「全包含」，必须改为「包含任一」才能按多个 SKU 做 OR 查询。
- **SKU 分隔符**：英文逗号。

## 异常原因可选值

- 冷链（默认）
- 缺货
- 补单
- 运营通知添加异常/不发货
- 顺丰特快+冰袋

## 执行后验证

脚本会输出：
- 原查询结果条数
- 剩余待审核条数
- 成功标记异常的条数（= 原值 - 剩余值）

如果脚本报告异常或结果不符合预期：
1. 检查浏览器页面是否有未关闭的弹窗或错误提示
2. 检查 opencli 会话是否还活着：`opencli browser d3-coldchain state`
3. 必要时截图查看：`opencli browser d3-coldchain screenshot`

## 手动排障命令

```bash
opencli doctor
opencli browser d3-coldchain state
opencli browser d3-coldchain get url
opencli browser d3-coldchain screenshot
```

---

# D3 缺货订单自动检测、打标与到货跟踪

## 触发词

当用户表达以下意图时使用缺货脚本：
- "处理缺货订单" / "缺货检测" / "缺货打标"
- "检查缺货" / "D3 缺货" / "缺货跟踪"

## 脚本

主脚本：`~/.openclaw/workspace/skills/d3-coldchain/scripts/d3-out-of-stock-ego.sh`
浏览器逻辑：`~/.openclaw/workspace/skills/d3-coldchain/scripts/ego-shortage.mjs`
跟踪表工具：`~/.openclaw/workspace/skills/d3-coldchain/scripts/d3-shortage-tracker.py`

> **注意**：ego-browser 版为当前版本，固定使用 task space ID 24（d3-shortage-auto）。
> 旧 opencli 版 `d3-out-of-stock.sh` 仍保留但不再用于定时任务。

### 用法

```bash
# 正式运行：检测缺货 → 打标 → 写跟踪表 → 到货通知
~/.openclaw/workspace/skills/d3-coldchain/scripts/d3-out-of-stock.sh

# 只检测不操作（排查用）
~/.openclaw/workspace/skills/d3-coldchain/scripts/d3-out-of-stock.sh --dry-run
```

### 处理流程

1. 进入订单客审页，加载全部待审核订单（200条/页）
2. **一次遍历同时完成三件事**：
   - 逐单加载货品明细，比对 `availableNum`（可用库存）< `num`（货品数量）
   - **新缺货**：没有缺货标签的订单 → 打"缺货"标签 + 写入跟踪表 + 群通知
   - **已到货**：已有缺货标签但所有商品库存已满足 → 更新跟踪表为"已到货待审" + @客服审单
   - **已审核**：缺货标签订单状态变为非待审核 → 更新跟踪表为"已审核"（闭环）
3. 不转异常单，只打标签，订单留在待审核队列

### 打标操作（不转异常单）

1. 通过 `_onSelectRows(ids, rows)` 选中缺货订单
2. 调用顶层组件 `top.mark()` 打开打标弹窗
3. 选中第三个 radio（缺货，tagId=613013）
4. 点击"打 标"按钮确认
5. 订单的 `tags` 字段会出现 `{id:613013, tagName:'缺货'}`

### 钉钉缺货跟踪表

- **所在 Base**：发货订单管理系统（`jb9Y4gmKWrALBykmTe2A2g3l8GXn6lpz`）
- **数据表 ID**：`8FWt8wz`
- **字段**：订单号、平台、店铺、缺货SKU、缺货商品名、需求数量、当前可用库存、状态（缺货待到货/已到货待审/已审核）、首次检测时间、预计到货时间（人工填写）、到货通知时间、审核时间、客服备注、D3订单ID
- **状态流转**：缺货待到货 → 已到货待审 → 已审核
- 预计到货时间由采购/人工在表中填写

### 定时任务

- **Cron 名称**：`d3-out-of-stock-hourly`
- **频率**：每 1 小时
- **状态**：✅ 已启用（2026-08-25）
- **并行隔离**：补单、冷链、缺货三个场景使用独立的 opencli browser session（d3-budan / d3-coldchain / d3-shortage），各自绑定独立浏览器 tab，互不干扰，可同时运行

### 通知配置

- 机器人：MAC糖果（robotCode=`dingsshadsm8rt5h7ruv`）
- 群：亿民补单-测试群（`cid5wfiNs3aPtM7DpL050FRUQ==`）
- 新缺货通知：@客服组全部人员，列出缺货品种和库存
- 到货通知：@客服组全部人员，列出已到货订单号，提醒审单
  - Base：发货订单管理系统（`jb9Y4gmKWrALBykmTe2A2g3l8GXn6lpz`），表 ID：`y89Wute`
  - 字段：平台（`6O9aB0Z`）、人员（`pbTluRY`，user 类型）
  - 若读取失败则 fallback @张一钦

### 关键技术点

- **打标 vs 标记异常**：打标（`top.mark()`）是打样式标签，订单留在待审核队列；标记异常（`top.isException()`）是转异常单池。缺货流程只打标不转异常
- **缺货标签 ID**：613013（`tagName: '缺货'`，背景色 `#d3f948`）
- **canvas 表格**：通过 Vue 实例操作，`_onSelectRows(ids, rows)` 选中、`_onCheckAll()` 全选
- **货品明细字段**：第二个 spreadtable 的 `dataSource` 中，`availableNum`=可用库存，`num`=货品数量，`outerId`=SKU
- **跳过已有标签**：检测时跳过已有缺货标签的订单，避免重复打标；这些订单用于到货检测

---

# D3 补单/占单自动处理

## 触发词

当用户表达以下意图时使用补单/占单脚本：
- "处理补单" / "补单处理" / "占单处理"
- "轮询补单表格" / "查补单登记表"
- 补单/占单也由 cron 每5分钟自动轮询，无需手动触发

## 定时任务

- **Cron 名称**：`d3-budan-poll`
- **频率**：每 5 分钟
- **运行方式**：isolated session，无消息推送（delivery=none）
- **行为**：查钉钉表格待处理记录 → D3 自动操作 → 回写结果 → 群通知

## 钉钉登记表

- **多维表 Base ID**：`jb9Y4gmKWrALBykmTe2A2g3l8GXn6lpz`
- **数据表 ID**：`hERWDMS`
- **表格链接**：https://alidocs.dingtalk.com/i/nodes/jb9Y4gmKWrALBykmTe2A2g3l8GXn6lpz?entrance=data&sheetId=hERWDMS
- **字段**：订单号（主键）、类型（三方补单/自营补单/占单）、平台/店铺、提交人、提交时间、备注/原因、处理状态、客服备注、处理结果、处理时间、处理人、D3订单ID、原始SKU、原始商品名、错误信息
- **读取只活跃记录（服务端过滤）**：shell 查询用 `dws aitable record query --filters '{or:[eq 状态=待处理, un_exist 状态]}' --field-ids 单号,类型,提交人,状态 --all`，服务端只返回待处理/空状态的活跃记录（个位数），读量恒定、不随登记表历史增长；**回写按 recordId 定点 update**，同样与表总量无关。singleSelect 字段过滤值传选项名称（如“待处理”）。

## 自动化脚本

脚本路径：`~/.openclaw/workspace/skills/d3-coldchain/scripts/d3-budan-process.sh`

### 处理流程（v2：以 D3 系统单为单位，支持合并/拆单）

登记表里一次可填多个原始单号，而 D3 会独立做合并/拆单，两者是**多对多**关系：
- **合并单**：不同次填写、或同次多个单号，被 D3 合进同一个系统单（`refOids` 含多个原始单号，可能还混入登记表没填的无关单号）。
- **拆单**：同一次填写的单号，被 D3 拆到不同系统单。

v2 不再“按登记表记录逐个搜索”，改为：

1. 打开 D3 客审页，**全量加载**当前待审核订单（`clickQuery` 后轮询到 `dataSource.length === pagination.total`，不使用搜索框，避开 clearSearch/dataSource 不同步 bug）。
2. 每行直接带 `refOids`（数组）和 `lines`（含 `outerId` SKU），用 `refOids` 与所有待处理原始单号做**交集**，反查命中的 D3 系统单。
3. 以 D3 系统单为处理单位：
   - 一个 D3 单命中多个单号/多条记录（合并）→ 只处理一次，覆盖的所有单号都记成功。
   - 一条记录的单号落在多个 D3 单（拆单）→ 每个 D3 单各处理一次，全部成功才算该记录完成。
   - 类型冲突（同一 D3 单既有补单又有占单登记）→ 不自动操作，记冲突告警人工。
   - 待审核列表里找不到的单号 = 未同步，**保留待处理下轮**（绝不“假去重”）。
4. 处理后**强制校验**：原地轮询 dataSource，确认该 D3 单已离开待审核列表才算成功（不重复 clickQuery 全量刷；超时才兜底刷一次）。

### 补单（三方补单/自营补单）

1. 按 D3 行 id 选中订单（`_onSelectRows` + `_onRowClick`）→ 切「货品列表」
2. 逐轮换货：找到第一个非 `FF000748` 的货品行（同 `suitSkuId` 套装行自动全选）→ `_exchangeGoods(line,false)` 打开「更换商品」弹窗 → 搜 `FF000748` → `selectionSourceChange` 选中 → 确定；轮询直到货品列表全部为 `FF000748`
3. 写客服备注 `0000`（`editSellerMemo`）
4. **按 id 重新选中订单行**（换货切 tab 会丢选中态）后 `audit()` 审核通过
5. 关闭「操作结果」弹窗（按钮“关 闭”），校验订单已离开待审核
6. 回写表格：已处理 / 已改商品+审核通过 / D3订单ID / 原始SKU / 原始品名
7. 群通知 @提交人

### 占单

1. 按 id 选中订单（**不进货品列表、绝不换货**）
2. `标记异常` → 异常原因选「运营通知添加异常/不发货」→ 确定
3. 关闭弹窗，校验订单已离开待审核
4. 回写：已处理 / 已转异常单；群通知 @提交人

> ⚠️ **markException 必须逐步校验，不能无条件返回成功**：点按钮→弹窗打开→选原因→点确定→弹窗关闭，每一步都要确认真的发生（按钮点到、弹窗真开、选项真选中并返回可选项、确定点到、等弹窗关闭且抓 D3 报错），任一步失败就返回 `{success:false,error}`。旧版 `markException` 无脑返回 `'exception-done'`，叠加 `waitOrderGone` 只看一次“列表里没了”，曾出现“异常实际没打上、表格却回写已转异常单”的假成功（2026-08-28 单 1648096 络活喜：仍在待审核 P006920，表格却显示已转异常）。

### 关键技术点

- **全量加载 + refOids 交集**：不用搜索框；每行 `refOids` 是数组（比拆 `refOid` 字符串可靠），用它与待处理单号做交集映射，天然支持合并/拆单。
- **分页条数必须强制设大**：新开的 ego task space 默认 **20 条/页**，不设会截断待审核列表导致漏单。`loadAllOrders()` 开头先 `setPageSizeLarge()`（把 tableProps.pagination.pageSize=1000、current=1）再查询。
- **加载前必须清空查询表单**：不能假设页面控件是干净的。tab 可能残留搜索词/日期/筛选（调试或上轮留下），只点“查询”会带着残留条件查到过滤后的子集（极端为 0 条），导致整批单号误判“未同步/未找到”。`loadAllOrders()` 开头先 `resetSearchForm()`：清空所有可见文本输入框（原始订单号/系统订单号/货品信息）并 dispatch input+change，点掉 select 的清除 ×，再查询。
- **全局互斥锁（2026-09-07 改为必须互斥，废弃“不用锁/多 space 并发”）**：cron 每 5 分钟一轮，shell 入口 `acquire_lock()` 用 `mkdir` 原子锁（macOS 无 flock）`/tmp/d3-budan.lock`（内含 PID+启动时间戳）+ `trap EXIT/TERM/INT` 释放 + stale 检测（PID 存活→本轮直接 exit 0 跳过；PID 死且锁龄 >600s→判 stale 抢占重建，<600s 保守跳过）。**根因教训（2026-09-07）**：旧设计让超时轮次的 ego 进程继续跑、下一轮换新 ego task space（`d3-budan`/`-2`/`-3`，epoch/300%3 轮换）并发操作同一批 D3 订单，两个 tab 交叉换货/审核导致“换货弹窗未打开/货品行未变运费链接2”假失败，甚至换货未完成订单被放行审核（原货流出）。现绝不并发，拿不到锁就等下一轮。（space 轮换代码保留但单实例下无实际并发。）输入文件仍 `mktemp -t budanpending` 每轮独立，路径经 `globalThis.__BUDAN_INPUT__` 传入（ego nodejs 不支持自定义 argv/env）。
- **孤儿 ego 防护 + 台账原子合并写（2026-09-09 修复，根因见案例 9 单假失败）**：cron 300s 超时会 SIGKILL 掉持锁 shell（trap 放锁），但 `ego-browser nodejs` 子进程可能成**孤儿继续跑**；下一轮拿到新锁又起一个 ego → 两进程并发操作同一批 D3 单，且各自启动时读入旧台账快照、结束时 `writeFileSync` **整份覆盖**，后写的冲掉先写的成功单号（铁证：3616411011514621 14:29 曾命中 D3 1701658 成功入台账，随后消失）。已成功离开待审核的单号一旦台账丢失，脚本在待审核池找不到、台账又没有 → 永久 notFound → 记录卡待处理 → 满 25 分钟触发超时 @（假报警）。两道修复：①shell 用带 `set -m` 的子 shell 让 ego 在**独立进程组**后台跑，把 PGID 写 `$LOCK_DIR/ego.pgid`，trap `_cleanup` 与 stale 接管时 `kill -TERM/-KILL -PGID` **整组杀光**（ego 及子孙），不再有孤儿；②`saveLedger()` 改为**读磁盘最新→只 merge 本进程新增成功单号（不回退已成功）→临时文件+rename 原子落盘+5 次重试**，绝不整份覆盖。验证：陈旧快照单测（磁盘 A+B，本进程只知 A 却新成 C，写后 A/B/C 都在）通过；真实一轮 9 单全命中台账、记录正确置已处理。
- **订单“换货/标记前消失”= 事故告警，绝不当成功（2026-09-07）**：`processBudanD3Order`/`processZhandanD3Order` 选中订单时若 `selectRowById` 返回 nf（本轮 loadAllOrders 已拍到该单、台账也无成功记录，此刻却选不中），先 `confirmOrderReallyGone()`：强制 `clickQuery()` 重查待审核列表、连续 2 次（两轮、每轮多次）非 loading 都读不到才判“真消失”；能查回=列表刷新/分页抖动的**假消失**，重新选中继续处理。真消失时，加锁后不存在“自己并发审核”、脚本也还没换货/转异常，唯一可能是被 **D3 自动客审放行（原货未换成运费链接2就审出去=事故）**，返回 `{success:false, vanished:true}` → postprocess 归 hardfail，立即置「处理失败」+@提交人+@客服组+发群。旧代码把 nf 当 `alreadyGone:true` 成功是严重漏报。注意：订单还没同步进 D3 的情况走 notFound（loadAllOrders 根本没拍到），不会误触发 vanished。
- **临时失败自动重试 + 熔断（2026-09-07）**：postprocess 把失败分三类：①未同步 notFound→保持待处理、不计数、不发群；②临时失败 transientfail（换货失败/审核失败/审核后仍在列表/处理异常）→**保持「待处理」**、结果栏写“自动重试中(n/3)”、**静默不发群**（这样人工取消审核后订单重回待审核，下一轮 cron 能重新捞起→换好→正常发成功通知；旧逻辑一遇失败就置「处理失败」永久停重试，人工取消后再也捞不起、成功也无通知）；③永久/事故 hardfail（vanished 事故 / conflict 类型冲突 / unknownType 类型未知）→立即「处理失败」+@客服+发群。临时失败本地计数文件 `/tmp/d3-budan-retry.json`（按 orderCode，MAX_TRANSIENT_RETRY=3），连续 3 次仍失败才升级「处理失败」发群（over_quota，计数达阈值时**不要 pop**，否则通知块重读时 count 归零不发群）；全成功/未同步时清对应单号计数。
- **自补单 notFound 超时二次核实闭环（2026-09-10 定稿；取代 09-09 的“满45分钟直接@”）**：背景是 09-09 晚多笔自补单因平台→D3 夜间批量同步延迟（有的 1 小时才进 D3），满 45 分钟时其实只是“还没同步”（无发货风险）却误 @ 了人工。现改为：自补单满约 45 分钟（`PLAN_VERIFY_MIN=40`）仍 notFound（待审核池、台账都没有）时，ego 自动去 **「出库计划单(通知成功)」页按原始单号二次核实**，三结局分流，尽量不 @：
  - **结局 A 已通知仓库 + 货品全是 FF000748** → 其实已成功：补成功台账（`planVerified:true`），本轮直接算成功、记录置已处理，**不 @**。
  - **结局 B 已通知仓库 + 有原货**（没换货就被审核放行，原货险被仓库真发）→ **自动救回、不 @**：勾选该计划单点「取消计划单」（多个确认框一律点确定/确认），等订单离开通知成功列表、回到待审核，随后脚本重做换货→备注→审核。读不到商品明细时保守 `unknown` 跳过，绝不把“没读到”当原货误取消。
  - **结局 C 出库计划单也没有** → 确实还没同步：静默继续等；**满 60 分钟（`PLAN_UNSYNC_ALERT_MIN=60`）仍两列表皆无**，ego 置记录级 `unsyncedOver60:true`，postprocess 才发「⏰ 超1小时未进D3」@提交人+客服（疑处方单异常卡在异常单，需人工），每条仍只 @ 一次（`budan-stale-alert.json` 去重）。
  - 页面/接口：计划单页 URL `/omni/3rd-warehousing/stock-out-plan/index.html?stockPlanStatus=NOTIFY_SUCCESS`，顶层组件 `OutPlanIndexNext`，查询框 `#refOid`（原生 setter 写入+点查询），主表 `tableProps.dataSource`（行有 `id`/`refOid`/`sourceId`=D3订单ID/`status.enumName`）。商品明细走接口 `POST /app-web/router/rest.json?method=sharing.third.warehousing.whsStockOutPlanLine.getPage`，**请求体必须 `{"qo":{"planIds":[<计划单id>],"pageNo":1,"pageSize":200}}`**（直接传 planId 不过滤会返回全表！必须按返回行 `planId===rowId` 再筛一道），返回 content[].outerId。取消计划单=勾选行(`onSelectChange`)+点「取消计划单」按钮+确认弹窗。入口是首页待办卡片（在 `dashboard/home/index.html` iframe），但自动化直接用上述 URL。
  - 仅自补单生效；三方补单/占单不触发。读侧 A/C 已真实单测验证（已知成功单读到 [FF000748] allFF=true；不存在单号 found=false）；postprocess 5 场景打桩全过；端到端新单正确 notFound 不 @。**结局 B（取消计划单写操作）首次真实触发需人工旁站验证。**
- **（已被上条取代，留档）自补单超 45 分钟直接 @（2026-09-09 初版，2026-09-10 改为二次核实闭环后不再满45分钟就 @）**：旧逻辑 postprocess 对满 `STALE_AFTER_MIN=40` 的自补单直接 `send_stale_alert()` @。现 @ 条件改为只认 ego 的 `unsyncedOver60`（满60分钟两列表皆无）；`STALE_AFTER_MIN`/`PLAN_ALERT_AGE_MIN=60` 仅参考。龄期由提交时间字段 `g6Tme2D` 计算。
- **所有人工告警一律只提醒一次（2026-09-09 14:40 代总追加要求）**：失败告警（hardfail 事故/冲突/未知 + over_quota 熔断）加第二道去重文件 `budan-notify-sent.json`（脚本目录，按 recordId，2 天 TTL）。正常情况下失败记录当轮即置「处理失败」、cron 只捞「待处理」本就不会重复发，此文件防回写失败/记录被复位/过滤变动后每轮重复 @；成功通知不受去重影响（dedup 只 gate `realfail`），记录办结成功即 pop 标记，人工复位后重新失败可再提醒一次。`send_stale_alert` 的 30 分钟超时提醒继续用 `budan-stale-alert.json` 去重。跨进程单测：vanished 首轮发、次轮静默、成功轮能发成功通知，全过。
- **行数据自带 lines**：待审核列表每行的 `lines` 直接含 `outerId`(SKU)/`suitSkuId`，不进详情即可读全部货品 SKU。
- **换成单品**：OrderLineTable 实例 `_exchangeGoods(line, false)`；弹窗内商品选择也是 canvas spreadtable，用 `selectionSourceChange([id],[row])` 选中（不是 `_onCheckAll`）。
- **换货选行必须按“平台子订单”分组（关键）**：D3 校验“换出货品必须来自同一个平台子订单才可以换货”。合并单里多行可能同属一个套装（同 `suitSkuId`）但分属不同原始单/子订单（货品行 `refOid` 不同）。选行规则：只选 `refOid` 相同的行；其中套装行（suitSkuId≠0）连同该子订单内同套装全部行，普通单品只选该行；跨子订单的行**分多次换货**（外层轮询逐组处理）。只按 suitSkuId 全选会报“换出货品必须来自同一个平台子订单”。
- **换货弹窗报错要早抓**：`_exchangeGoods` 不弹弹窗时，D3 的 ant-message 错误提示约 3 秒消失；触发后要 800ms 起高频轮询（~600ms×8）抓 `.ant-message-notice`，不能 sleep 4s 才看（会漏掉真实报错，只拿到空 `closed:`）。
- **换货报错要做快照 diff + 强校验，防止假失败（2026-09-02 初修，2026-09-04 完善）**：合并/多子订单里换货成功后行 id 会变，D3 可能对陈旧行返回报错气泡（如「换出的货品不属于该订单」），但换货实际已成功。做法：①触发换货前先快照已存在的 `.ant-message-notice` 文本，之后只把“新冒出”的气泡当本轮结果（过滤上一轮残留）；②点“确定”后即使抓到报错，也先 `refreshLines` 强刷新货品行，按「整单非FF行数减少」或「该 refOid 子订单已全 FF000748」判定，**连续 3 次**强校验不过才判真失败；③外层兜底用 **4 轮 refreshLines+sleep(3s) 多轮重刷新**（异步换货落地需要时间），任一轮看到非FF行减少/子订单全FF就 continue，绝不在异步落地前判死。
  - **⚠️ 2026-09-04 补充：「换货任务已提交」是异步受理提示，不是报错！** D3 换货是异步的，点确定后弹「[DsApiError] 换货任务已提交」表示后台已受理排队，根本不含“成功”二字，旧逻辑用 `气泡文本.indexOf('成功')<0` 判报错会把它误判成失败。已在 ego-budan.js 加 `isBenignExchangeMsg()`/`pickHardErr()`：把含 `换货任务已提交`、`已提交`、`换出的货品不属于该订单`、`成功` 的气泡一律当良性（非硬错误），硬错误才判失败；良性/弹窗已关但货品行未变时继续等待轮询（等待窗口 2s×10→2.5s×16），绝不因异步延迟判死。案例：2026-09-04 08:40 G5Btgd33ol（3610406007906495→D3 1676931、3610425018173844→D3 1677057，报“换出的货品不属于该订单”）与 67lwA3KUmo（3610437018065293、3610414019659994，报“换货任务已提交”）共 4 单被假失败，后台核实均已换货+审核成功。处理：4 单补入台账、两条登记记录复位为“待处理”+清空假错误栏（让未同步单继续自动补）、群里发更正通知撤销假 @客服告警。
  - **次生坑**：记录一旦被置“处理失败”，cron 只捞“待处理”，会把该记录里其余尚未同步的单号一起卡死。所以假失败复位必须把记录改回“待处理”（已成功单号靠台账命中跳过，不会重复处理）。
- **换货验证超时要兜底重读，不能一次超时就中止**：`exchangeToSingle` 内部验证（刷新货品列表核对非FF行数）在多行品/刷新慢时可能超时误判失败，但 D3 换货动作其实已成功（案例 2026-08-28 1648091 干扰素凝胶+推进器：货已全换成 FF000748，脚本却判超时、停在审核前成半成品）。所以 `processBudanD3Order` 换货循环里，`exchangeToSingle` 返回失败后先 `refreshLines()` 重读整单货品行：若非FF行数实际减少（`beforeNonFF > afterNonFF`）说明换货已生效，log 警告并 continue 下一轮；只有真无进展才判失败。最终验证（整单 all FF）仍把关，绝不会放非FF半成品去审核。
- **origSku/origName 要排除运费链接2本身**：合并单可能部分行已是 FF000748，统计原始品种时过滤掉 REPLACEMENT_SKU / “运费链接2”，否则通知/回写里原SKU会混入 FF000748。
- **审核前必须按 id 重新选中，且要 _onRowClick + 重试**：换货过程切「货品列表」tab 后，主表选中态会丢，直接 `audit()` 会 `no-selection`。仅调 `_onSelectRows([id],[row])` 不够——停在详情/货品行子 tab 时选中态不会同步到顶层 `selectedRows`，必须同时调 `os._onRowClick(row,true)`（与 selectRowById 一致），并且选中后读 `top.$data.selectedRows.length` 确认 >0，为空最多重试 3 次。案例：2026-09-04 抖音自补单 1679571（6955679272346785170，吡美莫司乳膏 YPH0443）换货成功但审核报 `no-selection`、卡在待审核；只读探针确认货品行已全 FF000748、只差审核。修复 auditOrder 加 `_onRowClick` + 选中重试后，手动跑一轮：该单 1679571 与原“未同步”单 1679762 均一次审核通过（日志 `审核前选中(第1次): {"selected":1}` → `audit-done`）。注意这类报错属“换货成功、审核漏点”，与 9-4 上午的异步假失败不是同一类。
- **客服备注**：顶层组件 `editSellerMemo('0000', {thirdOrderCode, flag:0})`，`thirdOrderCode` 取货品行 `thirdOid`。
- **审核/异常后校验**：轮询 dataSource 确认订单行消失（离开待审核）才算成功，杜绝“报成功但实际没处理”。`waitOrderGone` 要求**连续 2 次**都读到消失才判离开（单次可能撞上列表刷新/分页瞬时抖动，把“还在”误判成“已离开”导致假成功），超时兜底 clickQuery 重查同样要连续 2 次。
- **未同步不假成功**：待审核里找不到的单号只保留待处理，下轮再来，绝不因 processedD3Ids 非空就判去重成功。
- **失败分级 + 告警**：
  - **未同步**(notFound，订单还没进 D3)：表格保持「待处理」、不发群消息（避免每 5 分钟刷屏），下轮自动补。
  - **真失败**(换货/审核失败、类型冲突、类型为空/未知)：表格置「处理失败」（停止静默重试）并发群消息，**@提交人 + @客服组全员**（客服组从部门-人员对应表 Base `jb9Y4gmKWrALBykmTe2A2g3l8GXn6lpz` 表 `y89Wute` 取「平台字段 6O9aB0Z=客服」的人员字段 pbTluRY 全部 userId），标题带 ⚠️ 需人工。全部成功时只 @提交人。
  - 类型冲突（同一 D3 单既登记补单又登记占单）不自动操作。
- **群通知 SKU 取记录级**：合并单多个单号共享一套 SKU，origSku/origName 在结果的**记录级**，通知文案读记录级（订单级可能为空）。
- **人工补发模式**：输入 JSON 支持 `{"taskSpace":"d3-budan","records":[...],"manual":[{orderCodes,type}]}`，manual 只处理 D3 不回写表格，用于回归/补单。

### 运费链接2（棉签）

- **SKU**：`FF000748`
- 替换后 D3 会将订单发送到仓库，发一个棉签包裹
