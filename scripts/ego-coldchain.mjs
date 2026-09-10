// ego-coldchain.mjs — D3 冷链异常单自动处理
// 固定 task space ID: 25 (d3-coldchain-auto)
// 参数通过 /tmp/d3-coldchain-params.json 传入
const fs = require('fs')
const params = JSON.parse(fs.readFileSync('/tmp/d3-coldchain-params.json', 'utf8'))
const { skuList, exceptionReason, skuCount } = params

// 登录/地址配置：参数 → 凭据文件 → 默认；密码不硬编码在仓库
try {
  if (!params.orderPageUrl && params.credFile && fs.existsSync(params.credFile)) {
    Object.assign(params, JSON.parse(fs.readFileSync(params.credFile, 'utf8')))
  }
} catch (_) {}
const TASK_SPACE_NAME = 'd3-coldchain-auto'
const ORDER_PAGE_URL = params.orderPageUrl || 'https://d3.diansan.com/omni/order/order-check/indexFeature/index.html'
const D3_TENANT = params.tenant || 'REPLACE_WITH_YOUR_D3_TENANT'
const D3_USERNAME = params.username || ''
const D3_PASSWORD = params.password || ''

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

  // 打开订单客审页
  await ego.helpers.openOrReuseTab(ORDER_PAGE_URL)
  await sleep(5000)

  // 检查登录
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
  console.log('[OK] 已进入订单客审页')

  // 设置货品信息字段为"货品sku编码"
  console.log('[*] 设置字段为货品sku编码...')
  await pjs(`
    var selects = document.querySelectorAll('.ant-select');
    for (var s of selects) {
      if (s.getAttribute('title') && s.getAttribute('title').includes('货品名称')) { s.click(); break; }
    }
  `)
  await sleep(800)
  await pjs(`
    var items = document.querySelectorAll('li.ant-select-dropdown-menu-item');
    for (var item of items) {
      if (item.textContent.trim() === '货品sku编码') { item.click(); break; }
    }
  `)
  await sleep(500)
  await pjs(`document.body.click()`)
  await sleep(300)

  // 设置匹配方式为"包含任一"
  console.log('[*] 设置匹配方式为包含任一...')
  await pjs(`
    var selects = document.querySelectorAll('.ant-select');
    for (var s of selects) {
      if (s.getAttribute('title') && s.getAttribute('title').includes('全包含')) { s.click(); break; }
    }
  `)
  await sleep(800)
  await pjs(`
    var items = document.querySelectorAll('li.ant-select-dropdown-menu-item');
    for (var item of items) {
      if (item.textContent.trim() === '包含任一') { item.click(); break; }
    }
  `)
  await sleep(500)
  await pjs(`document.body.click()`)
  await sleep(300)

  // 填入 SKU
  console.log('[*] 填入 ' + skuCount + ' 个 SKU...')
  await pjs(`
    var inp = document.querySelector('input[placeholder="货品信息"]');
    if (inp) {
      var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(inp, ${JSON.stringify(skuList)});
      inp.dispatchEvent(new Event('input', {bubbles:true}));
    }
  `)
  await sleep(500)

  // 查询
  console.log('[*] 点击查询...')
  await pjs(`
    var btns = document.querySelectorAll('button.ant-btn-primary');
    for (var b of btns) {
      if (b.textContent.includes('查') && b.textContent.includes('询')) { b.click(); break; }
    }
  `)
  await sleep(5000)

  // 获取结果
  const result = await pjs(`
    var text = document.body.innerText;
    var m = text.match(/共(\\d+)条/);
    return JSON.stringify({ total: m ? parseInt(m[1]) : 0 });
  `)
  const { total } = JSON.parse(result)
  console.log('[*] 查询结果: 共 ' + total + ' 条')

  if (total === 0) {
    console.log('[!] 无待处理订单')
    return
  }

  // 全选
  console.log('[*] 全选订单...')
  await pjs(`
    var st = document.querySelectorAll('.spreadtable')[0];
    if (st && st.__vue__) st.__vue__._onCheckAll();
  `)
  await sleep(1000)

  // 标记异常
  console.log('[*] 点击标记异常...')
  await pjs(`
    var btns = document.querySelectorAll('button');
    for (var b of btns) {
      if (b.textContent.trim() === '标记异常') { b.click(); break; }
    }
  `)
  await sleep(2000)

  // 选择异常原因
  console.log('[*] 选择原因: ' + exceptionReason + '...')
  await pjs(`
    var modals = document.querySelectorAll('.ant-modal-wrap');
    for (var m of modals) {
      if (getComputedStyle(m).display !== 'none') {
        var sel = m.querySelector('.ant-select');
        if (sel) { sel.click(); break; }
      }
    }
  `)
  await sleep(800)
  await pjs(`
    var items = document.querySelectorAll('li.ant-select-dropdown-menu-item');
    for (var item of items) {
      if (item.textContent.trim() === ${JSON.stringify(exceptionReason)}) { item.click(); break; }
    }
  `)
  await sleep(500)

  // 确定
  console.log('[*] 提交...')
  await pjs(`
    var modals = document.querySelectorAll('.ant-modal-wrap');
    for (var m of modals) {
      if (getComputedStyle(m).display !== 'none') {
        var btns = m.querySelectorAll('button.ant-btn-primary');
        for (var b of btns) {
          if (b.textContent.trim() === '确定') { b.click(); break; }
        }
      }
    }
  `)
  await sleep(5000)

  // 验证
  const finalR = await pjs(`
    var text = document.body.innerText;
    var m = text.match(/共(\\d+)条/);
    var modal = document.querySelector('.ant-modal-wrap');
    return JSON.stringify({
      remaining: m ? parseInt(m[1]) : -1,
      modalVisible: modal ? getComputedStyle(modal).display !== 'none' : false
    });
  `)
  const final = JSON.parse(finalR)
  const handled = total - final.remaining

  console.log('')
  console.log('========================================')
  if (!final.modalVisible && final.remaining >= 0) {
    console.log('[OK] 处理完成!')
    console.log('     原查询: ' + total + ' 条')
    console.log('     剩余: ' + final.remaining + ' 条')
    if (handled > 0) console.log('     标记异常: ' + handled + ' 条 (' + exceptionReason + ')')
  } else {
    console.log('[!] 可能未完全成功 modal=' + final.modalVisible + ' remaining=' + final.remaining)
  }
  console.log('========================================')
})().catch(err => {
  console.error('[ERR] ' + err.message)
  process.exit(1)
})