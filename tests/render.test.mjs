/**
 * 画板组件的无头渲染测试：把真组件跑起来，点按钮、拖鼠标画矩形，
 * 然后检查它**实际通过 conversation.send 发给模型的那条消息**。
 *
 * 这是单测几何函数覆盖不到的那一层：组件渲染会不会抛错、事件链对不对、
 * 回传的协议载荷是不是模型读得懂的形状。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { loadClientBundle, mount, click, drag, dragPath, findAll, findOne, textOf, byMarker, contains, pressKey } from './harness.mjs'

const LEGEND = [
  { id: 'a', color: '#e5484d', name: '主区', meaning: '可滚动的正文' },
  { id: 'b', color: '#0b7fd4', name: '侧栏', meaning: '导航' },
]

function setup(options) {
  const client = loadClientBundle(options)
  const sent = []
  const conversation = { send: (text) => { sent.push(text); return Promise.resolve() } }
  const registrations = []
  const ctx = {
    slots: {
      inject: (_slot, callback) => { const dispose = callback(); return typeof dispose === 'function' ? dispose : () => {} },
      register: (declaration, Component) => { registrations.push({ declaration, Component }); return () => {} },
    },
    sessions: { scope: () => ({ get: (name) => (name === 'conversation' ? conversation : undefined) }) },
  }
  client.apply(ctx)
  const toolview = registrations.find((entry) => entry.declaration.name === 'tool.call.toolview')
  const overlay = registrations.find((entry) => entry.declaration.name === 'shell.overlay')
  assert.ok(toolview !== undefined, 'tool.call.toolview 必须注册')
  assert.ok(overlay !== undefined, 'shell.overlay 必须注册')
  return {
    client,
    Component: toolview.Component,
    Overlay: overlay.Component,
    declaration: toolview.declaration,
    sent,
    React: client.__harness.reactStub.React,
  }
}

function mountOverlay(env) {
  return mount(env.client.__harness.reactStub, env.React.createElement(env.Overlay, {}))
}

function mountBoard(env, args, callId, sessionId) {
  const element = env.React.createElement(env.Component, {
    callId,
    sessionId: sessionId || 'sess-1',
    block: { argsRaw: typeof args === 'string' ? args : JSON.stringify(args) },
  })
  return mount(env.client.__harness.reactStub, element)
}

function payloadOf(message) {
  assert.ok(message.startsWith('[partition-board] '), '消息必须带协议前缀')
  return JSON.parse(message.slice('[partition-board] '.length))
}

function approx(actual, expected, tolerance) {
  assert.ok(Math.abs(actual - expected) <= (tolerance === undefined ? 1e-6 : tolerance),
    `期望 ${expected}±${tolerance}, 实际 ${actual}`)
}

/* ───────────────────────── 渲染结构 ───────────────────────── */

test('draw 模式：画板渲染出来，色卡与工具都在', () => {
  const env = setup()
  const board = mountBoard(env, {
    mode: 'draw',
    purpose: 'ui-layout',
    task: '首页分区',
    ask: '先把主区和侧栏涂出来',
    canvas: { aspect: '16:9', guide: '顶栏+左导航+主区' },
    legend: LEGEND,
  }, 'call-1')

  const text = textOf(board.tree)
  assert.ok(text.includes('分区画板'), '标题要有画板标识')
  assert.ok(text.includes('首页分区'), '标题要显示 task')
  assert.ok(text.includes('先把主区和侧栏涂出来'), '要显示给用户的指令')
  assert.equal(env.declaration.key, 'partition_board')

  const canvas = findOne(board.tree, (node) => node.type === 'canvas')
  assert.equal(canvas.dom.clientWidth, 800)
  assert.ok(canvas.dom.drawCalls.length > 0, '挂载后应当真的画过一次（effect 里的 paintCanvas）')

  const colorInputs = findAll(board.tree, (node) => node.type === 'input' && node.props.type === 'color')
  assert.equal(colorInputs.length, 2, '每个色卡一个取色器')
  const main = findAll(board.tree, (node) => node.type === 'input' && node.props.value === '主区')
  assert.equal(main.length, 1)
  const meaning = findAll(board.tree, (node) => node.type === 'input' && node.props.value === '可滚动的正文')
  assert.equal(meaning.length, 1, '含义输入框要回填 legend.meaning')

  assert.ok(textOf(board.tree).includes('覆盖率 0%'), '初始覆盖率是 0%')
})

test('参数还在流式生成时显示占位，不抛错', () => {
  const env = setup()
  const board = mountBoard(env, '{"mode":"draw","legend":[{"id":"a"', 'call-x')
  assert.ok(textOf(board.tree).includes('正在起草画板'))
})

/* ───────────────────────── 交互 → 协议 ───────────────────────── */

test('拖出一个矩形 → 请 AI 规划 → 回传合法的 plan-request', async () => {
  const env = setup()
  const board = mountBoard(env, {
    mode: 'draw',
    purpose: 'ui-layout',
    task: '首页分区',
    legend: LEGEND,
  }, 'call-2')

  // 画布 800×450；从 (80,45) 拖到 (320,180) → 归一化 rect [0.1, 0.1, 0.3, 0.3]
  drag(board, [80, 45], [320, 180])

  assert.ok(textOf(board.tree).includes('分区 1'), '拖完应当多出一块分区')
  assert.ok(/覆盖率 [1-9]\d?%/.test(textOf(board.tree)), '拖完覆盖率应不再为 0')

  click(board, '让 AI 规划')
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(env.sent.length, 1, '应当只发一条消息')
  const payload = payloadOf(env.sent[0])
  assert.equal(payload.kind, 'plan-request')
  assert.equal(payload.boardId, 'call-2', '首轮没有 boardId 时用 callId')
  assert.equal(payload.revision, 1)
  assert.equal(payload.purpose, 'ui-layout')
  assert.equal(payload.legend.length, 2)
  assert.equal(payload.legend[0].name, '主区')
  assert.equal(payload.regions.length, 1)
  assert.equal(payload.regions[0].kind, 'rect')
  assert.equal(payload.regions[0].colorId, 'a')
  approx(payload.regions[0].rect[0], 0.1, 1e-3)
  approx(payload.regions[0].rect[1], 0.1, 1e-3)
  approx(payload.regions[0].rect[2], 0.3, 1e-3)
  approx(payload.regions[0].rect[3], 0.3, 1e-3)
  assert.equal(payload.grid.cols, 32)
  assert.equal(payload.grid.rows, 18, '16:9 画布在 32 列下应是 18 行')
  assert.equal(payload.grid.cells.length, 32 * 18)
  assert.ok(payload.stats.coverage > 0 && payload.stats.coverage < 1)
})

test('套索画多边形 → 载荷里是压过的折线点', async () => {
  const env = setup()
  const board = mountBoard(env, { mode: 'draw', purpose: 'image-compose', legend: LEGEND }, 'call-3')

  click(board, '套索')
  // 套索要 ≥3 点才有面积；直线拖出来的退化多边形会被正确地丢掉。
  dragPath(board, [[80, 45], [400, 60], [360, 300], [100, 280], [80, 45]])

  assert.ok(textOf(board.tree).includes('分区 1'))
  click(board, '让 AI 规划')
  await new Promise((resolve) => setImmediate(resolve))

  const payload = payloadOf(env.sent[0])
  assert.equal(payload.regions[0].kind, 'poly')
  assert.ok(payload.regions[0].points.length >= 3, '多边形至少 3 个点')
  for (const point of payload.regions[0].points) {
    assert.ok(point[0] >= 0 && point[0] <= 1 && point[1] >= 0 && point[1] <= 1, '坐标必须归一化')
  }
})

test('退化几何被丢掉：直线拖出的套索不该产出零面积分区', () => {
  const env = setup()
  const board = mountBoard(env, { mode: 'draw', purpose: 'other', legend: LEGEND }, 'call-3b')
  click(board, '套索')
  drag(board, [80, 45], [400, 300])
  assert.ok(!textOf(board.tree).includes('分区 1'), '两点直线无面积，不应提交')
})

test('review 模式：AI 方案叠加，确认后回传 plan', async () => {
  const env = setup()
  const board = mountBoard(env, {
    mode: 'review',
    revision: 2,
    boardId: 'call-4',
    purpose: 'ui-layout',
    task: '首页分区',
    legend: LEGEND,
    regions: [
      { id: 'ai1', colorId: 'b', kind: 'rect', rect: [0.5, 0, 0.5, 1], softness: 0.3, note: '补侧栏' },
    ],
  }, 'call-4')

  const text = textOf(board.tree)
  assert.ok(text.includes('AI 方案 1 块'), '要显示 AI 方案面板')
  assert.ok(text.includes('补侧栏'), '要显示模型写的 note')

  click(board, '确认最终规划')
  await new Promise((resolve) => setImmediate(resolve))
  board.rerender() // send() 的 .then 里才改状态，要等微任务落地后再渲染一次

  const payload = payloadOf(env.sent[0])
  assert.equal(payload.kind, 'confirmed')
  assert.equal(payload.boardId, 'call-4')
  assert.equal(payload.plan.regions.length, 1, '确认时 AI 方案并入最终规划')
  assert.equal(payload.plan.regions[0].source, 'ai')
  assert.equal(payload.plan.legend.length, 2)
  assert.equal(typeof payload.plan.confirmedAt, 'string')
  assert.equal(payload.grid, undefined, '确认后不再重复发网格')

  assert.ok(textOf(board.tree).includes('已确认'), '画板要进入已确认状态')
})

test('返工：附上意见再回传', async () => {
  const env = setup()
  const board = mountBoard(env, {
    mode: 'review', revision: 2, boardId: 'call-5', purpose: 'ui-layout', legend: LEGEND,
    regions: [{ id: 'ai1', colorId: 'b', kind: 'rect', rect: [0.5, 0, 0.5, 1], softness: 0.3 }],
  }, 'call-5')

  const textarea = findOne(board.tree, (node) => node.type === 'textarea')
  textarea.props.onChange({ target: { value: '侧栏太宽了' } })
  board.rerender()

  click(board, '返工重规划')
  await new Promise((resolve) => setImmediate(resolve))

  const payload = payloadOf(env.sent[0])
  assert.equal(payload.kind, 'rework')
  assert.equal(payload.feedback, '侧栏太宽了')
})

test('改色卡名字会进载荷（AI 靠 legend 解读分区）', async () => {
  const env = setup()
  const board = mountBoard(env, { mode: 'draw', purpose: 'doc-structure', legend: LEGEND }, 'call-6')

  const nameInput = findOne(board.tree, (node) => node.type === 'input' && node.props.value === '主区')
  nameInput.props.onChange({ target: { value: '第一章' } })
  board.rerender()

  click(board, '请 AI 复核')
  await new Promise((resolve) => setImmediate(resolve))
  const payload = payloadOf(env.sent[0])
  assert.equal(payload.legend[0].name, '第一章')
  assert.equal(payload.legend[0].meaning, '可滚动的正文', '改名字不该动含义')
})

/* ───────────────────────── 边画边写 ───────────────────────── */

test('边画边写：文字说明随消息一起回传', async () => {
  const env = setup()
  const board = mountBoard(env, { mode: 'draw', purpose: 'ui-layout', legend: LEGEND }, 'call-note')

  // 先画一块，说明才有指代对象
  drag(board, [80, 45], [320, 180])

  const textarea = findOne(byMarker(board.tree, 'note'), (node) => node.type === 'textarea')
  textarea.props.onChange({ target: { value: '左栏是筛选条件，主区要能并排看两张卡' } })
  board.rerender()

  click(board, '让 AI 规划')
  await new Promise((resolve) => setImmediate(resolve))

  const payload = payloadOf(env.sent[0])
  assert.equal(payload.kind, 'plan-request')
  assert.equal(payload.note, '左栏是筛选条件，主区要能并排看两张卡')
  assert.equal(payload.feedback, undefined, 'note 是「我画的是什么」，不是「对方案的意见」')
})

test('边画边写：确认最终规划时同样带上说明；没写字就不塞空 note', async () => {
  const env = setup()
  const board = mountBoard(env, { mode: 'draw', purpose: 'ui-layout', legend: LEGEND }, 'call-note2')
  drag(board, [80, 45], [320, 180])

  click(board, '就这样，确认')
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(payloadOf(env.sent[0]).note, undefined, '空 note 不该出现在载荷里')
})

test('边画边写：有 AI 方案时让位给「返工意见」，不出现两个文字框', () => {
  const env = setup()
  const board = mountBoard(env, {
    mode: 'review', revision: 2, boardId: 'call-note3', purpose: 'ui-layout', legend: LEGEND,
    regions: [{ id: 'ai1', colorId: 'b', kind: 'rect', rect: [0.5, 0, 0.5, 1], softness: 0.3 }],
  }, 'call-note3')

  assert.equal(findAll(board.tree, (node) => node.props !== undefined && node.props['data-dpb'] === 'note').length, 0,
    '有方案时不该再显示边画边写框')
  assert.equal(findAll(board.tree, (node) => node.type === 'textarea').length, 1, '只留返工意见那一个文字框')
})

/* ───────────────────────── 尺寸变化后重绘 ───────────────────────── */

test('画布尺寸变化后重画（否则笔迹按旧尺寸被拉伸变形）', () => {
  const env = setup()
  const board = mountBoard(env, { mode: 'draw', purpose: 'ui-layout', legend: LEGEND }, 'call-resize')

  const observers = env.client.__harness.resizeObservers
  assert.ok(observers.length > 0, '要挂 ResizeObserver 才谈得上跟随尺寸')
  const observer = observers[observers.length - 1]
  assert.ok(observer.targets.length > 0, '必须真的 observe 了画布')
  assert.equal(observer.targets[0].tag, 'canvas', '观察的是画布本身')

  const before = findOne(board.tree, (node) => node.type === 'canvas').dom.drawCalls.length
  const canvasDom = findOne(board.tree, (node) => node.type === 'canvas').dom
  canvasDom.clientWidth = 1200   // 模拟分栏被拉宽
  canvasDom.clientHeight = 675

  assert.equal(observer.trigger(), true, '回调应当被触发')
  board.rerender()

  const after = findOne(board.tree, (node) => node.type === 'canvas').dom.drawCalls.length
  assert.ok(after > before, '尺寸变化后应当真的重画一次')
})

/* ───────────────────────── 缩放 / 平移 ───────────────────────── */

function zoomBar(board) { return byMarker(board.tree, 'zoom') }

function zoomPercent(board) {
  const match = /(\d+)%/.exec(textOf(zoomBar(board)))
  assert.ok(match !== null, '缩放读数应当是 N% 的形式')
  return Number(match[1])
}

function pressZoom(board, label) {
  const button = findOne(zoomBar(board), (node) => node.type === 'button' && textOf(node) === label)
  button.props.onClick({ currentTarget: button.dom })
  board.rerender()
}

/** 画布最近一次「世界 → 屏幕」矩阵（末尾那次是还回的像素变换）。 */
function worldTransform(board) {
  const calls = findOne(board.tree, (node) => node.type === 'canvas').dom.drawCalls
    .filter((call) => call[0] === 'setTransform')
  return calls[calls.length - 2]
}

test('缩放：只有 Ctrl/⌘ + 滚轮才动画板，普通滚轮留给页面滚动', () => {
  const env = setup()
  const board = mountBoard(env, { mode: 'draw', purpose: 'ui-layout', legend: LEGEND }, 'call-zoom')
  // 测试台每轮渲染都新建 DOM 桩，原生监听留在最早那轮的桩上 —— 按监听找桩，别按树找
  const canvas = env.client.__harness.canvasStubs.find((dom) => dom.listenerCount('wheel') > 0)
  assert.ok(canvas !== undefined,
    '滚轮监听要挂在画布上：React 的 onWheel 是 passive 的，preventDefault 拦不住浏览器整页缩放')
  assert.equal(zoomPercent(board), 100)

  let plain = false
  canvas.dispatchDom('wheel', {
    ctrlKey: false, metaKey: false, deltaY: 120, deltaMode: 0,
    clientX: 400, clientY: 225, preventDefault() { plain = true },
  })
  assert.equal(plain, false, '普通滚轮不能被吃掉，否则对话就滚不动了')
  board.rerender()
  assert.equal(zoomPercent(board), 100)

  let prevented = false
  canvas.dispatchDom('wheel', {
    ctrlKey: true, deltaY: -100, deltaMode: 0,
    clientX: 400, clientY: 225, preventDefault() { prevented = true },
  })
  assert.equal(prevented, true, '要拦掉浏览器整页缩放')
  board.rerender()
  assert.equal(zoomPercent(board), Math.round(Math.exp(0.15) * 100), '100 → 116（指数映射，鼠标一格 ~100）')
})

test('放大后落笔位置仍跟屏幕一致：世界 = 中心 + (屏幕 - 0.5) / 缩放', async () => {
  const env = setup()
  const board = mountBoard(env, { mode: 'draw', purpose: 'ui-layout', legend: LEGEND }, 'call-zoomin')
  pressZoom(board, '+')   // ×1.4，锚点在正中 → 中心不动
  assert.equal(zoomPercent(board), 140)

  drag(board, [80, 45], [320, 180])
  click(board, '让 AI 规划')
  await new Promise((resolve) => setImmediate(resolve))

  const rect = payloadOf(env.sent[0]).regions[0].rect
  approx(rect[0], 0.5 - 0.4 / 1.4, 1e-3)
  approx(rect[1], 0.5 - 0.4 / 1.4, 1e-3)
  approx(rect[2], 0.3 / 1.4, 1e-3)
  approx(rect[3], 0.3 / 1.4, 1e-3)
})

test('抓手平移：只挪视图不改缩放，0 键复位回 100%', () => {
  const env = setup()
  const board = mountBoard(env, { mode: 'draw', purpose: 'ui-layout', legend: LEGEND }, 'call-pan')
  pressZoom(board, '+')
  pressZoom(board, '+')   // ×1.96
  const before = worldTransform(board)
  assert.ok(before[1] > 2, '缩放系数要进到画布矩阵里（2 = devicePixelRatio）')

  click(board, '抓手')
  drag(board, [400, 225], [200, 225])   // 往左拖 25% 屏宽
  const after = worldTransform(board)
  assert.equal(after[1], before[1], '平移不该改缩放')
  assert.notDeepEqual(after.slice(5), before.slice(5), '平移要反映到矩阵的平移量上')

  const reset = pressKey(env, '0')
  assert.equal(reset.handled, 1, '0 复位应当被这块画板处理')
  assert.equal(reset.prevented, true)
  board.rerender()
  assert.equal(zoomPercent(board), 100)
})

test('画布的右键菜单被接管（画到一半弹菜单会打断绘制）', () => {
  const env = setup()
  const board = mountBoard(env, { mode: 'draw', purpose: 'ui-layout', legend: LEGEND }, 'call-ctx')
  const canvas = findOne(board.tree, (node) => node.type === 'canvas')
  let prevented = false
  canvas.props.onContextMenu({ preventDefault() { prevented = true } })
  assert.equal(prevented, true)
})

/* ───────────────────────── 成品级细节 ───────────────────────── */

test('存盘节流：连着改多次只落一次盘（橡皮拖一下不该写几十次）', async () => {
  const env = setup()
  const board = mountBoard(env, { mode: 'draw', purpose: 'ui-layout', legend: LEGEND }, 'call-save')
  const nameInput = findOne(board.tree, (node) => node.type === 'input' && node.props.value === '主区')
  const before = env.client.__harness.storeWrites

  for (const name of ['第一章', '第二章', '第三章']) {
    nameInput.props.onChange({ target: { value: name } })
    board.rerender()
  }
  // 没有节流的话这里已经是 3 次以上（挂载本身也会排一次）
  assert.ok(env.client.__harness.storeWrites - before <= 1, '不该每次改 state 都写盘')

  await new Promise((resolve) => setTimeout(resolve, 460))
  assert.equal(env.client.__harness.storeWrites - before, 1, '节流到期后合并成一次落盘')
  assert.ok(env.client.__harness.store.has('dsh.partitionBoard.v1:sess-1:call-save'), '最终要真的写进去')
})

test('空画布给上手引导，画出第一块就收起来', () => {
  const env = setup()
  const board = mountBoard(env, { mode: 'draw', purpose: 'ui-layout', legend: LEGEND }, 'call-hint')
  assert.ok(textOf(byMarker(board.tree, 'hint')).includes('让 AI'), '第一眼要告诉人怎么做')

  drag(board, [80, 45], [320, 180])
  assert.equal(findAll(board.tree, (n) => n.props !== undefined && n.props['data-dpb'] === 'hint').length, 0,
    '画出东西后不再占地方')
})

test('分区超过上限时状态条明说「多出来的不会回传」', () => {
  const env = setup()
  const regions = []
  for (let index = 0; index < 205; index += 1) {
    regions.push({ id: 'r' + index, colorId: 'a', kind: 'rect', rect: [0, 0, 0.02, 0.02], softness: 0.1, source: 'user' })
  }
  env.client.__harness.store.set('dsh.partitionBoard.v1:sess-1:call-ovf', JSON.stringify({
    legend: LEGEND, regions, proposals: [], aiLegendRev: 1, aiProposalRev: 0,
    confirmedAt: null, lastSentRevision: 0, rejected: [],
  }))

  const board = mountBoard(env, { mode: 'draw', purpose: 'ui-layout', legend: LEGEND }, 'call-ovf')
  const status = textOf(byMarker(board.tree, 'status'))
  assert.ok(status.includes('分区 205'), '先如实报数量：' + status)
  assert.ok(status.includes('200') && status.includes('5'), '还要说出上限与超出的块数：' + status)
})

test('进全屏把焦点搬进画布（键盘用户不用从页头 Tab 过去）', () => {
  const env = setup()
  const board = mountBoard(env, { mode: 'draw', purpose: 'ui-layout', legend: LEGEND }, 'call-fs-focus')
  const overlay = mountOverlay(env)
  assert.equal(env.client.__harness.canvasStubs.some((dom) => dom.focused), false, '开局没人在画布上')

  click(board, '全屏')
  overlay.rerender()
  assert.ok(env.client.__harness.canvasStubs.some((dom) => dom.focused), '全屏层的画布应当拿到焦点')
})

/* ───────────────────────── 降低「第一次调用」的门槛 ───────────────────────── */

/** 取色器的数量 = 色卡条数（色卡是画板的语义底座，也是上手门槛）。 */
const swatchCount = (board) => findAll(board.tree, (n) => n.type === 'input' && n.props.type === 'color').length

test('模型只给 task+ask 也能用：自动摆好待命颜色，画完就能发', async () => {
  const env = setup()
  const board = mountBoard(env, { purpose: 'ui-layout', task: '首页版式', ask: '先把顶栏、主区、侧栏涂出来' }, 'call-seed')
  assert.equal(swatchCount(board), 4, '没给 legend 也要有能直接画的颜色，否则第一次调用就废了')
  assert.ok(textOf(board.tree).includes('首页版式'))

  drag(board, [80, 45], [320, 180])
  assert.ok(textOf(board.tree).includes('分区 1'), '用待命颜色画得出来')

  click(board, '让 AI 规划')
  await new Promise((resolve) => setImmediate(resolve))
  const payload = payloadOf(env.sent[0])
  assert.equal(payload.legend.length, 4, '待命颜色也会作为色卡回传（模型下一轮能改名）')
  assert.equal(payload.regions.length, 1)
  assert.equal(payload.regions[0].colorId, 'c1')
})

test('模型下一轮给了真色卡：待命颜色让位，不叠加两套', () => {
  const env = setup()
  // 上一轮没给 legend，画板存下了 4 个待命颜色
  env.client.__harness.store.set('dsh.partitionBoard.v1:sess-1:call-seed2', JSON.stringify({
    legend: [1, 2, 3, 4].map((n) => ({ id: 'c' + n, color: '#e5484d', name: '新分区' + n, meaning: '', seeded: true })),
    regions: [], proposals: [], aiLegendRev: 0, aiProposalRev: 0,
    confirmedAt: null, lastSentRevision: 0, rejected: [],
  }))

  const board = mountBoard(env, {
    mode: 'review', revision: 2, boardId: 'call-seed2', purpose: 'ui-layout', legend: LEGEND,
    regions: [{ id: 'ai1', colorId: 'a', kind: 'rect', rect: [0, 0, 0.5, 1], softness: 0.2 }],
  }, 'call-seed2-r2')

  assert.equal(swatchCount(board), LEGEND.length, '只剩模型给的色卡')
  assert.equal(findAll(board.tree, (n) => typeof n.props.value === 'string' && n.props.value.startsWith('新分区')).length, 0,
    '待命颜色不该留在界面上')
})

/* ───────────────────────── 无障碍 / 语言 ───────────────────────── */

test('无障碍：画布有角色与说明，状态条会被播报，工具按钮标出是否选中', () => {
  const env = setup()
  const board = mountBoard(env, { mode: 'draw', purpose: 'ui-layout', legend: LEGEND }, 'call-a11y')
  const canvas = findOne(board.tree, (node) => node.type === 'canvas')

  assert.equal(canvas.props.role, 'application', '画布是交互面，不能按死图片')
  assert.equal(canvas.props.tabIndex, 0, '键盘要能 Tab 进来')
  assert.ok(canvas.props['aria-label'].includes('2 色色卡'), '读屏读不到像素，得有一句话说明现状')

  const status = byMarker(board.tree, 'status')
  assert.equal(status.props.role, 'status')
  assert.equal(status.props['aria-live'], 'polite', '覆盖率/提示的变化要播报')
  assert.equal(status.props.id, canvas.props['aria-describedby'], 'aria-describedby 必须真的指到状态条')

  const pressed = findAll(board.tree, (n) => n.type === 'button' && n.props['aria-pressed'] === true)
  assert.equal(pressed.length >= 1, true, '至少要有一个工具被标成选中')
  click(board, '选择')
  assert.equal(findOne(board.tree, (n) => n.type === 'button' && textOf(n) === '选择').props['aria-pressed'], true, '当前工具要说出来')
  assert.equal(findOne(board.tree, (n) => n.type === 'button' && textOf(n) === '矩形').props['aria-pressed'], false, '换工具后旧的就不该还说选中')

  // 图标按钮（× / + / −）读屏只会念符号，必须补 aria-label
  for (const label of ['×', '−', '+']) {
    const hits = findAll(board.tree, (n) => n.type === 'button' && textOf(n) === label)
    assert.ok(hits.length > 0, `应当有「${label}」按钮`)
    for (const hit of hits) {
      assert.equal(typeof hit.props['aria-label'], 'string', `「${label}」按钮缺 aria-label`)
      assert.ok(hit.props['aria-label'].length > 1)
    }
  }
})

test('无障碍：同一页多块画板的 id 不能撞（aria-describedby 会指错）', () => {
  const env = setup()
  const first = mountBoard(env, { mode: 'draw', revision: 1, boardId: 'a11y-a', purpose: 'ui-layout', legend: LEGEND }, 'call-id1')
  const second = mountBoard(env, { mode: 'draw', revision: 1, boardId: 'a11y-b', purpose: 'ui-layout', legend: LEGEND }, 'call-id2')
  const idOf = (board) => findOne(board.tree, (n) => n.type === 'canvas').props['aria-describedby']
  assert.notEqual(idOf(first), idOf(second))
  assert.equal(idOf(first), byMarker(first.tree, 'status').props.id)
})

test('文案跟浏览器语言走：<html lang="en"> 出英文，认不出来就中文', () => {
  const zh = setup()
  const zhBoard = mountBoard(zh, { mode: 'draw', purpose: 'ui-layout', legend: LEGEND }, 'call-lang-zh')
  assert.ok(textOf(zhBoard.tree).includes('分区画板'))
  assert.ok(textOf(zhBoard.tree).includes('覆盖率 0%'))
  assert.ok(textOf(byMarker(zhBoard.tree, 'action-dock')).includes('让 AI 草拟一版'))

  // navigator.language 兜底：宿主页面没写 lang 时用它
  const nav = setup({ navLang: 'en-US' })
  const navBoard = mountBoard(nav, { mode: 'draw', purpose: 'ui-layout', legend: LEGEND }, 'call-lang-nav')
  assert.ok(textOf(navBoard.tree).includes('Partition board'))
  assert.ok(textOf(navBoard.tree).includes('Coverage 0%'))

  // <html lang> 优先于 navigator.language
  const en = setup({ lang: 'en', navLang: 'zh-CN' })
  const enBoard = mountBoard(en, { mode: 'draw', purpose: 'ui-layout', legend: LEGEND }, 'call-lang-en')
  const text = textOf(enBoard.tree)
  assert.ok(text.includes('Partition board'))
  assert.ok(text.includes('Let the AI draft a plan'))
  assert.ok(text.includes('Rect') && text.includes('Lasso') && text.includes('Pan'), '工具名要跟着翻译')
  assert.ok(!text.includes('分区'), '英文界面里不该漏出中文')

  // 有语言信号但不是中文 → 英文（国际兜底）
  const junk = setup({ lang: 'xx-YY' })
  const junkBoard = mountBoard(junk, { mode: 'draw', purpose: 'ui-layout', legend: LEGEND }, 'call-lang-xx')
  assert.ok(textOf(junkBoard.tree).includes('Partition board'))

  // 完全没有语言信号（宿主没写 lang、navigator 也没有）→ 中文，这块画板的老家
  const silent = setup()
  const silentBoard = mountBoard(silent, { mode: 'draw', purpose: 'ui-layout', legend: LEGEND }, 'call-lang-none')
  assert.ok(textOf(silentBoard.tree).includes('分区画板'), '认不出来就用中文')
})

/* ───────────────────────── 多轮折叠 ───────────────────────── */

test('同一 boardId 的旧轮次自动折叠', () => {
  const env = setup()
  const first = mountBoard(env, {
    mode: 'draw', revision: 1, boardId: 'shared', purpose: 'ui-layout', task: '第一轮', legend: LEGEND,
  }, 'call-a')
  assert.ok(textOf(first.tree).includes('你来做主'), '第 1 轮是活的')

  const second = mountBoard(env, {
    mode: 'review', revision: 2, boardId: 'shared', purpose: 'ui-layout', task: '第二轮', legend: LEGEND,
    regions: [{ id: 'ai1', colorId: 'a', kind: 'rect', rect: [0, 0, 1, 1], softness: 0.2 }],
  }, 'call-b')

  // 第 2 轮挂载后，第 1 轮应当收到通知并折叠
  first.rerender()
  assert.ok(textOf(first.tree).includes('已被第 2 轮取代'), '旧轮次应折叠成一行摘要')
  assert.ok(textOf(second.tree).includes('审阅 AI 方案'), '新一轮是活的')
})

/* ───────────────────────── 已确认版式的回归守卫 ───────────────────────── */

/**
 * 版式来自 2026-09-29 用户亲手画并确认的那块画板（boardId call_00_…Ji1737）：
 *   r3 状态条 = 内容顶部通栏；r2 控制栏 = 右列上半 + 便签（边画边写）+ r4 动作区；
 *   r1 画布 = 左列。这里把「哪块在哪」钉住，免得以后改样式时把版式改回去。
 */
test('确认版式：状态条在内容顶部通栏、动作区钉在控制栏底部', () => {
  const env = setup()
  const board = mountBoard(env, {
    mode: 'draw', purpose: 'ui-layout', task: '版式回归', legend: LEGEND,
  }, 'call-layout')
  const tree = board.tree

  const boardNode = byMarker(tree, 'board')
  const marked = boardNode.children.filter((node) => node.props !== undefined && node.props['data-dpb'] !== undefined)
  const order = marked.map((node) => node.props['data-dpb'])
  assert.deepEqual(order, ['header', 'status', 'body'], '状态条必须在 header 之后、body 之前（顶部通栏）')

  const status = byMarker(tree, 'status')
  assert.ok(textOf(status).includes('覆盖率 0%'), '状态条要显示覆盖率')
  assert.ok(textOf(status).includes('分区 0'), '状态条要显示分区数')
  assert.equal(contains(byMarker(tree, 'canvas-wrap'), (n) => n.props && n.props['data-dpb'] === 'status'), false,
    '状态条不能还留在画布那一列里')

  const panel = byMarker(tree, 'panel')
  assert.deepEqual(
    panel.children.filter((n) => n.props && n.props['data-dpb'] !== undefined).map((n) => n.props['data-dpb']),
    ['panel-scroll', 'note', 'action-dock'],
    '控制栏 = 上半可滚 + 边画边写 + 底部动作区',
  )

  const scroll = byMarker(tree, 'panel-scroll')
  const dock = byMarker(tree, 'action-dock')
  assert.equal(contains(scroll, (n) => n.props && n.props['data-dpb'] === 'action-dock'), false,
    '动作区不能在滚动容器内部')
  assert.ok(contains(dock, (n) => n.type === 'button' && textOf(n).includes('AI')), '动作区要放 AI 相关按钮')
  assert.ok(contains(scroll, (n) => n.type === 'input' && n.props.type === 'color'), '色卡留在可滚动的上半区')
})

test('已确认后动作区消失（不给无效按钮）', async () => {
  const env = setup()
  const board = mountBoard(env, {
    mode: 'review', revision: 2, boardId: 'call-locked', purpose: 'ui-layout', legend: LEGEND,
    regions: [{ id: 'ai1', colorId: 'a', kind: 'rect', rect: [0, 0, 1, 1], softness: 0.2 }],
  }, 'call-locked')

  click(board, '确认最终规划')
  await new Promise((resolve) => setImmediate(resolve))
  board.rerender()

  const marked = byMarker(board.tree, 'panel').children
    .filter((node) => node.props !== undefined && node.props['data-dpb'] !== undefined)
    .map((node) => node.props['data-dpb'])
  assert.deepEqual(marked, ['panel-scroll'], '锁定后只剩上半区，动作区不渲染')
  assert.ok(textOf(byMarker(board.tree, 'status')).includes('覆盖率 100%'))
})

test('「仍要打开这一轮」不该把最新一轮挤下去', () => {
  const env = setup()
  const first = mountBoard(env, {
    mode: 'draw', revision: 1, boardId: 'reopen', purpose: 'ui-layout', task: '旧板', legend: LEGEND,
  }, 'call-r1')
  const second = mountBoard(env, {
    mode: 'review', revision: 2, boardId: 'reopen', purpose: 'ui-layout', task: '新板', legend: LEGEND,
    regions: [{ id: 'ai1', colorId: 'a', kind: 'rect', rect: [0, 0, 1, 1], softness: 0.2 }],
  }, 'call-r2')

  first.rerender()
  assert.ok(textOf(first.tree).includes('已被第 2 轮取代'), '开局：旧板折叠')
  assert.ok(textOf(second.tree).includes('审阅 AI 方案'), '开局：新板是活的')

  click(first, '仍要打开这一轮')
  first.rerender()
  second.rerender()

  assert.ok(textOf(first.tree).includes('你来做主'), '点开后旧板应当可以看')
  assert.ok(textOf(second.tree).includes('审阅 AI 方案'), '最新一轮不能被挤下去')
})

/* ───────────────────────── 全屏层（shell.overlay） ───────────────────────── */

test('全屏把画板搬到 shell.overlay：不再依赖 position:fixed 赌祖先没有 transform', () => {
  const env = setup()
  const board = mountBoard(env, { mode: 'draw', purpose: 'ui-layout', task: '全屏', legend: LEGEND }, 'call-fs')
  const overlay = mountOverlay(env)

  assert.equal(overlay.tree, null, '没展开时全局层不渲染任何东西')

  click(board, '全屏')
  assert.ok(textOf(board.tree).includes('已全屏显示'), '工具行换成一行占位')
  assert.equal(contains(board.tree, (node) => node.type === 'canvas'), false,
    '工具行里不该再有画布（否则两个实例各持一份 state）')

  overlay.rerender()
  const backdrop = byMarker(overlay.tree, 'overlay')
  assert.equal(backdrop.props.style.position, 'fixed', '位置由 root 上的背景层负责')
  assert.ok(contains(backdrop, (node) => node.type === 'canvas'), '全屏层里有画布')
  assert.ok(textOf(backdrop).includes('退出全屏'))

  click(board, '退出全屏')
  overlay.rerender()
  assert.equal(overlay.tree, null, '退出后全局层清空')
  assert.ok(contains(board.tree, (node) => node.type === 'canvas'), '画布回到工具行')
})

test('Esc 退出全屏；内嵌时 Esc 只取消选中', () => {
  const env = setup()
  const board = mountBoard(env, { mode: 'draw', purpose: 'ui-layout', legend: LEGEND }, 'call-esc')
  const overlay = mountOverlay(env)

  click(board, '全屏')
  overlay.rerender()
  assert.ok(contains(overlay.tree, (node) => node.type === 'canvas'))

  const escape = pressKey(env, 'Escape')
  assert.ok(escape.handled >= 1, 'Esc 至少要被全屏层处理（本测试台不做卸载清理，计数只当下界用）')

  overlay.rerender()
  board.rerender()
  assert.equal(overlay.tree, null, 'Esc 关掉全屏')
  assert.ok(contains(board.tree, (node) => node.type === 'canvas'), '画布回到工具行')
})

/* ───────────────────────── 键盘 ───────────────────────── */

test('键盘：Ctrl+Z 撤销、Ctrl+Shift+Z 重做、Delete 删掉选中的分区', () => {
  const env = setup()
  const board = mountBoard(env, { mode: 'draw', purpose: 'ui-layout', legend: LEGEND }, 'call-key')
  drag(board, [80, 45], [320, 180])
  assert.ok(textOf(board.tree).includes('分区 1'))

  const undoKey = pressKey(env, 'z', { ctrlKey: true })
  assert.equal(undoKey.handled, 1, '焦点在这块画板上，撤销键应当被处理')
  assert.equal(undoKey.prevented, true, '要拦掉浏览器的默认行为')
  board.rerender()
  assert.ok(textOf(board.tree).includes('分区 0'), 'Ctrl+Z 撤销掉刚画的那块')

  pressKey(env, 'z', { ctrlKey: true, shiftKey: true })
  board.rerender()
  assert.ok(textOf(board.tree).includes('分区 1'), 'Ctrl+Shift+Z 重做回来')

  // 选择工具 + 点中矩形中心，再按 Delete
  click(board, '选择')
  const canvas = findOne(board.tree, (node) => node.type === 'canvas')
  canvas.props.onPointerDown({
    clientX: 200, clientY: 113, pointerId: 1,
    currentTarget: canvas.dom, target: canvas.dom,
    preventDefault() {}, stopPropagation() {},
  })
  board.rerender()
  assert.ok(textOf(board.tree).includes('选中分区'), '点中后应出现选中面板')

  const del = pressKey(env, 'Delete')
  assert.equal(del.handled, 1)
  board.rerender()
  assert.ok(textOf(board.tree).includes('分区 0'), 'Delete 删掉选中分区')
})

test('焦点归属：没有焦点的画板不抢键盘', () => {
  const env = setup()
  const older = mountBoard(env, { mode: 'draw', revision: 1, boardId: 'focus', purpose: 'ui-layout', legend: LEGEND }, 'call-f1')
  const newer = mountBoard(env, { mode: 'draw', revision: 2, boardId: 'focus', purpose: 'ui-layout', legend: LEGEND }, 'call-f2')

  drag(newer, [80, 45], [320, 180])
  assert.ok(textOf(newer.tree).includes('分区 1'))

  // 真 React 里 newer 挂载改焦点 → older 的订阅立刻触发重渲染 → 它的 effect 清理掉监听。
  // 这个测试台要我手动重渲染一次才能复现同一时序。
  older.rerender()
  const escape = pressKey(env, 'Escape')
  assert.equal(escape.handled, 1, '只有拿到焦点的那块挂监听')

  drag(newer, [80, 45], [320, 180])
  assert.ok(textOf(newer.tree).includes('分区 2'), '键盘没被旧板吃掉')
  assert.ok(textOf(older.tree).includes('已被第 2 轮取代'), '旧板仍是折叠的')
})

test('在输入框里打字不触发画板快捷键', () => {
  const env = setup()
  const board = mountBoard(env, { mode: 'draw', purpose: 'ui-layout', legend: LEGEND }, 'call-type')
  drag(board, [80, 45], [320, 180])

  const inInput = pressKey(env, 'z', { ctrlKey: true, target: { tagName: 'INPUT' } })
  assert.equal(inInput.handled, 1, '监听挂着')
  assert.equal(inInput.prevented, false, '但在输入框里不该拦默认行为')
  board.rerender()
  assert.ok(textOf(board.tree).includes('分区 1'), '分区没被撤销')
})

/* ───────────────────────── 逐条否决 AI 方案 ───────────────────────── */

test('AI 方案可逐条否决，且否掉的不会在下一轮回来', () => {
  const env = setup()
  const proposals = [
    { id: 'ai1', colorId: 'a', kind: 'rect', rect: [0, 0, 1, 1], softness: 0.2 },
    { id: 'ai2', colorId: 'b', kind: 'rect', rect: [0.5, 0, 0.5, 1], softness: 0.2 },
  ]
  const board = mountBoard(env, {
    mode: 'review', revision: 2, boardId: 'call-rej', purpose: 'ui-layout', legend: LEGEND, regions: proposals,
  }, 'call-rej')
  assert.ok(textOf(board.tree).includes('AI 方案 2 块'))

  const panel = byMarker(board.tree, 'proposals')
  const crosses = findAll(panel, (node) => node.type === 'button' && textOf(node) === '×')
  assert.equal(crosses.length, 2, '每条方案一个否决按钮')
  crosses[0].props.onClick({ currentTarget: crosses[0].dom })
  board.rerender()
  assert.ok(textOf(board.tree).includes('AI 方案 1 块'), '否掉一条后只剩一条')

  // 模型下一轮又把两条一起发回来 —— 被否掉的那条不该复活
  const next = mountBoard(env, {
    mode: 'review', revision: 3, boardId: 'call-rej', purpose: 'ui-layout', legend: LEGEND, regions: proposals,
  }, 'call-rej-r3')
  assert.ok(textOf(next.tree).includes('AI 方案 1 块'), '否掉的方案下一轮不再出现')
  assert.ok(!textOf(byMarker(next.tree, 'proposals')).includes('· 主区'), '复活的是被否掉的那条')
})

test('宿主没声明 shell.overlay 时不提供全屏入口（否则点了画板会消失）', () => {
  const client = loadClientBundle()
  const registrations = []
  client.apply({
    slots: {
      // 只让 tool.call.toolview 的注册回调跑；shell.overlay 的注入回调永远不被调用，
      // 模拟「这个组合没声明那个槽」。
      inject: (slot, callback) => {
        if (slot === 'tool.call.toolview') { const dispose = callback(); return typeof dispose === 'function' ? dispose : () => {} }
        return () => {}
      },
      register: (declaration, Component) => { registrations.push({ declaration, Component }); return () => {} },
    },
    sessions: { scope: () => undefined },
  })
  const Component = registrations[0].Component
  const board = mount(client.__harness.reactStub, client.__harness.reactStub.React.createElement(
    Component,
    { callId: 'c', sessionId: 's', block: { argsRaw: JSON.stringify({ mode: 'draw', legend: LEGEND }) } },
  ))

  assert.ok(contains(board.tree, (node) => node.type === 'canvas'), '画板照常渲染')
  assert.equal(findAll(board.tree, (node) => node.type === 'button' && textOf(node).includes('全屏')).length, 0,
    '不该出现一个点了会把自己弄没的按钮')
})

/* ───────────────────────── 会话通道缺失时的降级 ───────────────────────── */

test('会话通道未就绪时给提示而不是崩', async () => {
  const client = loadClientBundle()
  const registered = []
  client.apply({
    slots: {
      inject: (_slot, callback) => callback(),
      register: (declaration, Component) => { registered.push({ declaration, Component }); return () => {} },
    },
    sessions: { scope: () => undefined },
  })
  const board = mount(client.__harness.reactStub, client.__harness.reactStub.React.createElement(
    registered[0].Component,
    { callId: 'c', sessionId: 's', block: { argsRaw: JSON.stringify({ mode: 'draw', legend: LEGEND }) } },
  ))
  click(board, '请 AI 复核')
  await new Promise((resolve) => setImmediate(resolve))
  assert.ok(textOf(board.tree).includes('会话通道未就绪'))
})
