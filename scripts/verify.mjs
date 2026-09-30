/**
 * 安装期自检：把「这行插件真的会被装载器正确装配」这件事在装之前验掉。
 *
 * 覆盖四条真实契约：
 *   1. 文件清单齐全（少一个就会在启动期静默地少一半能力）。
 *   2. package.json 的 dsh.client / dsh.bundle / exports 指向的文件真的存在，
 *      且 bundle 补丁里的 name 跟包名一致（不一致 = Loader 解析不到包）。
 *   3. 浏览器 bundle 用包名注册 factory，并把画板挂到「宿主工具名」这个 key 上
 *      —— key 写错的表现是：插件装好了、工具能调，但画板永远不弹。
 *   4. Host 的 apply() 在桩 ctx 上真的注册出工具与 skill，且 skill 正文读得到
 *      （这条同时验证了 `new URL('../skills/...', import.meta.url)` 的路径解析）。
 */
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import vm from 'node:vm'

const ROOT = new URL('..', import.meta.url)
const at = (relative) => new URL(relative, ROOT)
const readJson = (relative) => JSON.parse(readFileSync(at(relative), 'utf8'))

const failures = []
const checks = []

function check(label, fn) {
  try {
    fn()
    checks.push(['ok', label])
  } catch (error) {
    checks.push(['fail', label + ' —— ' + (error && error.message ? error.message : String(error))])
    failures.push(label)
  }
}

/* ── 1. 文件清单 ── */
const REQUIRED = [
  'package.json',
  'cordis.patch.yml',
  'dsh.plugin.json',
  'lib/index.js',
  'client/client.js',
  'skills/partition-board.md',
  'README.md',
]

check('文件清单齐全', () => {
  for (const file of REQUIRED) {
    assert.ok(existsSync(at(file)), `缺少 ${file}`)
  }
})

/* ── 2. package.json 声明与补丁 ── */
const pkg = readJson('package.json')

check('包名与目录一致', () => {
  assert.equal(pkg.name, 'dsh-partition-board')
})

check('bundle 补丁存在且 name 与包名一致', () => {
  const patchPath = pkg.dsh?.bundle?.patch
  assert.ok(typeof patchPath === 'string', 'dsh.bundle.patch 必须是字符串')
  assert.ok(existsSync(at(patchPath)), `补丁文件不存在: ${patchPath}`)
  const patch = readFileSync(at(patchPath), 'utf8')
  assert.ok(patch.includes(`name: '${pkg.name}'`), `补丁里的 name 必须是 '${pkg.name}'`)
  assert.ok(patch.includes('- insert:'), '补丁必须是 insert 形式')
})

check('dsh.client 声明为 web 平台且导出 ./client', () => {
  assert.equal(pkg.dsh?.client?.platform, 'web')
  const clientExport = pkg.exports?.['./client']
  assert.ok(typeof clientExport === 'string', 'exports["./client"] 必须指向 bundle')
  assert.ok(existsSync(at(clientExport)), `client bundle 不存在: ${clientExport}`)
  assert.equal(pkg.main, pkg.exports?.['.'], 'main 应与 exports["."] 一致')
})

/* ── 3. 浏览器 bundle 的注册契约 ── */
function loadClientBundle() {
  const source = readFileSync(at('client/client.js'), 'utf8')
  const registered = []
  const sandbox = { window: { __ModuleLoader__: { load: (record) => registered.push(record) } }, console }
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox)
  assert.equal(registered.length, 1, 'bundle 必须只注册一个 factory')
  return registered[0]
}

let clientExports = null

check('bundle 用包名注册 factory', () => {
  const record = loadClientBundle()
  assert.equal(record.id, pkg.name, 'factory id 必须等于包名，否则装载器找不到它')
  assert.equal(typeof record.factory, 'function')
})

check('bundle 只依赖基线模块 react', () => {
  const record = loadClientBundle()
  const seen = new Set()
  // 桩 React：模块顶层就会取 createElement，返回 undefined 会立刻炸。
  const reactStub = {
    createElement: () => null,
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useRef: () => ({ current: null }),
    useEffect: () => {},
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
  }
  const exports_ = record.factory((name) => { seen.add(name); return name === 'react' ? reactStub : undefined })
  assert.deepEqual([...seen], ['react'], '除 react 外不应 require 任何模块（基线表里没有的会装载失败）')
  assert.equal(typeof exports_.apply, 'function')
  assert.equal(typeof exports_.__test, 'object')
  clientExports = exports_
})

let toolviewKey = null

check('工具行 + root 全屏层都注册上了，key = 宿主工具名', () => {
  const registrations = []
  const fakeCtx = {
    slots: {
      inject: (slot, callback) => { registrations.push({ kind: 'inject', slot }); const dispose = callback(); return typeof dispose === 'function' ? dispose : () => {} },
      register: (declaration) => { registrations.push({ kind: 'register', declaration }); return () => {} },
    },
  }
  const dispose = clientExports.apply(fakeCtx)
  assert.equal(typeof dispose, 'function', 'apply 必须返回拆卸函数（cordis 卸载时要收干净）')

  const injected = registrations.filter((entry) => entry.kind === 'inject').map((entry) => entry.slot)
  assert.deepEqual(injected, ['tool.call.toolview', 'shell.overlay'], '两个扩展点：工具行 + root 全屏层')

  const declarations = registrations.filter((entry) => entry.kind === 'register').map((entry) => entry.declaration)
  const toolview = declarations.find((entry) => entry.name === 'tool.call.toolview')
  const overlay = declarations.find((entry) => entry.name === 'shell.overlay')
  assert.ok(toolview !== undefined, 'tool.call.toolview 必须注册，否则画板永远不弹')
  assert.ok(overlay !== undefined, 'shell.overlay 必须注册，否则全屏会被聊天气泡的 transform 截断')
  assert.ok(typeof overlay.id === 'string' && overlay.id.length > 0, 'list 槽条目要有 id')
  assert.equal(typeof overlay.order, 'number', 'list 槽条目要有 order')
  assert.equal(typeof overlay.label, 'function', 'list 槽条目要有 label')

  toolviewKey = toolview.key
  assert.ok(typeof toolviewKey === 'string' && toolviewKey.length > 0, 'keyed slot 必须给 key')
})

/* ── 4. Host 半边在桩 ctx 上真的装配得出来 ── */
check('Host apply() 注册出工具与 skill', async () => {
  const tools = []
  const skills = []
  const fakeCtx = {
    tools: { register: (definition) => tools.push(definition) },
    skills: { register: (definition) => skills.push(definition) },
  }
  const host = await import('../lib/index.js')
  host.apply(fakeCtx)

  assert.equal(tools.length, 1, '应注册 1 个工具')
  const tool = tools[0]
  assert.equal(tool.name, host.TOOL_NAME)
  assert.ok(tool.description.length > 200, '工具描述必须足够教会模型协议与 boardId/revision 规则')
  assert.ok(tool.description.includes('boardId'), '描述里必须写清 boardId 的迭代规则')
  assert.equal(tool.parameters.type, 'object')
  assert.equal(tool.parameters.additionalProperties, false)
  for (const key of ['mode', 'purpose', 'legend', 'regions', 'boardId', 'revision', 'targets']) {
    assert.ok(tool.parameters.properties[key] !== undefined, `参数缺少 ${key}`)
  }
  assert.equal(tool.parameters.properties.legend.items.additionalProperties, false)
  assert.equal(typeof tool.execute, 'function')
  assert.equal(typeof tool.output.render, 'function')

  const output = await tool.execute({
    mode: 'review',
    purpose: 'ui-layout',
    revision: 2,
    boardId: 'demo',
    legend: [{ id: 'a', color: '#e5484d', name: '主区', meaning: '正文' }],
    regions: [{ colorId: 'a', kind: 'rect', rect: [0.1, 0.1, 0.3, 0.2], softness: 0.3 }],
  })
  assert.equal(typeof output.text, 'string')
  assert.ok(output.text.includes('boardId=demo'))
  assert.equal(output.data.regionCount, 1)
  assert.equal(output.data.regions[0].softness, 0.3)
  assert.deepEqual(tool.output.render(null, output), [{ type: 'text', text: output.text }])

  assert.equal(skills.length, 1, '应注册 1 个 skill')
  assert.equal(skills[0].name, host.SKILL_NAME)
  assert.ok(skills[0].content.length > 1500, `skill 正文太短，可能没读到文件（${skills[0].content.length} 字符）`)
  assert.ok(skills[0].content.includes('boardId'), 'skill 必须讲 boardId 规则')
  assert.ok(skills[0].content.includes('confirmed'), 'skill 必须讲三种 kind')
  assert.ok(skills[0].whenToUse.length > 0)

  assert.equal(toolviewKey, tool.name, `画板的 key ("${toolviewKey}") 必须等于工具名 ("${tool.name}")，否则画板永远不弹`)
})

/* ── 报告 ── */
const failuresAfter = checks.filter(([status]) => status === 'fail')
for (const [status, label] of checks) console.log(`${status === 'ok' ? '✔' : '✖'} ${label}`)
console.log(`\n${checks.length - failuresAfter.length}/${checks.length} 通过`)

if (failuresAfter.length > 0) {
  console.error('\n自检未通过，不要安装：')
  for (const [, label] of failuresAfter) console.error('  - ' + label)
  process.exit(1)
}
