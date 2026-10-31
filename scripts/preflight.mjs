/**
 * 重启前的**兼容性预检**：不启动 DSH，把真正会被加载的东西逐层跑一遍。
 *
 *   1. 所有 lib/**\/*.js 语法；
 *   2. 宿主插件：用 test/harness.mjs 真加载 lib/index.js，确认 12 个工具全注册；
 *   3. 客户端 bundle：在 vm 里**按宿主的方式**跑 profile 里那份（含注入的路径），
 *      连跑两次（宿主会拼接两次），确认不抛、不重复注册、apply 能挂上 tab；
 *   4. profile 装配：package.json 的 bundle/dependency、cordis.patch.yml、views.json；
 *   5. 画板本地服务：真起一个服务，验证首页 / cookie / 静态资源 / 鉴权 / POST。
 *
 * 用法：node scripts/preflight.mjs
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { register } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

// 宿主才有的两个包（@deepseek-ai/dsh-tools、schemastery）在插件目录里没有，
// 用测试 loader 映射到桩，才能真加载 lib/index.js。
register(new URL('../test/loader.mjs', import.meta.url))

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const profile = path.join(homedir(), '.dsh', 'profiles', 'desktop')
const installed = path.join(profile, 'node_modules', 'dsh-chemflow')

let failed = 0
const pass = (label, extra = '') => console.log(`  ✓ ${label}${extra ? `  ${extra}` : ''}`)
const fail = (label, detail = '') => {
  failed += 1
  console.log(`  ✗ ${label}${detail ? `\n      ${detail}` : ''}`)
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (full.endsWith('.js')) out.push(full)
  }
  return out
}

/* 0. profile 是否与源码同步 ---------------------------------------------- */
console.log('\n[0] profile 与源码是否一致')
if (!existsSync(installed)) {
  fail('profile 里没有安装目录', installed)
} else {
  const relative = ['index.js', 'client.js', 'tools/view.js', 'tools/export.js', 'export/formats.js', 'export/layout2d.js',
    'view/pack.js', 'view/structure.js', 'view/cube.js', 'view/surface.js', 'view/resample.js',
    'sketch/server.js', 'sketch/info.js']
  const stale = []
  for (const rel of relative) {
    const sourceFile = path.join(root, 'lib', rel)
    const installedFile = path.join(installed, 'lib', rel)
    if (!existsSync(sourceFile) || !existsSync(installedFile)) {
      stale.push(`${rel}（缺文件）`)
      continue
    }
    let installedText = readFileSync(installedFile, 'utf8')
    // client.js 里有两个路径是装配时注入的，比对前先还原成占位符
    installedText = installedText
      .replace(/const INDEX_PATH = '[^']+';/, "const INDEX_PATH = '__DSH_CHEMFLOW_INDEX__';")
      .replace(/const SKETCH_INFO_PATH = '[^']+';/, "const SKETCH_INFO_PATH = '__DSH_CHEMFLOW_SKETCH__';")
    if (installedText !== readFileSync(sourceFile, 'utf8')) stale.push(rel)
  }
  if (stale.length > 0) fail('profile 里的文件不是最新的', `先跑 install-profile.mjs --sync：${stale.join(', ')}`)
  else pass(`${relative.length} 个文件一致`)
}

/* 1. 语法 ---------------------------------------------------------------- */
console.log('\n[1] 语法检查')
const files = walk(path.join(root, 'lib'))
let syntaxOk = 0
for (const file of files) {
  try {
    // lib 是 ESM，只能用 `node --check`；vm.Script 会按 CommonJS 编译，全是假报错。
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' })
    syntaxOk += 1
  } catch (error) {
    fail(path.relative(root, file), String(error.stderr ?? error.message).trim().split('\n')[0])
  }
}
if (syntaxOk === files.length) pass(`${files.length} 个文件`)

/* 2. 宿主插件 ------------------------------------------------------------ */
console.log('\n[2] 宿主插件加载（真 import + apply）')
try {
  const { createHarness } = await import('../test/harness.mjs')
  const harness = await createHarness()
  const expected = ['chem_env', 'chem_orca', 'chem_orca_states', 'chem_hole_electron', 'chem_orbital',
    'chem_aromatic', 'chem_esp', 'chem_render', 'chem_view', 'chem_views', 'chem_export', 'chem_sketch', 'chem_3d', 'chem_multiwfn']
  const missing = expected.filter((name) => !harness.tools.has(name))
  if (missing.length > 0) fail('工具注册不全', `缺：${missing.join(', ')}`)
  else pass(`${harness.names.length} 个工具`, harness.names.join(' '))

  const view = harness.tools.get('chem_view')
  const params = Object.keys(view?.parameters ?? {})
  const wanted = ['volumes', 'structure', 'hole', 'electron', 'xyz', 'outDir', 'name', 'title', 'maxDim']
  const absent = wanted.filter((key) => !params.includes(key))
  if (absent.length > 0) fail('chem_view 参数不全', `缺：${absent.join(', ')}`)
  else pass('chem_view 参数', params.join(' '))
} catch (error) {
  fail('加载 lib/index.js 失败', error.stack ?? String(error))
}

/* 3. 客户端 bundle（profile 里那份，带注入路径） ------------------------- */
console.log('\n[3] 客户端 bundle（profile 副本，跑两次）')
const clientPath = path.join(installed, 'lib', 'client.js')
if (!existsSync(clientPath)) {
  fail('profile 里没有 client.js')
} else {
  const source = readFileSync(clientPath, 'utf8')

  if (source.includes('__DSH_CHEMFLOW_INDEX__')) {
    fail('列表路径占位符没被注入', 'install-profile.mjs 的注入步骤没跑到')
  } else {
    const injected = /const INDEX_PATH = '([^']+)';/.exec(source)?.[1]
    if (injected && existsSync(injected)) pass('列表路径注入', injected)
    else fail('列表路径指向的文件不存在', injected ?? '(没匹配到)')
  }

  // 画板登记文件：服务没启动时文件本来就不存在，只要求路径被注入到数据目录下。
  if (source.includes('__DSH_CHEMFLOW_SKETCH__')) {
    fail('画板路径占位符没被注入', 'install-profile.mjs 的注入步骤没跑到')
  } else {
    const injected = /const SKETCH_INFO_PATH = '([^']+)';/.exec(source)?.[1]
    if (injected && existsSync(path.dirname(injected))) pass('画板登记路径注入', injected)
    else fail('画板登记路径的目录不存在', injected ?? '(没匹配到)')
  }

  const registered = []
  let captured = null
  // 重复注册的 warn 是**预期行为**（宿主会拼接两次），不要让它污染输出。
  const quiet = { log: console.log, warn() {}, error: console.error }
  const sandbox = {
    console: quiet,
    document: {
      head: { appendChild() {} },
      querySelector: () => null,
      createElement: () => ({ dataset: {}, style: {}, appendChild() {}, addEventListener() {}, querySelector: () => null }),
    },
    Image: function Image() {},
  }
  sandbox.globalThis = sandbox
  sandbox.window = {
    __ModuleLoader__: {
      load({ id, factory }) {
        if (registered.includes(id)) {
          throw new Error(`duplicate factory registration for "${id}"`)
        }
        registered.push(id)
        const fakeRequire = (name) => {
          if (name === 'react') return { createElement: () => null, useRef: () => ({}), useEffect: () => {} }
          throw new Error(`unexpected require: ${name}`)
        }
        captured = factory(fakeRequire)
      },
    },
  }
  vm.createContext(sandbox)

  try {
    vm.runInContext(source, sandbox)
    vm.runInContext(source, sandbox) // 宿主会拼接两次
    if (registered.length === 1 && registered[0] === 'dsh-chemflow') pass('注册 id', registered[0])
    else fail('注册 id 不对', JSON.stringify(registered))
  } catch (error) {
    fail('bundle 执行失败', error.message)
  }

  if (captured) {
    const tabs = []
    const slots = []
    const ctx = {
      sidebarRightTabs: { register: (def) => { tabs.push(def); return () => {} } },
      slots: { inject: (name, fn) => fn(), register: (def) => { slots.push(def); return () => {} } },
      get: (name) => (name === 'sidebarRight' ? { openTab() {} } : undefined),
      effect: (fn) => fn(),
    }
    try {
      captured.apply(ctx)
      const kinds = tabs.map((t) => t.kind)
      const wantKinds = ['chem-structure', 'chem-structure-index', 'chem-sketch']
      if (wantKinds.every((k) => kinds.includes(k))) pass('tab 类型', kinds.join(' + '))
      else fail('tab 类型没注册全', JSON.stringify(kinds))
      const headers = slots.filter((s) => s.name === 'conversation.session.header.utilities')
      if (headers.length === 1) pass('头部按钮组', '1 组（结构 + 画板两个图标）')
      else fail('头部按钮组数量不对（应为 1 组）', `${headers.length} 组`)
      const inject = captured.inject ?? []
      if (inject.includes('sidebarRight')) fail('sidebarRight 不能写进 inject（会让插件停在 PENDING）')
      else pass('inject 名单', inject.join(' '))
    } catch (error) {
      fail('apply 抛错', error.message)
    }
  } else {
    fail('拿不到 factory 的导出')
  }
}

/* 4. profile 装配 -------------------------------------------------------- */
console.log('\n[4] profile 装配')
try {
  const pkg = JSON.parse(readFileSync(path.join(profile, 'package.json'), 'utf8'))
  if (pkg.dependencies?.['dsh-chemflow']) pass('依赖声明', pkg.dependencies['dsh-chemflow'])
  else fail('package.json 里没有 dsh-chemflow 依赖')
  if ((pkg.dsh?.profile?.bundles ?? []).includes('dsh-chemflow')) pass('bundles 已列')
  else fail('dsh.profile.bundles 里没有 dsh-chemflow')
} catch (error) {
  fail('读 profile package.json 失败', error.message)
}

try {
  const yml = readFileSync(path.join(profile, 'cordis.patch.yml'), 'utf8')
  if (yml.includes('dsh-chemflow')) pass('cordis.patch.yml 有本插件配置')
  else fail('cordis.patch.yml 没有本插件配置')
} catch (error) {
  fail('读 cordis.patch.yml 失败', error.message)
}

try {
  const indexFile = path.join(homedir(), '.dsh', 'dsh-chemflow', 'views.json')
  const data = JSON.parse(readFileSync(indexFile, 'utf8'))
  pass('视图列表可解析', `${data.items?.length ?? 0} 条`)
} catch (error) {
  fail('views.json 读不了', error.message)
}

/* 5. 画板本地服务（真起一个，跑完就关） ---------------------------------- */
console.log('\n[5] 画板服务自检')
try {
  const { startSketchServer } = await import('../lib/sketch/server.js')
  const rootDir = path.join(root, 'lib', 'sketch', 'spike')
  const logFile = path.join(tmpdir(), `chemflow-preflight-${Date.now()}.log`)
  const server = await startSketchServer({ rootDir, outDir: tmpdir(), token: 'preflight-token', port: 0, logFile })
  try {
    // token 在**路径**里（`/s/<token>/`）：iframe 里 cookie 不可靠，子资源靠相对路径继承前缀。
    const page = await fetch(server.url)
    const html = await page.text()
    if (page.status === 200 && html.includes('传输层自检')) pass('首页', `${page.status}, ${html.length} B`)
    else fail('首页打不开', `status=${page.status}`)
    if (html.includes('src="spike.js"')) pass('页面用相对路径引用脚本')
    else fail('页面里是绝对路径，子资源会 403')

    const wasm = await fetch(`${server.url}tiny.wasm`)
    const bytes = await wasm.arrayBuffer()
    const okWasm = WebAssembly.validate(bytes)
    if (wasm.status === 200 && okWasm) pass('静态资源 + wasm 合法', `${bytes.byteLength} B`)
    else fail('wasm 资源有问题', `status=${wasm.status}`)

    const unauthorized = await fetch(`${server.origin}/spike.js`)
    if (unauthorized.status === 403) pass('无 token 前缀被拒', '403')
    else fail('无 token 前缀也能读（鉴权失效）', `status=${unauthorized.status}`)

    const saved = await fetch(`${server.url}api/log`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'preflight' }),
    })
    if (saved.status === 200 && existsSync(logFile)) pass('POST 接口写日志')
    else fail('POST 接口没写日志', `status=${saved.status}`)
  } finally {
    await server.close()
    try { rmSync(logFile, { force: true }) } catch { /* 忽略 */ }
  }
} catch (error) {
  fail('画板服务起不来', error.stack ?? String(error))
}

/* 6. Ketcher 静态产物（装没装、关键文件齐不齐） ------------------------- */
console.log('\n[6] Ketcher 画板产物')
const ketcherDir = path.join(homedir(), '.dsh', 'dsh-chemflow', 'sketch')
if (!existsSync(path.join(ketcherDir, 'index.html'))) {
  console.log('  – 未安装（chem_sketch serve 会退回自检页；要装就跑 node scripts/build-sketcher.mjs）')
} else {
  const required = ['index.html', 'app.js', 'app.css', 'indigoWorker-d22340fa.js', 'indigo-ketcher-1.46.0.wasm']
  const missing = required.filter((name) => !existsSync(path.join(ketcherDir, name)))
  if (missing.length === 0) {
    const total = required.reduce((sum, name) => sum + statSync(path.join(ketcherDir, name)).size, 0)
    pass('关键文件齐', required.length + ' 个，' + (total / 1024 / 1024).toFixed(1) + ' MB')
  } else {
    fail('缺文件', missing.join(', ') + '（重跑 scripts/build-sketcher.mjs）')
  }

  // 真起一个服务，确认 index.html 用 module、app.js 与 wasm 都能取到
  try {
    const { startSketchServer } = await import('../lib/sketch/server.js')
    const server = await startSketchServer({ rootDir: ketcherDir, token: 'ketcher-preflight', port: 0 })
    try {
      const page = await fetch(server.url)
      const html = await page.text()
      if (page.status === 200 && html.includes('type="module"')) pass('页面用 module 加载')
      else fail('Ketcher 页面不对', 'status=' + page.status)
      const app = await fetch(server.url + 'app.js', { method: 'HEAD' })
      const wasm = await fetch(server.url + 'indigo-ketcher-1.46.0.wasm', { method: 'HEAD' })
      const appMb = (statSync(path.join(ketcherDir, 'app.js')).size / 1024 / 1024).toFixed(1)
      if (app.status === 200 && wasm.status === 200) pass('app.js / wasm 可取', `app=${appMb}MB, wasm 200`)
      else fail('静态资源取不到', 'app=' + app.status + ' wasm=' + wasm.status)
    } finally {
      await server.close()
    }
  } catch (error) {
    fail('Ketcher 服务起不来', error.message ?? String(error))
  }
}

console.log(`\n${failed === 0 ? '预检通过，可以重启。' : `预检发现 ${failed} 个问题，先别重启。`}`)
process.exit(failed === 0 ? 0 : 1)
