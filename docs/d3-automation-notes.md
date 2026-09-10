# D3 自动客审拦截 - 关键技术笔记

## 登录信息
- URL: https://d3.diansan.com/
- 租户：见 scripts/config.env 的 D3_TENANT
- 账号：见 scripts/config.env 的 D3_USERNAME
- 密码：不写入仓库，在 scripts/config.env 的 D3_PASSWORD 填写（或复用浏览器登录态）
- 登录后有安全提示，点"我知道了，继续登录"

## 导航路径
设置 → 策略设置 → 自动客审

## 自动客审页面结构
- 列表页 iframe: /omni/setting/policy/new-auto-audit/index.html
- 编辑页在列表 iframe 内嵌套 iframe: /omni/setting/policy/new-auto-audit/save/index.html?id=678962&action=edit
- 三层 iframe 嵌套：主页 → 列表iframe → 编辑iframe
- 默认策略 ID: 678962

## 添加货品流程（已验证）
1. 点"添加货品"按钮
2. 弹窗"选择货品"：切到"套装"tab（.ant-radio-button-wrapper）
3. 搜索框 input.ant-input[0]，输入套装编码，点"查询"
4. 结果中精确匹配 productOuterId === TARGET 的行
5. **勾选 checkbox（关键难点）**
6. 点"确定"
7. 货品加入列表后，点外层"保存"
8. 确认弹窗选"保存后立即启用"→确定

## checkbox 勾选问题（已解决）
- ~~opencli 的 setCheckboxRow 和 DOM click 都不生效~~
- **正确方法**：用 ego-browser 原生 `click()` 点击 fixed-left 可见副本
- 步骤：
  1. JS 找到 `.fixed-left--wrapper` 中目标行的 `.col--checkbox .vxe-cell--checkbox`
  2. 给该元素设一个唯一 `id`
  3. ego-browser `click('#id')` 触发真实鼠标事件
- **不要用** `setCheckboxRow()`、DOM `.click()`、`dispatchEvent` —— 都不生效
- vxe-table 有两个副本（body-wrapper + fixed-left-wrapper），必须点 fixed-left 的那个

## 保存按钮（已解决）
- **必须用 ego-browser 原生 `click('@ref')`**，JS `.click()` 不弹确认框
- 保存后出现确认弹窗：选"保存后立即启用" → 点确定
- 保存成功后没有明显提示，但 reload 可验证数据已持久化
- 每次操作（添加/删除）后 ref 会变，必须重新 `snapshotText()` 获取

## 精确匹配（重要）
- 套装搜索会返回模糊匹配结果（如搜 `A+B` 会返回 `A+B+C*3`）
- 添加时必须精确比对 `cells[2].textContent === TARGET`
- 排除含额外 SKU 段的行（QT0021、FF000、PP014、QQQ 等）

## 脚本架构
- `d3-audit-policy.sh`：bash 主控，读钉钉表 → 调 ego-browser → 回写结果
- `d3-audit-policy-exec.mjs`：ego-browser 执行的 JS 脚本，完成所有 D3 操作
- payload 通过 `/tmp/d3-audit-payload.json` 传递（环境变量在 ego-browser nodejs 中不生效）
- ego-browser 脚本必须通过 stdin 传入：`ego-browser nodejs < script.mjs`

## 删除货品流程
1. 主列表搜索框（placeholder="请输入SKU编码/货品名称/条码进行筛选"）
2. 勾选行
3. 点"批量删除"
4. 保存 → 保存后立即启用 → 确定

## ⚠️ 规则未保存 bug（2026-08-27 修复，关键教训）
- **现象**：群里发品号 → 拦截表已录入，但 D3 自动客审规则里货品没真正加上（规则没保存）。
- **根因**：旧脚本复用 ego task space 的旧 tab，进编辑页后**没有整页 reload**。表单可能是脏/空状态，
  添加货品挂在一个空表单上，点保存时整规则被空状态覆盖/新增没带上 → 规则没真正落库。
- **修法（d3-audit-policy-exec.mjs）三重校验，杜绝假成功**：
  1. **进页面强制 `location.reload()`**（`loadEditPageFresh()`）：先建立 D3 上下文→进编辑页→reload，
     确保表单加载的是服务端【已持久化的完整规则】，不是脏 tab。reload 后读 `Baseline`。
  2. **每次增/删后立即用主列表搜索框回读**（`isPresentInMain`：搜索 SKU→读 SKU 列精确匹配→清空）：
     添加后必须搜到、删除后必须搜不到，否则算 errors 不进 added/deleted。
  3. **保存并“保存后立即启用”确定后，再整页 reload 复核**：待添加必须仍搜到、待删除必须仍搜不到。
     复核不过 → errors（“规则未落库”），shell 侧不会标“已拦截”，下轮重试。
- **幂等**：添加前先 `isPresentInMain`，已在规则里计入 `skipped`（不触发无意义保存）。
- **注意**：主表“首页渲染行数”受分页影响（baseline rows 不等于总数）；权威判断一律用**针对 SKU 的搜索回读**，
  且用 SKU 列**精确匹配**（`indexOf` 模糊匹配会把含该组件的套装也带出来，如搜 P000394 命中 P000394*2套装）。

## 监听服务守护进程（2026-08-27）
- audit-listener.py（钉钉群品号轮询监听）已由 **launchd 看门狗**托管，不再用裸 nohup。
- plist：`~/Library/LaunchAgents/com.yimin.d3-audit-listener.plist`
  - `RunAtLoad=true`（开机/登录自启）、`KeepAlive=true`（进程崩溃/被杀 10s 内自动拉起）、`ThrottleInterval=10`。
  - PATH 显式带上 `~/.local/bin`（dws/ego-browser 所在），WorkingDirectory=scripts 目录。
- 管理：`bash audit-listener-ctl.sh {start|stop|restart|kick|status|log}`
  - start=bootstrap 加载看门狗；stop=bootout 卸载（不再自启）；kick=`launchctl kickstart -k` 保托管重启。
  - 日志：/tmp/d3-audit-listener.log（应用）；/tmp/d3-audit-listener.launchd.{log,err.log}（launchd）。
- 已实测：`kill -9` 后 launchd 约 10s 自动拉起新进程。

## 文件位置
- 脚本目录: ~/.openclaw/workspace/skills/d3-coldchain/scripts/
  - d3-audit-policy.sh (主脚本)
  - audit-tracker.py (钉钉表管理)
  - audit-listener.py (群消息监听)
  - sku-parser.py (SKU解析)
- 钉钉表: base=jb9Y4gmKWrALBykmTe2A2g3l8GXn6lpz, table=OQwqwXj
- 群: 亿民补单群 chat=chat_af916e9001aa4b3a92d3bb250bf258c2
- 机器人: dingtalk-robot

## ego-browser 用法
- 命令: ego-browser nodejs <<'EOF' ... EOF
- 创建/复用任务: const task = await useOrCreateTaskSpace('d3-audit-policy')
- 点击: await click('@ref') 或 await click('css selector')
- 填表单: await fillInput('@ref', 'text')
- 截图: await captureScreenshot('/path.png')
- 快照: await snapshotText()
- 执行JS: await js(`...`)
- 等待: await wait(seconds)
- iframe: ego-browser 自动处理 iframe，用 snapshotText 找 ref
