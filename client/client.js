/**
 * dsh-partition-board —— 分区画板（浏览器半边，手写 bundle）。
 *
 * 契约（已核过 DSH 0.1.6-alpha.2 源码）：
 *   - 客户端插件 = `window.__ModuleLoader__.load({id, factory})` 的手写 bundle，
 *     `id` 必须等于包名；基线模块**只有 React**（没有 react-dom → 不做 portal）。
 *   - 画板挂 keyed slot `tool.call.toolview`，key = 工具名 `partition_board`。
 *     owner props 里的 `block.argsRaw` 是工具参数的**实时**流，模型一调用画板就弹。
 *   - 客户端 → 宿主只有一条安全信道：`ctx.sessions.scope(sessionId).get('conversation').send(text)`。
 *     自定义 waterfall 不可用（`dsh-api-remotes` 转发白名单是编译期固定的），
 *     复用 `user-questions/request` 会被内置问题卡抢答。
 *
 * 所以：模型调工具 → 画板弹出 → 用户画 → 客户端把紧凑状态作为一条用户消息发回 → 模型继续。
 */
window.__ModuleLoader__.load({
  id: 'dsh-partition-board',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    'use strict'

    const React = require('react')
    const h = React.createElement
    const { useState, useRef, useEffect, useCallback, useMemo } = React

    const TOOL_NAME = 'partition_board'
    const STORE_PREFIX = 'dsh.partitionBoard.v1'
    const MSG_PREFIX = '[partition-board]'

    /** 调色板：色相拉开，深浅底都能辨。 */
    const PALETTE = [
      '#e5484d', '#0b7fd4', '#12a594', '#f5a524', '#8e4ec6', '#e93d82',
      '#46a758', '#0d74ce', '#d6409f', '#ffb224', '#6e56cf', '#30a46c',
    ]

    const GRID_COLS = 32

    /* ══════════════════════════ 纯函数（可被 node --test 直接测） ══════════════════════════ */

    const clamp01 = (n) => (typeof n === 'number' && Number.isFinite(n) ? (n < 0 ? 0 : n > 1 ? 1 : n) : 0)
    const round3 = (n) => Math.round(clamp01(n) * 1000) / 1000
    const uniq = (list) => Array.from(new Set(list))

    /** 归一化 hex；非法返回 null。 */
    function normalizeHex(value) {
      if (typeof value !== 'string') return null
      const text = value.trim()
      if (/^#[0-9a-fA-F]{3}$/.test(text)) {
        return ('#' + text[1] + text[1] + text[2] + text[2] + text[3] + text[3]).toLowerCase()
      }
      if (/^#[0-9a-fA-F]{6}$/.test(text)) return text.toLowerCase()
      return null
    }

    function hexToRgb(hex) {
      const normalized = normalizeHex(hex) || '#888888'
      return [
        parseInt(normalized.slice(1, 3), 16),
        parseInt(normalized.slice(3, 5), 16),
        parseInt(normalized.slice(5, 7), 16),
      ]
    }

    function withAlpha(hex, alpha) {
      const [r, g, b] = hexToRgb(hex)
      return `rgba(${r},${g},${b},${Math.max(0, Math.min(1, alpha))})`
    }

    /** 读 `block`（RunningToolCall | ToolResultNode）里的参数原文。 */
    function argsRawOf(block) {
      if (block === null || typeof block !== 'object') return ''
      if (typeof block.argsRaw === 'string') return block.argsRaw
      if (block.call !== null && typeof block.call === 'object' && typeof block.call.argsRaw === 'string') {
        return block.call.argsRaw
      }
      return ''
    }

    /** 解析画板参数；流式未闭合时返回 ok:false（调用方显示「正在起草」）。 */
    function parseBoardArgs(raw) {
      if (typeof raw !== 'string' || raw.trim() === '') return { ok: false, reason: 'empty' }
      let parsed
      try {
        parsed = JSON.parse(raw)
      } catch (error) {
        return { ok: false, reason: 'partial' }
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { ok: false, reason: 'shape' }
      }
      const canvas = parsed.canvas !== null && typeof parsed.canvas === 'object' ? parsed.canvas : {}
      return {
        ok: true,
        args: {
          boardId: typeof parsed.boardId === 'string' ? parsed.boardId.trim() : '',
          revision: Number.isInteger(parsed.revision) && parsed.revision > 0 ? parsed.revision : 1,
          mode: parsed.mode === 'review' ? 'review' : 'draw',
          purpose: typeof parsed.purpose === 'string' && parsed.purpose !== '' ? parsed.purpose : 'other',
          task: typeof parsed.task === 'string' ? parsed.task : '',
          ask: typeof parsed.ask === 'string' ? parsed.ask : '',
          aspect: typeof canvas.aspect === 'string' && canvas.aspect !== '' ? canvas.aspect : '16:9',
          guide: typeof canvas.guide === 'string' ? canvas.guide : '',
          legend: Array.isArray(parsed.legend) ? parsed.legend : [],
          regions: Array.isArray(parsed.regions) ? parsed.regions : [],
          targets: Array.isArray(parsed.targets) ? parsed.targets.filter((t) => typeof t === 'string') : [],
        },
      }
    }

    /** `16:9` / `4:3` / 任意 `W:H` → 宽高比数值；认不出就回 16/9。 */
    function aspectRatio(text) {
      if (typeof text !== 'string') return 16 / 9
      const match = /^(\d+(?:\.\d+)?)\s*[:/]\s*(\d+(?:\.\d+)?)$/.exec(text.trim())
      if (match === null) return 16 / 9
      const w = Number(match[1])
      const hgt = Number(match[2])
      if (!Number.isFinite(w) || !Number.isFinite(hgt) || w <= 0 || hgt <= 0) return 16 / 9
      return Math.max(0.2, Math.min(5, w / hgt))
    }

    /** 按最小间距抽稀手绘轨迹（保留首末点）。 */
    function thinPoints(points, minDist) {
      const gap = typeof minDist === 'number' && minDist > 0 ? minDist : 0.004
      if (!Array.isArray(points) || points.length <= 2) return Array.isArray(points) ? points.slice() : []
      const out = [points[0]]
      for (let index = 1; index < points.length; index += 1) {
        const last = out[out.length - 1]
        const point = points[index]
        const dx = point[0] - last[0]
        const dy = point[1] - last[1]
        if (Math.sqrt(dx * dx + dy * dy) >= gap || index === points.length - 1) out.push(point)
      }
      return out.length >= 2 ? out : points.slice(0, 2)
    }

    function distToSegment(px, py, ax, ay, bx, by) {
      const vx = bx - ax
      const vy = by - ay
      const lengthSq = vx * vx + vy * vy
      if (lengthSq === 0) return Math.sqrt((px - ax) ** 2 + (py - ay) ** 2)
      let t = ((px - ax) * vx + (py - ay) * vy) / lengthSq
      t = t < 0 ? 0 : t > 1 ? 1 : t
      const cx = ax + t * vx
      const cy = ay + t * vy
      return Math.sqrt((px - cx) ** 2 + (py - cy) ** 2)
    }

    /** Ramer–Douglas–Peucker，按归一化坐标系。 */
    function rdp(points, epsilon) {
      const eps = typeof epsilon === 'number' && epsilon > 0 ? epsilon : 0.003
      if (!Array.isArray(points) || points.length < 3) return Array.isArray(points) ? points.slice() : []
      const keep = new Array(points.length).fill(false)
      keep[0] = true
      keep[points.length - 1] = true
      const stack = [[0, points.length - 1]]
      while (stack.length > 0) {
        const [first, last] = stack.pop()
        let worst = 0
        let index = -1
        for (let i = first + 1; i < last; i += 1) {
          const d = distToSegment(
            points[i][0], points[i][1],
            points[first][0], points[first][1],
            points[last][0], points[last][1],
          )
          if (d > worst) { worst = d; index = i }
        }
        if (worst > eps && index > 0) {
          keep[index] = true
          stack.push([first, index], [index, last])
        }
      }
      const out = []
      for (let i = 0; i < points.length; i += 1) if (keep[i]) out.push(points[i])
      return out.length >= 2 ? out : [points[0], points[points.length - 1]]
    }

    function regionBounds(region) {
      if (region.kind === 'rect' && Array.isArray(region.rect)) {
        const [x, y, w, hgt] = region.rect
        return { x0: x, y0: y, x1: x + w, y1: y + hgt }
      }
      const points = Array.isArray(region.points) ? region.points : []
      if (points.length === 0) return { x0: 0, y0: 0, x1: 0, y1: 0 }
      let x0 = 1; let y0 = 1; let x1 = 0; let y1 = 0
      for (const point of points) {
        if (point[0] < x0) x0 = point[0]
        if (point[1] < y0) y0 = point[1]
        if (point[0] > x1) x1 = point[0]
        if (point[1] > y1) y1 = point[1]
      }
      const pad = region.kind === 'stroke' ? (region.width || 0.05) / 2 : 0
      return { x0: Math.max(0, x0 - pad), y0: Math.max(0, y0 - pad), x1: Math.min(1, x1 + pad), y1: Math.min(1, y1 + pad) }
    }

    function pointInRect(rect, x, y) {
      return x >= rect[0] && x <= rect[0] + rect[2] && y >= rect[1] && y <= rect[1] + rect[3]
    }

    function pointInPoly(points, x, y) {
      let inside = false
      for (let i = 0, j = points.length - 1; i < points.length; j = i, i += 1) {
        const xi = points[i][0]
        const yi = points[i][1]
        const xj = points[j][0]
        const yj = points[j][1]
        if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi || 1e-9) + xi) inside = !inside
      }
      return inside
    }

    function pointInStroke(points, width, x, y) {
      const half = Math.max(0.004, (width || 0.05) / 2)
      for (let i = 1; i < points.length; i += 1) {
        const d = distToSegment(x, y, points[i - 1][0], points[i - 1][1], points[i][0], points[i][1])
        if (d <= half) return true
      }
      return false
    }

    /** 命中测试：返回最上层（数组靠后）的分区 id。 */
    function hitTest(regions, x, y) {
      for (let index = regions.length - 1; index >= 0; index -= 1) {
        const region = regions[index]
        const bounds = regionBounds(region)
        if (x < bounds.x0 || x > bounds.x1 || y < bounds.y0 || y > bounds.y1) continue
        if (region.kind === 'rect') {
          if (pointInRect(region.rect, x, y)) return region.id
        } else if (region.kind === 'poly') {
          if (pointInPoly(region.points, x, y)) return region.id
        } else if (region.kind === 'stroke') {
          if (pointInStroke(region.points, region.width, x, y)) return region.id
        }
      }
      return null
    }

    /** 分区的近似面积占比（用于「细小分区」判定）。 */
    function regionAreaPct(region) {
      if (region.kind === 'rect' && Array.isArray(region.rect)) return region.rect[2] * region.rect[3]
      const points = Array.isArray(region.points) ? region.points : []
      if (points.length < 2) return 0
      if (region.kind === 'stroke') {
        let length = 0
        for (let i = 1; i < points.length; i += 1) {
          length += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1])
        }
        return Math.min(1, length * (region.width || 0.05))
      }
      let area = 0
      for (let i = 0, j = points.length - 1; i < points.length; j = i, i += 1) {
        area += points[j][0] * points[i][1] - points[i][0] * points[j][1]
      }
      return Math.min(1, Math.abs(area) / 2)
    }

    /**
     * 把画布栅格化成 cols×rows 的占用矩阵：每格取最上层命中的分区。
     * @returns {{ cols:number, rows:number, cells:number[] }} cells 里 0 表示未标注，其余是 legend 索引（1 起）。
     */
    function rasterize(regions, legend, cols, rows) {
      const colorOf = new Map()
      legend.forEach((entry, index) => colorOf.set(entry.id, index + 1))
      const cells = new Array(cols * rows).fill(0)
      for (let row = 0; row < rows; row += 1) {
        const y = (row + 0.5) / rows
        for (let col = 0; col < cols; col += 1) {
          const x = (col + 0.5) / cols
          for (let index = regions.length - 1; index >= 0; index -= 1) {
            const region = regions[index]
            const bounds = regionBounds(region)
            if (x < bounds.x0 || x > bounds.x1 || y < bounds.y0 || y > bounds.y1) continue
            let hit = false
            if (region.kind === 'rect') hit = pointInRect(region.rect, x, y)
            else if (region.kind === 'poly') hit = pointInPoly(region.points, x, y)
            else hit = pointInStroke(region.points, region.width, x, y)
            if (hit) {
              cells[row * cols + col] = colorOf.get(region.colorId) ?? 0
              break
            }
          }
        }
      }
      return { cols, rows, cells }
    }

    /** 每格一个 base36 字符（0=未标注），行优先。 */
    function gridToString(cells) {
      let out = ''
      for (const cell of cells) out += (cell < 36 ? cell : 35).toString(36)
      return out
    }

    /** 四邻连通域；`match(cell, index)` 判定该格是否属于要找的域。 */
    function connectedComponents(grid, match) {
      const { cols, rows, cells } = grid
      const seen = new Uint8Array(cells.length)
      const components = []
      for (let start = 0; start < cells.length; start += 1) {
        if (seen[start] === 1 || !match(cells[start], start)) continue
        const queue = [start]
        seen[start] = 1
        const members = []
        let x0 = cols; let y0 = rows; let x1 = -1; let y1 = -1
        while (queue.length > 0) {
          const index = queue.pop()
          members.push(index)
          const col = index % cols
          const row = (index - col) / cols
          if (col < x0) x0 = col
          if (row < y0) y0 = row
          if (col > x1) x1 = col
          if (row > y1) y1 = row
          const neighbours = [
            col > 0 ? index - 1 : -1,
            col < cols - 1 ? index + 1 : -1,
            row > 0 ? index - cols : -1,
            row < rows - 1 ? index + cols : -1,
          ]
          for (const next of neighbours) {
            if (next < 0 || seen[next] === 1 || !match(cells[next], next)) continue
            seen[next] = 1
            queue.push(next)
          }
        }
        components.push({ size: members.length, cells: members, x0, y0, x1, y1 })
      }
      return components
    }

    /**
     * 画板体检：覆盖率、未标注区块、细小分区。
     * @param {number} tinyRatio 小于画布此比例的连通域算「细小」。
     */
    function analyzeBoard(regions, legend, cols, rows, tinyRatio) {
      const grid = rasterize(regions, legend, cols, rows)
      const total = grid.cells.length
      const ratio = typeof tinyRatio === 'number' && tinyRatio > 0 ? tinyRatio : 0.015

      let labeled = 0
      for (const cell of grid.cells) if (cell > 0) labeled += 1

      const nameOf = new Map()
      legend.forEach((entry, index) => nameOf.set(index + 1, entry))

      const unlabeled = []
      for (const component of connectedComponents(grid, (cell) => cell === 0)) {
        if (component.size !== total) {
          unlabeled.push({
            id: 'u' + (unlabeled.length + 1),
            x: round3(component.x0 / cols),
            y: round3(component.y0 / rows),
            w: round3((component.x1 - component.x0 + 1) / cols),
            h: round3((component.y1 - component.y0 + 1) / rows),
            area: round3(component.size / total),
          })
        }
      }
      unlabeled.sort((a, b) => b.area - a.area)

      const tiny = []
      for (let index = 1; index < 36; index += 1) {
        const entry = nameOf.get(index)
        if (entry === undefined) continue
        for (const component of connectedComponents(grid, (cell) => cell === index)) {
          const area = component.size / total
          if (area >= ratio) continue
          tiny.push({
            id: 't' + (tiny.length + 1),
            colorId: entry.id,
            name: entry.name,
            x: round3(component.x0 / cols),
            y: round3(component.y0 / rows),
            w: round3((component.x1 - component.x0 + 1) / cols),
            h: round3((component.y1 - component.y0 + 1) / rows),
            area: round3(area),
          })
        }
      }
      tiny.sort((a, b) => a.area - b.area)

      // 分区级细小判定：整块面积低于阈值也算「细小」，即使栅格连通域够大。
      const small = regions
        .filter((region) => regionAreaPct(region) < ratio * 3)
        .map((region) => {
          const entry = legend.find((candidate) => candidate.id === region.colorId)
          return {
            id: region.id,
            colorId: region.colorId || '',
            name: region.label || (entry === undefined ? '' : entry.name),
            area: round3(regionAreaPct(region)),
          }
        })

      return {
        grid,
        coverage: round3(labeled / total),
        unlabeled: unlabeled.slice(0, 12),
        tiny: tiny.slice(0, 20),
        small,
        labeled,
        total,
      }
    }

    /* ══════════════════════════ 本地存储 ══════════════════════════ */

    function storeKey(sessionId, boardId) {
      return `${STORE_PREFIX}:${sessionId || 'nosession'}:${boardId}`
    }

    function loadBoardState(sessionId, boardId) {
      try {
        const raw = window.localStorage.getItem(storeKey(sessionId, boardId))
        if (raw === null) return null
        const parsed = JSON.parse(raw)
        if (parsed === null || typeof parsed !== 'object') return null
        return {
          legend: Array.isArray(parsed.legend) ? parsed.legend : [],
          regions: Array.isArray(parsed.regions) ? parsed.regions : [],
          proposals: Array.isArray(parsed.proposals) ? parsed.proposals : [],
          aiLegendRev: Number.isInteger(parsed.aiLegendRev) ? parsed.aiLegendRev : 0,
          aiProposalRev: Number.isInteger(parsed.aiProposalRev) ? parsed.aiProposalRev : 0,
          confirmedAt: typeof parsed.confirmedAt === 'string' ? parsed.confirmedAt : null,
          lastSentRevision: Number.isInteger(parsed.lastSentRevision) ? parsed.lastSentRevision : 0,
          rejected: Array.isArray(parsed.rejected) ? parsed.rejected.filter((id) => typeof id === 'string') : [],
        }
      } catch (error) {
        return null
      }
    }

    function saveBoardState(sessionId, boardId, state) {
      try {
        window.localStorage.setItem(storeKey(sessionId, boardId), JSON.stringify({
          legend: state.legend,
          regions: state.regions,
          proposals: state.proposals,
          aiLegendRev: state.aiLegendRev,
          aiProposalRev: state.aiProposalRev,
          confirmedAt: state.confirmedAt,
          lastSentRevision: state.lastSentRevision,
          rejected: Array.isArray(state.rejected) ? state.rejected : [],
        }))
        return true
      } catch (error) {
        /* 隐私模式 / 配额满：画板仍可用，只是不跨刷新记忆 */
        return false
      }
    }

    /**
     * 存盘节流：橡皮拖一下会改几十次 state，每次都 `JSON.stringify` 整个画板
     * 是白烧 CPU（分区多时一次几十 KB）。合并成一次落盘，卸载/刷新前补一次。
     */
    function makeSaver(delayMs) {
      let timer = null
      let pending = null
      const flush = () => {
        if (timer !== null) { window.clearTimeout(timer); timer = null }
        if (pending === null) return
        const job = pending
        pending = null
        saveBoardState(job.sessionId, job.boardId, job.state)
      }
      return {
        schedule(sessionId, boardId, state) {
          pending = { sessionId, boardId, state }
          if (timer !== null) window.clearTimeout(timer)
          timer = window.setTimeout(flush, delayMs)
        },
        flush,
      }
    }

    /* ══════════════════════════ 轮次登记（旧画板自动折叠） ══════════════════════════ */

    const revisionRegistry = new Map()

    function registryBump(boardId, revision) {
      const entry = revisionRegistry.get(boardId) || { max: 0, version: 0, listeners: new Set() }
      if (revision > entry.max) entry.max = revision
      entry.version += 1
      revisionRegistry.set(boardId, entry)
      for (const listener of entry.listeners) listener(entry.version)
      return entry.max
    }

    function registrySubscribe(boardId, listener) {
      const entry = revisionRegistry.get(boardId) || { max: 0, version: 0, listeners: new Set() }
      entry.listeners.add(listener)
      revisionRegistry.set(boardId, entry)
      return () => { entry.listeners.delete(listener) }
    }

    function registryMax(boardId) {
      const entry = revisionRegistry.get(boardId)
      return entry === undefined ? 0 : entry.max
    }

    /* ══════════════════════════ 模块级共享状态 ══════════════════════════ */

    /**
     * 全屏归属。
     *
     * 为什么不用 `position:fixed` 自撑：画板挂在聊天气泡内部，任何祖先带
     * `transform` / `filter` / `contain` 都会给 fixed 元素造一个新的包含块，
     * 于是「全屏」被截在容器里。改成注册到 root 作用域的 `shell.overlay`
     * （kind=list，可以多占），全屏那层就真的在 shell 根上。
     *
     * 代价是同一时刻只能有一个活着的 BoardCore 实例：展开时工具行里那块
     * 换成一行占位，否则两个实例各自持有一份 state 会分叉出两个事实来源。
     */
    const overlayState = {
      current: null, // { key, sessionId, callId, boardId, args, revision }
      prefs: { tool: 'rect', colorId: '', brushWidth: 0.05, softness: 0.15 },
      listeners: new Set(),
    }

    /**
     * 全屏层是否真的注册上了。
     *
     * 这个开关不是装饰：注册回调只在宿主**声明**了 `shell.overlay` 时才跑。
     * 若某个组合没声明这个槽，而我们还是把工具行换成占位，画板就会凭空消失
     * —— 那是最糟的失败模式。所以拿不到槽时干脆不提供全屏入口。
     */
    let overlayAvailable = false

    function overlaySet(current) {
      overlayState.current = current
      for (const listener of overlayState.listeners) listener()
    }

    function overlaySlotKey(sessionId, boardId, revision) {
      return `${sessionId}|${boardId}|${revision}`
    }

    /**
     * 键盘焦点归属：屏幕上有好几块画板时，Ctrl+Z 只该作用在你正在动的那块。
     * 每次在这块画板上按下指针就夺焦；新挂载的画板默认夺焦（刚弹出来的就是你关心的）。
     */
    const boardFocus = { key: null, listeners: new Set() }

    function boardFocusSet(key) {
      if (boardFocus.key === key) return
      boardFocus.key = key
      for (const listener of boardFocus.listeners) listener()
    }

    function useOverlayState() {
      const [, bump] = useState(0)
      useEffect(() => {
        const listener = () => bump((value) => value + 1)
        overlayState.listeners.add(listener)
        return () => { overlayState.listeners.delete(listener) }
      }, [])
      return overlayState.current
    }

    function useBoardFocus(key) {
      const [, bump] = useState(0)
      useEffect(() => {
        const listener = () => bump((value) => value + 1)
        boardFocus.listeners.add(listener)
        return () => { boardFocus.listeners.delete(listener) }
      }, [])
      return boardFocus.key === key
    }

    /* ══════════════════════════ 视图（缩放 / 平移） ══════════════════════════ */

    /**
     * 视图按 boardId 记在模块里，而不是组件 state：内嵌 ↔ 全屏会换一个 BoardCore 实例，
     * 你没道理一进全屏就被弹回 100%。也不进 localStorage —— 它是「看的角度」，不是画板内容。
     *
     * 坐标约定：`cx/cy` = 画布正中看到的世界点（归一化 0..1），所以
     *   屏幕 s → 世界 w：w = c + (s - 0.5) / zoom
     *   世界 w → 屏幕 s：s = 0.5 + (w - c) * zoom
     */
    const viewStore = new Map()
    const ZOOM_MIN = 1
    const ZOOM_MAX = 8

    function readView(boardId) {
      const stored = viewStore.get(boardId)
      return stored === undefined ? { zoom: 1, cx: 0.5, cy: 0.5 } : stored
    }

    function writeView(boardId, view) {
      viewStore.set(boardId, view)
      return view
    }

    /**
     * 夹住视图：只放大不缩小（画布本来就刚好放下），并让视口始终留在画布内 ——
     * 中心点的活动范围随缩放收窄，所以任何 zoom 下都拖不出空白。
     */
    function clampView(view) {
      const raw = view === null || typeof view !== 'object' ? {} : view
      const zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Number.isFinite(raw.zoom) ? raw.zoom : ZOOM_MIN))
      const half = 0.5 / zoom
      const pin = (value) => Math.max(half, Math.min(1 - half, Number.isFinite(value) ? value : 0.5))
      return { zoom, cx: pin(raw.cx), cy: pin(raw.cy) }
    }

    function useBoardView(boardId) {
      const [view, setViewState] = useState(() => readView(boardId))
      const setView = useCallback((next) => {
        const resolved = typeof next === 'function' ? next(readView(boardId)) : next
        setViewState(writeView(boardId, clampView(resolved)))
      }, [boardId])
      return [view, setView]
    }

    /* ══════════════════════════ 画布绘制 ══════════════════════════ */

    function drawRegion(ctx2d, region, legendById, options) {
      const entry = legendById.get(region.colorId)
      const baseColor = entry === undefined ? '#9aa4b2' : entry.color
      const soft = Math.max(0, Math.min(1, region.softness === undefined ? 0.15 : region.softness))
      // 缩放系数只用来抵消「装饰性」尺寸（轮廓线、虚线、标签），
      // 几何本身（矩形/多边形/笔宽/羽化）是世界的，必须跟着缩放一起变。
      const zoom = options.zoom === undefined ? 1 : options.zoom
      const fine = (px) => px / zoom
      ctx2d.save()
      if (soft > 0.01) ctx2d.filter = `blur(${(soft * 14).toFixed(1)}px)`
      if (options !== null && options !== undefined && options.proposed === true) {
        ctx2d.globalAlpha = 0.30
      } else {
        ctx2d.globalAlpha = 0.46
      }
      ctx2d.fillStyle = baseColor
      ctx2d.strokeStyle = baseColor
      if (region.kind === 'rect') {
        const [x, y, w, hgt] = region.rect
        ctx2d.fillRect(x * options.w, y * options.h, w * options.w, hgt * options.h)
      } else if (region.kind === 'poly') {
        ctx2d.beginPath()
        region.points.forEach((point, index) => {
          const px = point[0] * options.w
          const py = point[1] * options.h
          if (index === 0) ctx2d.moveTo(px, py)
          else ctx2d.lineTo(px, py)
        })
        ctx2d.closePath()
        ctx2d.fill()
      } else {
        ctx2d.lineWidth = Math.max(2, (region.width || 0.05) * Math.min(options.w, options.h))
        ctx2d.lineCap = 'round'
        ctx2d.lineJoin = 'round'
        ctx2d.beginPath()
        region.points.forEach((point, index) => {
          const px = point[0] * options.w
          const py = point[1] * options.h
          if (index === 0) ctx2d.moveTo(px, py)
          else ctx2d.lineTo(px, py)
        })
        ctx2d.stroke()
      }
      ctx2d.restore()

      // 清晰轮廓 + 标签画在模糊层之外，避免虚线也被糊掉。
      const bounds = regionBounds(region)
      ctx2d.save()
      const selected = region.id === options.selectedId
      ctx2d.setLineDash(options.proposed === true ? [fine(7), fine(5)] : [])
      ctx2d.lineWidth = fine(selected ? 2.5 : 1.25)
      ctx2d.strokeStyle = selected ? '#ffffff' : withAlpha(baseColor, options.proposed === true ? 0.95 : 0.75)
      if (region.kind === 'rect') {
        ctx2d.strokeRect(region.rect[0] * options.w, region.rect[1] * options.h, region.rect[2] * options.w, region.rect[3] * options.h)
      } else if (region.kind === 'poly') {
        ctx2d.beginPath()
        region.points.forEach((point, index) => {
          const px = point[0] * options.w
          const py = point[1] * options.h
          if (index === 0) ctx2d.moveTo(px, py)
          else ctx2d.lineTo(px, py)
        })
        ctx2d.closePath()
        ctx2d.stroke()
      }
      ctx2d.restore()

      const labelText = (region.label || (entry === undefined ? '' : entry.name)) || ''
      const boxW = (bounds.x1 - bounds.x0) * options.w
      const boxH = (bounds.y1 - bounds.y0) * options.h
      // 标签是注释而不是几何：屏幕上够大才画，字号也跟着缩放抵消，放大后不会糊一屏
      if (labelText !== '' && boxW * zoom > 54 && boxH * zoom > 22) {
        const cx = ((bounds.x0 + bounds.x1) / 2) * options.w
        const cy = ((bounds.y0 + bounds.y1) / 2) * options.h
        ctx2d.save()
        ctx2d.font = `600 ${fine(12)}px ui-sans-serif, system-ui, "Segoe UI", sans-serif`
        ctx2d.textAlign = 'center'
        ctx2d.textBaseline = 'middle'
        const text = (options.proposed === true ? 'AI · ' : '') + labelText
        const width = ctx2d.measureText(text).width
        ctx2d.fillStyle = 'rgba(12,15,22,0.72)'
        ctx2d.fillRect(cx - width / 2 - fine(6), cy - fine(10), width + fine(12), fine(20))
        ctx2d.fillStyle = '#ffffff'
        ctx2d.fillText(text, cx, cy)
        ctx2d.restore()
      }
    }

    function paintCanvas(canvas, state, view) {
      if (canvas === null) return
      const ratio = window.devicePixelRatio || 1
      const cssW = canvas.clientWidth || 640
      const cssH = canvas.clientHeight || Math.round(cssW / view.aspect)
      if (canvas.width !== Math.round(cssW * ratio) || canvas.height !== Math.round(cssH * ratio)) {
        canvas.width = Math.max(1, Math.round(cssW * ratio))
        canvas.height = Math.max(1, Math.round(cssH * ratio))
      }
      const painter = canvas.getContext('2d')
      if (painter === null) return
      painter.setTransform(ratio, 0, 0, ratio, 0, 0)
      painter.clearRect(0, 0, cssW, cssH)

      // 底：浅网格 + 参照说明
      painter.fillStyle = view.dark ? 'rgba(255,255,255,0.03)' : 'rgba(15,23,42,0.035)'
      const step = 32
      for (let x = step; x < cssW; x += step) painter.fillRect(x, 0, 1, cssH)
      for (let y = step; y < cssH; y += step) painter.fillRect(0, y, cssW, 1)
      if (view.guide !== '') {
        painter.save()
        painter.font = '500 13px ui-sans-serif, system-ui, sans-serif'
        painter.fillStyle = view.dark ? 'rgba(255,255,255,0.20)' : 'rgba(15,23,42,0.22)'
        painter.textAlign = 'center'
        painter.textBaseline = 'middle'
        painter.fillText(view.guide.slice(0, 90), cssW / 2, cssH / 2)
        painter.restore()
      }

      const legendById = new Map(state.legend.map((entry) => [entry.id, entry]))
      // 世界 → 屏幕：缩放与平移交给画布矩阵，下面所有 `x * cssW` 的绘制代码一行都不动，
      // 也就不会出现「某几处忘了乘 zoom」的错位。网格与 guide 画在上面，
      // 它们是屏幕空间的尺子，不跟着缩放跑。
      const zoom = view.zoom === undefined ? 1 : view.zoom
      const vcx = view.cx === undefined ? 0.5 : view.cx
      const vcy = view.cy === undefined ? 0.5 : view.cy
      painter.setTransform(
        ratio * zoom, 0, 0, ratio * zoom,
        ratio * cssW * (0.5 - vcx * zoom),
        ratio * cssH * (0.5 - vcy * zoom),
      )

      const options = { w: cssW, h: cssH, zoom, selectedId: view.selectedId, proposed: false, dark: view.dark }
      for (const region of state.regions) drawRegion(painter, region, legendById, options)
      for (const region of state.proposals) {
        drawRegion(painter, region, legendById, { ...options, proposed: true, selectedId: null })
      }
      if (view.draft !== null) {
        const draft = view.draft
        painter.save()
        painter.setLineDash([6 / zoom, 4 / zoom])
        painter.lineWidth = 1.5 / zoom
        painter.strokeStyle = view.dark ? 'rgba(255,255,255,0.85)' : 'rgba(15,23,42,0.75)'
        const color = legendById.get(draft.colorId)
        painter.fillStyle = withAlpha(color === undefined ? '#888888' : color.color, 0.4)
        if (draft.kind === 'rect' && draft.rect !== undefined) {
          painter.fillRect(draft.rect[0] * cssW, draft.rect[1] * cssH, draft.rect[2] * cssW, draft.rect[3] * cssH)
          painter.strokeRect(draft.rect[0] * cssW, draft.rect[1] * cssH, draft.rect[2] * cssW, draft.rect[3] * cssH)
        } else if (Array.isArray(draft.points) && draft.points.length > 1) {
          painter.lineWidth = draft.kind === 'stroke' ? Math.max(2, (draft.width || 0.05) * Math.min(cssW, cssH)) : 1.5 / zoom
          painter.lineCap = 'round'
          painter.lineJoin = 'round'
          painter.strokeStyle = color === undefined ? '#888888' : color.color
          painter.beginPath()
          draft.points.forEach((point, index) => {
            const px = point[0] * cssW
            const py = point[1] * cssH
            if (index === 0) painter.moveTo(px, py)
            else painter.lineTo(px, py)
          })
          if (draft.kind === 'poly') { painter.closePath(); painter.fill() }
          painter.stroke()
        }
        painter.restore()
      }

      // 还回像素变换：同一个 2D 上下文可能被别的绘制复用，不该继承我们的视图
      painter.setTransform(ratio, 0, 0, ratio, 0, 0)
    }

    /* ══════════════════════════ 回传给模型的消息 ══════════════════════════ */

    function buildLegendPayload(legend) {
      return legend.map((entry) => ({
        id: entry.id,
        color: entry.color,
        name: entry.name,
        ...(entry.meaning ? { meaning: entry.meaning } : {}),
      }))
    }

    /**
     * 矢量载荷的硬预算。
     *
     * 没有预算时：单分区最多 80 点 × 最多 200 个分区 = 16000 个点，
     * 一条 `[partition-board]` 消息能把整个回合撑爆。所以总量封顶，
     * 分区越多每个分区分到的点越少（退化但不丢分区）。
     */
    const MAX_TOTAL_POINTS = 600
    const MAX_POINTS_PER_REGION = 80

    /** 回传分区的硬上限：超出的会被丢掉，所以界面上要明说（见状态条）。 */
    const MAX_REGIONS = 200

    /** 用户「边画边写」的说明上限：够写两三句判断依据，又不至于把一条消息撑爆。 */
    const MAX_NOTE_CHARS = 600

    function buildRegionPayload(regions, options) {
      const list = regions.slice(0, MAX_REGIONS)
      const curved = list.filter((region) => region.kind !== 'rect').length
      const budget = (options !== null && options !== undefined && options.maxTotalPoints !== undefined)
        ? options.maxTotalPoints : MAX_TOTAL_POINTS
      const cap = (options !== null && options !== undefined && options.maxPointsPerRegion !== undefined)
        ? options.maxPointsPerRegion : MAX_POINTS_PER_REGION
      // 每个分区的配额由「还剩多少分区要分这点预算」决定：总量因此可证 ≤ budget。
      const perRegion = Math.min(cap, Math.max(2, Math.floor(budget / Math.max(1, curved))))

      return list.map((region) => {
        const out = {
          id: region.id,
          colorId: region.colorId || '',
          kind: region.kind,
          softness: round3(region.softness === undefined ? 0.15 : region.softness),
        }
        if (region.label) out.label = region.label
        if (region.note) out.note = region.note
        if (region.source === 'ai') out.source = 'ai'
        if (region.kind === 'rect') {
          out.rect = (Array.isArray(region.rect) ? region.rect : [0, 0, 0, 0]).map(round3)
          return out
        }
        let points = rdp(thinPoints(region.points || [], 0.006), 0.004)
        if (points.length > perRegion) {
          const stride = Math.ceil(points.length / perRegion)
          const reduced = points.filter((_point, index) => index % stride === 0)
          const tail = points[points.length - 1]
          if (reduced[reduced.length - 1] !== tail) reduced.push(tail)
          points = reduced
        }
        out.points = points.map((point) => [round3(point[0]), round3(point[1])])
        if (region.kind === 'stroke') out.width = round3(region.width === undefined ? 0.05 : region.width)
        return out
      })
    }

    /** 画板 → 模型：色卡、几何（简化过）、栅格矩阵、体检统计。 */
    function buildPayload(kind, context) {
      const { args, state, stats, feedback, note } = context
      const merged = state.regions.concat(state.proposals.map((region) => ({ ...region, source: 'ai' })))
      const payload = {
        kind,
        boardId: context.boardId,
        revision: args.revision,
        purpose: args.purpose,
        ...(args.task ? { task: args.task } : {}),
        canvas: { aspect: args.aspect, gridCols: stats.grid.cols, gridRows: stats.grid.rows },
        legend: buildLegendPayload(state.legend),
        regions: buildRegionPayload(merged),
        grid: { cols: stats.grid.cols, rows: stats.grid.rows, cells: gridToString(stats.grid.cells) },
        stats: {
          coverage: stats.coverage,
          regionCount: state.regions.length,
          proposedCount: state.proposals.length,
          unlabeled: stats.unlabeled,
          tiny: stats.tiny,
          small: stats.small.slice(0, 12),
        },
      }
      if (Array.isArray(args.targets) && args.targets.length > 0) payload.targets = args.targets
      if (typeof feedback === 'string' && feedback.trim() !== '') payload.feedback = feedback.trim().slice(0, 800)
      // 用户边画边写的说明：人和 AI 之间「文字 + 图形」两条腿，note 是文字那条腿。
      // 它和 feedback 分开：feedback 是「对 AI 方案的意见」，note 是「我画的东西是什么」。
      if (typeof note === 'string' && note.trim() !== '') payload.note = note.trim().slice(0, MAX_NOTE_CHARS)
      if (kind === 'confirmed') {
        payload.plan = {
          legend: buildLegendPayload(state.legend),
          regions: buildRegionPayload(merged),
          grid: { cols: stats.grid.cols, rows: stats.grid.rows, cells: gridToString(stats.grid.cells) },
          coverage: stats.coverage,
          confirmedAt: new Date().toISOString(),
        }
        delete payload.grid
        delete payload.stats
        delete payload.regions
      }
      return payload
    }

    /* ══════════════════════════ 样式 ══════════════════════════ */

    const CSS = {
      shell: {
        font: '13px/1.55 ui-sans-serif, system-ui, "Segoe UI", "Microsoft YaHei", sans-serif',
        border: '1px solid rgba(127,140,165,0.35)',
        borderRadius: '12px',
        background: 'var(--dsh-surface, #fff)',
        color: 'inherit',
        overflow: 'hidden',
        margin: '6px 0',
      },
      header: {
        display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap',
        padding: '10px 12px', borderBottom: '1px solid rgba(127,140,165,0.28)',
        background: 'rgba(127,140,165,0.08)',
      },
      badge: {
        display: 'inline-flex', alignItems: 'center', gap: '5px',
        padding: '2px 8px', borderRadius: '999px', fontSize: '11px', fontWeight: 600,
        background: 'rgba(127,140,165,0.18)',
      },
      btn: {
        padding: '5px 11px', borderRadius: '8px', cursor: 'pointer', fontSize: '12px',
        border: '1px solid rgba(127,140,165,0.45)', background: 'transparent', color: 'inherit',
        lineHeight: 1.4,
      },
      btnPrimary: {
        padding: '6px 13px', borderRadius: '8px', cursor: 'pointer', fontSize: '12px', fontWeight: 600,
        border: '1px solid transparent', background: '#0b7fd4', color: '#fff', lineHeight: 1.4,
      },
      btnGhostActive: {
        padding: '5px 11px', borderRadius: '8px', cursor: 'pointer', fontSize: '12px',
        border: '1px solid #0b7fd4', background: 'rgba(11,127,212,0.16)', color: 'inherit',
      },
      input: {
        padding: '5px 8px', borderRadius: '7px', fontSize: '12px', color: 'inherit',
        border: '1px solid rgba(127,140,165,0.45)', background: 'transparent', minWidth: 0,
      },
      body: { display: 'flex', gap: '12px', padding: '12px', flexWrap: 'wrap' },
      // 状态条：内容顶部通栏（来自确认版式里的 r3「状态条」）
      statusStrip: {
        display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap',
        padding: '7px 12px', fontSize: '11px',
        borderBottom: '1px solid rgba(127,140,165,0.28)',
        background: 'rgba(127,140,165,0.06)',
      },
      meter: {
        display: 'block', flex: '0 0 108px', height: '5px', borderRadius: '3px',
        background: 'rgba(127,140,165,0.30)', overflow: 'hidden',
      },
      meterFill: { display: 'block', height: '100%', background: '#0b7fd4' },
      // 控制栏：上半可滚，动作区钉在底部（确认版式里的 r2 / r4）
      panelScroll: {
        display: 'flex', flexDirection: 'column', gap: '8px',
        overflowY: 'auto', flex: '1 1 auto', minHeight: 0,
      },
      actionDock: {
        display: 'flex', gap: '6px', flexWrap: 'wrap',
        borderTop: '2px solid rgba(127,140,165,0.45)', paddingTop: '9px', flex: '0 0 auto',
      },
      // 边画边写：贴着动作区上方，画的时候一直看得见
      noteBox: {
        display: 'flex', flexDirection: 'column', gap: '4px',
        borderTop: '1px solid rgba(127,140,165,0.28)', paddingTop: '8px', flex: '0 0 auto',
      },
      canvasWrap: { position: 'relative', flex: '1 1 420px', minWidth: '300px' },
      // 缩放控件：浮在画布右下角（canvasWrap 是 relative 容器）
      zoomBar: {
        position: 'absolute', right: '8px', bottom: '8px', display: 'flex', gap: '4px',
        alignItems: 'center', padding: '3px 5px', borderRadius: '9px',
        border: '1px solid rgba(127,140,165,0.35)',
        background: 'var(--dsh-surface, #fff)',
      },
      canvas: {
        width: '100%', display: 'block', borderRadius: '10px', touchAction: 'none',
        border: '1px solid rgba(127,140,165,0.4)',
        background: 'var(--dsh-canvas-bg, rgba(127,140,165,0.06))',
        cursor: 'crosshair',
      },
      panel: { flex: '0 0 268px', minWidth: '240px', display: 'flex', flexDirection: 'column', gap: '8px', minHeight: 0 },
      legendRow: { display: 'flex', alignItems: 'center', gap: '6px' },
      swatch: { width: '22px', height: '22px', borderRadius: '6px', border: '2px solid transparent', cursor: 'pointer', flex: '0 0 auto', padding: 0 },
      small: { fontSize: '11px', opacity: 0.72 },
      // 空画布上手引导：一次性提示，第一块画出来就消失
      hint: {
        padding: '7px 9px', borderRadius: '8px', fontSize: '11.5px', lineHeight: 1.6,
        border: '1px dashed rgba(11,127,212,0.45)', background: 'rgba(11,127,212,0.06)',
      },
      // 全屏层：挂在 shell 根上，所以这里的 fixed 不会遇到 transform 祖先
      backdrop: {
        position: 'fixed', inset: '0', zIndex: 2147483000,
        background: 'rgba(6,8,12,0.55)', display: 'flex', padding: '10px',
        boxSizing: 'border-box',
      },
    }

    /* ══════════════════════════ 文案（中 / 英） ══════════════════════════ */

    /**
     * 界面文案。语言跟**人的**浏览器走（`<html lang>` → `navigator.language` → 中文兜底）：
     * 画板是给人看的，而 skill / README 是给模型和安装者看的，那些不在这里。
     * 键名用英文是为了让这里像一张表，而不是一堆散落的中文串。
     */
    const STRINGS = {
      zh: {
        boardTitle: '分区画板',
        drafting: '正在起草画板…',
        emptyArgs: '画板参数为空',
        overlayActive: '第 {n} 轮 · 已全屏显示',
        fullscreen: '全屏',
        exitFullscreen: '退出全屏',
        roundStale: '第 {n} 轮 · 已被第 {m} 轮取代（往下看最新画板）',
        reopenRound: '仍要打开这一轮',
        roundOf: '第 {n} 轮 · {mode}',
        modeReview: '审阅 AI 方案',
        modeDraw: '你来做主',
        notLatest: '非最新（最新第 {n} 轮）',
        confirmed: '已确认',
        askDefault: '请划分这块区域',
        lockedHint: '规划已确认。若要改，直接在对话里说要改什么，我会带同一块画板重开一轮。',
        coverage: '覆盖率 {pct}%',
        regionCount: '分区 {n}',
        proposalCount: 'AI 方案 {n}',
        unlabeledCount: '未标注区块 {n}',
        tinyCount: '细小分区 {n}',
        toolSelect: '选择',
        toolRect: '矩形',
        toolLasso: '套索',
        toolBrush: '软笔刷',
        toolErase: '橡皮',
        toolPan: '抓手',
        brushWidth: '笔宽 ',
        feather: '边界羽化 ',
        legendTitle: '色卡：颜色 ↔ 含义',
        setCurrentColor: '设为当前颜色',
        changeColor: '改颜色',
        regionName: '分区名',
        meaningPlaceholder: '含义 / 判据（AI 解读分区靠它）',
        addColor: '+ 增加颜色',
        selectedRegion: '选中分区 {id}（{kind}）',
        regionLabelPlaceholder: '这块叫什么',
        featherShort: '羽化 ',
        firstRunHint: '① 给颜色起个名字 → ② 用矩形/套索画出区块 → ③ 点底部按钮让 AI 补全剩下',
        eraseHint: '橡皮：碰到哪块就删掉整块（按 Delete 删选中的那块）',
        panHint: '抓手：拖动平移画布（Ctrl/⌘ + 滚轮缩放，0 复位）',
        overflowWarning: '分区超过 {max} 块，超出的 {extra} 块不会回传给 AI',
        deleteRegion: '删除这块',
        removeColor: '删除这个颜色',
        undo: '撤销',
        redo: '重做',
        clearMine: '清空我的分区',
        copyPlan: '复制规划 JSON',
        proposalsTitle: 'AI 方案 {n} 块（虚线覆盖层）',
        rejectProposal: '否掉这一块（后续轮次不再出现）',
        confirmPlan: '确认最终规划',
        adoptProposals: '先采纳进我的分区',
        feedbackPlaceholder: '不满意就说要改什么（可不填）',
        rework: '返工重规划',
        noteLabel: '边画边写（可选）：这块画的是什么 / 你判断的依据',
        notePlaceholder: '例如「左栏是筛选条件，主区要能同时并排看两张卡」——AI 补全时会先读这段话',
        planAttention: '让 AI 规划 {n} 处未标注/细小区域',
        planReview: '请 AI 复核并补全',
        confirmKeep: '就这样，确认',
        draftPlan: '让 AI 草拟一版',
        draftPlanFeedback: '请从头草拟一版分区方案',
        zoomOut: '缩小',
        zoomIn: '放大',
        zoomGroup: '缩放',
        toolsGroup: '工具',
        zoomReset: '回到 100%（快捷键 0）',
        zoomFit: '复位',
        canvasLabel: '分区画板：{n} 色色卡，{m} 个分区，覆盖率 {pct}%',
        toastCopied: '规划 JSON 已复制',
        toastCopyFailed: '复制失败，请手动扩展开关后从控制台取',
        toastNoClipboard: '剪贴板不可用：规划 JSON 长度 {n}',
        toastChannel: '会话通道未就绪：切回该会话再试',
        toastSentPlan: '已请 AI 规划',
        toastSentRework: '已提交返工',
        toastSentConfirmed: '已确认最终规划',
        toastSendFailed: '发送失败：{msg}',
        defaultRegionName: '分区 {n}',
        newColorName: '新分区',
        overlayLabel: '分区画板全屏层',
        registerFailed: '[dsh-partition-board] 画板注册失败：',
        overlayRegisterFailed: '[dsh-partition-board] 全屏层注册失败（画板仍可用，只是不提供全屏入口）：',
      },
      en: {
        boardTitle: 'Partition board',
        drafting: 'Drafting the board…',
        emptyArgs: 'Empty board arguments',
        overlayActive: 'Round {n} · shown fullscreen',
        fullscreen: 'Fullscreen',
        exitFullscreen: 'Exit fullscreen',
        roundStale: 'Round {n} · superseded by round {m} (see the latest board below)',
        reopenRound: 'Open this round anyway',
        roundOf: 'Round {n} · {mode}',
        modeReview: 'reviewing the AI plan',
        modeDraw: 'you drive',
        notLatest: 'Not the latest (latest is round {n})',
        confirmed: 'Confirmed',
        askDefault: 'Divide this area',
        lockedHint: 'Plan confirmed. To change it, just say what to change in the chat and I will reopen the same board.',
        coverage: 'Coverage {pct}%',
        regionCount: 'Regions {n}',
        proposalCount: 'AI plan {n}',
        unlabeledCount: 'Unlabeled {n}',
        tinyCount: 'Tiny regions {n}',
        toolSelect: 'Select',
        toolRect: 'Rect',
        toolLasso: 'Lasso',
        toolBrush: 'Brush',
        toolErase: 'Eraser',
        toolPan: 'Pan',
        brushWidth: 'Width ',
        feather: 'Feather ',
        legendTitle: 'Legend: colour ↔ meaning',
        setCurrentColor: 'Use this colour',
        changeColor: 'Change colour',
        regionName: 'Region name',
        meaningPlaceholder: 'Meaning / criterion (the AI reads regions through this)',
        addColor: '+ Add colour',
        selectedRegion: 'Selected {id} ({kind})',
        regionLabelPlaceholder: 'What is this one',
        featherShort: 'Feather ',
        firstRunHint: '① Name the colours → ② Draw regions with Rect/Lasso → ③ Ask the AI to fill in the rest',
        eraseHint: 'Eraser: removes the whole region you touch (Delete removes the selected one)',
        panHint: 'Pan: drag to move the canvas (Ctrl/⌘ + wheel to zoom, 0 to reset)',
        overflowWarning: 'More than {max} regions: the extra {extra} will not be sent to the AI',
        deleteRegion: 'Delete this region',
        removeColor: 'Remove this colour',
        undo: 'Undo',
        redo: 'Redo',
        clearMine: 'Clear my regions',
        copyPlan: 'Copy plan JSON',
        proposalsTitle: 'AI plan: {n} regions (dashed overlay)',
        rejectProposal: 'Reject this one (it will not come back next round)',
        confirmPlan: 'Confirm final plan',
        adoptProposals: 'Adopt into my regions',
        feedbackPlaceholder: 'Not happy? Say what to change (optional)',
        rework: 'Rework the plan',
        noteLabel: 'Notes while you draw (optional): what this area is / your reasoning',
        notePlaceholder: 'e.g. "left column is filters, main area must show two cards side by side" — the AI reads this first',
        planAttention: 'Let the AI plan {n} unlabeled/tiny areas',
        planReview: 'Ask the AI to review and fill in',
        confirmKeep: 'Good enough, confirm',
        draftPlan: 'Let the AI draft a plan',
        draftPlanFeedback: 'Please draft a full partition plan from scratch',
        zoomOut: 'Zoom out',
        zoomIn: 'Zoom in',
        zoomGroup: 'Zoom',
        toolsGroup: 'Tools',
        zoomReset: 'Back to 100% (shortcut 0)',
        zoomFit: 'Reset',
        canvasLabel: 'Partition board: {n} legend colours, {m} regions, coverage {pct}%',
        toastCopied: 'Plan JSON copied',
        toastCopyFailed: 'Copy failed: expand the details from the console manually',
        toastNoClipboard: 'Clipboard unavailable: plan JSON is {n} chars',
        toastChannel: 'Conversation channel not ready: switch back to that session and retry',
        toastSentPlan: 'Asked the AI to plan',
        toastSentRework: 'Rework submitted',
        toastSentConfirmed: 'Final plan confirmed',
        toastSendFailed: 'Send failed: {msg}',
        defaultRegionName: 'Region {n}',
        newColorName: 'Region ',
        overlayLabel: 'Partition board fullscreen layer',
        registerFailed: '[dsh-partition-board] board registration failed: ',
        overlayRegisterFailed: '[dsh-partition-board] fullscreen layer registration failed (board still works, just no fullscreen entry): ',
      },
    }

    /**
     * 宿主页面的语言：`<html lang>` 优先，其次 `navigator.language`。
     * 有信号但不是中文 → 英文（国际兜底）；**完全没信号 → 中文**（这块画板的老家）。
     */
    function detectLang() {
      let tag = ''
      try {
        if (typeof document !== 'undefined' && document.documentElement !== undefined
          && typeof document.documentElement.lang === 'string') {
          tag = document.documentElement.lang
        }
      } catch (error) { /* 忽略：拿不到就当没说 */ }
      if (tag === '') {
        try {
          if (typeof navigator !== 'undefined' && typeof navigator.language === 'string') tag = navigator.language
        } catch (error) { /* 忽略 */ }
      }
      return /^zh/i.test(tag) || tag === '' ? 'zh' : 'en'
    }

    const LANG = detectLang()

    /**
     * 取文案：`t('coverage', { pct: 62 })`。缺键时回落到中文，再缺就返回键名本身
     * —— 界面上露出一串英文键名很丑，但比 `undefined` 好定位。
     */
    function t(key, values) {
      const table = STRINGS[LANG] === undefined ? STRINGS.zh : STRINGS[LANG]
      let text = table[key] === undefined ? STRINGS.zh[key] : table[key]
      if (text === undefined) return key
      if (values !== undefined) {
        for (const name of Object.keys(values)) text = text.split('{' + name + '}').join(String(values[name]))
      }
      return text
    }

    /* ══════════════════════════ 组件 ══════════════════════════ */

    /** 每块画板的稳定 id 序号（aria-describedby / aria-labelledby 要用真 id）。 */
    let instanceSeq = 0

    /**
     * 撤销栈上限：一格 = 一次全量分区快照，不封顶的话长会话里会一直涨
     * （用户画几十笔就是几十份拷贝）。超出后丢最旧的。
     */
    const HISTORY_LIMIT = 40

    /**
     * 模型没给色卡时的兜底：先摆几个待命颜色，用户改个名字就能画。
     * 标 `seeded` 是为了下一轮模型真的给了 legend 时把它们**换掉**而不是叠加；
     * 用户一旦自己改过名字/颜色，就不再是 seeded，会被保留。
     */
    const SEED_COLORS = 4

    function seedLegend() {
      return PALETTE.slice(0, SEED_COLORS).map((color, index) => ({
        id: 'c' + (index + 1),
        color,
        name: t('newColorName') + (index + 1),
        meaning: '',
        seeded: true,
      }))
    }

    function pushHistory(past, regions) {
      const next = past.concat([regions])
      return next.length > HISTORY_LIMIT ? next.slice(next.length - HISTORY_LIMIT) : next
    }

    function BoardView(props) {
      const block = props.block
      const callId = props.callId
      const sessionId = props.sessionId
      const raw = argsRawOf(block)
      const parsed = useMemo(() => parseBoardArgs(raw), [raw])
      // hook 必须无条件调用，所以放在任何提前 return 之前
      const shared = useOverlayState()

      if (!parsed.ok) {
        return h('div', { style: { ...CSS.shell, padding: '10px 12px', display: 'flex', gap: '8px', alignItems: 'center' } },
          h('span', { style: { ...CSS.badge } }, t('boardTitle')),
          h('span', { style: CSS.small }, t(parsed.reason === 'partial' ? 'drafting' : 'emptyArgs')))
      }

      const args = parsed.args
      const boardId = args.boardId !== '' ? args.boardId : String(callId)
      const surface = {
        key: overlaySlotKey(sessionId, boardId, args.revision),
        sessionId,
        callId,
        boardId,
        args,
        revision: args.revision,
      }

      // 已经被全屏层接管：这里只留一行占位，避免出现两个各持一份 state 的实例
      if (overlayAvailable && shared !== null && shared.key === surface.key) {
        return h('div', { style: { ...CSS.shell, padding: '8px 12px', display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } },
          h('span', { style: { ...CSS.badge, background: 'rgba(11,127,212,0.2)' } }, t('boardTitle')),
          h('span', { style: CSS.small }, t('overlayActive', { n: surface.revision })),
          h('button', { style: CSS.btn, onClick: () => overlaySet(null) }, t('exitFullscreen')))
      }

      return h(BoardCore, { ...surface, ctx: clientCtx, expanded: false })
    }

    /** `shell.overlay`（root 作用域、list）里的全屏层：不受聊天气泡任何 transform 影响。 */
    function OverlayHost() {
      const shared = useOverlayState()
      if (shared === null) return null
      return h('div', { style: CSS.backdrop, 'data-dpb': 'overlay' },
        h(BoardCore, { ...shared, ctx: clientCtx, expanded: true }))
    }

    /** 客户端根上下文；apply() 时挂上，供组件发消息用。 */
    let clientCtx = null

    function BoardCore(props) {
      const { args, boardId, revision, sessionId, callId, ctx, expanded } = props
      const aspect = aspectRatio(args.aspect)
      const dark = useDarkMode()
      const canvasRef = useRef(null)
      const wrapRef = useRef(null)
      const dragRef = useRef(null)
      const myKey = overlaySlotKey(sessionId, boardId, revision)
      const hasFocus = useBoardFocus(myKey)

      const [state, setState] = useState(() => {
        const stored = loadBoardState(sessionId, boardId)
        if (stored !== null) return stored
        return {
          // 模型没写 legend 时先摆几个待命颜色：这样「只给 task+ask」的调用也能立刻用
          legend: args.legend.length > 0 ? [] : seedLegend(),
          regions: [], proposals: [], aiLegendRev: 0, aiProposalRev: 0,
          confirmedAt: null, lastSentRevision: 0, rejected: [],
        }
      })
      // 界面偏好放在共享 store 里：内嵌 ↔ 全屏 会换实例，偏好不该跟着丢
      const prefs = overlayState.prefs
      const [tool, setToolState] = useState(prefs.tool)
      const [colorId, setColorIdState] = useState(prefs.colorId)
      const [brushWidth, setBrushWidthState] = useState(prefs.brushWidth)
      const [softness, setSoftnessState] = useState(prefs.softness)
      const setTool = useCallback((value) => { prefs.tool = value; setToolState(value) }, [])
      const setColorId = useCallback((value) => { prefs.colorId = value; setColorIdState(value) }, [])
      const setBrushWidth = useCallback((value) => { prefs.brushWidth = value; setBrushWidthState(value) }, [])
      const setSoftness = useCallback((value) => { prefs.softness = value; setSoftnessState(value) }, [])
      const [selectedId, setSelectedId] = useState(null)
      const [draft, setDraft] = useState(null)
      const [feedback, setFeedback] = useState('')
      // 边画边写的说明：只活在这次会话里（刷新页面重画更不划算的是分区本身，不是这段话），
      // 但每次发送都会带上，所以不会因为刷新就丢给模型的那一份。
      const [note, setNote] = useState('')
      const [sizeTick, setSizeTick] = useState(0)
      // 缩放/平移：按 boardId 记在模块里（内嵌 ↔ 全屏不丢），不进画板状态
      const [view, setView] = useBoardView(boardId)
      const [toast, setToast] = useState('')
      const [busy, setBusy] = useState(false)
      const [staleVersion, setStaleVersion] = useState(0)
      const [forceOpen, setForceOpen] = useState(false)
      const [history, setHistory] = useState({ past: [], future: [] })

      const registryMaxRevision = useMemo(() => registryMax(boardId), [boardId, staleVersion])
      // forceOpen 只影响这一块画板自己。之前这里改成「把 registry 的 max 顶高」是错的：
      // 那会把**最新一轮**判成旧的，于是点旧板反而把新板挤下去，而旧板自己仍被 rule 挡住。
      const isStale = revision < registryMaxRevision && !forceOpen

      useEffect(() => {
        registryBump(boardId, revision)
        return registrySubscribe(boardId, (version) => setStaleVersion(version))
      }, [boardId, revision])

      /* ── 合并模型给来的色卡与方案（只在 revision 前进时接受） ── */
      useEffect(() => {
        setState((previous) => {
          let next = previous
          if (revision > previous.aiLegendRev && args.legend.length > 0) {
            // 待命颜色（模型上一轮没给色卡时我们摆的）让位给模型这次真正给的色卡，
            // 否则用户会看到「新分区1」和「主区」两套颜色混在一起。
            const legend = previous.legend.filter((entry) => entry.seeded !== true)
            for (const rawEntry of args.legend) {
              if (rawEntry === null || typeof rawEntry !== 'object') continue
              const id = typeof rawEntry.id === 'string' && rawEntry.id !== '' ? rawEntry.id : ('c' + (legend.length + 1))
              const color = normalizeHex(rawEntry.color) || PALETTE[legend.length % PALETTE.length]
              const name = typeof rawEntry.name === 'string' && rawEntry.name !== '' ? rawEntry.name.slice(0, 40) : t('defaultRegionName', { n: legend.length + 1 })
              const meaning = typeof rawEntry.meaning === 'string' ? rawEntry.meaning.slice(0, 200) : ''
              const index = legend.findIndex((entry) => entry.id === id)
              if (index >= 0) legend[index] = { ...legend[index], color, name, meaning }
              else legend.push({ id, color, name, meaning })
            }
            next = { ...next, legend, aiLegendRev: revision }
          }
          if (args.regions.length > 0) {
            if (revision >= previous.aiProposalRev) {
              const proposals = args.regions
                .filter((region) => region !== null && typeof region === 'object')
                .map((region, index) => ({
                  id: typeof region.id === 'string' && region.id !== '' ? region.id : ('ai' + (index + 1)),
                  colorId: typeof region.colorId === 'string' ? region.colorId : '',
                  label: typeof region.label === 'string' ? region.label.slice(0, 40) : '',
                  kind: ['rect', 'poly', 'stroke'].includes(region.kind) ? region.kind : 'rect',
                  rect: Array.isArray(region.rect) ? region.rect.slice(0, 4).map(round3) : undefined,
                  points: Array.isArray(region.points)
                    ? region.points.filter((p) => Array.isArray(p) && p.length >= 2).map((p) => [round3(p[0]), round3(p[1])])
                    : undefined,
                  width: typeof region.width === 'number' ? round3(region.width) : undefined,
                  softness: typeof region.softness === 'number' ? clamp01(region.softness) : 0.18,
                  source: 'ai',
                  note: typeof region.note === 'string' ? region.note.slice(0, 300) : '',
                }))
                .filter((region) => (region.kind === 'rect' ? Array.isArray(region.rect) && region.rect.length === 4 : Array.isArray(region.points) && region.points.length >= 2))
                // 用户逐条否掉过的方案不再回来：否则每一轮它都会重新出现，等于白点
                .filter((region) => !(previous.rejected || []).includes(region.id))
              next = { ...next, proposals, aiProposalRev: revision }
            }
          }
          return next === previous ? previous : next
        })
      }, [revision, args.legend, args.regions])

      const saver = useMemo(() => makeSaver(400), [])
      useEffect(() => { saver.schedule(sessionId, boardId, state) }, [sessionId, boardId, state, saver])
      // 卸载（切会话 / 关全屏换实例）时补一次落盘，别把最后几笔丢掉
      useEffect(() => () => saver.flush(), [saver])

      useEffect(() => {
        if (state.legend.length === 0) return
        if (colorId !== '' && state.legend.some((entry) => entry.id === colorId)) return
        setColorId(state.legend[0].id)
      }, [state.legend, colorId])

      const stats = useMemo(() => {
        const rows = Math.max(8, Math.min(48, Math.round(GRID_COLS / aspect)))
        return analyzeBoard(state.regions.concat(state.proposals), state.legend, GRID_COLS, rows, 0.015)
      }, [state.regions, state.proposals, state.legend, aspect])

      useEffect(() => {
        paintCanvas(canvasRef.current, state, {
          aspect, dark, selectedId, draft, guide: args.guide,
          zoom: view.zoom, cx: view.cx, cy: view.cy,
        })
      }, [state, aspect, dark, selectedId, draft, args.guide, expanded, sizeTick, view])

      /**
       * 画布的像素尺寸是画的时候按 clientWidth/clientHeight 现算的（见 paintCanvas），
       * 改窗口大小、拉分栏、进/出全屏只改 CSS 尺寸，不改 state —— 没有这一步，画布上的
       * 笔迹会停在旧尺寸上被拉伸变形。用 ResizeObserver 顶一个计数器，把重绘带出来。
       */
      useEffect(() => {
        const canvas = canvasRef.current
        if (canvas === null || typeof window.ResizeObserver !== 'function') return undefined
        const observer = new window.ResizeObserver(() => setSizeTick((value) => value + 1))
        observer.observe(canvas)
        return () => observer.disconnect()
      }, [expanded])

      /**
       * 进全屏时把焦点交给画布：全屏层是刚插进 root 的新节点，键盘用户
       * 如果不把焦点搬进来，Tab 还得从页头一路按过去（Esc 能退出但得先能到）。
       */
      useEffect(() => {
        if (!expanded) return
        const canvas = canvasRef.current
        if (canvas !== null && typeof canvas.focus === 'function') canvas.focus()
      }, [expanded])

      /* ── 手势 ── */
      /** 指针 → 屏幕归一化（相对画布本身，不夹范围）：平移与缩放用这个。 */
      const toScreen = useCallback((event) => {
        const canvas = canvasRef.current
        if (canvas === null) return null
        const rect = canvas.getBoundingClientRect()
        if (rect.width === 0 || rect.height === 0) return null
        return [
          (event.clientX - rect.left) / rect.width,
          (event.clientY - rect.top) / rect.height,
        ]
      }, [])

      const toNormalized = useCallback((event) => {
        const screen = toScreen(event)
        if (screen === null) return null
        // 屏幕 → 世界：paintCanvas 那次 setTransform 的逆运算，不跟它保持一致就会「画的不是点的」
        return [
          clamp01(view.cx + (screen[0] - 0.5) / view.zoom),
          clamp01(view.cy + (screen[1] - 0.5) / view.zoom),
        ]
      }, [toScreen, view])

      /** 以某个屏幕点为中心缩放：光标下的世界点保持不动。 */
      const zoomAt = useCallback((factor, screen) => {
        const current = readView(boardId)
        const next = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, current.zoom * factor))
        if (next === current.zoom) return
        const world = [
          current.cx + (screen[0] - 0.5) / current.zoom,
          current.cy + (screen[1] - 0.5) / current.zoom,
        ]
        setView({
          zoom: next,
          cx: world[0] - (screen[0] - 0.5) / next,
          cy: world[1] - (screen[1] - 0.5) / next,
        })
      }, [boardId, setView])

      /**
       * 滚轮缩放。**只有 Ctrl/⌘ + 滚轮**（触控板捏合浏览器会带 ctrlKey）才动画板 ——
       * 普通滚轮要是被吃掉，用户在对话里就滚不动页面了，那比没有缩放更糟。
       * React 的 onWheel 在根上是 passive 监听，preventDefault 无效（结果变成浏览器整页缩放），
       * 所以这里自己挂一个非 passive 的原生监听。
       */
      useEffect(() => {
        const canvas = canvasRef.current
        if (canvas === null || typeof canvas.addEventListener !== 'function') return undefined
        const onWheel = (event) => {
          if (event.ctrlKey !== true && event.metaKey !== true) return
          event.preventDefault()
          const rect = canvas.getBoundingClientRect()
          if (rect.width === 0 || rect.height === 0) return
          // 鼠标滚轮一格 deltaY≈100，触控板捏合只有几；指数映射让两者手感一致
          const step = event.deltaMode === 1 ? 0.05 : 0.0015
          zoomAt(Math.exp(-event.deltaY * step), [
            (event.clientX - rect.left) / rect.width,
            (event.clientY - rect.top) / rect.height,
          ])
        }
        canvas.addEventListener('wheel', onWheel, { passive: false })
        return () => canvas.removeEventListener('wheel', onWheel)
      }, [zoomAt, expanded])

      const commit = useCallback((region) => {
        const collected = region.label !== undefined && region.label !== ''
          ? region
          : (() => {
            const entry = state.legend.find((candidate) => candidate.id === region.colorId)
            return { ...region, label: entry === undefined ? '' : entry.name }
          })()
        setHistory((previous) => ({ past: pushHistory(previous.past, state.regions), future: [] }))
        setState((previous) => ({ ...previous, regions: previous.regions.concat([collected]) }))
      }, [state.regions, state.legend])

      const uniqueId = useCallback((prefix) => {
        let n = state.regions.length + state.proposals.length + 1
        const taken = new Set(state.regions.map((region) => region.id))
        while (taken.has(prefix + n)) n += 1
        return prefix + n
      }, [state.regions, state.proposals])

      const onPointerDown = useCallback((event) => {
        if (isStale || state.confirmedAt !== null) return
        const point = toNormalized(event)
        if (point === null) return
        if (event.currentTarget.setPointerCapture !== undefined) {
          try { event.currentTarget.setPointerCapture(event.pointerId) } catch (error) { /* 忽略 */ }
        }
        if (tool === 'pan') {
          const screen = toScreen(event)
          if (screen === null) return
          // 记下拖起点的屏幕位置与当时的视图：整段拖动都相对它算，避免逐帧累积误差
          dragRef.current = { mode: 'pan', start: screen, view: readView(boardId) }
          return
        }
        if (tool === 'erase') {
          const hit = hitTest(state.regions, point[0], point[1])
          if (hit !== null) {
            setHistory((previous) => ({ past: pushHistory(previous.past, state.regions), future: [] }))
            setState((previous) => ({ ...previous, regions: previous.regions.filter((region) => region.id !== hit) }))
          }
          dragRef.current = { mode: 'erase' }
          return
        }
        if (tool === 'select') {
          setSelectedId(hitTest(state.regions, point[0], point[1]))
          dragRef.current = { mode: 'select' }
          return
        }
        setSelectedId(null)
        dragRef.current = { mode: 'draw', start: point }
        if (tool === 'rect') {
          setDraft({ kind: 'rect', colorId, rect: [point[0], point[1], 0, 0], softness })
        } else {
          setDraft({
            kind: tool === 'brush' ? 'stroke' : 'poly',
            colorId,
            points: [point],
            // 笔宽是「屏幕上多粗」的意图，所以除以缩放存成世界宽度 ——
            // 否则放大 4 倍后同一支笔会画出 4 倍粗的笔迹。
            width: brushWidth / view.zoom,
            softness,
          })
        }
      }, [tool, colorId, brushWidth, softness, state.regions, state.confirmedAt, isStale, toNormalized, toScreen, boardId, view.zoom])

      const onPointerMove = useCallback((event) => {
        const drag = dragRef.current
        if (drag === null) return
        if (drag.mode === 'pan') {
          const screen = toScreen(event)
          if (screen === null) return
          setView({
            zoom: drag.view.zoom,
            cx: drag.view.cx - (screen[0] - drag.start[0]) / drag.view.zoom,
            cy: drag.view.cy - (screen[1] - drag.start[1]) / drag.view.zoom,
          })
          return
        }
        const point = toNormalized(event)
        if (point === null) return
        if (drag.mode === 'erase') {
          const hit = hitTest(state.regions, point[0], point[1])
          if (hit !== null) setState((previous) => ({ ...previous, regions: previous.regions.filter((region) => region.id !== hit) }))
          return
        }
        if (drag.mode !== 'draw') return
        setDraft((previous) => {
          if (previous === null) return previous
          if (previous.kind === 'rect') {
            const [sx, sy] = drag.start
            return {
              ...previous,
              rect: [Math.min(sx, point[0]), Math.min(sy, point[1]), Math.abs(point[0] - sx), Math.abs(point[1] - sy)],
            }
          }
          const points = previous.points.concat([point])
          return { ...previous, points: thinPoints(points, 0.005) }
        })
      }, [state.regions, toNormalized, toScreen, setView])

      const onPointerUp = useCallback(() => {
        const drag = dragRef.current
        dragRef.current = null
        if (drag === null || drag.mode !== 'draw') { setDraft(null); return }
        const finished = draft
        setDraft(null)
        if (finished === null) return
        if (finished.kind === 'rect') {
          if (finished.rect[2] < 0.006 || finished.rect[3] < 0.006) return
          commit({ id: uniqueId('r'), ...finished })
          return
        }
        if (finished.points.length < 2) return
        const points = rdp(thinPoints(finished.points, 0.005), 0.0035)
        if (points.length < 2) return
        if (finished.kind === 'poly' && regionAreaPct({ kind: 'poly', points }) < 0.0006) return
        commit({ id: uniqueId('r'), ...finished, points })
      }, [draft, commit, uniqueId])

      /* ── 动作 ── */
      const send = useCallback((kind, extraFeedback, extraNote) => {
        const scope = ctx && typeof ctx.sessions?.scope === 'function' ? ctx.sessions.scope(sessionId) : undefined
        const conversation = scope && typeof scope.get === 'function' ? scope.get('conversation') : undefined
        if (conversation === undefined || typeof conversation.send !== 'function') {
          setToast(t('toastChannel'))
          return Promise.resolve(false)
        }
        const payload = buildPayload(kind, {
          boardId, args, state, stats,
          feedback: extraFeedback,
          note: typeof extraNote === 'string' ? extraNote : note,
        })
        return conversation.send(MSG_PREFIX + ' ' + JSON.stringify(payload))
          .then(() => {
            setState((previous) => ({ ...previous, lastSentRevision: revision, ...(kind === 'confirmed' ? { confirmedAt: new Date().toISOString() } : {}) }))
            setToast(t(kind === 'rework' ? 'toastSentRework' : kind === 'confirmed' ? 'toastSentConfirmed' : 'toastSentPlan'))
            return true
          })
          .catch((error) => {
            setToast(t('toastSendFailed', { msg: error && error.message ? error.message : String(error) }))
            return false
          })
      }, [ctx, sessionId, args, state, stats, revision, note])

      useEffect(() => {
        if (toast === '') return undefined
        const timer = window.setTimeout(() => setToast(''), 2600)
        return () => window.clearTimeout(timer)
      }, [toast])

      const adoptProposals = useCallback(() => {
        setHistory((previous) => ({ past: pushHistory(previous.past, state.regions), future: [] }))
        setState((previous) => ({
          ...previous,
          regions: previous.regions.concat(previous.proposals.map((region) => ({ ...region, source: 'ai' }))),
          proposals: [],
        }))
      }, [state.regions])

      const undo = useCallback(() => {
        if (history.past.length === 0) return
        const target = history.past[history.past.length - 1]
        setHistory({ past: history.past.slice(0, -1), future: [state.regions].concat(history.future) })
        setState((current) => ({ ...current, regions: target }))
      }, [history, state.regions])

      const redo = useCallback(() => {
        if (history.future.length === 0) return
        const target = history.future[0]
        setHistory({ past: pushHistory(history.past, state.regions), future: history.future.slice(1) })
        setState((current) => ({ ...current, regions: target }))
      }, [history, state.regions])

      /* ── 色卡编辑 ── */
      const updateLegend = useCallback((id, patch) => {
        setState((previous) => ({
          ...previous,
          // 用户动过的颜色不再是「待命颜色」：下一轮模型给色卡时不该被换掉
          legend: previous.legend.map((entry) => (entry.id === id ? { ...entry, ...patch, seeded: false } : entry)),
        }))
      }, [])

      const addLegend = useCallback(() => {
        setState((previous) => {
          const used = new Set(previous.legend.map((entry) => entry.id))
          let n = previous.legend.length + 1
          while (used.has('c' + n)) n += 1
          const id = 'c' + n
          const entry = { id, color: PALETTE[previous.legend.length % PALETTE.length], name: t('newColorName') + n, meaning: '' }
          setColorId(id)
          return { ...previous, legend: previous.legend.concat([entry]) }
        })
      }, [])

      const removeLegend = useCallback((id) => {
        setState((previous) => ({
          ...previous,
          legend: previous.legend.filter((entry) => entry.id !== id),
          regions: previous.regions.filter((region) => region.colorId !== id),
          proposals: previous.proposals.filter((region) => region.colorId !== id),
        }))
      }, [])

      const copyPlan = useCallback(() => {
        const payload = buildPayload('confirmed', { boardId, args, state, stats })
        const text = JSON.stringify(payload.plan, null, 2)
        const done = () => setToast(t('toastCopied'))
        try {
          if (navigator.clipboard !== undefined && typeof navigator.clipboard.writeText === 'function') {
            navigator.clipboard.writeText(text).then(done, () => setToast(t('toastCopyFailed')))
            return
          }
        } catch (error) { /* 落到下面的兜底 */ }
        setToast(t('toastNoClipboard', { n: text.length }))
      }, [args, state, stats])

      const locked = state.confirmedAt !== null
      const selectedRegion = state.regions.find((region) => region.id === selectedId) || null
      const needsAttention = stats.unlabeled.length + stats.tiny.length

      const removeRegion = useCallback((id) => {
        setState((previous) => ({ ...previous, regions: previous.regions.filter((region) => region.id !== id) }))
      }, [])

      /**
       * 逐条否掉某个 AI 方案；否过的记进 rejected，下一轮不再冒出来。
       *
       * 这里**立即落盘**（不走 400ms 节流）：下一轮的画板是另一个挂载实例，它靠
       * localStorage 里的 rejected 去重。要是等节流，用户点完否决后模型马上回一轮，
       * 新实例还没读到那条记录，被否掉的方案就复活了 —— 这是「点了没用」的观感。
       */
      const rejectProposal = useCallback((id) => {
        setState((previous) => {
          const next = {
            ...previous,
            proposals: previous.proposals.filter((region) => region.id !== id),
            rejected: Array.from(new Set((previous.rejected || []).concat([id]))),
          }
          saveBoardState(sessionId, boardId, next)
          return next
        })
      }, [sessionId, boardId])

      // 新挂载（也就是刚弹出来）的画板默认拿焦点
      useEffect(() => { boardFocusSet(myKey) }, [myKey])

      /* ── 键盘 ── */
      useEffect(() => {
        if (locked || !hasFocus) return undefined
        const isTyping = (target) => {
          if (target === null || target === undefined) return false
          const tag = typeof target.tagName === 'string' ? target.tagName.toLowerCase() : ''
          if (tag === 'input' || tag === 'textarea' || tag === 'select') return true
          return target.isContentEditable === true
        }
        const onKeyDown = (event) => {
          if (isTyping(event.target)) return
          const meta = event.ctrlKey === true || event.metaKey === true
          const key = typeof event.key === 'string' ? event.key.toLowerCase() : ''
          if (meta && key === 'z' && event.shiftKey !== true) { event.preventDefault(); undo(); return }
          if (meta && (key === 'y' || (key === 'z' && event.shiftKey === true))) { event.preventDefault(); redo(); return }
          if (event.key === '0') { event.preventDefault(); setView({ zoom: 1, cx: 0.5, cy: 0.5 }); return }
          if (event.key === 'Escape') {
            if (dragRef.current !== null || draft !== null) { dragRef.current = null; setDraft(null) }
            else if (expanded) overlaySet(null)
            else setSelectedId(null)
            return
          }
          if ((event.key === 'Delete' || event.key === 'Backspace') && selectedId !== null) {
            event.preventDefault()
            removeRegion(selectedId)
            setSelectedId(null)
          }
        }
        window.addEventListener('keydown', onKeyDown)
        return () => window.removeEventListener('keydown', onKeyDown)
      }, [locked, hasFocus, undo, redo, draft, selectedId, expanded, removeRegion, myKey, setView])

      /* ── 折叠态：被更新的一轮取代 ── */
      if (isStale) {
        return h('div', { style: { ...CSS.shell, padding: '8px 12px', display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } },
          h('span', { style: CSS.badge }, t('boardTitle')),
          h('span', { style: CSS.small }, t('roundStale', { n: revision, m: registryMaxRevision })),
          h('button', {
            style: CSS.btn,
            onClick: () => setForceOpen(true),
          }, t('reopenRound')))
      }

      const shellStyle = expanded
        ? {
          ...CSS.shell,
          // 位置由 backdrop 负责（它在 shell 根上），这里只管铺满与滚动
          flex: '1 1 auto', margin: 0, borderRadius: '12px',
          display: 'flex', flexDirection: 'column', overflow: 'auto',
          background: dark ? '#0f1319' : '#ffffff',
          boxShadow: '0 24px 80px rgba(0,0,0,0.45)',
        }
        : CSS.shell

      const canvasWrapStyle = expanded
        ? { ...CSS.canvasWrap, flex: '1 1 auto', minHeight: 0 }
        : CSS.canvasWrap

      // 全屏时按高度反推限宽，保住画布比例；指针坐标走 getBoundingClientRect，
      // 所以即使 CSS 拉伸也不会画错位置。
      const canvasStyle = {
        ...CSS.canvas,
        aspectRatio: String(aspect),
        cursor: tool === 'pan' ? 'grab' : 'crosshair',
        ...(expanded
          ? { maxWidth: `calc((100vh - 220px) * ${aspect.toFixed(4)})`, margin: '0 auto' }
          : {}),
      }

      const zoomPct = Math.round(view.zoom * 100)
      // 每块画板一个稳定 id：aria-describedby 需要一个真 id，而同一页可能有好几块板
      const instanceId = useRef(null)
      if (instanceId.current === null) {
        instanceSeq += 1
        instanceId.current = 'dsh-pb-' + instanceSeq
      }
      const statusId = instanceId.current + '-status'
      const zoomControls = h('div', { style: CSS.zoomBar, 'data-dpb': 'zoom', role: 'group', 'aria-label': t('zoomGroup') },
        h('button', {
          style: CSS.btn, disabled: locked || view.zoom <= ZOOM_MIN, title: t('zoomOut'), 'aria-label': t('zoomOut'),
          onClick: () => zoomAt(1 / 1.4, [0.5, 0.5]),
        }, '−'),
        h('span', { style: { ...CSS.small, minWidth: '38px', textAlign: 'center' } }, zoomPct + '%'),
        h('button', {
          style: CSS.btn, disabled: locked || view.zoom >= ZOOM_MAX, title: t('zoomIn'), 'aria-label': t('zoomIn'),
          onClick: () => zoomAt(1.4, [0.5, 0.5]),
        }, '+'),
        view.zoom > ZOOM_MIN || view.cx !== 0.5 || view.cy !== 0.5
          ? h('button', {
            style: CSS.btn, title: t('zoomReset'),
            onClick: () => setView({ zoom: 1, cx: 0.5, cy: 0.5 }),
          }, t('zoomFit'))
          : null,
      )

      return h('div', {
        ref: wrapRef,
        style: shellStyle,
        'data-dpb': 'board',
        // 谁被点过谁拿键盘焦点：屏幕上多块画板时，Ctrl+Z 只作用在你正在动的那块
        onPointerDownCapture: () => boardFocusSet(myKey),
      },
        h('div', { style: CSS.header, 'data-dpb': 'header' },
          h('span', { style: { ...CSS.badge, background: 'rgba(11,127,212,0.2)' } }, t('boardTitle')),
          h('span', { style: { fontWeight: 600 } }, args.task !== '' ? args.task : t('askDefault')),
          h('span', { style: CSS.small }, t('roundOf', { n: revision, mode: t(args.mode === 'review' ? 'modeReview' : 'modeDraw') })),
          forceOpen && revision < registryMaxRevision
            ? h('span', { style: { ...CSS.badge, background: 'rgba(245,165,36,0.22)' } }, t('notLatest', { n: registryMaxRevision }))
            : null,
          h('span', { style: { flex: 1 } }),
          locked ? h('span', { style: { ...CSS.badge, background: 'rgba(70,167,88,0.24)' } }, t('confirmed')) : null,
          overlayAvailable
            ? h('button', {
              style: CSS.btn,
              'aria-pressed': expanded,
              onClick: () => overlaySet(expanded ? null : {
                key: myKey, sessionId, callId, boardId, args, revision,
              }),
            }, t(expanded ? 'exitFullscreen' : 'fullscreen'))
            : null,
        ),

        args.ask !== '' || locked
          ? h('div', { style: { padding: '8px 12px 0', fontSize: '12px', opacity: 0.9 } },
            locked ? t('lockedHint') : args.ask)
          : null,

        // 状态条：顶部通栏，扫一眼就知道画到哪了。aria-live 让读屏软件也能听到覆盖率与提示变化
        h('div', {
          style: CSS.statusStrip, 'data-dpb': 'status', id: statusId, role: 'status', 'aria-live': 'polite',
        },
          h('span', null, t('coverage', { pct: Math.round(stats.coverage * 100) })),
          h('span', { style: CSS.meter, 'aria-hidden': true }, h('span', { style: { ...CSS.meterFill, width: `${Math.round(stats.coverage * 100)}%` } })),
          h('span', null, t('regionCount', { n: state.regions.length })),
          state.proposals.length > 0 ? h('span', null, t('proposalCount', { n: state.proposals.length })) : null,
          stats.unlabeled.length > 0 ? h('span', null, t('unlabeledCount', { n: stats.unlabeled.length })) : null,
          stats.tiny.length > 0 ? h('span', null, t('tinyCount', { n: stats.tiny.length })) : null,
          state.regions.length > MAX_REGIONS
            ? h('span', { style: { color: '#e5484d', fontWeight: 600 } },
              t('overflowWarning', { max: MAX_REGIONS, extra: state.regions.length - MAX_REGIONS }))
            : null,
          h('span', { style: { flex: 1 } }),
          toast !== '' ? h('span', { style: { color: '#0b7fd4', fontWeight: 600 } }, toast) : null,
        ),

        h('div', { style: CSS.body, 'data-dpb': 'body' },
          h('div', { style: canvasWrapStyle, 'data-dpb': 'canvas-wrap' },
            h('canvas', {
              ref: canvasRef,
              style: canvasStyle,
              // 读屏软件读不到像素，所以给这块画布一句「现在是什么状况」，
              // 并把状态条挂上去（role=status 会跟着念）。键盘也能 Tab 进来。
              role: 'application',
              tabIndex: 0,
              'aria-label': t('canvasLabel', {
                n: state.legend.length, m: state.regions.length, pct: Math.round(stats.coverage * 100),
              }),
              'aria-describedby': statusId,
              onPointerDown,
              onPointerMove,
              onPointerUp,
              onPointerCancel: onPointerUp,
              // 画布上弹的浏览器右键菜单会打断绘制，这里自己接管
              onContextMenu: (event) => event.preventDefault(),
            }),
            zoomControls,
          ),

          h('div', { style: CSS.panel, 'data-dpb': 'panel' },
            h('div', { style: CSS.panelScroll, 'data-dpb': 'panel-scroll' },
            // 工具
            h('div', { style: { display: 'flex', gap: '5px', flexWrap: 'wrap' }, role: 'group', 'aria-label': t('toolsGroup') },
              ...['select', 'rect', 'lasso', 'brush', 'erase', 'pan'].map((id) => h('button', {
                key: id,
                style: tool === id ? CSS.btnGhostActive : CSS.btn,
                disabled: locked,
                title: id === 'erase' ? t('eraseHint') : id === 'pan' ? t('panHint') : undefined,
                // 一排工具按钮本质是单选：把「当前选中哪个」也说给读屏软件
                'aria-pressed': tool === id,
                onClick: () => setTool(id),
              }, t({
                select: 'toolSelect', rect: 'toolRect', lasso: 'toolLasso',
                brush: 'toolBrush', erase: 'toolErase', pan: 'toolPan',
              }[id]))),
            ),

            // 空画布上手引导：一次显示，画出第一块就消失
            state.regions.length === 0 && !locked
              ? h('div', { style: CSS.hint, 'data-dpb': 'hint' }, t('firstRunHint'))
              : null,

            // 笔触参数
            tool === 'brush'
              ? h('label', { style: CSS.small }, t('brushWidth'),
                h('input', {
                  type: 'range', min: 0.01, max: 0.3, step: 0.005, value: brushWidth,
                  'aria-label': t('brushWidth'),
                  onChange: (event) => setBrushWidth(Number(event.target.value)), style: { width: '150px' },
                }))
              : null,
            h('label', { style: CSS.small }, t('feather'),
              h('input', {
                type: 'range', min: 0, max: 1, step: 0.05, value: softness,
                'aria-label': t('feather'),
                onChange: (event) => setSoftness(Number(event.target.value)), style: { width: '150px' },
              }), ' ', Math.round(softness * 100) + '%'),

            // 色卡
            h('div', { style: { ...CSS.small, fontWeight: 600, marginTop: '2px' } }, t('legendTitle')),
            ...state.legend.map((entry) => h('div', {
              key: entry.id,
              style: {
                display: 'flex', flexDirection: 'column', gap: '4px',
                borderLeft: '3px solid ' + entry.color, paddingLeft: '7px',
              },
            },
              h('div', { style: CSS.legendRow },
                h('button', {
                  title: t('setCurrentColor'), 'aria-label': t('setCurrentColor'), 'aria-pressed': entry.id === colorId,
                  style: { ...CSS.swatch, background: entry.color, borderColor: entry.id === colorId ? '#0b7fd4' : 'transparent' },
                  onClick: () => setColorId(entry.id),
                }),
                h('input', {
                  type: 'color', value: entry.color, title: t('changeColor'), 'aria-label': t('changeColor'),
                  style: { ...CSS.input, width: '26px', padding: '1px', flex: '0 0 auto' },
                  onChange: (event) => updateLegend(entry.id, { color: normalizeHex(event.target.value) || entry.color }),
                }),
                h('input', {
                  value: entry.name, placeholder: t('regionName'), 'aria-label': t('regionName'),
                  style: { ...CSS.input, flex: '1 1 auto', width: '40px' },
                  onChange: (event) => updateLegend(entry.id, { name: event.target.value.slice(0, 40) }),
                }),
                h('button', {
                  style: { ...CSS.btn, padding: '2px 7px', flex: '0 0 auto' },
                  'aria-label': t('removeColor'), title: t('removeColor'),
                  onClick: () => removeLegend(entry.id),
                }, '×'),
              ),
              h('input', {
                value: entry.meaning, placeholder: t('meaningPlaceholder'), 'aria-label': t('meaningPlaceholder'),
                style: { ...CSS.input, width: '100%' },
                onChange: (event) => updateLegend(entry.id, { meaning: event.target.value.slice(0, 200) }),
              }),
            )),
            h('button', { style: CSS.btn, onClick: addLegend }, t('addColor')),

            // 选中分区
            selectedRegion !== null && !locked
              ? h('div', { style: { borderTop: '1px solid rgba(127,140,165,0.28)', paddingTop: '8px', display: 'flex', flexDirection: 'column', gap: '6px' } },
                h('div', { style: CSS.small }, t('selectedRegion', { id: selectedRegion.id, kind: selectedRegion.kind })),
                h('input', {
                  value: selectedRegion.label || '', placeholder: t('regionLabelPlaceholder'), 'aria-label': t('regionLabelPlaceholder'),
                  style: { ...CSS.input, width: '100%' },
                  onChange: (event) => setState((previous) => ({
                    ...previous,
                    regions: previous.regions.map((region) => (region.id === selectedRegion.id ? { ...region, label: event.target.value.slice(0, 40) } : region)),
                  })),
                }),
                h('label', { style: CSS.small }, t('featherShort'),
                  h('input', {
                    type: 'range', min: 0, max: 1, step: 0.05, value: selectedRegion.softness,
                    'aria-label': t('featherShort'),
                    onChange: (event) => setState((previous) => ({
                      ...previous,
                      regions: previous.regions.map((region) => (region.id === selectedRegion.id ? { ...region, softness: Number(event.target.value) } : region)),
                    })), style: { width: '140px' },
                  })),
                h('button', {
                  style: CSS.btn,
                  onClick: () => {
                    setState((previous) => ({ ...previous, regions: previous.regions.filter((region) => region.id !== selectedRegion.id) }))
                    setSelectedId(null)
                  },
                }, t('deleteRegion')),
              )
              : null,

            // 历史
            h('div', { style: { display: 'flex', gap: '5px', flexWrap: 'wrap', borderTop: '1px solid rgba(127,140,165,0.28)', paddingTop: '8px' } },
              h('button', { style: CSS.btn, disabled: locked || history.past.length === 0, onClick: undo }, t('undo')),
              h('button', { style: CSS.btn, disabled: locked || history.future.length === 0, onClick: redo }, t('redo')),
              h('button', {
                style: CSS.btn, disabled: locked || state.regions.length === 0,
                onClick: () => {
                  setHistory((previous) => ({ past: pushHistory(previous.past, state.regions), future: [] }))
                  setState((previous) => ({ ...previous, regions: [] }))
                },
              }, t('clearMine')),
              h('button', { style: CSS.btn, onClick: copyPlan }, t('copyPlan')),
            ),

            // AI 方案
            state.proposals.length > 0 && !locked
              ? h('div', { style: { border: '1px dashed rgba(11,127,212,0.6)', borderRadius: '9px', padding: '8px', display: 'flex', flexDirection: 'column', gap: '6px' }, 'data-dpb': 'proposals' },
                h('div', { style: { ...CSS.small, fontWeight: 600 } }, t('proposalsTitle', { n: state.proposals.length })),
                ...state.proposals.slice(0, 8).map((region) => h('div', {
                  key: region.id,
                  style: { display: 'flex', gap: '6px', alignItems: 'flex-start' },
                },
                  h('span', { style: { ...CSS.small, flex: '1 1 auto' } },
                    '· ' + (region.label || region.colorId) + (region.note ? ' — ' + region.note.slice(0, 60) : '')),
                  h('button', {
                    style: { ...CSS.btn, padding: '0 6px', flex: '0 0 auto' },
                    title: t('rejectProposal'), 'aria-label': t('rejectProposal'),
                    onClick: () => rejectProposal(region.id),
                  }, '×'))),
                h('div', { style: { display: 'flex', gap: '5px', flexWrap: 'wrap' } },
                  h('button', { style: CSS.btnPrimary, onClick: () => send('confirmed') }, t('confirmPlan')),
                  h('button', { style: CSS.btn, onClick: adoptProposals }, t('adoptProposals')),
                ),
                h('textarea', {
                  value: feedback, placeholder: t('feedbackPlaceholder'), 'aria-label': t('feedbackPlaceholder'),
                  style: { ...CSS.input, width: '100%', minHeight: '46px', resize: 'vertical' },
                  onChange: (event) => setFeedback(event.target.value),
                }),
                h('button', { style: CSS.btn, onClick: () => send('rework', feedback) }, t('rework')),
              )
              : null,

            ),

            // 边画边写：光靠图形说不清「这块为什么要这么分」，配一句话。
            // 只在「用户自己做主」的阶段出现 —— 有 AI 方案时，下方那个文字框是「返工意见」。
            !locked && state.confirmedAt === null && state.proposals.length === 0
              ? h('div', { style: CSS.noteBox, 'data-dpb': 'note' },
                h('div', { style: CSS.small }, t('noteLabel')),
                h('textarea', {
                  value: note,
                  placeholder: t('notePlaceholder'), 'aria-label': t('noteLabel'),
                  style: { ...CSS.input, width: '100%', minHeight: '52px', resize: 'vertical' },
                  onChange: (event) => setNote(event.target.value.slice(0, 600)),
                }),
              )
              : null,

            // 动作区：钉在控制栏底部，不随上面的色卡一起滚
            !locked && state.confirmedAt === null
              ? h('div', { style: CSS.actionDock, 'data-dpb': 'action-dock' },
                h('button', {
                  style: CSS.btnPrimary, disabled: busy || state.legend.length === 0,
                  onClick: () => { setBusy(true); send('plan-request', undefined, note).finally(() => setBusy(false)) },
                }, needsAttention > 0
                  ? t('planAttention', { n: needsAttention })
                  : t('planReview')),
                state.proposals.length === 0
                  ? h('button', {
                    style: CSS.btn, disabled: busy || state.regions.length === 0,
                    onClick: () => { setBusy(true); send('confirmed', undefined, note).finally(() => setBusy(false)) },
                  }, t('confirmKeep'))
                  : null,
                h('button', {
                  style: CSS.btn, disabled: busy,
                  onClick: () => { setBusy(true); send('plan-request', t('draftPlanFeedback'), note).finally(() => setBusy(false)) },
                }, t('draftPlan')),
              )
              : null,
          ),
        ),
      )
    }

    /** 跟随主题：读根元素的 class/配色方案，变了就重绘。 */
    function useDarkMode() {
      const read = () => {
        try {
          const root = document.documentElement
          if (root.classList.contains('dark') || root.dataset.theme === 'dark') return true
          if (root.dataset.theme === 'light') return false
          return window.matchMedia !== undefined && window.matchMedia('(prefers-color-scheme: dark)').matches
        } catch (error) {
          return false
        }
      }
      const [dark, setDark] = useState(read)
      useEffect(() => {
        if (typeof MutationObserver !== 'function') return undefined
        const observer = new MutationObserver(() => setDark(read()))
        observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme'] })
        return () => observer.disconnect()
      }, [])
      return dark
    }

    /* ══════════════════════════ 插件装配 ══════════════════════════ */

    exports.name = 'dsh-partition-board'
    exports.inject = ['slots', 'sessions']

    exports.apply = function apply(ctx) {
      clientCtx = ctx
      const disposers = []
      try {
        disposers.push(ctx.slots.inject('tool.call.toolview', () => ctx.slots.register(
          { name: 'tool.call.toolview', key: TOOL_NAME },
          BoardView,
        )))
      } catch (error) {
        console.error(t('registerFailed'), error)
      }
      try {
        // root 作用域的 list 槽：全屏层挂在这里，不受聊天气泡任何 transform 影响
        disposers.push(ctx.slots.inject('shell.overlay', () => {
          const dispose = ctx.slots.register({
            name: 'shell.overlay',
            id: 'partition-board-fullscreen',
            order: 70,
            label: () => t('overlayLabel'),
          }, OverlayHost)
          overlayAvailable = true
          return dispose
        }))
      } catch (error) {
        console.error(t('overlayRegisterFailed'), error)
      }
      return () => {
        for (const dispose of disposers) {
          try { dispose() } catch (error) { /* 忽略拆卸期错误 */ }
        }
      }
    }

    exports.__test = {
      parseBoardArgs, aspectRatio, thinPoints, rdp, regionBounds, pointInPoly, pointInStroke,
      hitTest, regionAreaPct, rasterize, gridToString, connectedComponents, analyzeBoard,
      normalizeHex, withAlpha, buildPayload, round3, storeKey, MSG_PREFIX, GRID_COLS, PALETTE,
      clampView, ZOOM_MIN, ZOOM_MAX, pushHistory, HISTORY_LIMIT, MAX_REGIONS,
    }

    return module.exports
  },
})
