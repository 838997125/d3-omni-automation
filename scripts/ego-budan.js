// D3 补单/占单处理脚本 - ego-browser 版本（v2：以 D3 系统单为单位，支持合并/拆单）
// 用法: ego-browser nodejs < ego-budan.js
// 输入文件 /tmp/budan-pending.json:
//   { "taskSpace": 6,                       // 可选：ego task space；并发轮次用不同 space
//     "records": [ {recordId, orderCodes:[], type, submitterId} ],
//     "manual":  [ {orderCodes:[], type} ] } // 可选：人工补发，不回写表格
//
// 核心设计：
//   - 全量加载待审核列表（不用搜索框），每行直接带 refOids(数组) 和 lines(SKU)
//   - 用 refOids 与所有待处理原始单号做交集，反查命中的 D3 系统单
//   - 一个 D3 单命中多个单号/多条记录（合并单）→ 只处理一次，覆盖的单号全部记成功
//   - 一条记录的单号落在多个 D3 单（拆单）→ 每个 D3 单各处理一次，全成功才算记录完成
//   - 处理后强制校验：该 D3 单已离开待审核列表才算成功（杜绝假成功）
//   - 待审核列表里找不到的单号 = 未同步，保留待处理下轮（绝不假去重）

const DEFAULT_TASK_SPACE = 'd3-budan';
var REPLACEMENT_SKU = 'FF000748';

// 净化粘贴带入的异常字符（2026-09-08）：
// ① NFKC 归一化：全角数字/字母/标点 → 半角；
// ② 删除所有 Unicode「格式控制符」\p{Cf}（零宽空格 U+200B、BOM U+FEFF、零宽连接、软连字符、双向控制符等），
//    这些字符肉眼不可见，会粘在单号前导致 D3 精确匹配失败、单一直卡待审核；
// ③ 异常空白（全角空格 U+3000、不间断空格 U+00A0、行/段分隔符）统一换成换行，避免两个单号连在一起。
function sanitizeCode(s) {
  if (s == null) return '';
  s = String(s).normalize('NFKC');
  s = s.replace(/\p{Cf}/gu, '');
  s = s.replace(/[\u00a0\u3000\u2028\u2029]/g, '\n');
  return s;
}
// 把一段可能含多个单号的文本拆成干净单号数组
function splitCodes(raw) {
  return sanitizeCode(raw).split(/[\n\r,，;；\s\t]+/).map(function(x){return x.trim();}).filter(Boolean);
}
var D3_ORDER_URL = 'https://d3.diansan.com/omni/order/order-check/indexFeature/index.html';
// 出库计划单(通知成功)页：已审核并已通知仓库的 D3 单。用于自补单 notFound 超时二次核实
var D3_PLAN_URL = 'https://d3.diansan.com/omni/3rd-warehousing/stock-out-plan/index.html?stockPlanStatus=NOTIFY_SUCCESS';
// 自补单 notFound 后到出库计划单二次核实的龄期阈值（分钟）：40=约45分钟；两列表都查不到再等到 60 分钟才 @ 人
const PLAN_VERIFY_MIN = 40;
const PLAN_UNSYNC_ALERT_MIN = 60;
var SELLER_MEMO = '0000';
const EXCEPTION_REASON = '运营通知添加异常/不发货';
// 跨轮次成功台账：默认放项目 .state 目录；实际路径由 shell 通过输入 JSON 的 ledgerPath 传入。
var LEDGER_PATH = (function(){ try { return require('path').join(__dirname, '..', '.state', 'budan-ledger.json'); } catch(_) { return '/tmp/budan-ledger.json'; } })();

// 从凭据文件（shell 生成）覆盖地址/业务常量（不影响登录密码，补单流程复用浏览器登录态）
function applyCredentialFile(fs, credFile) {
  try {
    if (credFile && fs.existsSync(credFile)) {
      const c = JSON.parse(fs.readFileSync(credFile, 'utf8'));
      if (c.orderCheckUrl) D3_ORDER_URL = c.orderCheckUrl;
      if (c.planUrl) D3_PLAN_URL = c.planUrl;
      if (c.replacementSku) REPLACEMENT_SKU = c.replacementSku;
      if (c.sellerMemo) SELLER_MEMO = c.sellerMemo;
    }
  } catch(_) {}
}

function loadLedger(fs) {
  try {
    if (fs.existsSync(LEDGER_PATH)) {
      var l = JSON.parse(fs.readFileSync(LEDGER_PATH, 'utf8'));
      if (l && l.orders) {
        // 清理 7 天前的记录
        var cutoff = Date.now() - 7*24*3600*1000;
        Object.keys(l.orders).forEach(function(k){
          if (!l.orders[k].ts || l.orders[k].ts < cutoff) delete l.orders[k];
        });
        return l;
      }
    }
  } catch(e) { console.log('[budan] 台账读取失败: ' + e.message); }
  return { orders: {} };
}
function saveLedger(fs, ledger) {
  // 【读-合并-原子写】2026-09-09 修复并发覆盖丢台账：
  // cron 300s 超时会 SIGKILL 掉 shell（trap 放锁），但 ego-browser 子进程可能成孤儿还在跑；
  // 下一轮拿到新锁又起一个 ego，两个进程各自在启动时读入旧台账快照、结束时全量 writeFileSync，
  // 后写的整份覆盖先写的 → 先成功记台账的单号被冲掉（案例 3616411011514621 14:29 曾命中 D3 1701658
  // 成功，之后却从台账消失）。这里改为写入前重新读磁盘最新台账，只把本进程新增/确认成功的单号 merge 进去，
  // 绝不整份覆盖；再用 临时文件+rename 原子落盘（rename 同盘原子），并对短暂冲突重试。
  try {
    var merged;
    try {
      merged = JSON.parse(fs.readFileSync(LEDGER_PATH, 'utf8'));
      if (!merged || !merged.orders) merged = { orders: {} };
    } catch (e) { merged = { orders: {} }; }   // 文件不存在/损坏：用内存台账
    var incoming = (ledger && ledger.orders) ? ledger.orders : {};
    var added = 0;
    Object.keys(incoming).forEach(function (code) {
      var inc = incoming[code];
      var cur = merged.orders[code];
      // 已存在且成功则不回退；否则写入（或补上成功标记）
      if (!cur || !cur.success || (inc.success && !cur.success)) {
        merged.orders[code] = inc;
        if (inc.success && !(cur && cur.success)) added++;
      }
    });
    // 顺手清理 7 天前记录
    var cutoff = Date.now() - 7 * 24 * 3600 * 1000;
    Object.keys(merged.orders).forEach(function (k) {
      if (!merged.orders[k].ts || merged.orders[k].ts < cutoff) delete merged.orders[k];
    });
    var tmp = LEDGER_PATH + '.tmp.' + process.pid;
    var payload = JSON.stringify(merged);
    for (var attempt = 0; attempt < 5; attempt++) {
      try { fs.writeFileSync(tmp, payload, 'utf8'); fs.renameSync(tmp, LEDGER_PATH); return; }
      catch (e) { try { fs.unlinkSync(tmp); } catch (_) {} if (attempt === 4) throw e; }
    }
  } catch (e) { console.log('[budan] 台账写入失败: ' + e.message); }
}

// task space 在 main() 里通过 useOrCreateTaskSpace(spaceName) 创建/选定

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
async function pjs(code) { return await ego.helpers.js(code); }
function log(m) { console.log('[budan] ' + m); }
// D3 换货是【异步】的：点确定后可能弹“换货任务已提交”表示已受理（后台稍后才把货品行换成 FF000748），
// 合并/多子订单里换货成功后行 id 会变，再操作陈旧行会弹“换出的货品不属于该订单”。
// 这两类气泡都【不代表换货失败】，不能当错误中止；必须以刷新后货品行的真实状态为准。
function isBenignExchangeMsg(x) {
  if (!x) return false;
  return x.indexOf('换货任务已提交') >= 0 ||
         x.indexOf('换出的货品不属于该订单') >= 0 ||
         x.indexOf('换货成功') >= 0 ||
         x.indexOf('成功') >= 0;
}
// 从一批气泡里挑出“真正的硬错误”（排除异步受理/陈旧行/成功提示）
function pickHardErr(msgs, preMsgs) {
  var hard = (msgs || []).filter(function(x){ return (preMsgs||[]).indexOf(x) < 0 && !isBenignExchangeMsg(x); });
  return hard.length ? hard.join('|') : '';
}

// ---------- 页面基础 ----------
async function ensurePage() {
  const url = await pjs('return location.href');
  if (!url.includes('order-check')) {
    await ego.helpers.openOrReuseTab(D3_ORDER_URL);
    await sleep(7000);
  }
}

async function clickQuery() {
  await pjs(`
    var b = document.querySelectorAll('button.ant-btn-primary');
    for (var i=0;i<b.length;i++){
      if(b[i].innerText.indexOf('查')>=0&&b[i].innerText.indexOf('询')>=0){b[i].click();break;}
    }
  `);
}

// 把订单表分页条数设大（新开 task space 默认 20 条/页，会截断待审核列表导致漏单）
async function setPageSizeLarge() {
  await pjs(`
    var os=document.querySelectorAll('.spreadtable')[0].__vue__.$parent;
    var tp=os.$data.tableProps||{};
    if(tp.pagination){
      if(tp.pagination.pageSize!==undefined) tp.pagination.pageSize=1000;
      if(tp.pagination.current!==undefined) tp.pagination.current=1;
      if(tp.pagination.page!==undefined) tp.pagination.page=1;
    }
  `);
}

// 清空查询表单（搜索框/货品信息/日期等），避免残留筛选导致全量加载读到过滤后的子集
async function resetSearchForm() {
  await pjs(`
    // 清空所有文本输入框（原始订单号/系统订单号/货品信息等）
    var inputs=document.querySelectorAll('.ant-form input[type="text"], .ant-form input:not([type]), form input[type="text"], form input:not([type])');
    var setter=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
    for(var i=0;i<inputs.length;i++){
      var inp=inputs[i];
      if(inp.offsetParent===null) continue;
      if(inp.value){
        setter.call(inp,'');
        inp.dispatchEvent(new Event('input',{bubbles:true}));
        inp.dispatchEvent(new Event('change',{bubbles:true}));
      }
    }
    // 清掉多选/标签类筛选的已选 tag（点 × 关闭）
    var closes=document.querySelectorAll('.ant-select-selection__clear, .ant-select-clear');
    for(var j=0;j<closes.length;j++){ if(closes[j].offsetParent!==null){ try{closes[j].click();}catch(e){} } }
  `);
}

// 全量加载待审核订单，返回精简行数组
async function loadAllOrders() {
  await setPageSizeLarge();
  await resetSearchForm();
  await clickQuery();
  // 轮询等待 dataSource 稳定
  var lastLen = -1, stable = 0;
  for (var i = 0; i < 12; i++) {
    await sleep(1500);
    var info = await pjs(`
      var os=document.querySelectorAll('.spreadtable')[0].__vue__.$parent;
      var tp=os.$data.tableProps||{};
      var ds=tp.dataSource||[];
      var pg=tp.pagination||{};
      return JSON.stringify({len:ds.length,total:pg.total,loading:tp.loading===true});
    `);
    var d = JSON.parse(info);
    if (!d.loading && d.len > 0 && d.len === d.total) {
      stable++;
      if (stable >= 2) break;   // 连续两次长度一致且=total，认为加载完
    }
    lastLen = d.len;
  }
  return await pjs(`
    var os=document.querySelectorAll('.spreadtable')[0].__vue__.$parent;
    var ds=os.$data.tableProps.dataSource||[];
    return JSON.stringify(ds.map(function(r){
      return {
        id:r.id, code:r.code,
        refOids: Array.isArray(r.refOids)?r.refOids:(r.refOid?String(r.refOid).split(/[,，;；\\s]+/):[]),
        status: r.status?(r.status.name||String(r.status)):'',
        lines: (r.lines||[]).map(function(l){return {id:l.id,outerId:l.outerId,title:l.title,num:l.num,suitSkuId:l.suitSkuId,suitNum:l.suitNum,suitOuterId:l.suitOuterId,thirdOid:l.thirdOid};})
      };
    }));
  `);
}

// ---------- 选中 / 详情 ----------
async function selectRowById(rowId) {
  return await pjs(`
    var os=document.querySelectorAll('.spreadtable')[0].__vue__.$parent;
    var ds=os.$data.tableProps.dataSource||[];
    var row=ds.find(function(r){return r.id===${rowId};});
    if(!row) return 'nf';
    os._onSelectRows([row.id],[row]);
    os._onRowClick(row,true);
    return 'ok:'+row.code;
  `);
}

async function openLinesTab() {
  await pjs(`
    var t=document.querySelectorAll('.ant-tabs-tab');
    for(var i=0;i<t.length;i++){if(t[i].innerText.trim()==='货品列表'){t[i].click();break;}}
  `);
  await sleep(3000);
}

async function getProductLines() {
  return await pjs(`
    var lt=document.querySelectorAll('.spreadtable')[1].__vue__.$parent;
    var ds=lt.$data.tableProps.dataSource||[];
    return JSON.stringify(ds.map(function(l){return {id:l.id,outerId:l.outerId,title:(l.title||'').substring(0,30),num:l.num,suitSkuId:l.suitSkuId,suitNum:l.suitNum,suitOuterId:l.suitOuterId,thirdOid:l.thirdOid,refOid:l.refOid};}));
  `);
}

async function refreshLines() {
  await pjs(`
    var t=document.querySelectorAll('.ant-tabs-tab');
    for(var i=0;i<t.length;i++){if(t[i].innerText.trim()==='订单详情'){t[i].click();break;}}
  `);
  await sleep(2000);
  await openLinesTab();
}

// ---------- 换货 ----------
// 对一行（同平台子订单 + 同套装的所有行）换成单品
// 关键：D3 要求“换出货品必须来自同一个平台子订单”，跨子订单(refOid不同)不能一起选，需分组多次换货
async function exchangeToSingle(line) {
  var lineId = line.id;
  var subKey = line.refOid || '';   // 平台子订单标识
  // 换货前快照：整单非运费链接2行数 + 本次选中行数（进度判定用）
  var preInfo = await pjs(`
    var lt = document.querySelectorAll('.spreadtable')[1].__vue__.$parent;
    var ds = lt.$data.tableProps.dataSource;
    var row = ds.find(function(r){return r.id===${lineId};});
    if(!row) return JSON.stringify({err:'nf'});
    var rowsToSelect = ds.filter(function(r){
      if(r.refOid!==row.refOid) return false;
      if(row.suitSkuId && row.suitSkuId!==0){ return r.suitSkuId===row.suitSkuId; }
      return r.id===row.id;
    });
    if(!rowsToSelect.length) rowsToSelect=[row];
    var keys = rowsToSelect.map(function(r){return r.id;});
    var preNonFF = ds.filter(function(r){return r.outerId!=='${REPLACEMENT_SKU}';}).length;
    // 快照触发换货前已存在的报错气泡（上一轮/其他操作的残留），后续只把“新冒出”的气泡当本轮结果
    var preMsgs=[];var __pm=document.querySelectorAll('.ant-message-notice');for(var __z=0;__z<__pm.length;__z++){if(__pm[__z].innerText)preMsgs.push(__pm[__z].innerText);}
    lt.onSelectChange(keys, rowsToSelect);
    lt._exchangeGoods(row, false);
    return JSON.stringify({preNonFF:preNonFF, selCount:keys.length, sub:row.refOid, preMsgs:preMsgs});
  `);
  var pre;
  try { pre = JSON.parse(preInfo); } catch(e) { pre = {err:preInfo}; }
  if (pre.err) return { success: false, error: '换货定位失败: ' + pre.err };
  var preNonFF = pre.preNonFF, selCount = pre.selCount;
  var preMsgs = pre.preMsgs || [];   // 触发前已存在的气泡（残留报错），不计入本轮
  await sleep(800);
  // 高频轮询：弹窗打开 or D3 报错（ant-message 约3s消失，必须早抓）
  var dialogState = 'timeout';
  var earlyErr = '';
  for (var poll = 0; poll < 8; poll++) {
    await sleep(600);
    var pc = await pjs(`
      var modalOpen=false;
      var wraps=document.querySelectorAll('.ant-modal-wrap');
      for(var i=0;i<wraps.length;i++){ if(getComputedStyle(wraps[i]).display!=='none'){var t=wraps[i].querySelector('.ant-modal-title');if(t&&t.innerText.indexOf('更换商品')>=0){modalOpen=true;}}}
      var msgs=[];var m=document.querySelectorAll('.ant-message-notice');for(var j=0;j<m.length;j++){var tx=m[j].innerText;if(tx)msgs.push(tx);}
      return JSON.stringify({modalOpen:modalOpen,msgs:msgs});
    `);
    var pci = JSON.parse(pc);
    if (pci.modalOpen) { dialogState = 'open'; break; }
    // 只认本轮新冒出的【硬错误】（过滤触发前残留气泡 + “换货任务已提交/换出的货品不属于该订单/成功”等良性提示）
    var hardEarly = pickHardErr(pci.msgs, preMsgs);
    if (hardEarly) { earlyErr = hardEarly; dialogState = 'err'; break; }
  }
  var dialogCheck = dialogState === 'open' ? 'open' : ('closed:' + earlyErr);
  if (dialogCheck !== 'open') return { success: false, error: '换货弹窗未打开' + (earlyErr ? '（D3提示: ' + earlyErr + '）' : '') };

  // 搜 FF000748
  await pjs(`
    var wraps = document.querySelectorAll('.ant-modal-wrap');
    for(var i=0;i<wraps.length;i++){
      var w=wraps[i];
      if(getComputedStyle(w).display==='none')continue;
      var inp=w.querySelector('input[placeholder="货品SKU编码"]');
      if(inp){
        var s=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
        s.call(inp,'${REPLACEMENT_SKU}');
        inp.dispatchEvent(new Event('input',{bubbles:true}));
        inp.dispatchEvent(new Event('change',{bubbles:true}));
        var btns=w.querySelectorAll('button');
        for(var j=0;j<btns.length;j++){if(btns[j].innerText.indexOf('查')>=0&&btns[j].innerText.indexOf('询')>=0){btns[j].click();break;}}
      }
    }
  `);
  await sleep(5000);

  var selectResult = await pjs(`
    var wraps = document.querySelectorAll('.ant-modal-wrap');
    for(var i=0;i<wraps.length;i++){
      var w=wraps[i];
      if(getComputedStyle(w).display==='none')continue;
      var st=w.querySelector('.spreadtable');
      if(st&&st.__vue__){
        var cur=st.__vue__.$parent;
        for(var hop=0;hop<6&&cur;hop++){
          var dd=cur.$data||{};
          if(dd.dataSource&&dd.tableSelection){
            var row=dd.dataSource.find(function(r){return r.outerId==='${REPLACEMENT_SKU}';})||dd.dataSource[0];
            if(row){ cur.selectionSourceChange([row.id],[row]); return 'selected:'+row.outerId; }
            return 'no-row,len='+dd.dataSource.length;
          }
          cur=cur.$parent;
        }
      }
    }
    return 'no-target';
  `);
  if (!selectResult.startsWith('selected')) {
    await closeAllModals();
    return { success: false, error: '换货弹窗选中失败: ' + selectResult };
  }
  await sleep(500);

  await pjs(`
    var wraps=document.querySelectorAll('.ant-modal-wrap');
    for(var i=0;i<wraps.length;i++){
      var w=wraps[i];
      if(getComputedStyle(w).display==='none')continue;
      var title=w.querySelector('.ant-modal-title');
      if(!title||title.innerText.indexOf('更换商品')<0)continue;
      var footer=w.querySelector('.ant-modal-footer');
      if(footer){
        var btns=footer.querySelectorAll('button');
        for(var j=0;j<btns.length;j++){if(btns[j].innerText.trim()==='确 定'){btns[j].click();return 'clicked';}}
      }
    }
    return 'no-confirm-btn';
  `);

  // 等待弹窗关闭 + 验证
  // 关键：点“确定”后 D3 可能返回报错气泡（如合并单里陈旧行“换出的货品不属于该订单”），
  // 但换货实际可能已成功。不能一见报错就判死——以强刷新后货品行的真实状态为准。
  var confirmErr = '';   // 本轮“确定”后新冒出的【硬错误】（异步受理/陈旧行/成功提示不算）
  var badReads = 0;      // 硬错误后强校验连续不通过次数（3 次才判真失败，给异步换货留足落地时间）
  var noProgressWaits = 0; // 弹窗已关但货品行尚未变化的等待次数（异步换货落地中）
  for (var wait = 0; wait < 16; wait++) {
    await sleep(2500);
    var errCheck = await pjs(`
      var m=document.querySelectorAll('.ant-message-notice');
      var msgs=[]; for(var i=0;i<m.length;i++) msgs.push(m[i].innerText);
      var open=0;
      var wraps=document.querySelectorAll('.ant-modal-wrap');
      for(var i=0;i<wraps.length;i++){if(getComputedStyle(wraps[i]).display!=='none')open++;}
      return JSON.stringify({msgs:msgs,openModals:open});
    `);
    var errInfo = JSON.parse(errCheck);
    // 只认本轮“确定”后新冒出的【硬错误】：过滤残留气泡 + “换货任务已提交/换出的货品不属于该订单/成功”等良性提示
    var hardErr = pickHardErr(errInfo.msgs, preMsgs);
    if (hardErr) {
      confirmErr = hardErr;
      log('  ⚠️ 换货返回硬报错（先强校验货品行再定性）: ' + confirmErr);
    }
    // 有报错且弹窗仍开着：关掉弹窗，按货品行实际状态强校验
    if (confirmErr && errInfo.openModals > 0) { await closeAllModals(); await sleep(1500); }

    if (errInfo.openModals === 0 || confirmErr) {
      var allLines = [];
      try { allLines = JSON.parse(await getProductLines()); } catch(e) { allLines = []; }
      // 脏读保险：强制刷新货品列表再读
      await refreshLines();
      try { allLines = JSON.parse(await getProductLines()); } catch(e) { allLines = []; }
      var nonFFafter = allLines.filter(function(l){return l.outerId!==REPLACEMENT_SKU;});
      // 进度判定：换货后整单非FF行数必须减少（减少量≥本次选中行数）
      var progressed = nonFFafter.length <= preNonFF - selCount;
      // 同时确认本子订单(refOid)已全部变为FF（双保险）。稳定键是 refOid（换货后行id/suitSkuId会变）
      var SUB = line.refOid || '';
      var groupLines = allLines.filter(function(l){ return (l.refOid||'') === SUB; });
      var groupOk = groupLines.length>0 && groupLines.every(function(l){return l.outerId===REPLACEMENT_SKU;});
      log('  换货后非FF行数: ' + nonFFafter.length + '/' + preNonFF + ' 子订单['+SUB+']已替换=' + groupOk + (progressed?' ✅进度达标':(confirmErr?'':'（异步落地中…）')));
      if (progressed || groupOk) return { success: true };
      if (confirmErr) {
        // 有硬报错：连续 3 次强刷新都不通过才判真失败（给异步换货/后端延迟留足时间）
        badReads++;
        if (badReads >= 3) { await closeAllModals(); return { success: false, error: '换货错误提示: ' + confirmErr }; }
        log('  硬报错但强校验第 ' + badReads + ' 次未过，再刷新确认...');
      } else {
        // 无硬报错、弹窗已关、货品行还没变：异步换货落地中，继续等（不计失败）
        noProgressWaits++;
      }
    }
  }
  await closeAllModals();
  // 超时仍未落地：硬报错才报错；否则说明异步延迟，交给外层下一轮换货循环/双刷新兜底再判
  return { success: false, error: confirmErr ? ('换货错误提示: ' + confirmErr) : '换货提交后货品行未在等待窗口内变为运费链接2（可能异步延迟）' };
}

// ---------- 客服备注 / 审核 / 标记异常 ----------
async function writeSellerMemo(thirdOid) {
  return await pjs(`
    var top = document.querySelectorAll('.spreadtable')[0].__vue__.$parent.$parent.$parent;
    if(!top.editSellerMemo) return 'no-editSellerMemo';
    top.editSellerMemo('${SELLER_MEMO}', {thirdOrderCode:${thirdOid},flag:0});
    return 'saved';
  `);
}

// 轮询等待订单从当前列表消失（不重新 clickQuery，原地读 dataSource；超时才兜底刷一次）
// 要求连续 2 次都读到消失才算真离开，避免列表刷新/分页瞬时抖动把“还在”误判成“已离开”（假成功）。
async function waitOrderGone(rowId) {
  var goneStreak = 0;
  for (var i = 0; i < 14; i++) {
    await sleep(1500);
    var there = await pjs(`
      var os=document.querySelectorAll('.spreadtable')[0].__vue__.$parent;
      var ds=os.$data.tableProps.dataSource||[];
      return ds.some(function(r){return r.id===${rowId};}) ? '1' : '0';
    `);
    if (there === '0') {
      goneStreak++;
      if (goneStreak >= 2) return true;   // 连续两次都不在，确认离开
    } else {
      goneStreak = 0;
    }
  }
  // 兜底：手动刷一次再查（同样要求连续两次）
  await clickQuery();
  await sleep(4000);
  var s2 = 0;
  for (var j = 0; j < 4; j++) {
    var there2 = await pjs(`
      var os=document.querySelectorAll('.spreadtable')[0].__vue__.$parent;
      var ds=os.$data.tableProps.dataSource||[];
      return ds.some(function(r){return r.id===${rowId};}) ? '1' : '0';
    `);
    if (there2 === '0') { s2++; if (s2 >= 2) return true; } else { s2 = 0; }
    await sleep(1500);
  }
  return false;
}

// 复核订单是否真的已离开待审核：强制重新查询列表，连续 N 次读不到该单才确认“真消失”。
// 防止快照后列表刷新/分页抖动/加载中导致的假消失误报。
async function confirmOrderReallyGone(rowId) {
  for (var round = 0; round < 2; round++) {
    await clickQuery();
    await sleep(4000);
    var seen = 0;
    for (var k = 0; k < 4; k++) {
      var there = await pjs(`
        var os=document.querySelectorAll('.spreadtable')[0].__vue__.$parent;
        var ds=os.$data.tableProps.dataSource||[];
        var tp=os.$data.tableProps||{};
        var loading=tp.loading===true;
        return JSON.stringify({there: ds.some(function(r){return r.id===${rowId};}), loading: loading});
      `);
      try {
        var d = JSON.parse(there);
        if (d.there) return false;      // 查到了 => 还在待审核，是假消失
        if (!d.loading) seen++;
      } catch(e) {}
      await sleep(1500);
    }
    if (seen < 2) return false;         // 一直 loading/读不稳，保守当还在，不误报
  }
  return true;                          // 两轮重查、每轮连续2次非loading都读不到 => 真消失
}

// 审核通过（按 id 重新选中订单行，避免换货切 tab 后选中态丢失）
async function auditOrder(rowId) {
  // 关键：换货过程停在“货品列表”子 tab，仅调 _onSelectRows 不会把选中态同步到顶层 selectedRows
  // （top.audit() 读不到 → no-selection）。必须与 selectRowById 一样同时调 _onSelectRows + _onRowClick，
  // 并多次重试选中直到顶层 selectedRows 非空。
  var selOk = false;
  for (var attempt = 0; attempt < 3; attempt++) {
    await pjs(`
      var os=document.querySelectorAll('.spreadtable')[0].__vue__.$parent;
      var ds=os.$data.tableProps.dataSource||[];
      var row=ds.find(function(r){return r.id===${rowId};});
      if(row){ os._onSelectRows([row.id],[row]); os._onRowClick(row,true); }
    `);
    await sleep(1200);
    var selCheck = await pjs(`
      var top=document.querySelectorAll('.spreadtable')[0].__vue__.$parent.$parent.$parent;
      return JSON.stringify({selected: top.$data.selectedRows?top.$data.selectedRows.length:0});
    `);
    log('  审核前选中(第'+(attempt+1)+'次): ' + selCheck);
    try { if (JSON.parse(selCheck).selected > 0) { selOk = true; break; } } catch(e) {}
    await sleep(1000);
  }
  if (!selOk) log('  ⚠️ 审核前选中态仍为空，仍尝试 audit（交由 waitOrderGone 校验）');
  var result = await pjs(`
    var top = document.querySelectorAll('.spreadtable')[0].__vue__.$parent.$parent.$parent;
    if(!top.$data.selectedRows||!top.$data.selectedRows.length) return 'no-selection';
    return top.audit().then(function(){return 'audit-done';}).catch(function(e){return 'audit-error:'+e.message;});
  `);
  await sleep(4000);
  var closed = await closeAllModals();
  log('  审核后弹窗关闭: ' + closed);
  return result;
}

async function closeAllModals() {
  var closed = [];
  for (var attempt = 0; attempt < 5; attempt++) {
    var info = await pjs(`
      var found = false;
      var wraps=document.querySelectorAll('.ant-modal-wrap');
      for(var i=0;i<wraps.length;i++){
        if(getComputedStyle(wraps[i]).display==='none')continue;
        var title=wraps[i].querySelector('.ant-modal-title,.ant-modal-confirm-title');
        var titleText=title?title.innerText:'';
        var btns=wraps[i].querySelectorAll('button');
        for(var j=0;j<btns.length;j++){
          if(btns[j].offsetParent===null)continue;
          var t=btns[j].innerText.trim();
          if(t==='确定'||t==='关 闭'||t==='关闭'||t==='确 定'||t==='OK'){ btns[j].click(); found=true; break; }
        }
        if(found) return titleText||'modal';
      }
      var notifs=document.querySelectorAll('.ant-notification-notice-close');
      for(var k=0;k<notifs.length;k++){notifs[k].click();found=true;}
      return found ? 'notification' : '';
    `);
    if (!info) break;
    closed.push(info);
    await sleep(2000);
  }
  return closed.join(', ') || 'none';
}

async function markException() {
  // 1. 点“标记异常”按钮，并确认点到了
  var clickRes = await pjs(`
    var hit=false;
    document.querySelectorAll('button').forEach(function(b){
      if(b.offsetParent===null)return;
      if(b.innerText.trim()==='标记异常'&&!b.disabled&&!hit){b.click();hit=true;}
    });
    return hit?'clicked':'no-btn';
  `);
  if (clickRes !== 'clicked') return { success:false, error:'未找到可点的“标记异常”按钮' };
  await sleep(3000);

  // 2. 轮询等待“标记异常”弹窗打开（同时早抓 D3 报错，ant-message ~3s 消失）
  var modalOpen = false, earlyErr = '';
  for (var poll = 0; poll < 8; poll++) {
    await sleep(600);
    var pc = await pjs(`
      var open=false;
      var wraps=document.querySelectorAll('.ant-modal-wrap');
      for(var i=0;i<wraps.length;i++){if(getComputedStyle(wraps[i]).display==='none')continue;
        var t=wraps[i].querySelector('.ant-modal-title');if(t&&t.innerText.indexOf('标记异常')>=0){open=true;}}
      var msgs=[];var m=document.querySelectorAll('.ant-message-notice');for(var j=0;j<m.length;j++){if(m[j].innerText)msgs.push(m[j].innerText);}
      return JSON.stringify({open:open,msgs:msgs});
    `);
    var pci = JSON.parse(pc);
    if (pci.open) { modalOpen = true; break; }
    if (pci.msgs.length) { var j2 = pci.msgs.join('|'); if (j2.indexOf('成功') < 0) { earlyErr = j2; break; } }
  }
  if (!modalOpen) return { success:false, error:'标记异常弹窗未打开' + (earlyErr ? '（D3提示: '+earlyErr+'）' : '') };

  // 3. 点开原因下拉
  await pjs(`
    var wraps=document.querySelectorAll('.ant-modal-wrap');
    for(var i=0;i<wraps.length;i++){if(getComputedStyle(wraps[i]).display==='none')continue;
      var title=wraps[i].querySelector('.ant-modal-title');if(!title||title.innerText.indexOf('标记异常')<0)continue;
      var sel=wraps[i].querySelector('.ant-select');if(sel)sel.click();}
  `);
  await sleep(2000);

  // 4. 选原因（轮询等下拉选项渲染），并确认选中
  var picked = false, avail = [];
  for (var p2 = 0; p2 < 6; p2++) {
    var pr = await pjs(`
      var hit=false;var labels=[];
      var opts=document.querySelectorAll('.ant-select-dropdown-menu-item,.ant-select-item-option');
      for(var i=0;i<opts.length;i++){if(opts[i].offsetParent===null)continue;var tx=opts[i].innerText.trim();if(tx)labels.push(tx);
        if(tx==='${EXCEPTION_REASON}'&&!hit){opts[i].click();hit=true;}}
      return JSON.stringify({picked:hit,labels:labels});
    `);
    var pri = JSON.parse(pr);
    avail = pri.labels;
    if (pri.picked) { picked = true; break; }
    await sleep(800);
  }
  if (!picked) { await closeAllModals(); return { success:false, error:'未找到异常原因选项「'+EXCEPTION_REASON+'」（可选: '+avail.join('/')+'）' }; }
  await sleep(1000);

  // 5. 点“确 定”，并确认点到了
  var confirmRes = await pjs(`
    var hit=false;
    var wraps=document.querySelectorAll('.ant-modal-wrap');
    for(var i=0;i<wraps.length;i++){if(getComputedStyle(wraps[i]).display==='none')continue;
      var title=wraps[i].querySelector('.ant-modal-title');if(!title||title.innerText.indexOf('标记异常')<0)continue;
      var footer=wraps[i].querySelector('.ant-modal-footer');if(footer){var btns=footer.querySelectorAll('button');
        for(var j=0;j<btns.length;j++){if(btns[j].innerText.trim()==='确 定'){btns[j].click();hit=true;break;}}}}
    return hit?'confirmed':'no-confirm';
  `);
  if (confirmRes !== 'confirmed') { await closeAllModals(); return { success:false, error:'标记异常弹窗未找到确定按钮' }; }

  // 6. 等弹窗关闭 + 抓 D3 报错
  for (var w = 0; w < 10; w++) {
    await sleep(1500);
    var ec = await pjs(`
      var msgs=[];var m=document.querySelectorAll('.ant-message-notice');for(var i=0;i<m.length;i++){if(m[i].innerText)msgs.push(m[i].innerText);}
      var open=0;var wraps=document.querySelectorAll('.ant-modal-wrap');
      for(var i=0;i<wraps.length;i++){if(getComputedStyle(wraps[i]).display==='none')continue;
        var t=wraps[i].querySelector('.ant-modal-title');if(t&&t.innerText.indexOf('标记异常')>=0)open++;}
      return JSON.stringify({msgs:msgs,open:open});
    `);
    var eci = JSON.parse(ec);
    var em = eci.msgs.join('|');
    if (em && em.indexOf('成功') < 0) { await closeAllModals(); return { success:false, error:'标记异常D3报错: '+em }; }
    if (eci.open === 0) return { success:true };
  }
  await closeAllModals();
  return { success:false, error:'标记异常后弹窗未关闭/状态未变' };
}

// ---------- 补单处理一个 D3 系统单 ----------
async function processBudanD3Order(row) {
  log('补单处理 D3单 id=' + row.id + ' code=' + row.code + ' 覆盖单号=' + row.refOids.join(','));
  var origSkus = row.lines.map(function(l){return l.outerId;}).filter(function(s){return s && s!==REPLACEMENT_SKU;}).filter(function(s,i,a){return a.indexOf(s)===i;});
  var origNames = row.lines.map(function(l){return l.title;}).filter(function(s){return s && s!=='运费链接2';}).filter(function(s,i,a){return a.indexOf(s)===i;});
  // 收集本单换货过程中出现过的所有平台子单号(refOid)。合并订单一个 D3 单含多个平台子单，
  // 列表行 refOids 快照可能漏掉个别子单号，用明细行 refOid（换货后仍稳定）兜底，防关联单号漏记台账。
  var seenRefOids = {};

  // 直接选中（dataSource 已是本轮加载的最新数据）
  var sel = await selectRowById(row.id);
  log('  选中: ' + sel);
  // 本轮 loadAllOrders 时该单还在待审核、台账也无成功记录，此刻却选不中=已离开待审核。
  // 加全局锁后不存在“自己并发审核”的可能，脚本也还没对它换货，所以它消失只可能是被
  // D3 自动客审放行（原货未换成运费链接2就审出去=事故）。绝不能当成功，必须告警人工核对。
  if (sel === 'nf') {
    // 可能是快照后列表刷新/分页抖动造成的假消失：强制重查待审核列表复核。
    var reallyGone = await confirmOrderReallyGone(row.id);
    if (!reallyGone) {
      log('  ⚠️ 选中时读不到但重查仍在待审核（假消失），重新选中继续处理');
      var sel2 = await selectRowById(row.id);
      log('  重新选中: ' + sel2);
      if (sel2 === 'nf') {
        return { success: false, d3Id: row.id, d3Code: row.code, vanished: true,
          error: '订单重查后仍无法选中，请人工核对', origSku: origSkus.join(','), origName: origNames.join(',') };
      }
    } else {
      // 本轮加载时该单还在待审核、台账无成功记录，还没换货就重查不到=真消失。
      // 加全局锁后不存在“自己并发审核”，脚本也还没换货，只可能被 D3 自动客审放行
      // （原货未换成运费链接2就审出去=事故），绝不当成功，必须告警人工核对。
      return { success: false, d3Id: row.id, d3Code: row.code, vanished: true,
        error: '订单在换货前已离开待审核（疑似被D3自动客审放行，原货可能未换成运费链接2，请立即核对货品行）',
        origSku: origSkus.join(','), origName: origNames.join(',') };
    }
  }
  await sleep(1500);
  await openLinesTab();

  // 逐轮换货，直到全部是运费链接2
  var maxRounds = 20;
  for (var round = 0; round < maxRounds; round++) {
    var linesJson = await getProductLines();
    var lines = JSON.parse(linesJson);
    lines.forEach(function(l){ if(l.refOid) seenRefOids[l.refOid]=true; if(l.thirdOid) seenRefOids[String(l.thirdOid)]=true; });
    var target = lines.find(function(l){return l.outerId !== REPLACEMENT_SKU;});
    if (!target) { log('  所有货品已替换为 ' + REPLACEMENT_SKU); break; }
    var beforeNonFF = lines.filter(function(l){return l.outerId !== REPLACEMENT_SKU;}).length;
    log('  第'+(round+1)+'轮换货: ' + target.outerId + ' (' + target.title + ') 子订单=' + (target.refOid||''));
    var r = await exchangeToSingle(target);
    // 换货后强制刷新货品列表，保证下一轮读到最新数据
    await refreshLines();
    if (!r.success) {
      // 兜底：exchangeToSingle 内部已做强校验仍判失败。这里再独立多轮强刷新（异步换货可能还在落地），
      // 以整单/目标子订单的真实状态为最终依据：只要非FF行减少、或目标子订单已全FF，就继续下一轮，绝不误中止。
      var recovered = false;
      for (var retry = 0; retry < 4; retry++) {
        await refreshLines();
        var afterLines = [];
        try { afterLines = JSON.parse(await getProductLines()); } catch(e) { afterLines = []; }
        var afterNonFF = afterLines.filter(function(l){return l.outerId !== REPLACEMENT_SKU;}).length;
        var subKey = target.refOid || '';
        var subGroup = afterLines.filter(function(l){return (l.refOid||'')===subKey;});
        var subAllFF = subGroup.length>0 && subGroup.every(function(l){return l.outerId===REPLACEMENT_SKU;});
        if (afterLines.length>0 && (afterNonFF < beforeNonFF || subAllFF)) {
          log('  ⚠️ 换货报失败但重读确认实际已生效（非FF '+beforeNonFF+'→'+afterNonFF+'，子订单全FF='+subAllFF+'），继续下一轮');
          recovered = true;
          break;
        }
        // 还没落地：多等一轮（异步换货后台处理需要时间）
        log('  兜底重刷新第'+(retry+1)+'次：非FF '+afterNonFF+'/'+beforeNonFF+' 子订单全FF='+subAllFF+'，异步落地中…');
        await sleep(3000);
      }
      if (recovered) continue;
      return { success: false, d3Id: row.id, error: '换货失败: ' + r.error, origSku: origSkus.join(','), origName: origNames.join(',') };
    }
  }

  // 最终验证
  var finalJson = await getProductLines();
  var finalLines = JSON.parse(finalJson);
  finalLines.forEach(function(l){ if(l.refOid) seenRefOids[l.refOid]=true; if(l.thirdOid) seenRefOids[String(l.thirdOid)]=true; });
  if (!finalLines.length || !finalLines.every(function(l){return l.outerId === REPLACEMENT_SKU;})) {
    return { success: false, d3Id: row.id, error: '换货后仍有非运费链接2货品: ' + finalLines.map(function(l){return l.outerId;}).join(','), origSku: origSkus.join(','), origName: origNames.join(',') };
  }

  // 客服备注
  var thirdOid = finalLines[0] ? finalLines[0].thirdOid : (row.lines[0] ? row.lines[0].thirdOid : null);
  if (thirdOid) { log('  客服备注: ' + await writeSellerMemo(thirdOid)); await sleep(800); }

  // 审核
  log('  审核通过...');
  var auditRes = await auditOrder(row.id);
  log('  审核结果: ' + auditRes);
  if (auditRes !== 'audit-done') return { success: false, d3Id: row.id, error: '审核失败: ' + auditRes, exchanged: true, origSku: origSkus.join(','), origName: origNames.join(',') };

  // 强制校验：订单应已离开待审核（原地轮询，不重复全量刷）
  var gone = await waitOrderGone(row.id);
  if (!gone) {
    log('  ⚠️ 审核后订单仍在待审核，重试审核一次');
    await auditOrder(row.id);
    gone = await waitOrderGone(row.id);
    if (!gone) return { success: false, d3Id: row.id, error: '审核后订单仍在待审核列表', exchanged: true, origSku: origSkus.join(','), origName: origNames.join(',') };
  }
  log('  ✅ D3单 ' + row.code + ' 已完成换货+审核并离开待审核');
  return { success: true, d3Id: row.id, d3Code: row.code, exchanged: true, audited: true, origSku: origSkus.join(','), origName: origNames.join(','),
    allRefOids: Object.keys(seenRefOids) };
}

// ---------- 占单处理一个 D3 系统单 ----------
async function processZhandanD3Order(row) {
  log('占单处理 D3单 id=' + row.id + ' code=' + row.code + ' 覆盖单号=' + row.refOids.join(','));
  var origSkus = row.lines.map(function(l){return l.outerId;}).filter(function(s){return s && s!==REPLACEMENT_SKU;}).filter(function(s,i,a){return a.indexOf(s)===i;});
  var origNames = row.lines.map(function(l){return l.title;}).filter(function(s){return s && s!=='运费链接2';}).filter(function(s,i,a){return a.indexOf(s)===i;});

  var sel = await selectRowById(row.id);
  log('  选中: ' + sel);
  // 同补单：本轮加载时该单还在待审核、台账无成功记录，还没转异常就消失，加锁后只可能是
  // 被 D3 自动客审放行（占单本应转异常拦截，却被正常审出去=事故），必须告警人工核对。
  if (sel === 'nf') {
    // 同补单：先重查复核，防快照后刷新/分页抖动造成的假消失。
    var zReallyGone = await confirmOrderReallyGone(row.id);
    if (!zReallyGone) {
      log('  ⚠️ 选中时读不到但重查仍在待审核（假消失），重新选中继续处理');
      var zSel2 = await selectRowById(row.id);
      log('  重新选中: ' + zSel2);
      if (zSel2 === 'nf') {
        return { success: false, d3Id: row.id, d3Code: row.code, vanished: true,
          error: '订单重查后仍无法选中，请人工核对', origSku: origSkus.join(','), origName: origNames.join(',') };
      }
    } else {
      // 本轮加载时还在、台账无成功记录，还没转异常就真消失=疑似被 D3 自动客审放行（事故）。
      return { success: false, d3Id: row.id, d3Code: row.code, vanished: true,
        error: '订单在转异常前已离开待审核（疑似被D3自动客审放行，占单未转异常，请立即核对）',
        origSku: origSkus.join(','), origName: origNames.join(',') };
    }
  }
  await sleep(1500);

  var r = await markException();
  log('  标记异常结果: ' + JSON.stringify(r));
  if (!r.success) return { success: false, d3Id: row.id, error: '标记异常失败: ' + r.error, origSku: origSkus.join(','), origName: origNames.join(',') };

  // 强制校验（原地轮询）：订单必须真的离开待审核
  var gone = await waitOrderGone(row.id);
  if (!gone) {
    log('  ⚠️ 标记异常后订单仍在待审核，重试一次');
    await selectRowById(row.id);
    await sleep(1200);
    var r2 = await markException();
    log('  重试标记异常结果: ' + JSON.stringify(r2));
    if (!r2.success) return { success: false, d3Id: row.id, error: '标记异常失败(重试): ' + r2.error, origSku: origSkus.join(','), origName: origNames.join(',') };
    gone = await waitOrderGone(row.id);
    if (!gone) return { success: false, d3Id: row.id, error: '标记异常后订单仍在待审核列表', origSku: origSkus.join(','), origName: origNames.join(',') };
  }
  log('  ✅ D3单 ' + row.code + ' 已转异常单并离开待审核');
  return { success: true, d3Id: row.id, d3Code: row.code, exceptioned: true, origSku: origSkus.join(','), origName: origNames.join(',') };
}

// ---------- 出库计划单(通知成功)二次核实（2026-09-10）----------
// 场景：自补单提交满约45分钟仍 notFound（待审核池没有、台账没有）。此时单只有两种归宿：
//  ①已审核进了出库计划单——看货品行：全是 FF000748=其实成功（补台账闭环，不@）；有原货=没换货就被放行（自动取消计划单拉回重做，不@）；
//  ②出库计划单也没有——确实还没从平台同步，静默继续等；满60分钟仍没有才 @ 人（疑处方单异常卡在异常单里）。
function submitAgeMin(submitTime) {
  if (!submitTime) return 0;
  var t = Date.parse(submitTime);
  if (isNaN(t)) return 0;
  return Math.floor((Date.now() - t) / 60000);
}
async function ensurePlanPage() {
  const url = await pjs('return location.href');
  if (!url.includes('stock-out-plan')) {
    await ego.helpers.openOrReuseTab(D3_PLAN_URL);
    await sleep(9000);
  }
}
async function planSearch(code) {
  // 用原生 setter 写 #refOid（原始订单号）并点查询（与人工操作一致，已探针验证）
  await pjs(`
    var inp=document.getElementById('refOid');
    var s=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
    s.call(inp,${JSON.stringify(code)});
    inp.dispatchEvent(new Event('input',{bubbles:true}));
    inp.dispatchEvent(new Event('change',{bubbles:true}));
    var b=document.querySelectorAll('button');for(var i=0;i<b.length;i++){if(b[i].innerText.trim()==='查询'&&b[i].offsetParent!==null){b[i].click();break;}}
  `);
}
async function planReadRow() {
  return await pjs(`
    var st=document.querySelectorAll('.spreadtable')[0];if(!st||!st.__vue__)return JSON.stringify({none:true});
    var v=st.__vue__,h=0,root=null;
    while(v&&h<14){if(v.$options&&v.$options.name==='OutPlanIndexNext'){root=v;break;}v=v.$parent;h++;}
    if(!root)return JSON.stringify({none:true});
    var ds=(root.tableProps&&root.tableProps.dataSource)||[];
    return JSON.stringify(ds.slice(0,5).map(function(r){return {id:r.id,code:r.code,refOid:r.refOid,sourceId:r.sourceId,
      status:r.status?(r.status.enumName||r.status.name||String(r.status)):'',pos:r.posName||''};}));
  `);
}
async function planReadGoods(rowId) {
  // 直接调计划单货品明细接口（已探针确认）：sharing.third.warehousing.whsStockOutPlanLine.getPage，按 planId 查。
  // 比解析 canvas 子表稳，返回行含 outerId（FF000748=运费链接2）。
  return await pjs(`
    return new Promise(function(resolve){
      var url='/app-web/router/rest.json?method=sharing.third.warehousing.whsStockOutPlanLine.getPage&bizType=ALL&_prdCode=omni&_pageCode=omni.omni.3rd-warehousing.stock-out-plan.index';
      var done=false;
      function finish(v){if(done)return;done=true;resolve(JSON.stringify(v));}
      try{
        var xhr=new XMLHttpRequest();
        xhr.open('POST',url,true);
        xhr.setRequestHeader('Content-Type','application/json;charset=UTF-8');
        xhr.onreadystatechange=function(){
          if(xhr.readyState!==4)return;
          try{
            var j=JSON.parse(xhr.responseText||'{}');
            var arr=(((j.data||{}).content)||(j.data&&j.data.list)||[]);
            // 只留属于本计划单的行（接口对 planId 过滤不稳定，必须前端再筛，防拿到全表误判原货）
            arr=arr.filter(function(l){return Number(l.planId)===Number(${rowId});});
            finish(arr.map(function(l){return {outerId:l.outerId||l.refSkuId,title:(l.skuFullVo&&(l.skuFullVo.title||l.skuFullVo.productName))||l.title||'',num:l.num,planNum:l.planNum||l.baseNum};}));
          }catch(e){finish([]);}
        };
        xhr.onerror=function(){finish([]);};
        xhr.send(JSON.stringify({qo:{planIds:[${rowId}],pageNo:1,pageSize:200}}));
        setTimeout(function(){finish([]);},8000);
      }catch(e){finish([]);}
    });
  `).then(function(s){try{return JSON.parse(s);}catch(e){return [];}}).catch(function(){return [];});
}
// 核实单个 notFound 单号在出库计划单的状态。返回 {found,allFF,goods,rowId,sourceId}
async function verifyOutPlan(code) {
  await ensurePlanPage();
  await planSearch(code);
  var rows = [];
  for (var i = 0; i < 12; i++) {
    await sleep(1500);
    try { rows = JSON.parse(await planReadRow()); } catch(e) { rows = []; }
    if (rows.length===1 && rows[0].none) rows=[];
    if (rows.length) break;
  }
  if (!rows.length) return { found: false };
  var row = rows[0];
  var goods = await planReadGoods(row.id);
  var skus = goods.map(function(g){return g.outerId;}).filter(Boolean);
  // 明细读不到时保守判 unknown（绝不把“没读到商品”当原货去取消，避免误取消正常计划单）
  if (!skus.length) return { found: true, unknown: true, goods: [], rowId: row.id, sourceId: row.sourceId };
  var allFF = skus.every(function(s){return s===REPLACEMENT_SKU;});
  return { found: true, allFF: allFF, goods: goods, rowId: row.id, sourceId: row.sourceId };
}
// 勾选出库计划单行 → 点“取消计划单” → 确认所有弹窗 → 等该单离开通知成功列表
async function cancelOutPlan(code, rowId) {
  log('  ↩️ 原货被放行，取消计划单拉回: ' + code + ' (planRow ' + rowId + ')');
  // 勾选行
  await pjs(`
    var st=document.querySelectorAll('.spreadtable')[0];var v=st.__vue__,h=0,root=null;
    while(v&&h<14){if(v.$options&&v.$options.name==='OutPlanIndexNext'){root=v;break;}v=v.$parent;h++;}
    if(root){var row=(root.tableProps.dataSource||[]).find(function(r){return r.id===${rowId};});
      if(row){try{root.onSelectChange([row.id],[row]);}catch(e){}}}
  `);
  await sleep(600);
  // 点“取消计划单”
  await pjs(`var hit=false;document.querySelectorAll('button').forEach(function(b){if(!hit&&b.offsetParent!==null&&b.innerText.trim()==='取消计划单'&&!b.disabled){b.click();hit=true;}});`);
  // 可能弹一个或多个确认框，依次点“确定/确认/是”，并关消息提示
  for (var k = 0; k < 4; k++) {
    await sleep(1200);
    var acted = await pjs(`
      var a=false;
      var wraps=document.querySelectorAll('.ant-modal-wrap,.ant-modal-confirm');
      for(var i=0;i<wraps.length;i++){var w=wraps[i];if(getComputedStyle(w).display==='none')continue;
        var btns=w.querySelectorAll('button.ant-btn-primary,button');
        for(var j=0;j<btns.length;j++){var t=(btns[j].innerText||'').trim();
          if(btns[j].offsetParent!==null&&(t==='确 定'||t==='确定'||t==='确认'||t==='是')){btns[j].click();a=true;break;}}
        if(a)break;
      }
      return a?'1':'0';
    `);
    if (acted !== '1') break;
  }
  await closeAllModals();
  // 重新查询，等该单离开“通知成功”列表（取消生效）
  await planSearch(code);
  for (var w2 = 0; w2 < 10; w2++) {
    await sleep(1500);
    var rr;
    try { rr = JSON.parse(await planReadRow()); } catch(e) { rr = []; }
    if (rr.length===1 && rr[0].none) rr=[];
    if (!rr.length) { log('  ✅ 计划单已取消，订单应已回到待审核'); return true; }
  }
  log('  ⚠️ 取消计划单后该单仍在通知成功列表，需人工关注');
  return false;
}

// ---------- 主流程 ----------
async function main() {
  var fs = require('fs');
  var inputFile = (typeof globalThis !== 'undefined' && globalThis.__BUDAN_INPUT__) ? globalThis.__BUDAN_INPUT__ : '/tmp/budan-pending.json';
  var input = fs.readFileSync(inputFile, 'utf8');
  var parsed;
  try { parsed = JSON.parse(input.trim()); }
  catch(e) { console.error('JSON解析失败:', e.message); process.exit(1); }

  // 由 shell 注入：台账路径与凭据文件（项目可搬迁的关键）
  if (parsed && parsed.ledgerPath) LEDGER_PATH = parsed.ledgerPath;
  applyCredentialFile(fs, parsed && parsed.credFile);

  // 并发轮次用各自独立的 ego task space（shell 分配 3 个命名 space 轮换，不存在则建、存在则复用，均继承登录态）
  var spaceName = (parsed && parsed.taskSpace) ? parsed.taskSpace : DEFAULT_TASK_SPACE;
  var task = await useOrCreateTaskSpace(spaceName);
  log('使用 ego task space: ' + spaceName + ' (id=' + task.id + ')');

  // 兼容旧格式（纯数组）与新格式（{records, manual}）
  var records = Array.isArray(parsed) ? parsed : (parsed.records || []);
  var manual = Array.isArray(parsed) ? [] : (parsed.manual || []);
  // 防御性净化：无论 shell 解析还是人工补发(manual)，单号都剥掉零宽/全角等异常字符
  records.forEach(function(rec){ if (Array.isArray(rec.orderCodes)) rec.orderCodes = rec.orderCodes.flatMap(function(c){ return splitCodes(c); }); });
  var allEntries = records.concat(manual.map(function(m, i){
    return { recordId: '__MANUAL_' + i, orderCodes: (Array.isArray(m.orderCodes) ? m.orderCodes.flatMap(function(c){ return splitCodes(c); }) : []), type: m.type, submitterId: '', submitTime: '', manual: true };
  }));
  // 带上提交时间（自补单 30 分钟未完成提醒用）
  allEntries.forEach(function(e){
    if (e.submitTime === undefined) e.submitTime = '';
  });

  log('待处理记录数: ' + records.length + '，人工补发: ' + manual.length);

  await ensurePage();
  await sleep(2000);

  // 跨轮次成功台账：已换货+审核/转异常离开待审核池的单号，下轮不再去池里找（否则会误判未同步）
  // 台账由 loadLedger 内的 7 天 TTL 自动清理，无需额外裁剪。
  var ledger = loadLedger(fs);
  var ledgerHits = 0;

  // 1. 全量加载待审核
  var rowsJson = await loadAllOrders();
  var d3rows = JSON.parse(rowsJson);
  log('D3待审核订单数: ' + d3rows.length);

  // 2. 建立 原始单号 -> D3行 映射（refOids 数组交集）；台账已成功的直接命中
  var targetMap = {};
  var codeStatus = {};  // code -> {found, d3Ids, fromLedger}
  for (var rec of allEntries) {
    var isBudan = String(rec.type || '').indexOf('补单') >= 0;
    var isZhan = String(rec.type || '').indexOf('占单') >= 0;
    var kind = isBudan ? 'budan' : (isZhan ? 'zhandan' : 'unknown');
    for (var code of rec.orderCodes) {
      if (!codeStatus[code]) codeStatus[code] = { found: false, d3Ids: [] };
      if (kind === 'unknown') {
        codeStatus[code].unknownType = true;
        continue;
      }
      // 台账已记录成功：直接算成功，不再去待审核池找
      if (ledger.orders[code] && ledger.orders[code].success) {
        codeStatus[code].found = true;
        codeStatus[code].fromLedger = true;
        if (ledger.orders[code].d3Id) codeStatus[code].d3Ids = [ledger.orders[code].d3Id];
        ledgerHits++;
        continue;
      }
      for (var row of d3rows) {
        if (row.code === code || row.refOids.indexOf(code) >= 0) {
          codeStatus[code].found = true;
          if (codeStatus[code].d3Ids.indexOf(row.id) < 0) codeStatus[code].d3Ids.push(row.id);
          if (!targetMap[row.id]) targetMap[row.id] = { row: row, codes: {}, records: {}, types: {} };
          targetMap[row.id].codes[code] = true;
          targetMap[row.id].records[rec.recordId] = rec;
          targetMap[row.id].types[kind] = true;
        }
      }
    }
  }
  log('台账命中已成功单号: ' + ledgerHits);

  // 3. 逐个处理命中的 D3 系统单
  var d3Results = {};  // d3Id -> result
  for (var d3IdStr in targetMap) {
    var d3Id = Number(d3IdStr);
    var t = targetMap[d3IdStr];
    var types = Object.keys(t.types);
    if (types.length > 1) {
      // 类型冲突：同一 D3 单既有补单又有占单登记
      log('⚠️ D3单 ' + t.row.code + ' 存在类型冲突(' + types.join('+') + ')，跳过自动处理');
      d3Results[d3Id] = { success: false, d3Id: d3Id, d3Code: t.row.code, conflict: true,
        error: '同一D3单同时存在补单和占单登记，需人工确认', coveredCodes: Object.keys(t.codes) };
      continue;
    }
    try {
      if (types[0] === 'zhandan') {
        d3Results[d3Id] = await processZhandanD3Order(t.row);
      } else {
        d3Results[d3Id] = await processBudanD3Order(t.row);
      }
      d3Results[d3Id].coveredCodes = Object.keys(t.codes);
    } catch(e) {
      log('D3单处理异常: ' + t.row.code + ' - ' + e.message);
      d3Results[d3Id] = { success: false, d3Id: d3Id, d3Code: t.row.code, error: e.message, coveredCodes: Object.keys(t.codes) };
    }
  }

  // 3.4 合并订单兜底：换货+审核成功的 D3 单，把它能拿到的全部平台单号（主单号 code、
  // 列表快照 refOids、换货明细行 refOid=allRefOids）与本批所有登记单号再对一遍。
  // 列表行 refOids 快照可能漏掉合并进来的个别子单号，导致它首轮没被映射上（一直 notFound）。
  // 只要某登记单号出现在成功 D3 单的单号集合里，就认定它随该单一并换货+审核成功，补标记+补台账。
  var allRegCodes = [];
  for (var _e of allEntries) { ( _e.orderCodes || []).forEach(function(c){ if (allRegCodes.indexOf(c) < 0) allRegCodes.push(c); }); }
  for (var _did in d3Results) {
    var _dr = d3Results[_did];
    if (!_dr || !_dr.success) continue;
    var oidSet = {};
    if (_dr.d3Code) oidSet[_dr.d3Code] = true;
    (_dr.allRefOids || []).forEach(function(x){ if (x) oidSet[String(x)] = true; });
    (_dr.coveredCodes || []).forEach(function(x){ oidSet[x] = true; });
    var _row = (targetMap[_did] && targetMap[_did].row) || null;
    if (_row) {
      if (_row.code) oidSet[_row.code] = true;
      (_row.refOids || []).forEach(function(x){ if (x) oidSet[String(x)] = true; });
      (_row.lines || []).forEach(function(l){ if (l && l.thirdOid) oidSet[String(l.thirdOid)] = true; });
    }
    for (var _rc of allRegCodes) {
      if (oidSet[_rc]) {
        if (!codeStatus[_rc]) codeStatus[_rc] = { found: false, d3Ids: [] };
        if (codeStatus[_rc].d3Ids.indexOf(Number(_did)) < 0) codeStatus[_rc].d3Ids.push(Number(_did));
        codeStatus[_rc].found = true;
        if (!_dr.coveredCodes) _dr.coveredCodes = [];
        if (_dr.coveredCodes.indexOf(_rc) < 0) { _dr.coveredCodes.push(_rc); log('  合并订单兜底：单号 ' + _rc + ' 随 D3单 ' + _did + ' 一并成功，补标记'); }
      }
    }
  }

  // 3.5 本轮新成功的 D3 单：把其覆盖的所有单号写入台账（跨轮次记忆）
  var newLedger = 0;
  for (var did in d3Results) {
    var dr = d3Results[did];
    if (dr && dr.success) {
      var cov = dr.coveredCodes || [];
      for (var ci = 0; ci < cov.length; ci++) {
        if (!ledger.orders[cov[ci]] || !ledger.orders[cov[ci]].success) {
          ledger.orders[cov[ci]] = {
            success: true,
            d3Id: dr.d3Id || Number(did),
            d3Code: dr.d3Code || '',
            kind: dr.exceptioned ? 'zhandan' : 'budan',
            origSku: dr.origSku || '',
            origName: dr.origName || '',
            ts: Date.now()
          };
          newLedger++;
        }
      }
    }
  }
  if (newLedger > 0) { saveLedger(fs, ledger); log('台账新增成功单号: ' + newLedger); }

  // 3.6 自补单 notFound 超时二次核实（2026-09-10）：满约45分钟仍在待审核池/台账都没有的单号，
  // 去「出库计划单(通知成功)」按单号核实，自动闭环，尽量不 @ 人：
  //   A 已通知仓库且货品全是 FF000748 → 其实成功：补台账，本轮直接算成功；
  //   B 已通知仓库但有原货（没换货就被放行）→ 自动「取消计划单」拉回待审核，随后重做换货+审核；
  //   C 出库计划单也没有 → 确实未同步，静默继续等；满 60 分钟仍没有才在 postprocess @ 人（疑处方单异常）。
  var planVerified = 0, planCancelled = 0;
  var rescuedCodes = [];          // B：已取消计划单、待本轮重做换货+审核的单号
  var unsyncedOver60 = {};        // C：recordId -> true，满60分钟仍两列表皆无，交 postprocess @ 一次
  var needPlanVerify = allEntries.filter(function(e){
    return !e.manual && String(e.type||'').indexOf('自补单')>=0 && submitAgeMin(e.submitTime) >= PLAN_VERIFY_MIN;
  });
  if (needPlanVerify.length) {
    for (var e of needPlanVerify) {
      var codesToCheck = (e.orderCodes||[]).filter(function(c){
        var cs2 = codeStatus[c];
        return (!cs2 || !cs2.found || !cs2.d3Ids.length) && !(ledger.orders[c] && ledger.orders[c].success);
      });
      if (!codesToCheck.length) continue;
      var over60 = submitAgeMin(e.submitTime) >= PLAN_UNSYNC_ALERT_MIN;
      for (var code2 of codesToCheck) {
        var pv = await verifyOutPlan(code2);
        if (!pv.found) {
          if (over60) unsyncedOver60[e.recordId] = true;
          continue;
        }
        if (pv.unknown) {
          // 计划单找到但商品明细本轮没读到：保守不动，等下一轮（不取消、不@）
          log('  ⚠️ 出库计划单找到但明细未读到，本轮跳过 ' + code2);
          continue;
        }
        if (pv.allFF) {
          // 结局 A：其实已成功（货品行全运费链接2），补台账
          var ffNames = (pv.goods||[]).map(function(g){return g.title;}).filter(function(x){return x && x!=='运费链接2';});
          if (!ledger.orders[code2] || !ledger.orders[code2].success) {
            ledger.orders[code2] = { success: true, d3Id: pv.sourceId || null, kind: 'budan',
              origSku: REPLACEMENT_SKU, origName: ffNames.join(','), ts: Date.now(), planVerified: true };
            newLedger++; planVerified++;
          }
          log('  🔎 出库计划单核实成功（已是运费链接2）: ' + code2 + (pv.sourceId?(' D3 '+pv.sourceId):''));
        } else {
          // 结局 B：原货被放行，取消计划单拉回重做
          log('  🚨 出库计划单中为原货（' + (pv.goods||[]).map(function(g){return g.outerId;}).join(',') + '），取消计划单: ' + code2);
          var okCancel = await cancelOutPlan(code2, pv.rowId);
          if (okCancel) { planCancelled++; rescuedCodes.push(code2); }
        }
      }
    }
    if (planVerified > 0) saveLedger(fs, ledger);

    // B 收尾：回到待审核页，把刚拉回的单重新换货+审核
    if (rescuedCodes.length) {
      log('取消计划单 ' + planCancelled + ' 笔，回到待审核重做换货+审核: ' + rescuedCodes.join(','));
      await ensurePage();
      await sleep(3000);
      var reRows = JSON.parse(await loadAllOrders());
      log('重做时 D3待审核订单数: ' + reRows.length);
      var reDone = {};
      for (var rc of rescuedCodes) {
        var hitRow = reRows.find(function(r){ return r.code===rc || (r.refOids||[]).indexOf(rc)>=0; });
        if (!hitRow) { log('  ⚠️ 计划单已取消但暂未在待审核读到 ' + rc + '（下一轮补换货）'); continue; }
        if (reDone[hitRow.id]) continue;
        reDone[hitRow.id] = true;
        var rr2 = await processBudanD3Order(hitRow);
        d3Results[hitRow.id] = rr2;
        if (rr2.success) {
          var cov2 = rr2.allRefOids || hitRow.refOids || [];
          if (cov2.indexOf(rc) < 0) cov2.push(rc);
          rr2.coveredCodes = cov2;
          cov2.forEach(function(x){ if (!ledger.orders[x] || !ledger.orders[x].success) {
            ledger.orders[x] = { success:true, d3Id: rr2.d3Id||hitRow.id, kind:'budan',
              origSku: rr2.origSku||'', origName: rr2.origName||'', ts:Date.now(), rescued:true }; newLedger++; } });
        } else {
          log('  ⚠️ 拉回后重做未成功 ' + rc + ': ' + rr2.error);
        }
      }
      if (newLedger > 0) saveLedger(fs, ledger);
    }
  }

  // 4. 汇总到每条登记记录
  var results = [];
  for (var rec of allEntries) {
    var codeResults = [];
    var recordOk = true;
    var pendingCodes = [];
    var conflictCodes = [];
    var recD3Ids = [];
    var origSkusArr = [], origNamesArr = [];

    for (var code of rec.orderCodes) {
      var cs = codeStatus[code];
      if (cs && cs.unknownType) {
        codeResults.push({ orderCode: code, success: false, unknownType: true, error: '登记表类型为空或无法识别（需补单/占单），未自动处理' });
        recordOk = false;
        continue;
      }
      // 台账已成功：既包括本轮开始前已成功的，也包括 3.6 出库计划单核实后刚补入台账的（结局A）
      if (ledger.orders[code] && ledger.orders[code].success) {
        var le = ledger.orders[code] || {};
        var leD3 = le.d3Id || ((cs && cs.d3Ids && cs.d3Ids[0]) || null);
        if (leD3 && recD3Ids.indexOf(leD3) < 0) recD3Ids.push(leD3);
        if (le.origSku && le.origSku!==REPLACEMENT_SKU && origSkusArr.indexOf(le.origSku) < 0) origSkusArr.push(le.origSku);
        if (le.origName && origNamesArr.indexOf(le.origName) < 0) origNamesArr.push(le.origName);
        codeResults.push({ orderCode: code, success: true, d3Ids: leD3?[leD3]:(cs&&cs.d3Ids||[]), fromLedger: true, planVerified: !!le.planVerified });
        continue;
      }
      if (!cs || !cs.found || !cs.d3Ids.length) {
        codeResults.push({ orderCode: code, success: false, notFound: true, error: 'D3待审核中未找到（可能未同步或已处理）' });
        pendingCodes.push(code);
        recordOk = false;
        continue;
      }
      var codeOk = true;
      var errs = [];
      var codeVanished = false, codeConflict = false;
      for (var did of cs.d3Ids) {
        var dr = d3Results[did];
        if (recD3Ids.indexOf(did) < 0) recD3Ids.push(did);
        if (dr && dr.origSku && origSkusArr.indexOf(dr.origSku) < 0) origSkusArr.push(dr.origSku);
        if (dr && dr.origName && origNamesArr.indexOf(dr.origName) < 0) origNamesArr.push(dr.origName);
        if (!dr || !dr.success) {
          codeOk = false;
          if (dr && dr.conflict) { conflictCodes.push(code); codeConflict = true; errs.push('类型冲突'); }
          else {
            if (dr && dr.vanished) codeVanished = true;
            errs.push(dr ? dr.error : '未处理');
          }
        }
      }
      if (codeOk) {
        codeResults.push({ orderCode: code, success: true, d3Ids: cs.d3Ids,
          deduped: cs.d3Ids.length === 1 && Object.keys(targetMap[cs.d3Ids[0]].codes).length > 1 });
      } else {
        codeResults.push({ orderCode: code, success: false, d3Ids: cs.d3Ids, error: errs.join(';'),
          vanished: codeVanished, conflict: codeConflict });
        recordOk = false;
      }
    }

    results.push({
      recordId: rec.recordId,
      manual: !!rec.manual,
      type: rec.type,
      submitterId: rec.submitterId || '',
      submitTime: rec.submitTime || '',
      orderResults: codeResults,
      d3Ids: recD3Ids,
      origSku: origSkusArr.join(','),
      origName: origNamesArr.join(','),
      pendingCodes: pendingCodes,
      conflictCodes: conflictCodes,
      unsyncedOver60: !!unsyncedOver60[rec.recordId],
      allSuccess: recordOk
    });
  }

  console.log('RESULT_JSON:' + JSON.stringify(results));
}

main().catch(function(e){
  console.error('FATAL:', e.message, e.stack);
  process.exit(1);
});
