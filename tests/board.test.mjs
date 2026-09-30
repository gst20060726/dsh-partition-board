/**
 * 纯函数自测：直接加载浏览器 bundle，在 vm 里用桩 window 抓到 factory，
 * 把 `__test` 导出的几何 / 栅格 / 协议函数跑一遍。
 * 不测 React 渲染（那要真浏览器），只测「算得对不对」。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

import {
  TOOL_NAME, SKILL_NAME, normalizeLegend, normalizeRegion, compileParameterSpec, apply,
} from '../lib/index.js'

/* ───────────────────────── 载入浏览器 bundle ───────────────────────── */

const ReactStub = {
  createElement: () => null,
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useRef: () => ({ current: null }),
  useEffect: () => {},
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
}

function loadClient() {
  const source = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
  const registered = []
  const sandbox = {
    window: { __ModuleLoader__: { load: (record) => registered.push(record) } },
    console,
  }
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox)
  assert.equal(registered.length, 1, 'bundle 应当只注册一次 factory')
  assert.equal(registered[0].id, 'dsh-partition-board', 'factory id 必须等于包名')
  const exports_ = registered[0].factory((name) => {
    if (name === 'react') return ReactStub
    throw new Error('未声明的外部模块: ' + name)
  })
  assert.equal(exports_.inject.join(','), 'slots,sessions')
  assert.equal(typeof exports_.apply, 'function')
  return exports_
}

const client = loadClient()
const T = client.__test
/** vm realm 里的数组跟宿主 realm 的 Array 不同源，比较前先落地成同源结构。 */
const json = (value) => JSON.parse(JSON.stringify(value))
const LEGEND = [
  { id: 'a', color: '#e5484d', name: '主区', meaning: '正文' },
  { id: 'b', color: '#0b7fd4', name: '侧栏', meaning: '导航' },
]

/* ───────────────────────── 参数解析 ───────────────────────── */

test('parseBoardArgs：空 / 半截 JSON 都不算就绪', () => {
  assert.equal(T.parseBoardArgs('').ok, false)
  assert.equal(T.parseBoardArgs('{"mode":"dra').ok, false)
  assert.equal(T.parseBoardArgs('[]').ok, false)
})

test('parseBoardArgs：补默认值', () => {
  const parsed = T.parseBoardArgs('{"mode":"review","legend":[{"id":"a","color":"#e5484d","name":"主区"}]}')
  assert.equal(parsed.ok, true)
  assert.equal(parsed.args.mode, 'review')
  assert.equal(parsed.args.revision, 1)
  assert.equal(parsed.args.purpose, 'other')
  assert.equal(parsed.args.aspect, '16:9')
  assert.equal(parsed.args.legend.length, 1)
})

test('parseBoardArgs：revision 非正数回落到 1', () => {
  assert.equal(T.parseBoardArgs('{"revision":0}').args.revision, 1)
  assert.equal(T.parseBoardArgs('{"revision":7}').args.revision, 7)
})

test('aspectRatio：认得 W:H，认不出回 16:9', () => {
  assert.equal(Math.round(T.aspectRatio('16:9') * 100) / 100, 1.78)
  assert.equal(T.aspectRatio('4:3'), 4 / 3)
  assert.equal(T.aspectRatio('1:1'), 1)
  assert.equal(T.aspectRatio('乱写'), 16 / 9)
})

/* ───────────────────────── 几何 ───────────────────────── */

test('normalizeHex：三位展开、非法返回 null', () => {
  assert.equal(T.normalizeHex('#AbC'), '#aabbcc')
  assert.equal(T.normalizeHex(' #E5484D '), '#e5484d')
  assert.equal(T.normalizeHex('red'), null)
  assert.equal(T.normalizeHex('#12345'), null)
})

test('thinPoints：按最小间距抽稀并保留末点', () => {
  const points = [[0, 0], [0.1, 0], [0.2, 0], [0.3, 0], [0.4, 0]]
  assert.deepEqual(json(T.thinPoints(points, 0.15)), [[0, 0], [0.2, 0], [0.4, 0]])
})

test('rdp：共线点压成两端', () => {
  const points = [[0, 0], [0.1, 0], [0.2, 0], [0.3, 0], [0.4, 0]]
  assert.deepEqual(json(T.rdp(points, 0.003)), [[0, 0], [0.4, 0]])
})

test('rdp：拐点必须保住', () => {
  const points = [[0, 0], [0.5, 0], [0.5, 0.5]]
  assert.equal(T.rdp(points, 0.003).length, 3)
})

test('pointInPoly / pointInStroke', () => {
  const square = [[0, 0], [1, 0], [1, 1], [0, 1]]
  assert.equal(T.pointInPoly(square, 0.5, 0.5), true)
  assert.equal(T.pointInPoly(square, 1.5, 0.5), false)
  const line = [[0, 0.5], [1, 0.5]]
  assert.equal(T.pointInStroke(line, 0.1, 0.5, 0.53), true)
  assert.equal(T.pointInStroke(line, 0.1, 0.5, 0.9), false)
})

test('hitTest：上层压住下层', () => {
  const regions = [
    { id: 'under', kind: 'rect', colorId: 'a', rect: [0, 0, 1, 1] },
    { id: 'over', kind: 'rect', colorId: 'b', rect: [0.4, 0.4, 0.2, 0.2] },
  ]
  assert.equal(T.hitTest(regions, 0.5, 0.5), 'over')
  assert.equal(T.hitTest(regions, 0.1, 0.1), 'under')
  assert.equal(T.hitTest([], 0.5, 0.5), null)
})

test('regionAreaPct：矩形与多边形', () => {
  assert.equal(T.regionAreaPct({ kind: 'rect', rect: [0, 0, 0.5, 0.4] }), 0.2)
  const triangle = { kind: 'poly', points: [[0, 0], [1, 0], [0, 1]] }
  assert.equal(Math.round(T.regionAreaPct(triangle) * 100) / 100, 0.5)
})

/* ───────────────────────── 栅格与体检 ───────────────────────── */

test('rasterize + gridToString：左半矩形覆盖左列', () => {
  const grid = T.rasterize([{ id: 'r1', kind: 'rect', colorId: 'a', rect: [0, 0, 0.5, 1] }], LEGEND, 2, 2)
  assert.deepEqual(json(grid.cells), [1, 0, 1, 0], '行优先：左列被 a 盖住，右列未标注')
  assert.equal(T.gridToString(grid.cells), '1010')
})

test('connectedComponents：未标注散块各自成域', () => {
  // 3x1：中间一格未标注
  const grid = { cols: 3, rows: 1, cells: [1, 0, 1] }
  const components = T.connectedComponents(grid, (cell) => cell === 0)
  assert.equal(components.length, 1)
  assert.equal(components[0].size, 1)
  // 两端各有未标注，隔开 → 两块
  const split = T.connectedComponents({ cols: 4, rows: 1, cells: [0, 1, 1, 0] }, (cell) => cell === 0)
  assert.equal(split.length, 2)
})

test('analyzeBoard：覆盖率与未标注区块', () => {
  const stats = T.analyzeBoard([{ id: 'r1', kind: 'rect', colorId: 'a', rect: [0, 0, 0.5, 1] }], LEGEND, 2, 2, 0.015)
  assert.equal(stats.coverage, 0.5)
  assert.equal(stats.unlabeled.length, 1)
  assert.equal(stats.unlabeled[0].area, 0.5)
  assert.equal(stats.unlabeled[0].w, 0.5)
})

test('analyzeBoard：满覆盖才没有未标注', () => {
  const stats = T.analyzeBoard([{ id: 'r1', kind: 'rect', colorId: 'a', rect: [0, 0, 1, 1] }], LEGEND, 4, 4, 0.015)
  assert.equal(stats.coverage, 1)
  assert.equal(stats.unlabeled.length, 0)
  assert.equal(stats.grid.cells.every((cell) => cell === 1), true)
})

test('analyzeBoard：细小分区被挑出来', () => {
  const regions = [
    { id: 'big', kind: 'rect', colorId: 'a', rect: [0, 0, 1, 1] },
    { id: 'bit', kind: 'rect', colorId: 'b', rect: [0.9, 0.9, 0.1, 0.1] },
  ]
  const stats = T.analyzeBoard(regions, LEGEND, 8, 8, 0.05)
  assert.equal(stats.tiny.length, 1)
  assert.equal(stats.tiny[0].colorId, 'b')
  assert.equal(stats.small.length, 1)
  assert.equal(stats.small[0].id, 'bit')
})

/* ───────────────────────── 协议载荷 ───────────────────────── */

function payloadFor(kind) {
  const regions = [{ id: 'r1', kind: 'rect', colorId: 'a', rect: [0, 0, 0.5, 1], softness: 0.2, source: 'user' }]
  const proposals = [{
    id: 'ai1', kind: 'rect', colorId: 'b', rect: [0.5, 0, 0.5, 1], softness: 0.4, source: 'ai', note: '补侧栏',
  }]
  const state = { legend: LEGEND, regions, proposals }
  const stats = T.analyzeBoard(regions.concat(proposals), LEGEND, 8, 8, 0.02)
  return T.buildPayload(kind, {
    boardId: 'board-1',
    args: { revision: 3, purpose: 'ui-layout', task: '首页分区', aspect: '16:9', targets: ['u1'] },
    state,
    stats,
    feedback: kind === 'rework' ? '侧栏太宽' : '',
  })
}

test('buildPayload：plan-request 带网格与统计', () => {
  const payload = payloadFor('plan-request')
  assert.equal(payload.kind, 'plan-request')
  assert.equal(payload.boardId, 'board-1')
  assert.equal(payload.revision, 3)
  assert.equal(payload.legend.length, 2)
  assert.equal(payload.regions.length, 2)
  assert.equal(payload.regions[1].source, 'ai')
  assert.equal(typeof payload.grid.cells, 'string')
  assert.equal(payload.grid.cells.length, 64)
  assert.deepEqual(json(payload.targets), ['u1'])
  assert.equal(payload.stats.coverage, 1)
})

test('buildPayload：rework 带意见', () => {
  assert.equal(payloadFor('rework').feedback, '侧栏太宽')
})

test('buildPayload：confirmed 只留最终规划', () => {
  const payload = payloadFor('confirmed')
  assert.equal(payload.kind, 'confirmed')
  assert.equal(payload.plan.legend.length, 2)
  assert.equal(payload.plan.regions.length, 2)
  assert.equal(typeof payload.plan.confirmedAt, 'string')
  assert.equal(payload.grid, undefined, '确认后不再重复发送网格')
  assert.equal(payload.stats, undefined)
})

test('几何在载荷里被压到 3 位小数且点数量有上限', () => {
  const points = []
  for (let index = 0; index <= 400; index += 1) points.push([index / 400, Math.sin(index / 10) * 0.1 + 0.5])
  const state = {
    legend: LEGEND,
    regions: [{ id: 'r1', kind: 'stroke', colorId: 'a', points, softness: 0.5, width: 0.06, source: 'user' }],
    proposals: [],
  }
  const stats = T.analyzeBoard(state.regions, LEGEND, 8, 8, 0.02)
  const payload = T.buildPayload('plan-request', {
    boardId: 'b', args: { revision: 1, purpose: 'other', aspect: '16:9' }, state, stats,
  })
  const region = payload.regions[0]
  assert.equal(region.width, 0.06)
  assert.ok(region.points.length <= 81, `点数应被压到 80 附近，实际 ${region.points.length}`)
  for (const point of region.points) {
    assert.ok(Number.isInteger(Math.round(point[0] * 1000)), '坐标应被压到 3 位小数')
  }
})

test('载荷有硬预算：分区再多也不会把一条消息撑爆', () => {
  const regions = []
  for (let index = 0; index < 60; index += 1) {
    const points = []
    for (let step = 0; step < 300; step += 1) {
      points.push([(index / 60) + 0.0015 * step, 0.5 + Math.sin(step / 7) * 0.05])
    }
    regions.push({ id: 'r' + index, kind: 'poly', colorId: 'a', points, softness: 0.2, source: 'user' })
  }
  const stats = T.analyzeBoard(regions, LEGEND, 32, 18, 0.015)
  const payload = T.buildPayload('plan-request', {
    boardId: 'big',
    args: { revision: 1, purpose: 'other', aspect: '16:9' },
    state: { legend: LEGEND, regions, proposals: [] },
    stats,
  })
  const text = '[partition-board] ' + JSON.stringify(payload)

  let totalPoints = 0
  for (const region of payload.regions) totalPoints += (region.points ?? []).length
  assert.ok(totalPoints <= 600, `总点数必须封顶 600，实际 ${totalPoints}`)
  assert.ok(text.length <= 20000, `一条消息必须 ≤20000 字符，实际 ${text.length}`)
  assert.equal(payload.regions.length, 60, '预算只能压点数，不能丢分区')
})

test('分区少的时候不浪费预算：单分区点数上限生效', () => {
  const points = []
  for (let step = 0; step < 500; step += 1) points.push([0.001 * step, 0.5 + Math.cos(step / 9) * 0.1])
  const regions = [{ id: 'r1', kind: 'poly', colorId: 'a', points, softness: 0.2, source: 'user' }]
  const stats = T.analyzeBoard(regions, LEGEND, 32, 18, 0.015)
  const payload = T.buildPayload('plan-request', {
    boardId: 'one',
    args: { revision: 1, purpose: 'other', aspect: '16:9' },
    state: { legend: LEGEND, regions, proposals: [] },
    stats,
  })
  assert.ok(payload.regions[0].points.length <= 80, '单分区点数上限 80')
  assert.ok(payload.regions[0].points.length >= 20, '单分区不该被压到失真')
})

/* ───────────────────────── 真实回传夹具：协议自洽性 ───────────────────────── */

/**
 * 这是 2026-09-29 用户亲手画并确认的那块画板的原样捕获（boardId call_00_…Ji1737）。
 * 拿它做回归的价值在于：**用矢量分区重跑一遍栅格器，看能不能复现画板自己发出来的矩阵**。
 * 两边对不上就说明「线格式」与「渲染/统计」已经漂移，而单看任何一边都发现不了。
 */
test('真实回传：矢量分区重跑栅格器必须复现画板发出的矩阵', () => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/board-confirmed-2026-09-29.json', import.meta.url), 'utf8'))
  assert.equal(fixture.kind, 'confirmed')
  const plan = fixture.plan

  assert.equal(plan.grid.cols, 32)
  assert.equal(plan.grid.rows, 18)
  assert.equal(plan.grid.cells.length, 576, '行优先矩阵：32×18')

  const replayed = T.rasterize(plan.regions, plan.legend, plan.grid.cols, plan.grid.rows)
  assert.equal(T.gridToString(replayed.cells), plan.grid.cells,
    '重放出来的矩阵必须与画板发出的一致（栅格器与线格式没漂移）')

  // 每色格数：解码脚本报过的数字，冻在这里当回归基线
  const counts = {}
  for (const cell of plan.grid.cells) counts[cell] = (counts[cell] ?? 0) + 1
  assert.equal(counts['0'], 251, '未标注 251 格（四周页边距）')
  assert.equal(counts['1'], 216, '画布 216 格')
  assert.equal(counts['2'], 63, '控制栏 63 格')
  assert.equal(counts['3'], 21, '动作区 21 格')
  assert.equal(counts['4'], 25, '状态条 25 格')

  // z 序：控制栏(r2) 与 动作区(r4) 在矢量上重叠，栅格取最上层 → 动作区赢
  const panel = plan.regions.find((region) => region.id === 'r2')
  const action = plan.regions.find((region) => region.id === 'r4')
  const overlapY = (action.rect[1] + action.rect[3] / 2) / 1
  assert.ok(overlapY > panel.rect[1] && overlapY < panel.rect[1] + panel.rect[3], '两块确实重叠')
  const topMost = T.hitTest([panel, action], action.rect[0] + 0.02, overlapY)
  assert.equal(topMost, 'r4', '重叠处应判给后画的动作区')

  // 状态条通栏：横跨画布列与控制栏列
  const status = plan.regions.find((region) => region.id === 'r3')
  assert.ok(status.rect[0] + status.rect[2] > panel.rect[0] + panel.rect[2] - 1e-9,
    '状态条要盖住右列，才叫通栏')
})

test('storeKey / 消息前缀 / 常量', () => {
  assert.equal(T.storeKey('s1', 'b1'), 'dsh.partitionBoard.v1:s1:b1')
  assert.equal(T.MSG_PREFIX, '[partition-board]')
  assert.equal(T.GRID_COLS, 32)
  assert.equal(T.PALETTE.length >= 8, true)
})

/* ───────────────────────── Host 半边 ───────────────────────── */

test('工具名与 skill 名对得上客户端注册的 key', () => {
  assert.equal(TOOL_NAME, 'partition_board')
  assert.equal(SKILL_NAME, 'partition-board')
})

test('normalizeLegend：补 id / 颜色回落 / 重复 id 改写成新 id', () => {
  const { legend, warnings } = normalizeLegend([
    { color: '#E5484D', name: '主区' },
    { id: 'dup', color: 'not-a-color', name: '侧栏' },
    { id: 'dup', color: '#0b7fd4', name: '重复 id' },
  ])
  // 重复 id 不丢色卡，改写成一个新 id（丢掉反而会让用户少一个可用颜色）
  assert.equal(legend.length, 3)
  assert.equal(new Set(legend.map((entry) => entry.id)).size, 3, 'id 必须唯一')
  assert.equal(legend[0].id, 'c1')
  assert.equal(legend[0].color, '#e5484d')
  assert.equal(legend[1].id, 'dup')
  assert.equal(legend[1].color, T.PALETTE[1], '非法颜色回落到调色板')
  assert.notEqual(legend[2].id, 'dup')
  assert.ok(warnings.length >= 1)
})

test('normalizeRegion：裁掉退化几何', () => {
  assert.equal(normalizeRegion({ kind: 'rect', rect: [0, 0, 0, 0] }, new Set(), 0), null)
  assert.equal(normalizeRegion({ kind: 'poly', points: [[0, 0]] }, new Set(), 0), null)
  const region = normalizeRegion(
    { kind: 'rect', rect: [0.1, 0.2, 0.5, 0.5], softness: 2, colorId: 'a' },
    new Set(['a']),
    0,
  )
  assert.deepEqual(region.rect, [0.1, 0.2, 0.5, 0.5])
  assert.equal(region.softness, 1, 'softness 被夹到 0..1')
  assert.equal(region.colorId, 'a')
})

test('normalizeRegion：色卡外的 colorId 被清掉', () => {
  const region = normalizeRegion({ kind: 'rect', rect: [0, 0, 0.5, 0.5], colorId: '不存在' }, new Set(['a']), 0)
  assert.equal(region.colorId, '')
})

test('compileParameterSpec：根是封闭对象', () => {
  const schema = compileParameterSpec({ task: { type: 'string', required: true } })
  assert.equal(schema.type, 'object')
  assert.equal(schema.additionalProperties, false)
  assert.deepEqual(schema.required, ['task'])
  assert.equal(schema.properties.task.type, 'string')
})

/* ───────────────────── 视图（缩放 / 平移）的夹取 ───────────────────── */

/* ───────────────────── 撤销栈与载荷上限 ───────────────────── */

test('pushHistory：撤销栈封顶，只丢最旧的', () => {
  let past = []
  for (let index = 0; index < T.HISTORY_LIMIT + 7; index += 1) past = T.pushHistory(past, ['r' + index])
  assert.equal(past.length, T.HISTORY_LIMIT, '栈长必须封在 HISTORY_LIMIT')
  assert.equal(past[past.length - 1][0], 'r' + (T.HISTORY_LIMIT + 6), '最新一格在最上面')
  assert.equal(past[0][0], 'r7', '丢的是最旧的')
  assert.equal(T.pushHistory([], ['x']).length, 1)
})

test('载荷里分区最多 200 块（界面会就超出的部分警告）', () => {
  const regions = []
  for (let index = 0; index < T.MAX_REGIONS + 25; index += 1) {
    regions.push({ id: 'r' + index, colorId: 'a', kind: 'rect', rect: [0, 0, 0.02, 0.02], softness: 0.1, source: 'user' })
  }
  const payload = T.buildPayload('plan-request', {
    args: { aspect: '16:9', purpose: 'other', revision: 1, targets: [], canvas: {}, legend: LEGEND, regionCountBySource: {} },
    state: { legend: LEGEND, regions, proposals: [] },
    stats: {
      grid: { cols: T.GRID_COLS, rows: 18, cells: new Array(T.GRID_COLS * 18).fill(0) },
      coverage: 0.1, unlabeled: [], tiny: [], small: [],
    },
    boardId: 'ovf',
  })
  assert.equal(payload.regions.length, T.MAX_REGIONS, '超过上限的分区不入载荷')
  assert.equal(T.MAX_REGIONS, 200)
})

test('clampView：只放大不缩小，视口永远留在画布里', () => {
  // 1 倍：中心被钉死在 0.5，拖不出空白
  assert.deepEqual(json(T.clampView({ zoom: 1, cx: 0.9, cy: 0.1 })), { zoom: 1, cx: 0.5, cy: 0.5 })
  assert.equal(T.ZOOM_MIN, 1)
  assert.equal(T.ZOOM_MAX, 8)

  // 小于 1 会被抬回 1（画布本来就刚好放下，缩小没有意义）
  assert.equal(T.clampView({ zoom: 0.2, cx: 0.5, cy: 0.5 }).zoom, 1)
  // 大于上限会被压回上限
  assert.equal(T.clampView({ zoom: 99, cx: 0.5, cy: 0.5 }).zoom, 8)

  // 4 倍：中心活动范围收窄到 [0.125, 0.875]
  const wide = T.clampView({ zoom: 4, cx: 2, cy: -2 })
  assert.equal(wide.cx, 0.875)
  assert.equal(wide.cy, 0.125)
  assert.equal(T.clampView({ zoom: 4, cx: 0.4, cy: 0.6 }).cx, 0.4, '范围内的值原样保留')

  // 脏数据兜底
  assert.deepEqual(json(T.clampView(null)), { zoom: 1, cx: 0.5, cy: 0.5 })
  assert.deepEqual(json(T.clampView({ zoom: Number.NaN, cx: undefined, cy: 'x' })), { zoom: 1, cx: 0.5, cy: 0.5 })
})

/* ───────────────────── 工具合同（描述 + 参数校验） ───────────────────── */

/** 抓住 apply() 注册进来的工具：host 半边的 execute() 只有从这里拿得到。 */
function captureTool() {
  const registered = []
  apply({ tools: { register: (tool) => registered.push(tool) }, skills: { register: () => {} } })
  assert.equal(registered.length, 1, 'apply() 应当注册一个工具')
  return registered[0]
}

test('工具描述要「钩得住」模型：可识别的触发 + 反例 + 成本承诺 + 有界长度', () => {
  const tool = captureTool()
  assert.equal(tool.name, TOOL_NAME)
  const text = tool.description

  // 这些短语就是「模型会不会想到用它」的全部依据：
  // 光写「适用于先划片再干活的场合」没用 —— 模型得能在具体时刻对上号。
  const must = [
    '说不清',                  // 最强触发：写文字说不清
    '画个图给我看',             // 用户真会这么说，原话最容易命中
    '我说不上来哪儿不对',        // 同上：模糊抱怨也要能命中
    '写几行就能说清',           // 反后门条款（见下）
    '宁可多调一次',             // 偏向调用，而不是偏向省事
    'purpose="other"',         // 不属于既有分类时的落点
    'ask_user_question',       // 反例：别拿它当是非题工具
    '不阻塞',                  // 成本承诺：调用不会卡住这一轮
    'note',                    // 回传里有一段用户手写的说明
    'revision',                // 多轮协议的存在感（否则第二次调用必错）
  ]
  for (const phrase of must) assert.ok(text.includes(phrase), `工具描述里缺少「${phrase}」`)
  assert.ok(text.length <= 1200, `${text.length} 字：描述每轮都要付 token，别再加了`)

  /**
   * 回归守卫：**不要**把触发条件写成需要算阈值的条件句。
   *
   * 实测过一次：初版写「你正要写 3 行以上的版式描述时 → 停下改用它」，
   * 模型（评审模拟）于是先算「这个不到 3 行」→ 自己给自己开后门，
   * 「报告分章」「API 文档结构」两个本会命中画板的场景直接掉成「我自己出大纲」。
   * 分类条目必须是无条件的；挡后门要说「别用『我自己写几行就行』挡掉」。
   */
  for (const loophole of ['3 行以上', '2 个以上', '超过 3 行']) {
    assert.ok(!text.includes(loophole), `触发条件里又出现了阈值「${loophole}」—— 那会被算成后门`)
  }
})

test('工具描述里要写明「先读用户的 note」（那是颜色表达不了的约束）', () => {
  const tool = captureTool()
  assert.ok(tool.description.includes('先读'), 'note 得被明确要求先读，否则模型只看几何')
  assert.ok(tool.description.includes('purpose="other"'), '要给出不属于既有几类时的落点')
})

test('review 漏传 boardId 直接报错，不偷偷新开一块空画板', async () => {
  const tool = captureTool()

  await assert.rejects(
    () => tool.execute({ mode: 'review', purpose: 'ui-layout' }),
    /boardId/,
    'review 必须有 boardId：否则方案叠到新板上，用户看不到',
  )
  await assert.rejects(() => tool.execute({ mode: 'review', boardId: '   ' }), /boardId/, '只给空白也算没给')

  // draw 模式不带 boardId 是正常的首轮
  const first = await tool.execute({ mode: 'draw', purpose: 'ui-layout' })
  assert.equal(first.data.mode, 'draw')

  // review 带上就照常走
  const review = await tool.execute({ mode: 'review', boardId: 'call-1', revision: 2, purpose: 'ui-layout' })
  assert.equal(review.data.boardId, 'call-1')
  assert.equal(review.data.revision, 2)
})
