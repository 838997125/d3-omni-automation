// 配置从 shell 写入的凭据/地址 JSON 读取（/tmp/d3-credentials.json）；缺失回退默认值。
const _fs0 = require('fs');
let _cfg = {};
try { if (_fs0.existsSync('/tmp/d3-credentials.json')) _cfg = JSON.parse(_fs0.readFileSync('/tmp/d3-credentials.json', 'utf8')); } catch (_) {}

const TASK_SPACE_NAME = 'd3-shortage-auto'
const ORDER_PAGE_URL = _cfg.orderCheckUrl || 'https://d3.diansan.com/omni/order/order-check/indexFeature/index.html'
const D3_TENANT = _cfg.tenant || '亿民盛世'
const D3_USERNAME = _cfg.username || ''
const D3_PASSWORD = _cfg.password || ''
const LOAD_WAIT = 600

const sleep = (ms) => new Promise(r => setTimeout(r, ms))
async function pjs(code) { return await ego.helpers.js(code) }

;(async () => {
  // 复用固定 space（按名字），被接管则 claim 回来
  let task
  try {
    task = await ego.helpers.useOrCreateTaskSpace(TASK_SPACE_NAME)
  } catch(e) {
    const spaces = await ego.listTaskSpaces()
    const found = spaces.taskSpaces.find(s => s.name === TASK_SPACE_NAME)
    if (found) {
      task = await ego.helpers.claimTaskSpace(found.id)
    } else {
      task = await ego.helpers.useOrCreateTaskSpace(TASK_SPACE_NAME)
    }
  }
  if (task.ownership === 'user') {
    task = await ego.helpers.claimTaskSpace(task.id)
  }
  ego.useTaskSpace(task.id)
  console.log('[*] task space: ' + task.id + ' (' + (task.taskId||TASK_SPACE_NAME) + ')')

  // 打开页面
  await ego.helpers.openOrReuseTab(ORDER_PAGE_URL)
  await sleep(5000)

  // 登录检查
  let url = await pjs('return location.href')
  if (url.includes('/login/')) {
    if (!D3_PASSWORD) {
      throw new Error('需要登录但未配置 D3_PASSWORD：请在 scripts/config.env 填写，或先在该 ego task space 手动登录一次。')
    }
    console.log('[*] 需要登录...')
    await ego.helpers.fillInput('#tenantName', D3_TENANT); await sleep(500)
    await ego.helpers.fillInput('#userName', D3_USERNAME); await sleep(500)
    await ego.helpers.fillInput('#userPass', D3_PASSWORD); await sleep(500)
    await pjs(`document.querySelector('.app-login-form-submit').click()`)
    await sleep(6000)
    const bodyText = await pjs('return document.body.innerText')
    if (bodyText.includes('我知道了')) {
      await pjs(`var bs=document.querySelectorAll('button');for(var b of bs){if(b.textContent.includes('我知道了')){b.click();break;}}`)
      await sleep(5000)
    }
    url = await pjs('return location.href')
    if (url.includes('/login/')) throw new Error('登录失败')
    console.log('[OK] 登录成功')
    await ego.helpers.openOrReuseTab(ORDER_PAGE_URL)
    await sleep(5000)
  }

  url = await pjs('return location.href')
  if (!url.includes('order-check')) {
    await ego.helpers.gotoAndWait(ORDER_PAGE_URL)
    await sleep(4000)
  }

  // 查询并加载第一页（200条/页）
  await pjs(`
    var bs=document.querySelectorAll('button.ant-btn-primary');
    for(var b of bs){if(b.textContent.includes('查')&&b.textContent.includes('询')){b.click();break;}}
  `)
  await sleep(4000)

  // 设置 200 条/页
  await pjs(`
    var st=document.querySelectorAll('.spreadtable')[0];
    if(st&&st.__vue__){
      var os=st.__vue__.$parent;
      os.$data.tableProps.pagination.pageSize=200;
      os.$data.tableProps.pagination.current=1;
      os.query();
    }
  `)
  await sleep(8000)

  // 获取分页信息
  const pageInfo = await pjs(`
    var st=document.querySelectorAll('.spreadtable')[0];
    var os=st.__vue__.$parent;
    var p = os.$data.tableProps.pagination;
    return JSON.stringify({total:p.total, current:p.current, pageSize:p.pageSize});
  `)
  const pi = JSON.parse(pageInfo)
  const totalPages = Math.ceil(pi.total / pi.pageSize)
  console.log('[*] 总共 ' + pi.total + ' 条待审核订单, ' + totalPages + ' 页 (每页' + pi.pageSize + '条)')

  // 跨页收集所有结果
  const allNewShortage = []
  const allArrived = []
  const allAudited = []
  const pendingCodes = []  // 所有仍在待审核队列的订单号（用于闭环判断）

  for (let page = 1; page <= totalPages; page++) {
    if (page > 1) {
      console.log('[*] 翻到第 ' + page + '/' + totalPages + ' 页...')
      await pjs(`
        var st=document.querySelectorAll('.spreadtable')[0];
        var os=st.__vue__.$parent;
        os.$data.tableProps.pagination.current=${page};
        os.query();
      `)
      await sleep(6000)
    }

    const orderCount = await pjs(`
      var st=document.querySelectorAll('.spreadtable')[0];
      var os=st.__vue__.$parent;
      return (os.$data.tableProps.dataSource||[]).length;
    `)
    console.log('[*] 第' + page + '页: ' + orderCount + ' 条订单')

    // 获取本页订单基本信息
    const ordersInfoR = await pjs(`
      var os = document.querySelectorAll('.spreadtable')[0].__vue__.$parent;
      var ds = os.$data.tableProps.dataSource || [];
      var result = ds.map(function(r) {
        var hasTag = false;
        if (r.tags) { for (var t=0;t<r.tags.length;t++){ if(r.tags[t].tagName==='缺货'){hasTag=true;break;} } }
        return {
          id: r.id, code: r.code,
          platform: (r.platform&&r.platform.name)||'',
          shopName: r.storeName||'',
          tagged: hasTag,
          statusName: (r.status&&r.status.name)||'',
          lockAllowOperation: r.lockAllowOperation
        };
      });
      return JSON.stringify(result);
    `)
    const pageOrders = JSON.parse(ordersInfoR)

    // 收集本页所有订单号（含 refOid 拆分），供后续闭环判断
    const collectCodesR = await pjs(`
      var os = document.querySelectorAll('.spreadtable')[0].__vue__.$parent;
      var ds = os.$data.tableProps.dataSource || [];
      var codes = [];
      ds.forEach(function(r){
        if(r.code) codes.push(String(r.code));
        if(r.refOid) String(r.refOid).split(/[,，;；\\s]+/).forEach(function(c){ if(c) codes.push(c); });
      });
      return JSON.stringify(codes);
    `)
    try { pendingCodes.push(...JSON.parse(collectCodesR)); } catch(e) {}

    // 已审核的缺货单
    for (const o of pageOrders) {
      if (o.tagged && o.statusName !== '待审核') {
        allAudited.push({id:o.id, code:o.code})
      }
    }

    // 待扫描：未锁定 + 待审核
    const toScan = pageOrders.filter(o => o.lockAllowOperation !== false && o.statusName === '待审核')

    for (let i = 0; i < toScan.length; i++) {
      const o = toScan[i]
      await pjs(`
        var os=document.querySelectorAll('.spreadtable')[0].__vue__.$parent;
        var ds=os.$data.tableProps.dataSource;
        var row=ds.find(function(r){return r.id===${o.id};});
        if(row){ try{os._onRowClick(row,true);}catch(e){} }
      `)

      // 等待明细加载，并校验归属（防止串单：明细的 oid 必须等于当前订单 id）
      let lines = []
      let matched = false
      for (let attempt = 0; attempt < 6; attempt++) {
        await sleep(attempt === 0 ? LOAD_WAIT : 400)
        const linesR = await pjs(`
          var lt=document.querySelectorAll('.spreadtable')[1].__vue__.$parent;
          var ds=lt.$data.tableProps.dataSource||[];
          return JSON.stringify(ds.map(function(l){
            return {oid:l.oid, orderCode:l.orderCode, sku:l.outerId, title:(l.title||'').substring(0,60), num:l.num, avail:l.availableNum};
          }));
        `)
        let raw = []
        try { raw = JSON.parse(linesR); } catch(e) { raw = []; }
        if (raw.length > 0 && (raw[0].oid === o.id || raw[0].orderCode === o.code)) {
          lines = raw
          matched = true
          break
        }
        // 明细不匹配，可能还是上一订单残留，继续等
      }

      if (!matched) {
        // 明细始终无法确认归属，跳过该单（避免误判），下次周期重试
        continue
      }

      const shortageItems = []
      let allArrivedFlag = lines.length > 0  // 必须有明细数据才可能判到货
      let hasValidStock = false  // 至少有一行有有效库存数据
      const allItems = []
      lines.forEach(l => {
        allItems.push({sku:l.sku, title:(l.title||'').substring(0,40), num:l.num, avail:l.avail})
        if (typeof l.avail === 'number' && typeof l.num === 'number') {
          hasValidStock = true
          if (l.avail < l.num) {
            shortageItems.push({sku:l.sku, title:l.title, avail:l.avail, num:l.num})
            allArrivedFlag = false
          }
        }
      })
      // 没有有效库存数据时不能判到货
      if (!hasValidStock) allArrivedFlag = false

      if (!o.tagged && shortageItems.length > 0) {
        allNewShortage.push({id:o.id, code:o.code, platform:o.platform, shopName:o.shopName, shortage:shortageItems})
      } else if (o.tagged && allArrivedFlag) {
        const mainItems = allItems.filter(l => l.sku && l.sku.indexOf('FF00') !== 0)
        allArrived.push({id:o.id, code:o.code, platform:o.platform, shopName:o.shopName, items:mainItems})
      }
    }

    const scanned = ((page-1) * pi.pageSize + toScan.length)
    console.log('[*] 进度: 第' + page + '页完成, 累计扫描~' + scanned + '/' + pi.total)
  }

  const scan = { newShortage: allNewShortage, arrived: allArrived, audited: allAudited }
  console.log('[*] 全部扫描完成: 新缺货=' + allNewShortage.length + ' 已到货=' + allArrived.length + ' 已审核=' + allAudited.length)

  // 打标（逐页选中缺货订单并打标）
  let taggedCount = 0
  if (scan.newShortage.length > 0) {
    console.log('[*] 对 ' + scan.newShortage.length + ' 个缺货订单逐页打标...')

    // 逐页打标
    for (let page = 1; page <= totalPages; page++) {
      if (page > 1) {
        await pjs(`
          var st=document.querySelectorAll('.spreadtable')[0];
          var os=st.__vue__.$parent;
          os.$data.tableProps.pagination.current=${page};
          os.query();
        `)
        await sleep(6000)
      }

      // 找到本页的缺货订单
      const pageTagged = await pjs(`
        var os=document.querySelectorAll('.spreadtable')[0].__vue__.$parent;
        var ds=os.$data.tableProps.dataSource||[];
        var allIds=${JSON.stringify(scan.newShortage.map(o=>o.id))};
        var rows=ds.filter(function(r){return allIds.indexOf(r.id)>=0;});
        if(rows.length>0){
          var ids=rows.map(function(r){return r.id;});
          os._onSelectRows(ids,rows);
          return JSON.stringify({count:rows.length, ids:ids});
        }
        return JSON.stringify({count:0});
      `)
      const pt = JSON.parse(pageTagged)
      if (pt.count === 0) continue

      taggedCount += pt.count
      console.log('[*] 第' + page + '页: 选中 ' + pt.count + ' 个缺货订单')

      // 等一下让选中状态稳定
      await sleep(1000)
      // 直接点击工具栏的"打 标"按钮打开弹窗
      await pjs(`
        var btns = document.querySelectorAll('button');
        for (var b of btns) {
          if (b.textContent.trim() === '打 标' && b.offsetParent !== null && !b.disabled) {
            b.click();
            break;
          }
        }
      `)
      await sleep(2000)

      // 选第三个 radio（缺货）
      await pjs(`
        var modals=document.querySelectorAll('.ant-modal-wrap');
        for(var m of modals){
          if(getComputedStyle(m).display!=='none'){
            var radios=m.querySelectorAll('.ant-radio-wrapper');
            if(radios.length>=3){radios[2].click();break;}
          }
        }
      `)
      await sleep(500)

      // 点"打 标"
      await pjs(`
        var modals=document.querySelectorAll('.ant-modal-wrap');
        for(var m of modals){
          if(getComputedStyle(m).display!=='none'){
            var btns=m.querySelectorAll('button.ant-btn-primary');
            for(var b of btns){if(b.textContent.trim()==='打 标'){b.click();break;}}
          }
        }
      `)
      await sleep(3000)
      console.log('[*] 第' + page + '页: 打标完成')
    }
    console.log('[OK] 缺货标签已打: ' + taggedCount + ' 单')
  }

  const output = { scan, tagged: taggedCount, pendingCodes: pendingCodes }
  // 固定 space 不 complete，保留给下次运行复用

  // stdout 输出 JSON 结果
  console.log('JSON_RESULT:' + JSON.stringify(output))
})().catch(err => {
  console.error('[ERR] ' + err.message)
  process.exit(1)
})
