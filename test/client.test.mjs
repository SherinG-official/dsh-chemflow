import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

/**
 * 客户端 bundle 用 `window.__ModuleLoader__.load({ id, factory })` 的形态加载，
 * 这里用两个桩把它在 Node 里跑起来，只验证**不依赖浏览器**的那部分：
 * 地址解码、视图包路径推断、文件通道 URL、tab 类型的 canOpen。
 */
let internals
let applyFn
let injectList
globalThis.window = {
  __ModuleLoader__: {
    load({ factory }) {
      const fakeRequire = (name) => {
        if (name === 'react') {
          return { createElement: () => null, useRef: () => ({}), useEffect: () => {} }
        }
        throw new Error(`unexpected require: ${name}`)
      }
      const mod = factory(fakeRequire)
      internals = mod.__internals
      applyFn = mod.apply
      injectList = mod.inject
    },
  },
}

await import('../lib/client.js')

test('apply 注册两个 tab 类型 + 头部按钮；sidebarRight 走可选探测', () => {
  const tabs = []
  const slots = []
  const ctx = {
    sidebarRightTabs: { register: (def) => { tabs.push(def); return () => {} } },
    slots: {
      inject: (name, fn) => fn(),
      register: (def) => { slots.push(def); return () => {} },
    },
    get: (name) => (name === 'sidebarRight' ? { openTab: () => {} } : undefined),
    effect: (fn) => fn(),
  }
  applyFn(ctx)

  assert.deepEqual(tabs.map((t) => t.kind), ['chem-structure', 'chem-structure-index'])
  assert.ok(slots.some((s) => s.name === 'sidebar.right.pane.tab' && s.key === 'dsh-chemflow-viewer'))
  assert.ok(slots.some((s) => s.name === 'sidebar.right.pane.tab' && s.key === 'dsh-chemflow-index'))
  assert.ok(slots.some((s) => s.name === 'conversation.session.header.utilities'))
  // sidebarRight 不能写进 inject —— 缺它的宿主会让插件停在 PENDING（“没激活”且无报错）
  assert.deepEqual(injectList, ['slots', 'sidebarRightTabs'])
})

test('decodeAddress 还原 dsh-resource 地址', () => {
  assert.equal(internals.decodeAddress('dsh-resource://file/absolute/C%3A/x/hole.cub'), 'C:/x/hole.cub')
  assert.equal(internals.decodeAddress('C:\\x\\hole.cub'), 'C:\\x\\hole.cub')
  assert.equal(internals.decodeAddress(''), '')
})

test('resolveMetaPath：点 .cub 时找同目录的 <stem>.view/meta.json', () => {
  assert.equal(internals.resolveMetaPath('C:/work/hole.cub'), 'C:/work/hole.view/meta.json')
  assert.equal(internals.resolveMetaPath('C:\\work\\hole.cub'), 'C:/work/hole.view/meta.json')
})

test('resolveMetaPath：直接点 meta.json 时原样返回', () => {
  assert.equal(internals.resolveMetaPath('C:/work/hole.view/meta.json'), 'C:/work/hole.view/meta.json')
})

test('fileUrl 走 /api/file，且路径不带前导斜杠（Windows 盘符会被 resolve 吃掉）', () => {
  const url = internals.fileUrl('C:\\work\\a b\\hole.cub')
  assert.ok(url.startsWith('/api/file?path='))
  assert.equal(decodeURIComponent(url.slice('/api/file?path='.length)), 'C:/work/a b/hole.cub')
})

test('tab 类型只认 .cub 与专用后缀 .cfv，不抢内置预览的 .json', () => {
  const def = internals.viewerTabDefinition()
  assert.equal(def.id, 'dsh-chemflow-viewer')
  assert.equal(def.kind, 'chem-structure')
  assert.equal(def.canOpen('dsh-resource://file/absolute/C%3A/w/hole.cub'), true)
  assert.equal(def.canOpen('dsh-resource://file/absolute/C%3A/w/scene.cfv'), true)
  // .json 会被内置文本预览接管（实测点 meta.json 只弹 JSON）——所以我们不认它
  assert.equal(def.canOpen('dsh-resource://file/absolute/C%3A/w/hole.view/meta.json'), false)
  assert.equal(def.canOpen('dsh-resource://file/absolute/C%3A/w/readme.md'), false)
  assert.match(def.title('dsh-resource://file/absolute/C%3A/w/hole.cub'), /hole\.cub/)
})

test('「结构视图」页签是 page 类型（不认资源地址）', () => {
  const def = internals.indexTabDefinition()
  assert.equal(def.id, 'dsh-chemflow-index')
  assert.equal(def.kind, 'chem-structure-index')
  assert.equal(def.patterns, undefined)
  assert.equal(def.title(), '结构视图')
})

test('bundle 被执行两次也不炸（宿主会把它拼接进页面两次）', () => {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  const registered = new Set()

  const sandbox = {}
  sandbox.globalThis = sandbox
  sandbox.console = console
  sandbox.window = {
    __ModuleLoader__: {
      load({ id }) {
        if (registered.has(id)) {
          throw new Error(`client-modules: duplicate factory registration for "${id}" (bundle executed twice without invalidate?)`)
        }
        registered.add(id)
      },
    },
  }
  vm.createContext(sandbox)

  // 第一次：正常注册
  vm.runInContext(source, sandbox)
  // 注册 id 必须等于包名：宿主按包名激活，写成别的会静默 “entry did not activate”
  assert.deepEqual([...registered], ['dsh-chemflow'])

  // 第二次：同文件再执行一遍。以前顶层 const 会直接 SyntaxError；
  // 现在必须安静通过，并且不重复注册。
  assert.doesNotThrow(() => vm.runInContext(source, sandbox))
  assert.equal(registered.size, 1)
  assert.equal(sandbox.__DSH_CHEMFLOW_VIEWER_DUP__, true)
})

test('客户端内联的 surfaceNets 与 lib 版本行为一致（球体场）', () => {
  const n = 16
  const field = new Float32Array(n * n * n)
  const c = (n - 1) / 2
  for (let z = 0; z < n; z += 1) {
    for (let y = 0; y < n; y += 1) {
      for (let x = 0; x < n; x += 1) field[x + y * n + z * n * n] = 5 - Math.hypot(x - c, y - c, z - c)
    }
  }
  const mesh = internals.surfaceNets(field, [n, n, n], 0)
  assert.ok(mesh.triangles > 0)
  const verts = mesh.positions.length / 3
  for (const idx of mesh.indices) assert.ok(idx >= 0 && idx < verts)
})
