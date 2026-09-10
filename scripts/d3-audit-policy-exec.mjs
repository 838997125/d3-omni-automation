#!/usr/bin/env node
/**
 * D3 自动客审策略货品增删
 * 从临时文件 /tmp/d3-audit-payload.json 读取 JSON: {add: [{sku, type}], delete: [sku]}
 *
 * 关键修复（规则未保存 bug）：
 *   1. 进编辑页强制整页 reload，确保表单加载的是【已持久化的完整规则】，
 *      而不是复用旧 tab 的空/脏表单（旧逻辑进页面不刷新，添加挂在空规则上，保存被覆盖）。
 *   2. 每次添加/删除后，立即用主列表搜索框回读，确认货品真的在表单里。
 *   3. 保存并"保存后立即启用"确定后，再次整页 reload，逐条复核：
 *      待添加的必须能搜到、待删除的必须搜不到。复核不过的算失败，绝不假成功。
 * 输出: RESULTS:{json}
 */
import { readFileSync, existsSync } from 'fs';
const payload = JSON.parse(readFileSync('/tmp/d3-audit-payload.json', 'utf8'));
const addList = payload.add || [];
const delList = payload.delete || [];

// 统一配置：优先读 shell 写入的凭据/地址 JSON（/tmp/d3-credentials.json），
// 缺失时回退原始默认值，保证单独运行也能工作。
function loadCfg() {
  for (const p of ['/tmp/d3-credentials.json']) {
    try { if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf8')); } catch (_) {}
  }
  return {};
}
const _cfg = loadCfg();
const DEFAULT_EDIT_URL = 'https://d3.diansan.com/omni/setting/policy/new-auto-audit/save/index.html?id=678962&action=edit';
const EDIT_URL = _cfg.auditPolicyUrl || DEFAULT_EDIT_URL;

const results = { added: [], deleted: [], skipped: [], errors: [] };

async function findRef(text, type) {
  const snap = await snapshotText();
  const lines = snap.split('\n');
  let re;
  if (type === 'radio') re = /radio \[ref=(\d+)/;
  else if (type === 'button') re = /button \[ref=(\d+)/;
  else if (type === 'textbox') re = /textbox \[ref=(\d+)/;
  else re = /\[ref=(\d+)/;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(text)) {
      for (let offset = 0; offset <= 8; offset++) {
        for (let dir of [-1, 1]) {
          const j = i + dir * offset;
          if (j >= 0 && j < lines.length) {
            const m = lines[j].match(re);
            if (m) return m[1];
          }
        }
      }
    }
  }
  return null;
}

async function findRadioRef(labelText) {
  const snap = await snapshotText();
  const lines = snap.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === `text "${labelText}"`) {
      // radio 出现在其标签上一行（radio ref=X 然后 text "标签"）。
      // 必须从标签紧邻的上一行向上找、取最近的那个 radio；
      // 否则会误命中上方另一个单选项（如把“套装”点成“单品”）。
      for (let j = i - 1; j >= Math.max(0, i - 6); j--) {
        const m = lines[j].match(/radio \[ref=(\d+)/);
        if (m) return m[1];
      }
    }
  }
  return null;
}

// 读取主货品表（非弹窗）当前渲染行的 SKU 列表
async function mainTableInfo() {
  const res = await js(`(function(){
    var tables = document.querySelectorAll('.vxe-table');
    var mainTable = null;
    for (var i=0;i<tables.length;i++){
      if(tables[i].offsetParent!==null && !tables[i].closest('[role="dialog"]')){mainTable=tables[i];break;}
    }
    if(!mainTable) return JSON.stringify({error:'no table'});
    var bw = mainTable.querySelector('.vxe-table--body-wrapper.body--wrapper');
    if(!bw) return JSON.stringify({error:'no wrapper'});
    var rows = bw.querySelectorAll('.vxe-body--row');
    var skus = [];
    for (var i=0;i<rows.length;i++){
      var cells = rows[i].querySelectorAll('.vxe-body--column');
      var sku = '';
      for (var c=0;c<cells.length;c++){
        var t = (cells[c].textContent||'').trim();
        if(t && /^[A-Z0-9][A-Z0-9]*(?:\\*[0-9]+)?(?:\\+[A-Z0-9][A-Z0-9]*(?:\\*[0-9]+)?)*$/.test(t)
           && /[A-Z]/.test(t) && /[0-9]/.test(t)){ sku=t; break; }
      }
      skus.push(sku);
    }
    return JSON.stringify({rows: rows.length, skus: skus});
  })()`);
  try { return JSON.parse(res); } catch (e) { return { error: 'parse: ' + e.message }; }
}

// 主列表搜索框：填入 term 并点查询（term='' 即清空）
async function setMainSearch(term) {
  const snap = await snapshotText();
  let ref = null;
  for (const line of snap.split('\n')) {
    if (line.includes('请输入SKU编码/货品名称/条码进行筛选')) {
      const m = line.match(/textbox \[ref=(\d+)/);
      if (m) ref = m[1];
    }
  }
  if (!ref) return false;
  await fillInput('@' + ref, term);
  await wait(0.6);
  await js(`(function(){
    var inp = document.querySelector('input[placeholder="请输入SKU编码/货品名称/条码进行筛选"]');
    if(!inp) return;
    var w = inp.closest('.ant-input-search,.ant-input-group-wrapper');
    if(w){var b=w.querySelector('button');if(b)b.click();}
  })()`);
  await wait(2);
  return true;
}

// 判断某 SKU 此刻是否在主货品表中（精确匹配，用完清空搜索）
async function isPresentInMain(sku) {
  const okSearch = await setMainSearch(sku);
  if (!okSearch) return null; // 无法判断
  const info = await mainTableInfo();
  await setMainSearch('');
  if (info.error) return null;
  return (info.skus || []).indexOf(sku) >= 0;
}

async function pageReady() {
  return await js(`(function(){
    var b = document.querySelectorAll('button');
    for (var i=0;i<b.length;i++){
      if(b[i].textContent.trim()==='添加货品'&&b[i].offsetParent!==null) return 'ready';
    }
    return 'not_ready';
  })()`);
}

// 强制整页加载编辑页：先建立 D3 上下文，再进编辑页，最后 reload 保证加载的是已持久化规则
async function loadEditPageFresh() {
  let url = await js(`window.location.href`);
  if (!url.includes('d3.diansan.com')) {
    await js(`window.location.href = 'https://d3.diansan.com/'`);
    await wait(5);
  }
  await js(`window.location.href = '${EDIT_URL}'`);
  await wait(6);
  // 关键：强制 reload，丢弃任何脏/空表单状态，拉取服务端已保存的完整规则
  await js(`location.reload()`);
  await wait(7);
  for (let i = 0; i < 3; i++) {
    if ((await pageReady()) === 'ready') return true;
    await wait(3);
  }
  return (await pageReady()) === 'ready';
}

// ========== Main ==========
const task = await useOrCreateTaskSpace('d3-audit-policy');

if (!(await loadEditPageFresh())) {
  console.log('RESULTS:' + JSON.stringify({ ...results, errors: ['edit page not loaded after reload'] }));
  process.exit(1);
}

// 基线：刷新后表单里已有的货品（应为服务端已保存规则）
const baseline = await mainTableInfo();
console.log('Baseline after reload: ' + JSON.stringify({ rows: baseline.rows, count: (baseline.skus||[]).filter(Boolean).length }));

// ========== DELETE ==========
for (const sku of delList) {
  try {
    console.log('Deleting: ' + sku);

    const snap1 = await snapshotText();
    let searchRef = null;
    for (const line of snap1.split('\n')) {
      if (line.includes('请输入SKU编码/货品名称/条码进行筛选')) {
        const m = line.match(/textbox \[ref=(\d+)/);
        if (m) searchRef = m[1];
      }
    }
    if (!searchRef) { results.errors.push(sku + ': search box not found'); continue; }

    await fillInput('@' + searchRef, sku);
    await wait(1);
    await js(`(function(){
      var inp = document.querySelector('input[placeholder="请输入SKU编码/货品名称/条码进行筛选"]');
      var w = inp.closest('.ant-input-search,.ant-input-group-wrapper');
      if(w){var b=w.querySelector('button');if(b)b.click();}
    })()`);
    await wait(2);

    const markResult = await js(`(function(){
      var TARGET = '${sku.replace(/'/g, "\\'")}';
      var tables = document.querySelectorAll('.vxe-table');
      var mainTable = null;
      for (var i=0;i<tables.length;i++){
        if(tables[i].offsetParent!==null && !tables[i].closest('[role="dialog"]')){mainTable=tables[i];break;}
      }
      if(!mainTable) return JSON.stringify({error:'no table'});
      var bw = mainTable.querySelector('.vxe-table--body-wrapper.body--wrapper');
      var fw = mainTable.querySelector('.fixed-left--wrapper, .vxe-table--fixed-wrapper');
      if(!bw||!fw) return JSON.stringify({error:'no wrapper'});
      var br = bw.querySelectorAll('.vxe-body--row');
      var fr = fw.querySelectorAll('.vxe-body--row');
      for (var i=0;i<br.length;i++){
        var cells = br[i].querySelectorAll('.vxe-body--column');
        var rowSku = cells[2] ? cells[2].textContent.trim() : '';
        if (rowSku === TARGET) {
          var cell = fr[i].querySelector('.col--checkbox .vxe-cell--checkbox');
          if(cell){ cell.id='del-cb-'+i; cell.querySelector('.vxe-checkbox--icon').id='del-icon-'+i;
            return JSON.stringify({ok:true,idx:i}); }
        }
      }
      for (var i=0;i<br.length;i++){
        if(br[i].textContent.indexOf(TARGET)>=0){
          var cell = fr[i].querySelector('.col--checkbox .vxe-cell--checkbox');
          if(cell){cell.id='del-cb-'+i;return JSON.stringify({ok:true,idx:i,fuzzy:true});}
        }
      }
      return JSON.stringify({error:'row not found',rows:br.length});
    })()`);

    const mark = JSON.parse(markResult);
    if (!mark.ok) { results.errors.push(sku + ': ' + (mark.error||'mark failed')); await setMainSearch(''); continue; }

    await click('#del-cb-' + mark.idx);
    await wait(1);

    const delBtnRef = await findRef('text "批量删除"', 'button');
    if (!delBtnRef) { results.errors.push(sku + ': 批量删除 button not found'); await setMainSearch(''); continue; }
    await click('@' + delBtnRef);
    await wait(2);

    await js(`(function(){
      var w = document.querySelectorAll('.ant-modal-wrap,[role="dialog"]');
      for(var i=0;i<w.length;i++){
        if(w[i].offsetParent!==null && w[i].textContent.indexOf('删除')>=0){
          var b = w[i].querySelectorAll('button.ant-btn-primary');
          for(var j=0;j<b.length;j++){
            var t=b[j].textContent.replace(/\\s/g,'');
            if(t==='确定'||t==='删除'){b[j].click();return;}
          }
        }
      }
    })()`);
    await wait(2);
    await setMainSearch('');
    await wait(1);

    // 回读确认：删除后该 SKU 应已不在表单列表
    const stillThere = await isPresentInMain(sku);
    if (stillThere === true) {
      results.errors.push(sku + ': 删除后仍在列表中（未生效）');
    } else {
      results.deleted.push(sku);
      console.log('  Deleted (pending save): ' + sku);
    }
  } catch (e) {
    results.errors.push(sku + ': ' + e.message);
    console.log('  Error: ' + e.message);
  }
}

// ========== ADD ==========
for (const item of addList) {
  try {
    const sku = item.sku;
    const gtype = item.type || '单品';
    console.log('Adding: ' + sku + ' (' + gtype + ')');

    // 已在规则里则跳过（幂等：不计入 added，不触发无意义保存）
    const already = await isPresentInMain(sku);
    if (already === true) {
      results.skipped.push(sku);
      console.log('  Already in rule, skip (no save needed): ' + sku);
      continue;
    }

    const addRef = await findRef('text "添加货品"', 'button');
    if (!addRef) { results.errors.push(sku + ': 添加货品 button not found'); continue; }
    await click('@' + addRef);
    await wait(2);

    const typeRef = await findRadioRef(gtype);
    if (typeRef) { await click('@' + typeRef); await wait(1); }

    const snapS = await snapshotText();
    let skuInputRef = null;
    for (const line of snapS.split('\n')) {
      if (line.includes('placeholder="货品sku编码/套装编码"')) {
        const m = line.match(/textbox \[ref=(\d+)/);
        if (m) skuInputRef = m[1];
      }
    }
    if (!skuInputRef) { results.errors.push(sku + ': SKU input not found'); continue; }
    await fillInput('@' + skuInputRef, sku);
    await wait(0.5);

    await js(`(function(){
      var d = document.querySelector('[role="dialog"]');
      if(!d) return;
      var b = d.querySelectorAll('button');
      for(var i=0;i<b.length;i++){if(b[i].textContent.replace(/\\s/g,'')==='查询'){b[i].click();return;}}
    })()`);
    await wait(3);

    const rowResult = await js(`(function(){
      var TARGET = '${sku.replace(/'/g, "\\'")}';
      var d = document.querySelector('[role="dialog"]');
      if(!d) return JSON.stringify({error:'no dialog'});
      var t = d.querySelector('.vxe-table');
      if(!t) return JSON.stringify({error:'no table'});
      var bw = t.querySelector('.vxe-table--body-wrapper.body--wrapper');
      var fw = t.querySelector('.fixed-left--wrapper, .vxe-table--fixed-wrapper');
      if(!bw||!fw) return JSON.stringify({error:'no wrapper'});
      var br = bw.querySelectorAll('.vxe-body--row');
      var fr = fw.querySelectorAll('.vxe-body--row');
      for (var i=0;i<br.length;i++){
        var cells = br[i].querySelectorAll('.vxe-body--column');
        var rowSku = '';
        for (var c=0;c<cells.length;c++){
          var txt = cells[c].textContent.trim();
          if(txt.length > 3 && (txt.indexOf('+')>=0 || txt.indexOf('*')>=0 || /^[A-Z0-9]/.test(txt))){
            if(txt.indexOf('套装')<0 && txt.indexOf('单品')<0){ rowSku = txt; break; }
          }
        }
        if (rowSku === TARGET) {
          var cell = fr[i].querySelector('.col--checkbox .vxe-cell--checkbox');
          if(cell){
            cell.id='add-cb-'+i;
            cell.querySelector('.vxe-checkbox--icon').id='add-icon-'+i;
            return JSON.stringify({ok:true,idx:i,text:rowSku});
          }
        }
      }
      var debug = [];
      for (var i=0;i<br.length;i++){
        var cells = br[i].querySelectorAll('.vxe-body--column');
        for (var c=0;c<cells.length;c++){
          var txt = cells[c].textContent.trim();
          if(txt.length>5 && (txt.indexOf('+')>=0||txt.indexOf('*')>=0)){ debug.push(txt.substring(0,80)); break; }
        }
      }
      return JSON.stringify({error:'exact match not found', target: TARGET, rows: debug});
    })()`);

    const row = JSON.parse(rowResult);
    if (!row.ok) {
      results.errors.push(sku + ': ' + (row.error||'row not found') + ' | rows=' + JSON.stringify((row.rows||[]).slice(0,10)));
      await js(`(function(){
        var d=document.querySelector('[role="dialog"]');
        if(d){var b=d.querySelectorAll('button');for(var i=0;i<b.length;i++){if(b[i].textContent.replace(/\\s/g,'')==='取消'){b[i].click();return;}}}
      })()`);
      await wait(1);
      continue;
    }

    await click('#add-cb-' + row.idx);
    await wait(1);

    const checked = await js(`(function(){
      var icon = document.getElementById('add-icon-${row.idx}');
      return icon ? icon.className.indexOf('checked')>=0 : false;
    })()`);
    if (!checked) {
      results.errors.push(sku + ': checkbox did not check');
      await js(`(function(){
        var d=document.querySelector('[role="dialog"]');
        if(d){var b=d.querySelectorAll('button');for(var i=0;i<b.length;i++){if(b[i].textContent.replace(/\\s/g,'')==='取消'){b[i].click();return;}}}
      })()`);
      await wait(1);
      continue;
    }

    await js(`(function(){
      var d=document.querySelector('[role="dialog"]');
      if(!d) return;
      var b=d.querySelectorAll('button.ant-btn-primary');
      for(var i=0;i<b.length;i++){if(b[i].textContent.replace(/\\s/g,'')==='确定'){b[i].click();return;}}
    })()`);
    await wait(3);

    // 回读确认：添加后该 SKU 应已进入表单列表（保存前的待提交状态）
    const present = await isPresentInMain(sku);
    if (present !== true) {
      results.errors.push(sku + ': 添加后未出现在列表中（弹窗确定未生效）');
    } else {
      results.added.push(sku);
      console.log('  Added (pending save): ' + sku);
    }
  } catch (e) {
    results.errors.push(item.sku + ': ' + e.message);
    console.log('  Error: ' + e.message);
  }
}

// ========== SAVE ==========
const needSave = results.added.length > 0 || results.deleted.length > 0;
let saveConfirmed = false;
if (needSave) {
  console.log('Saving policy...');
  const saveRef = await findRef('text "保 存"', 'button');
  if (!saveRef) {
    results.errors.push('save button not found');
  } else {
    await click('@' + saveRef);
    await wait(3);

    const snapC = await snapshotText();
    let enableRef = null;
    let confirmRef = null;
    const cLines = snapC.split('\n');
    for (let i = 0; i < cLines.length; i++) {
      if (cLines[i].includes('保存后立即启用')) {
        for (let j = Math.max(0, i - 8); j <= i; j++) {
          const m = cLines[j].match(/radio \[ref=(\d+)/);
          if (m) enableRef = m[1];
        }
      }
      if (cLines[i].match(/text "确\s*定"/)) {
        for (let j = Math.max(0, i - 3); j <= i + 1; j++) {
          const m = cLines[j].match(/button \[ref=(\d+)/);
          if (m) confirmRef = m[1];
        }
      }
    }
    if (enableRef) { await click('@' + enableRef); await wait(0.5); }
    if (confirmRef) {
      await click('@' + confirmRef);
      await wait(6);
      saveConfirmed = true;
      console.log('Save confirm clicked.');
    } else {
      results.errors.push('save confirm button not found');
    }
  }
}

// ========== 保存后整页 reload 复核（权威校验，杜绝假成功）==========
// 需要确认在规则中的 = 新加的 + 本来就在的(skipped)；需要确认消失的 = 删除的
const wantPresent = results.added.concat(results.skipped);
const wantAbsent = results.deleted;
const verified = { added: [], deleted: [], errors: [] };

if (needSave && !saveConfirmed) {
  // 保存未完成：本次新增/删除都不算成功（skipped 与保存无关，下方仍会复核）
  for (const s of results.added) verified.errors.push(s + ': 保存未完成');
  for (const s of results.deleted) verified.errors.push(s + ': 保存未完成');
}

// 只要有需要确认的货品（新加/删除/本来就在），就 reload 后权威复核
if (wantPresent.length > 0 || wantAbsent.length > 0) {
  console.log(needSave && saveConfirmed
    ? 'Reloading for post-save verification...'
    : 'Reloading to confirm already-in-rule items...');
  await js(`location.reload()`);
  await wait(7);
  for (let i = 0; i < 3; i++) {
    if ((await pageReady()) === 'ready') break;
    await wait(3);
  }

  // 应在规则中的：新加的必须在；skipped(本来就在) 也必须在 → 都计为已拦截
  for (const sku of wantPresent) {
    const isNew = results.added.indexOf(sku) >= 0;
    const present = await isPresentInMain(sku);
    if (present === true) {
      verified.added.push(sku);
    } else if (present === false) {
      verified.errors.push(sku + (isNew ? ': 保存后复核未找到（规则未落库）' : ': 复核未在规则中'));
    }
    // present === null（无法判断）保守不计成功，交下轮
  }
  // 应消失的：删除的必须搜不到
  for (const sku of wantAbsent) {
    const present = await isPresentInMain(sku);
    if (present === false) {
      verified.deleted.push(sku);
    } else if (present === true) {
      verified.errors.push(sku + ': 保存后复核仍存在（删除未落库）');
    }
  }
}

// 合并错误（去重）
const allErrors = Array.from(new Set([...results.errors, ...verified.errors]));
const finalResult = {
  added: verified.added,      // 确认已在拦截规则中的全部 SKU（含本来就在的）
  deleted: verified.deleted,
  skipped: results.skipped,   // 本来就在规则里的（供通知/统计参考）
  errors: allErrors,
};
console.log('RESULTS:' + JSON.stringify(finalResult));
