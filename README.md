# D3 OMS 自动化套件（补单 / 占单 / 冷链 / 缺货 / 自动客审拦截）

一套运行在 **macOS + OpenClaw** 上的电商 OMS 自动化：监听钉钉群消息、操作点三 D3（diansan）OMS 网页、
回写钉钉多维表并在群里 @ 相关人。覆盖五大场景：

| 场景 | 触发方式 | 做什么 |
|---|---|---|
| **补单（三方/自营补单）** | 每 5 分钟轮询钉钉登记表 | 待审核订单自动换货成「运费链接2」(`FF000748`)、写客服备注 `0000`、审核通过，回写表格并 @ 提交人 |
| **占单** | 每 5 分钟轮询 | 选中订单「标记异常 → 运营通知添加异常/不发货」，订单不发出 |
| **冷链异常单** | 定时（默认工作时段外每小时） | 按 SKU 列表查出待审核订单，批量标记为「冷链」异常 |
| **缺货检测/到货跟踪** | 每小时 | 比对可用库存，给缺货单打「缺货」标签、写跟踪表；到货 @ 客服审核、审核后闭环 |
| **自动客审拦截规则** | 群消息监听（常驻）+ 每 5 分钟同步 | 群里发 SKU 即加入 D3 自动客审拦截规则（转人工审），回复「恢复 #批次」即移除 |

> 本仓库是从生产环境抽离、参数化后的**可独立复刻版本**。不含任何密码、登录态与运行台账。

---

## 一、架构总览

```
钉钉群 ──消息──▶ audit-listener.py（launchd 常驻，15s 轮询）
                   │ 识别 SKU / 恢复指令
                   ▼
             钉钉多维表（拦截表 / 补单登记表 / 缺货跟踪表）
                   ▲                              │
   回写结果 + @人   │                              ▼
        ┌──────────┴───────────────────────────────────────┐
        │ OpenClaw cron（isolated 会话，delivery=none）       │
        │  d3-audit-policy.sh   每5分钟  改 D3 拦截规则         │
        │  d3-budan-process.sh 每5分钟  补单/占单换货审核       │
        │  d3-out-of-stock-ego.sh 每小时 缺货检测/到货          │
        │  d3-coldchain-ego.sh 定时     冷链批量标异常          │
        └───────────────┬───────────────────────────────────┘
                         ▼
              ego-browser（浏览器自动化，复用登录态）
                         ▼
                    D3 OMS 网页
```

**关键组件**
- `ego-browser`：AI/脚本可控的 Chromium，所有 D3 网页操作都通过它完成；用独立命名的 **task space**
  （`d3-budan`、`d3-shortage-auto`、`d3-coldchain-auto`、`d3-audit-policy`）隔离各场景浏览器标签页。
- `dws`：钉钉产品 CLI，负责多维表读写、群机器人发消息/ @ 人。鉴权用本机登录态（`~/.dws`）。
- **OpenClaw cron**：定时调度器，用 isolated 会话跑 shell，`delivery.mode=none`（通知由脚本自己发群）。
- **launchd**：只托管「群消息监听器」一个常驻进程，崩溃/开机自动拉起。

---

## 二、运行环境与依赖

- **macOS**（Apple Silicon / Intel 均可；用到 `launchd`、`sed -i ''`、`stat -f`）
- **Python ≥ 3.9**（开发环境 3.12，仅用标准库，**无需 pip 安装任何包**）
- **Node.js ≥ 18**（ego-browser 的 JS 运行时；`require`/ESM 均有使用）
- [`ego-browser`](https://github.com/) 命令行（浏览器自动化），并在其浏览器里**登录过一次 D3**
- `dws` CLI（钉钉），并完成 `dws auth login` 授权
- OpenClaw（提供 cron 调度；如用别的调度器，见文末「不用 OpenClaw」）

安装后自检：
```bash
python3 --version && node --version
command -v dws ego-browser
dws auth status        # authenticated=true
```

---

## 三、快速安装（复刻步骤）

```bash
# 1) 克隆到任意目录（示例放家目录）
git clone <你的仓库地址> d3-omni-automation
cd d3-omni-automation

# 2) 一键安装：依赖检查、生成 config.env、装监听器 launchd 看门狗
./install.sh

# 3) 编辑配置（首次务必看一遍）
$EDITOR scripts/config.env      # D3 租户/账号/密码、机器人、群、多维表等

# 4) 在 OpenClaw 创建 4 个定时任务（见下节）
```

`install.sh` 做的事：检查 `python3/node/dws/ego-browser` → 从模板生成 `scripts/config.env`（不覆盖已有）
→ 给 `.sh` 加执行权限、建 `.state/` → 全部脚本语法自检 → 渲染并加载 launchd 看门狗。

> 不想跑安装脚本也可以手动：`cp deploy/config.env.example scripts/config.env`，
> 再 `scripts/audit-listener-ctl.sh start`。

### 3.1 创建定时任务

打开 `deploy/cron-jobs.json`，把里面所有 `<INSTALL_DIR>` 替换为本机绝对路径（如
`/Users/you/d3-omni-automation`），然后在 OpenClaw 里按其中 4 个 job 定义逐个创建（均为
`sessionTarget=isolated`、`delivery.mode=none`、时区 `Asia/Shanghai`）：

| 任务名 | 调度 | 命令 |
|---|---|---|
| `d3-budan-poll` | 每 5 分钟（every 300000ms） | `bash <DIR>/scripts/d3-budan-process.sh` |
| `d3-audit-policy` | 每 5 分钟 | `bash <DIR>/scripts/d3-audit-policy.sh` |
| `d3-out-of-stock-hourly` | cron `20 * * * *`（每小时 20 分） | `bash <DIR>/scripts/d3-out-of-stock-ego.sh` |
| `d3-coldchain-hourly` | cron `15 0-9,18-23 * * *` | `bash <DIR>/scripts/d3-coldchain-ego.sh` |

群消息监听器**不是 cron**，由 launchd 常驻（`install.sh` 已装好），用
`scripts/audit-listener-ctl.sh {status|kick|stop|log}` 管理。

---

## 四、配置说明（`scripts/config.env`）

从 `deploy/config.env.example` 复制。分两类：

**A. 资源标识**（模板里全部是 `REPLACE_WITH_...` 占位符，**必须**在 `config.env` 填成你自己的值）：
- `D3_ROBOT_CODE` 钉钉机器人 robotCode（clientId）
- `D3_NOTIFY_GROUP` 通知群 openConversationId
- `D3_ATABLE_BASE` 多维表 Base ID，以及 4 张表 ID（拦截/补单/缺货/人员）
- `D3_DEFAULT_AT_USER` 兜底 @ 的数字 userId

**B. 必须按本机填写**：
- `D3_TENANT` / `D3_USERNAME` / `D3_PASSWORD`：D3 登录租户、账号、密码。
  **密码不写入仓库**；如果 ego-browser 浏览器里已保存 D3 登录态，密码可留空（脚本会复用登录态），
  仅在会话过期需要自动登录时才用到。
- 钉钉侧鉴权**不在本文件**，由 `dws auth login` 的本机登录态（`~/.dws`）提供。

> 多维表各列的 **field id** 仍写在各业务脚本顶部（如补单表 `F_ORDER_CODE` 等），
> 它们与具体多维表结构强绑定。**若你在新组织新建了多维表，需按新表实际字段 ID 修改这些常量**
> （`audit-tracker.py`、`budan-postprocess.py`、`d3-shortage-tracker.py`、`d3-budan-process.sh` 顶部）。

### 4.1 需要提前建好的钉钉多维表

同一个 Base 下需要 4 张表（字段见 `docs/SKILL.original.md` 与各脚本顶部的 `F_*` 常量）：
1. **自动客审拦截表**：SKU、品名、类型(单品/套装)、状态(待拦截/已拦截/待恢复/已恢复)、批次、备注、提交人、各时间戳、错误。
2. **补单/占单登记表**：订单号、类型(三方补单/自营补单/占单)、提交人、提交时间、处理状态、处理结果、D3订单ID、原始SKU/品名、错误等。
3. **缺货跟踪表**：订单号、平台、店铺、缺货SKU/品名、需求数量、可用库存、状态、首检/到货通知/审核时间、预计到货时间、D3订单ID。
4. **部门-人员对应表**：平台（含「客服」选项）、人员(user)，用于失败时 @ 客服组。

### 4.2 钉钉机器人与权限
- 需要一个企业内部机器人（robotCode/clientId），并让 `dws` 以该机器人/有权限的成员身份登录；
- 机器人要被拉进通知群，且有多维表读写、群消息发送权限。

---

## 五、脚本清单（`scripts/`）

**Shell 入口（cron / 手动调用）**
- `d3-budan-process.sh`：补单/占单主流程（互斥锁、进程组查杀、调 ego + 回写）。
- `d3-audit-policy.sh`：读拦截表 → 用 ego 改 D3 拦截规则 → 回写 → 通知（含失败熔断）。
- `d3-out-of-stock-ego.sh`：缺货检测/打标/到货跟踪主流程（当前版本）。
- `d3-coldchain-ego.sh`：冷链批量标异常（当前版本）。
- `d3-out-of-stock.sh` / `d3-coldchain.sh`：旧 opencli 版（保留备用，需要 opencli/Browser Bridge）。
- `*-check-pending.sh`：轻量"是否有待处理"探针，可给 cron trigger 用，省 token。
- `audit-listener-ctl.sh`：监听器 launchd 服务管理。

**Python（数据/回写/通知，标准库）**
- `audit-listener.py`：群消息监听常驻进程；`audit-tracker.py`：拦截表 CRUD + 批次号 + 熔断；
  `audit-people.py`：SKU→提交/恢复人台账（用于 @）。
- `budan-postprocess.py`：补单结果回写、分级重试、超时/失败只 @ 一次。
- `d3-shortage-tracker.py`：缺货跟踪表 CRUD；`gen-shortage-notify.py`：缺货通知文案。
- `notify_ledger.py`：机器人消息 processQueryKey 台账（供撤回）；`sku-parser.py`：SKU 文本解析。
- `d3config.py`：统一配置加载（Python 侧）。

**浏览器自动化（ego-browser）**
- `ego-budan.js`：补单/占单（全量加载、refOids 交集、合并/拆单、换货、审核、出库计划单二次核实）。
- `d3-audit-policy-exec.mjs`：拦截规则货品增删与保存校验。
- `ego-shortage.mjs`：缺货扫描/打标/到货；`ego-coldchain.mjs`：冷链标异常。

**公共**
- `lib-config.sh`：shell 统一配置加载 + 生成临时凭据 JSON 给浏览器 JS。
- `d3-coldchain-skus.txt`：冷链默认 SKU 列表。

---

## 六、运行态数据与安全

- 所有运行态文件（台账、去重计数、批次号、PID、日志）统一写项目内 **`.state/`**（已 gitignore），
  克隆后是空的，随运行自动生成；也可用环境变量 `D3_STATE_DIR` 改位置。
- `scripts/config.env` 含（可能的）密码，**已 gitignore，不会被提交**。
- 浏览器 JS 需要的地址/凭据由 `lib-config.sh` 写成 `chmod 600` 的临时 JSON（默认 `/tmp/d3-credentials.json`），
  脚本退出自动删除。
- **本仓库不含**：D3 密码、`~/.dws` 登录态、任何历史订单台账/群消息账本。

---

## 七、运维与排障

```bash
# 监听器
scripts/audit-listener-ctl.sh status      # launchd 托管状态 + 最近日志
scripts/audit-listener-ctl.sh log         # 实时日志
scripts/audit-listener-ctl.sh kick        # 改完 listener 代码后重启
scripts/audit-listener-ctl.sh process     # 立即手动跑一次拦截同步

# 手动单跑（建议先小批量 / 先观察）
bash scripts/d3-budan-process.sh
bash scripts/d3-audit-policy.sh
bash scripts/d3-out-of-stock-ego.sh
bash scripts/d3-coldchain-ego.sh --skus "SKU1,SKU2"

# 配置解析自检
python3 scripts/d3config.py
```

常见问题：
- **浏览器需要登录**：在对应 ego task space 手动登录一次 D3，或在 config.env 填 `D3_PASSWORD`。
- **dws 鉴权过期**：`dws auth status` 查看，过期则 `dws auth login`。
- **多维表字段对不上**：新组织重建表后，改各脚本顶部 `F_*` field id。
- **补单/拦截"没反应"**：先看监听器日志与 `.state/` 去重文件；重复提交会收到"已在拦截列表"提示。
- **并发/假成功**：补单脚本有全局互斥锁（`.state/../` 下 `$D3_RUN_DIR/d3-budan.lock`）与进程组查杀，
  切勿同时手动多开。

更详细的业务规则、踩坑与 D3 页面技术细节见 `docs/SKILL.original.md` 与 `docs/d3-automation-notes.md`。

---

## 八、不用 OpenClaw 也能跑（可选）

OpenClaw 只承担"定时调度 isolated shell"。换成系统 `crontab`/launchd 定时执行那 4 个 `.sh` 即可，例如：
```
*/5 * * * * /bin/bash /path/to/d3-omni-automation/scripts/d3-budan-process.sh >> /path/to/.state/budan.log 2>&1
20 *  * * * /bin/bash /path/to/d3-omni-automation/scripts/d3-out-of-stock-ego.sh >> /path/to/.state/shortage.log 2>&1
```
群消息监听器与 OpenClaw 无关，`install.sh` 用 launchd 装好即可常驻。

---

## 目录结构
```
d3-omni-automation/
├── install.sh                 # 一键安装
├── README.md
├── .gitignore
├── deploy/
│   ├── config.env.example     # 配置模板（复制为 scripts/config.env）
│   ├── cron-jobs.json         # 4 个 OpenClaw 定时任务定义
│   └── com.d3omni.audit-listener.plist.template
├── scripts/                   # 全部代码（见第五节）
├── docs/                      # 业务/技术文档
└── .state/                    # 运行态（自动生成，不入库）
```
