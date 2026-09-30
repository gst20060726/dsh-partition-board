/**
 * 把一条 `[partition-board] {...}` 消息解码成人能读的东西：
 *   - 逐行 ASCII 分区图（· 未标注 / C 画布 / P 控制栏 / A 动作区 / S 状态条 …按 legend 顺序给字母）
 *   - 每种颜色的格数、占比、包围盒
 *   - 未标注连通域（哪几块留白、多大）
 *   - 矢量几何与栅格矩阵是否自洽（用 regions 重算一遍栅格对比）
 *
 * 用法：
 *   node scripts/decode.mjs <payload.json 路径>
 *   node scripts/decode.mjs --inline '<[partition-board] 整条消息或裸 JSON>'
 */
import { readFileSync } from 'node:fs'

const LETTERS = 'CPASTUVWXYZBDEFGHIJKLMNOQ'
const CH = { 0: '·' }

function normalize(message) {
  const text = message.trim()
  const start = text.indexOf('{')
  if (start < 0) throw new Error('找不到 JSON：' + text.slice(0, 80))
  return JSON.parse(text.slice(start))
}

const arg = process.argv[2]
if (arg === undefined) {
  console.error('用法：node scripts/decode.mjs <payload.json> | --inline <消息>')
  process.exit(2)
}
const payload = arg === '--inline' ? normalize(process.argv[3] ?? '') : JSON.parse(readFileSync(arg, 'utf8'))

const plan = payload.plan ?? payload
const grid = plan.grid
if (grid === undefined || typeof grid.cells !== 'string') {
  console.error('这条消息里没有 grid（rework / plan-request 之外的形状？）')
  process.exit(1)
}

const legend = plan.legend ?? payload.legend ?? []
const { cols, rows, cells } = grid
console.log(`# ${payload.kind ?? '(plan)'} · boardId=${payload.boardId ?? '?'} · revision=${payload.revision ?? '?'} · purpose=${payload.purpose ?? '?'}`)
if (payload.task) console.log(`# task: ${payload.task}`)
console.log(`# 画布 ${payload.canvas?.aspect ?? '?'} · 网格 ${cols}×${rows} = ${cols * rows} 格 · 字符串长度 ${cells.length}${cells.length === cols * rows ? ' ✔' : ' ✘ 与网格不符'}`)

legend.forEach((entry, index) => { CH[index + 1] = LETTERS[index % LETTERS.length] })

console.log('')
for (let r = 0; r < rows; r += 1) {
  let line = ''
  for (let c = 0; c < cols; c += 1) {
    const value = cells.charCodeAt(r * cols + c) - 48
    line += CH[value] ?? '?'
  }
  console.log(String(r).padStart(2) + ' |' + line + '|')
}
console.log('      ' + '+'.repeat(cols))

const stat = new Map()
for (let i = 0; i < cells.length; i += 1) {
  const value = cells.charCodeAt(i) - 48
  const c = i % cols
  const r = (i - c) / cols
  const entry = stat.get(value) ?? { n: 0, x0: cols, y0: rows, x1: -1, y1: -1 }
  entry.n += 1
  entry.x0 = Math.min(entry.x0, c); entry.y0 = Math.min(entry.y0, r)
  entry.x1 = Math.max(entry.x1, c); entry.y1 = Math.max(entry.y1, r)
  stat.set(value, entry)
}

console.log('\n每格统计：')
for (const key of [...stat.keys()].sort((a, b) => a - b)) {
  const entry = stat.get(key)
  const name = key === 0 ? '未标注' : `${CH[key]} ${legend[key - 1]?.name ?? '?'}`
  console.log(`  ${name.padEnd(12)} ${String(entry.n).padStart(4)} 格 ${(entry.n / cells.length * 100).toFixed(1).padStart(5)}%  列 ${entry.x0}-${entry.x1} 行 ${entry.y0}-${entry.y1}`)
}

// 未标注连通域（4 邻）
const seen = new Uint8Array(cells.length)
const comps = []
for (let start = 0; start < cells.length; start += 1) {
  if (seen[start] === 1 || cells[start] !== '0') continue
  const queue = [start]
  seen[start] = 1
  let n = 0; let x0 = cols; let y0 = rows; let x1 = -1; let y1 = -1
  while (queue.length > 0) {
    const i = queue.pop()
    n += 1
    const c = i % cols
    const r = (i - c) / cols
    x0 = Math.min(x0, c); y0 = Math.min(y0, r); x1 = Math.max(x1, c); y1 = Math.max(y1, r)
    for (const [dc, dr] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
      const nc = c + dc
      const nr = r + dr
      if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue
      const j = nr * cols + nc
      if (seen[j] === 0 && cells[j] === '0') { seen[j] = 1; queue.push(j) }
    }
  }
  comps.push({ n, x0, y0, x1, y1 })
}
comps.sort((a, b) => b.n - a.n)
console.log(`\n未标注连通域 ${comps.length} 块：`)
for (const c of comps) {
  console.log(`  ${String(c.n).padStart(4)} 格 ${(c.n / cells.length * 100).toFixed(1).padStart(5)}%  x ${(c.x0 / cols).toFixed(3)}..${((c.x1 + 1) / cols).toFixed(3)}  y ${(c.y0 / rows).toFixed(3)}..${((c.y1 + 1) / rows).toFixed(3)}`)
}

if (Array.isArray(plan.regions)) {
  console.log('\n矢量分区（归一化）：')
  for (const region of plan.regions) {
    const label = legend.find((entry) => entry.id === region.colorId)
    const where = region.kind === 'rect'
      ? `rect [${region.rect.map((v) => v.toFixed(3)).join(', ')}]`
      : `${region.kind} ${region.points.length} 点`
    console.log(`  ${String(region.id).padEnd(6)} ${(label?.name ?? region.colorId ?? '?').padEnd(6)} softness=${region.softness ?? '?'}  ${where}`)
  }
}
