/**
 * dsh-partition-board —— 分区画板（Host 半边）。
 *
 * 这个插件提供两样东西：
 *   1) tool  `partition_board`：AI 认为需要跟人确认「怎么分区」时自主调用。工具**立即返回**，
 *      不阻塞；浏览器侧的画板组件从工具参数的实时流里解析出规格并弹出画板。
 *   2) skill `partition-board`：教 AI 什么时候该弹板、怎么读画板回传的状态、怎么按用途
 *      解读最终规划。
 *
 * 为什么是「消息式往返」而不是「阻塞式等用户画完」——两条都是核过源码的事实：
 *   - 客户端 → 宿主唯一的安全信道是 `conversation.send(text)`（genui 的 [genui-action] 走的就是它）。
 *     宿主 → 客户端的自定义 waterfall 不可用：`dsh-api-remotes` 的转发事件白名单是编译期固定的，
 *     第三方插件加不进去；复用现成的 `user-questions/request` 会被内置问题卡抢先应答
 *     （`ctx.remote.$on` 没有优先级参数，注册顺序 = 插件加载顺序，内置的在前面）。
 *   - 阻塞式也省不了回合：AI 重新规划本来就需要一次模型回合，所以阻塞零收益、纯风险。
 *
 * 本文件刻意**零外部依赖**（不 import dsh-tools / schemastery / cordis）：
 * `link:` 安装的插件靠 profile 的 node_modules 解析，少一条 import 边就少一个装载期失败点。
 * 参数用 enforced JSON-Schema 子集直接声明，工具定义以普通对象注册。
 *
 * @module dsh-partition-board
 */

import { readFileSync } from 'node:fs'

export const name = 'dsh-partition-board'

/**
 * `skills` 也走 inject 硬依赖：装载器会等注册表就绪再 apply，
 * 用 `ctx.get('skills')` 反而可能拿到 undefined（fiber 时序，见 dsh-bench 的同类注释）。
 * apply 里仍保留 fail-soft 守卫：真拿不到就只跳过 skill，不影响画板。
 */
export const inject = ['tools', 'skills']

const TOOL_NAME = 'partition_board'
const SKILL_NAME = 'partition-board'
const MAX_DESC_CHARS = 900

/* ────────────────────────────────── 工具文案 ────────────────────────────────── */

const TOOL_DESCRIPTION = [
  '分区画板：在浏览器弹出一块画板，让人用「颜色↔含义」的色卡亲手画出分区，你再补全剩下的一起确认。用在「怎么分块」这种**写文字又长又说不清、画一笔就明白**的事上。',
  '该调（属于下面任何一条就先调，别急着写文字）：',
  '① 页面/组件/界面区块怎么分、谁包着谁、哪块自适应；② 图像·海报·封面·信息图的构图切分与视觉重心；③ 文档/报告的分节与篇幅配比；④ 素材/数据分堆的边界；⑤ 用户说「画个图给我看」「我在画板上标给你」「这样说不清」「我说不上来哪儿不对」；⑥ 任何你拿不准的空间关系 —— 不确定就调，用 purpose="other"。',
  '**别用「这个我自己写几行就能说清」把它挡掉**：分节、排版、构图这类事你只是猜得准，不是知道。看起来越简单越值得让他画一笔 —— 用户十秒钟的事，能省掉来回好几轮。宁可多调一次。',
  '不要用它问是非题/二选一（那是 ask_user_question），也不要拿它展示成品（那是 render_ui）。',
  '',
  '调用很省，别被参数吓退：首轮给 purpose + task + ask 就够（legend 省了我先摆 4 个待命颜色，用户改个名字就能用）。',
  '例：partition_board({purpose:"ui-layout", task:"首页版式", ask:"先把顶栏、主区、侧栏涂出来"})',
  '**不阻塞**：调用立刻返回，用户在画板上画，你在对话里等。他画完/改完/确认时会收到一条 `[partition-board] {...}`：',
  '· `plan-request` 用户画完了 → 同一 boardId、revision+1 再调一次，把方案填进 regions（mode="review"），并**先读 `note`**（他顺手写的文字说明）；',
  '· `rework` 用户不满意 → 读 `feedback` 改，同样 revision+1；',
  '· `confirmed` 确认了 → `plan` 里有色卡含义 + 几何 + 羽化度 + 栅格矩阵，按 purpose 解读后直接写代码/大纲/分类规则。',
  '每次回传都带 `grid`（栅格矩阵，0=未标注）与 `stats`（覆盖率、未标注区、细小区）。坐标归一化 0..1。',
  '漏传 boardId、revision 忘了 +1 会被拒绝或新开空板。用户没动就在对话里继续，不用重试。',
].join('\n')

const SUMMARY_HINT = '画板已弹出，用户正在画。你这一轮不用再做别的：等他那条 [partition-board] 消息即可（他要是一直没动，就在对话里正常继续）。'

/* ─────────────────────────── enforced JSON-Schema 子集 ─────────────────────────── */

/**
 * 极简 author-spec → enforced JSON-Schema 子集编译器。
 * 覆盖 object/array/string/number/integer/boolean/json、`required: true`、`enum`、
 * `description`、`items`、`properties`、`additionalProperties`。
 */
function compileValueSpec(spec) {
  const source = spec === null || typeof spec !== 'object' ? {} : spec
  const out = {}
  if (typeof source.description === 'string') out.description = source.description
  if (Array.isArray(source.enum)) out.enum = [...source.enum]
  if (source.type === 'json') return out
  if (typeof source.type !== 'string') out.type = 'string'
  else out.type = source.type
  if (out.type === 'object') {
    out.additionalProperties = source.additionalProperties === true
    out.properties = {}
    const required = []
    for (const [key, value] of Object.entries(source.properties ?? {})) {
      if (value !== null && typeof value === 'object' && value.required === true) required.push(key)
      out.properties[key] = compileValueSpec(value)
    }
    if (required.length > 0) out.required = required
    return out
  }
  if (out.type === 'array') {
    out.items = compileValueSpec(source.items)
    return out
  }
  return out
}

function compileParameterSpec(spec) {
  return compileValueSpec({ type: 'object', additionalProperties: false, properties: spec ?? {} })
}

/* ────────────────────────────────── 归一化 ────────────────────────────────── */

const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/

/** 把任意 hex 归一到 `#rrggbb`；认不出来就返回 null（调用方回退到调色板）。 */
function normalizeColor(value) {
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (!HEX.test(text)) return null
  if (text.length === 4) {
    return ('#' + text[1] + text[1] + text[2] + text[2] + text[3] + text[3]).toLowerCase()
  }
  return text.toLowerCase()
}

function clamp01(value) {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : 0
  return n < 0 ? 0 : n > 1 ? 1 : n
}

function asString(value, fallback = '') {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback
}

/**
 * 归一化色卡：保证 id 唯一、颜色合法、名称非空。
 * @returns {{ legend: Array<object>, warnings: string[] }}
 */
function normalizeLegend(rawLegend) {
  const warnings = []
  const legend = []
  const seen = new Set()
  const list = Array.isArray(rawLegend) ? rawLegend : []
  for (let index = 0; index < list.length && legend.length < 24; index += 1) {
    const entry = list[index]
    if (entry === null || typeof entry !== 'object') continue
    let id = asString(entry.id)
    if (id === '' || seen.has(id)) id = 'c' + (legend.length + 1)
    if (seen.has(id)) continue
    seen.add(id)
    const color = normalizeColor(entry.color) ?? PALETTE[legend.length % PALETTE.length]
    if (normalizeColor(entry.color) === null) warnings.push(`色卡 ${id} 的 color 不合法，已回退到调色板`)
    legend.push({
      id,
      color,
      name: asString(entry.name, '分区' + (legend.length + 1)).slice(0, 40),
      meaning: asString(entry.meaning).slice(0, 200),
    })
  }
  return { legend, warnings }
}

/** 调色板：12 色，色相拉开且在白/深底上都可辨。 */
const PALETTE = [
  '#e5484d', '#0b7fd4', '#12a594', '#f5a524',
  '#8e4ec6', '#e93d82', '#46a758', '#0d74ce',
  '#d6409f', '#ffb224', '#6e56cf', '#30a46c',
]

function numberOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/** 归一化一个坐标点：裁剪到 0..1，保留 3 位小数（≈1000px 画布上的 1px）。 */
function normalizePoint(point) {
  if (!Array.isArray(point) || point.length < 2) return null
  const x = typeof point[0] === 'number' && Number.isFinite(point[0]) ? point[0] : null
  const y = typeof point[1] === 'number' && Number.isFinite(point[1]) ? point[1] : null
  if (x === null || y === null) return null
  return [Math.round(clamp01(x) * 1000) / 1000, Math.round(clamp01(y) * 1000) / 1000]
}

function normalizeRegion(rawRegion, legendIds, index) {
  if (rawRegion === null || typeof rawRegion !== 'object') return null
  const kind = ['rect', 'poly', 'stroke'].includes(rawRegion.kind) ? rawRegion.kind : 'rect'
  let region = {
    id: asString(rawRegion.id, 'r' + (index + 1)),
    colorId: asString(rawRegion.colorId, ''),
    label: asString(rawRegion.label).slice(0, 40),
    kind,
    softness: clamp01(numberOr(rawRegion.softness, 0.15)),
    source: rawRegion.source === 'ai' ? 'ai' : 'user',
    note: asString(rawRegion.note).slice(0, 300),
  }
  if (legendIds.size > 0 && !legendIds.has(region.colorId)) region.colorId = ''
  if (kind === 'rect') {
    const rect = Array.isArray(rawRegion.rect) ? rawRegion.rect : []
    if (rect.length < 4) return null
    const x = clamp01(numberOr(rect[0], 0))
    const y = clamp01(numberOr(rect[1], 0))
    const w = clamp01(numberOr(rect[2], 0))
    const hgt = clamp01(numberOr(rect[3], 0))
    if (w <= 0.002 || hgt <= 0.002) return null
    region.rect = [
      Math.round(x * 1000) / 1000,
      Math.round(y * 1000) / 1000,
      Math.round(Math.min(w, 1 - x) * 1000) / 1000,
      Math.round(Math.min(hgt, 1 - y) * 1000) / 1000,
    ]
    return region
  }
  const points = (Array.isArray(rawRegion.points) ? rawRegion.points : [])
    .map(normalizePoint)
    .filter((point) => point !== null)
  if (points.length < 2) return null
  region.points = points.slice(0, 600)
  if (kind === 'stroke') {
    region.width = Math.round(clamp01(numberOr(rawRegion.width, 0.05)) * 1000) / 1000
  }
  return region
}

/* ────────────────────────────────── 工具 ────────────────────────────────── */

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    text: { type: 'string', description: '模型可见的紧凑摘要' },
    data: { description: '结构化回执（供 PTC / 程序化消费）' },
  },
  required: ['text', 'data'],
}

function buildTool() {
  return {
    name: TOOL_NAME,
    description: TOOL_DESCRIPTION,
    parameters: compileParameterSpec({
      boardId: {
        type: 'string',
        description: '画板 id。第一次调用省略（自动取本次调用 id）；规划/返工/换版时**必须**传回同一个 id —— review 模式漏传会被直接拒绝（防止方案画到一块新开的空画板上），draw 模式省略则新开一块空画板。',
      },
      revision: {
        type: 'integer',
        description: '轮次，从 1 开始。每次针对同一 boardId 重出方案都要 +1；旧轮次在界面上会自动折叠。',
      },
      mode: {
        type: 'string',
        enum: ['draw', 'review'],
        description: 'draw=等用户动手画（首轮默认）；review=展示你规划出的方案让用户确认/返工。',
      },
      purpose: {
        type: 'string',
        enum: [
          'ui-layout', 'ui-regions', 'image-compose', 'doc-structure',
          'data-segmentation', 'diagram', 'other',
        ],
        description: '这块画板为什么服务。确认后你按它解读规划：ui-layout=界面区块与层级；image-compose=画面构图；doc-structure=文档分节；data-segmentation=数据/素材分段；diagram=图示分区。',
      },
      task: { type: 'string', description: '一句话说明这块画板要解决什么（会显示在画板标题栏）。' },
      ask: { type: 'string', description: '给用户看的一句操作指令，例如「先把首页的主区和侧栏涂出来」。' },
      canvas: {
        type: 'object',
        description: '画布设定。',
        additionalProperties: false,
        properties: {
          aspect: { type: 'string', description: '16:9 | 4:3 | 1:1 | 3:4 | 9:16，默认 16:9。' },
          guide: { type: 'string', description: '底图/参考说明，例如「首页线框：顶栏+左导航+主区+右栏」。会淡淡显示在画布上做参照。' },
        },
      },
      legend: {
        type: 'array',
        description: '初始色卡：颜色 ↔ 含义。这是画板的图例，也是你之后解读分区的唯一依据，务必给出有区分度的名称。',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', required: true, description: '色卡 id，短字符串，如 a/b/hero；regions 用它引用。' },
            color: { type: 'string', required: true, description: '#rrggbb' },
            name: { type: 'string', required: true, description: '分区名，如「主内容区」「侧栏」' },
            meaning: { type: 'string', description: '这个分区意味着什么 / 判据，如「可滚动的正文，宽度自适应」' },
          },
        },
      },
      regions: {
        type: 'array',
        description: '你规划出的分区。坐标归一化到 0..1（左上原点），与像素无关。review 模式下用户会看到它们叠加在画布上。',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', description: '分区 id' },
            colorId: { type: 'string', required: true, description: '引用 legend 里的 id' },
            label: { type: 'string', description: '该分区的具体名字（可选，覆盖色卡名）' },
            kind: { type: 'string', enum: ['rect', 'poly', 'stroke'], description: 'rect 用 rect 字段；poly/stroke 用 points' },
            rect: { type: 'array', description: '[x, y, w, h]，归一化。kind=rect 时必填。' },
            points: { type: 'array', description: '[[x,y],...]，归一化。kind=poly 是闭合多边形；kind=stroke 是折线笔触。' },
            width: { type: 'number', description: 'stroke 的笔宽，归一化到画布短边，默认 0.05' },
            softness: { type: 'number', description: '0..1，边界羽化程度（模糊分区）。默认 0.15' },
            note: { type: 'string', description: '你在这块区域上想清了什么 / 依据什么这么分' },
          },
        },
      },
      targets: {
        type: 'array',
        description: '你要重点处理的未标注/细小分区 id（来自上一条 message 的 stats）。',
        items: { type: 'string' },
      },
    }),
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
    },
    timeoutMs: 30000,
    async execute(args) {
      const input = args !== null && typeof args === 'object' && !Array.isArray(args) ? args : {}
      const boardId = asString(input.boardId)
      const revision = Math.max(1, Math.round(numberOr(input.revision, 1)))
      const mode = input.mode === 'review' ? 'review' : 'draw'
      if (mode === 'review' && boardId === '') {
        throw new Error(
          'boardId 缺失：review 模式必须带上一条 [partition-board] 消息里的 boardId（同一次协作里保持不变），'
          + '否则方案会叠到一块新开的空画板上、用户看不到你规划的东西。'
          + '还没收到过 [partition-board] 消息的话：想先草拟一版给用户改，就用 mode="draw" 并把草图放进 regions'
          + '（画板会以虚线叠加、用户能直接改，效果一样），或者干脆先不带 regions 调一次让他自己画。',
        )
      }
      const purpose = asString(input.purpose, 'other')
      const canvas = input.canvas !== null && typeof input.canvas === 'object' ? input.canvas : {}
      const aspect = asString(canvas.aspect, '16:9')
      const { legend, warnings } = normalizeLegend(input.legend)
      const legendIds = new Set(legend.map((entry) => entry.id))
      const regions = (Array.isArray(input.regions) ? input.regions : [])
        .map((region, index) => normalizeRegion(region, legendIds, index))
        .filter((region) => region !== null)
        .slice(0, 200)

      const regionalNote = regions.filter((region) => region.colorId === '').length
      if (regionalNote > 0) {
        warnings.push(`${regionalNote} 个分区的 colorId 不在色卡里，画板上会显示为未着色并等你补`)
      }

      const bySource = { ai: 0, user: 0 }
      for (const region of regions) bySource[region.source] += 1

      const lines = [
        `画板已开 · boardId=${boardId === '' ? '(自动取本次调用 id)' : boardId} · revision=${revision} · mode=${mode}`,
        `用途=${purpose} · 画布=${aspect} · 色卡 ${legend.length} 色 · 你给出的分区 ${regions.length} 个（ai ${bySource.ai} / user ${bySource.user}）`,
      ]
      if (legend.length > 0) {
        lines.push('色卡：' + legend.map((entry) => `${entry.id}=${entry.name}(${entry.color})`).join(' · '))
      }
      for (const warning of warnings.slice(0, 6)) lines.push('! ' + warning)
      lines.push('')
      lines.push(mode === 'review' ? '方案已叠加到画板上，等用户点「确认最终规划」或「返工」。' : SUMMARY_HINT)
      lines.push('用户操作后你会收到一条 [partition-board] 开头的消息，按其中的 kind 继续。')

      return {
        text: lines.join('\n'),
        data: {
          tool: TOOL_NAME,
          boardId,
          revision,
          mode,
          purpose,
          aspect,
          legend,
          regionCount: regions.length,
          regionCountBySource: bySource,
          regions,
          warnings: warnings.slice(0, 12),
        },
      }
    },
  }
}

/* ────────────────────────────────── skill ────────────────────────────────── */

function readSkillBody() {
  return readFileSync(new URL('../skills/partition-board.md', import.meta.url), 'utf8')
}

const SKILL_DESCRIPTION =
  '分区画板协作协议：什么时候该请人在画板上划片、怎么读画板回传的状态、怎么按用途解读确认后的规划并推进项目。'

const SKILL_WHEN_TO_USE =
  '要在浏览器里跟人确认「怎么分区」时（界面区块、构图、文档分节、数据分段），'
  + '或你正要写 3 行以上的版式/构图描述、正要问用户 2 个以上空间问题时，'
  + '或收到了 [partition-board] 开头的消息时。'

/* ────────────────────────────────── 装配 ────────────────────────────────── */

export function apply(ctx) {
  if (ctx === null || ctx === undefined || ctx.tools === undefined
    || typeof ctx.tools.register !== 'function') {
    console.error('[dsh-partition-board] ctx.tools 不可用，工具未注册')
    return
  }

  ctx.tools.register(buildTool())

  const skills = ctx.skills
  if (skills === undefined || typeof skills.register !== 'function') {
    console.error('[dsh-partition-board] ctx.skills 不可用，skill 未注册（画板本身不受影响）')
    return
  }
  try {
    const content = readSkillBody()
    if (content.length > 0) {
      skills.register({
        name: SKILL_NAME,
        description: SKILL_DESCRIPTION.slice(0, MAX_DESC_CHARS),
        whenToUse: SKILL_WHEN_TO_USE,
        content,
        source: 'runtime',
      })
      console.log(`[dsh-partition-board] skill 已注册: ${SKILL_NAME} (${content.length} 字符)`)
    }
  } catch (error) {
    console.error('[dsh-partition-board] skill 注册失败: '
      + (error && error.message ? error.message : String(error)))
  }
}

export { TOOL_NAME, SKILL_NAME, normalizeLegend, normalizeRegion, compileParameterSpec, PALETTE }
