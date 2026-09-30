/**
 * 无头渲染测试台。
 *
 * 为什么自己写一个最小 React：本机没有 react-dom（profile 里没装），而画板最可能的
 * 运行时故障就是「组件渲染时抛错」和「按钮点了不发消息」——这两类单测几何函数抓不到。
 * 这里实现 hooks / refs / 事件派发 / effect 刷新的最小子集，把真组件跑起来，
 * 然后检查它**实际发给模型的那条消息**。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

/* ─────────────────────── 载入浏览器 bundle ─────────────────────── */

export function loadClientBundle(options) {
  const opts = options === undefined ? {} : options
  const source = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
  const registered = []
  const store = new Map()
  // localStorage.setItem 的调用次数：存盘节流（不是每次改 state 都写盘）靠它断言
  let storeWrites = 0
  // 让 window 具备最小事件目标能力，测试才能派发 keydown（键盘快捷键要有地方验）
  const windowListeners = new Map()
  // ResizeObserver 桩：实例留着，测试手动「触发一次尺寸变化」，看画布有没有重画
  const resizeObservers = []
  class ResizeObserverStub {
    constructor(callback) {
      this.callback = callback
      this.targets = []
      this.disconnected = false
      resizeObservers.push(this)
    }

    observe(target) { this.targets.push(target) }

    unobserve() {}

    disconnect() { this.disconnected = true }

    /** 测试专用：模拟一次尺寸变化回调。 */
    trigger() {
      if (this.disconnected) return false
      this.callback([], this)
      return true
    }
  }
  const sandbox = {
    console,
    window: {
      __ModuleLoader__: { load: (record) => registered.push(record) },
      devicePixelRatio: 2,
      ResizeObserver: ResizeObserverStub,
      localStorage: {
        getItem: (key) => (store.has(key) ? store.get(key) : null),
        setItem: (key, value) => { store.set(key, String(value)); storeWrites += 1 },
        removeItem: (key) => { store.delete(key) },
      },
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (id) => clearTimeout(id),
      addEventListener: (type, listener) => {
        const set = windowListeners.get(type) || new Set()
        set.add(listener)
        windowListeners.set(type, set)
      },
      removeEventListener: (type, listener) => { windowListeners.get(type)?.delete(listener) },
      matchMedia: undefined,
    },
    document: {
      documentElement: {
        // lang 决定画板用哪套文案（不传 = 跟宿主页面一样「没说」→ 中文兜底）
        lang: typeof opts.lang === 'string' ? opts.lang : undefined,
        classList: { contains: () => false },
        dataset: {},
      },
    },
  }
  sandbox.navigator = { clipboard: undefined, language: opts.navLang }
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox)
  assert.equal(registered.length, 1)
  // 桩 React 必须在 factory 执行**之前**就绪：bundle 顶层第一行就 require('react')。
  const reactStub = createTestReact()
  const exports_ = registered[0].factory((name) => {
    if (name === 'react') return reactStub.React
    throw new Error('意外 require: ' + name)
  })
  exports_.__harness = {
    sandbox,
    store,
    get storeWrites() { return storeWrites },
    reactStub,
    resizeObservers,
    get canvasStubs() { return reactStub.canvasStubs },
    dispatch(type, event) {
      let handled = 0
      for (const listener of [...(windowListeners.get(type) || [])]) {
        listener(event)
        handled += 1
      }
      return handled
    },
    listenerCount(type) {
      return (windowListeners.get(type) || new Set()).size
    },
  }
  return exports_
}

/** 派发一次 keydown；默认目标是普通元素（不是在输入框里打字）。 */
export function pressKey(env, key, options = {}) {
  let prevented = false
  const event = {
    key,
    ctrlKey: options.ctrlKey === true,
    metaKey: options.metaKey === true,
    shiftKey: options.shiftKey === true,
    target: options.target ?? { tagName: 'DIV' },
    preventDefault() { prevented = true },
    stopPropagation() {},
  }
  const handled = env.client.__harness.dispatch('keydown', event)
  return { handled, prevented }
}

/* ─────────────────────── 最小 React ─────────────────────── */

const sameDeps = (a, b) => Array.isArray(a) && Array.isArray(b)
  && a.length === b.length && a.every((value, index) => Object.is(value, b[index]))

export function createTestReact() {
  const hooks = new Map()
  let currentKey = 'root'
  let hookIndex = 0
  const effects = []
  const canvasLog = []
  // 本测试台每轮渲染都会新建一份 DOM 桩（真 React 会复用同一个节点），
  // 所以「挂在节点上的原生监听」会留在最早那一轮的桩上。要派发这类事件，
  // 得先按「哪个桩拿到了监听」找到它，别假设它就是最后一棵树里的那个。
  const canvasStubs = []
  let renders = 0

  function slot(index, initial) {
    const list = hooks.get(currentKey) || []
    if (list[index] === undefined) list[index] = initial
    hooks.set(currentKey, list)
    return list
  }

  const React = {
    createElement(type, props, ...children) {
      const next = { ...(props || {}) }
      if (children.length === 1) next.children = children[0]
      else if (children.length > 1) next.children = children
      return { type, props: next }
    },
    useState(initial) {
      const index = hookIndex++
      const list = slot(index, { value: undefined })
      if (list[index].value === undefined) {
        list[index].value = typeof initial === 'function' ? initial() : initial
      }
      return [list[index].value, (value) => {
        list[index].value = typeof value === 'function' ? value(list[index].value) : value
      }]
    },
    useRef(initial) {
      const index = hookIndex++
      const list = slot(index, { ref: { current: initial } })
      return list[index].ref
    },
    useMemo(fn, deps) {
      const index = hookIndex++
      const list = slot(index, { deps: undefined, value: undefined })
      if (list[index].deps === undefined || !sameDeps(list[index].deps, deps)) {
        list[index].value = fn()
        list[index].deps = deps
      }
      return list[index].value
    },
    useCallback(fn, deps) {
      const index = hookIndex++
      const list = slot(index, { deps: undefined, value: undefined })
      if (list[index].deps === undefined || !sameDeps(list[index].deps, deps)) {
        list[index].value = fn
        list[index].deps = deps
      }
      return list[index].value
    },
    useEffect(fn, deps) {
      const index = hookIndex++
      const list = slot(index, { deps: undefined, cleanup: undefined })
      if (list[index].deps === undefined || !sameDeps(list[index].deps, deps)) {
        list[index].deps = deps
        effects.push({ key: currentKey, index, fn })
      }
    },
  }

  /** 画布/输入元素的 DOM 桩：让 getBoundingClientRect 等契约真的可用。 */
  function domStubFor(type, props) {
    const dom = { ...props, tag: type }
    // 原生监听（滚轮缩放是绕过 React 自己挂非 passive 监听的），记下来供测试派发
    const domListeners = new Map()
    dom.addEventListener = (kind, listener) => {
      const set = domListeners.get(kind) || new Set()
      set.add(listener)
      domListeners.set(kind, set)
    }
    dom.removeEventListener = (kind, listener) => { domListeners.get(kind)?.delete(listener) }
    // focus/blur 桩：全屏夺焦这类无障碍行为要能断言「焦点真的搬过去了」
    dom.focused = false
    dom.focus = () => { dom.focused = true }
    dom.blur = () => { dom.focused = false }
    dom.dispatchDom = (kind, event) => {
      let handled = 0
      for (const listener of [...(domListeners.get(kind) || [])]) { listener(event); handled += 1 }
      return handled
    }
    dom.listenerCount = (kind) => (domListeners.get(kind) || new Set()).size
    if (type === 'canvas') {
      canvasStubs.push(dom)
      dom.width = 0
      dom.height = 0
      dom.clientWidth = props.__width || 800
      dom.clientHeight = props.__height || 450
      dom.getBoundingClientRect = () => ({ left: 0, top: 0, width: dom.clientWidth, height: dom.clientHeight })
      dom.setPointerCapture = () => {}
      dom.releasePointerCapture = () => {}
      // 所有 canvas 桩共用一份调用日志：绘制发生在哪一轮渲染不重要，重要的是「真的画了」。
      dom.drawCalls = canvasLog
      dom.getContext = () => createContext2D(canvasLog)
    }
    if (type === 'input' || type === 'textarea') dom.value = props.value === undefined ? '' : props.value
    return dom
  }

  function renderElement(element, key) {
    if (element === null || element === undefined || element === false || element === true) return null
    if (Array.isArray(element)) {
      const out = []
      for (let index = 0; index < element.length; index += 1) {
        const child = renderElement(element[index], key + '.' + index)
        if (child !== null) out.push(child)
      }
      return out
    }
    if (typeof element === 'string' || typeof element === 'number') {
      return { type: '#text', props: {}, text: String(element), children: [] }
    }
    if (typeof element.type === 'function') {
      const previousKey = currentKey
      const previousIndex = hookIndex
      currentKey = key
      hookIndex = 0
      const rendered = element.type({ ...element.props })
      currentKey = previousKey
      hookIndex = previousIndex
      return renderElement(rendered, key + '/')
    }
    const props = { ...element.props }
    const rawChildren = props.children === undefined ? [] : (Array.isArray(props.children) ? props.children : [props.children])
    delete props.children
    const dom = domStubFor(element.type, props)
    const ref = props.ref
    delete props.ref
    const out = { type: element.type, props, dom, children: [] }
    if (ref !== null && typeof ref === 'object') ref.current = dom
    const children = renderElement(rawChildren, key)
    out.children = children === null ? [] : (Array.isArray(children) ? children : [children])
    return out
  }

  return {
    React,
    /** 渲染一棵树；hooks 状态按 label + 元素路径保留，所以同一 label 重渲染 = React 的重渲染，
     *  不同 label（同一测试里挂载第二块画板）互不串状态。 */
    render(element, label) {
      renders += 1
      return renderElement(element, label === undefined ? 'root' : label)
    },
    flushEffects() {
      const pending = effects.splice(0, effects.length)
      for (const item of pending) {
        const list = hooks.get(item.key)
        if (list === undefined) continue
        const entry = list[item.index]
        // 上一轮的清理只在 effect 重跑或卸载时执行——像 React，而不是立刻执行。
        if (typeof entry.cleanup === 'function') entry.cleanup()
        const cleanup = item.fn()
        entry.cleanup = typeof cleanup === 'function' ? cleanup : undefined
      }
      return pending.length
    },
    get renderCount() { return renders },
    canvasStubs,
    reset() { hooks.clear(); effects.length = 0; renders = 0 },
  }
}

/** 记录调用的 2D 上下文桩：让绘制代码真的跑一遍，并留下可断言的痕迹。 */
function createContext2D(log) {
  const record = (name) => (...args) => { log.push([name, ...args]) }
  const noop = record('noop')
  return {
    log,
    setTransform: record('setTransform'),
    clearRect: record('clearRect'),
    fillRect: record('fillRect'),
    strokeRect: record('strokeRect'),
    save: record('save'),
    restore: record('restore'),
    beginPath: record('beginPath'),
    moveTo: record('moveTo'),
    lineTo: record('lineTo'),
    closePath: record('closePath'),
    fill: record('fill'),
    stroke: record('stroke'),
    fillText: record('fillText'),
    setLineDash: record('setLineDash'),
    measureText: (text) => ({ width: String(text).length * 7 }),
    filter: 'none',
    globalAlpha: 1,
    fillStyle: '#000',
    strokeStyle: '#000',
    lineWidth: 1,
    lineCap: 'butt',
    lineJoin: 'miter',
    font: '10px sans-serif',
    textAlign: 'start',
    textBaseline: 'alphabetic',
    unused: noop,
  }
}

/* ─────────────────────── 树查询与事件派发 ─────────────────────── */

export function textOf(node) {
  if (node === null || node === undefined) return ''
  if (node.type === '#text') return node.text
  return (node.children || []).map(textOf).join('')
}

export function findAll(node, predicate, out = []) {
  if (node === null || node === undefined) return out
  if (Array.isArray(node)) { for (const child of node) findAll(child, predicate, out); return out }
  if (predicate(node)) out.push(node)
  for (const child of node.children || []) findAll(child, predicate, out)
  return out
}

export function findOne(node, predicate) {
  const hits = findAll(node, predicate)
  assert.ok(hits.length > 0, '没找到目标节点')
  return hits[0]
}

/** 按可见文字找按钮。 */
export function findByButtonText(root, text) {
  return findOne(root, (node) => node.type === 'button' && textOf(node).includes(text))
}

/** 按 `data-dpb` 标记找容器（结构性断言用，不依赖样式对象）。 */
export function byMarker(root, marker) {
  return findOne(root, (node) => node.props !== undefined && node.props['data-dpb'] === marker)
}

/** 某个子树里有没有满足条件的节点。 */
export function contains(root, predicate) {
  return findAll(root, predicate).length > 0
}

let mountSequence = 0

/** 挂载一棵树，并让「重渲染」像 React 一样发生在每次事件之后。
 *  effect 里 setState 会再触发一轮渲染，所以这里循环直到没有新 effect。 */
export function mount(react, element) {
  const label = 'mount' + (mountSequence += 1)
  const api = {
    label,
    element,
    tree: null,
    rerender() {
      // 至少两轮：effect 里的 setState（例如夺键盘焦点）要有一轮把它读出来，
      // 否则依赖它的 effect 不会重挂。
      for (let round = 0; round < 8; round += 1) {
        api.tree = react.render(element, label)
        if (react.flushEffects() === 0 && round >= 1) break
      }
      return api.tree
    },
  }
  api.rerender()
  return api
}

const fakeEvent = (dom, extra) => ({
  currentTarget: dom,
  target: dom,
  preventDefault() {},
  stopPropagation() {},
  ...extra,
})

/** 点一个按钮（按可见文字找），点完重渲染。 */
export function click(mount, text) {
  const button = findByButtonText(mount.tree, text)
  assert.equal(typeof button.props.onClick, 'function', `按钮「${text}」没有 onClick`)
  button.props.onClick(fakeEvent(button.dom))
  mount.rerender()
  return button
}

/** 在画布上拖一次：down → move → up，每步之间重渲染（否则闭包里的 draft 是旧的）。 */
export function drag(mount, from, to) {
  return dragPath(mount, [from, to])
}

/** 多段路径（套索/笔刷需要 ≥3 点才能形成有效几何）。 */
export function dragPath(mount, points) {
  const canvasNode = () => findOne(mount.tree, (node) => node.type === 'canvas')
  const evt = (point) => fakeEvent(canvasNode().dom, { clientX: point[0], clientY: point[1], pointerId: 1 })
  canvasNode().props.onPointerDown(evt(points[0]))
  mount.rerender()
  for (let index = 1; index < points.length - 1; index += 1) {
    canvasNode().props.onPointerMove(evt(points[index]))
    mount.rerender()
  }
  const last = points[points.length - 1]
  canvasNode().props.onPointerMove(evt(last))
  mount.rerender()
  canvasNode().props.onPointerUp(evt(last))
  mount.rerender()
  return mount.tree
}
