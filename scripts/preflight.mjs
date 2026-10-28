/**
 * 重启前的**兼容性预检**：不启动 DSH，把真正会被加载的东西逐层跑一遍。
 *
 *   1. 所有 lib/**\/*.js 语法；
 *   2. 宿主插件：用 test/harness.mjs 真加载 lib/index.js，确认 10 个工具全注册；
 *   3. 客户端 bundle：在 vm 里**按宿主的方式**跑 profile 里那份（含注入的列表路径），
 *      连跑两次（宿主会拼接两次），确认不抛、不重复注册、apply 能挂上 tab；
 *   4. profile 装配：package.json 的 bundle/dependency、cordis.patch.yml、views.json。
 *
 * 用法：node scripts/preflight.mjs
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { register } from 'node:module'
import { homedir } from 'node:os'
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
  const relative = ['index.js', 'client.js', 'tools/view.js', 'view/pack.js', 'view/structure.js', 'view/cube.js', 'view/surface.js', 'view/resample.js']
  const stale = []
  for (const rel of relative) {
    const sourceFile = path.join(root, 'lib', rel)
    const installedFile = path.join(installed, 'lib', rel)
    if (!existsSync(sourceFile) || !existsSync(installedFile)) {
      stale.push(`${rel}（缺文件）`)
      continue
    }
    let installedText = readFileSync(installedFile, 'utf8')
    // client.js 的列表路径是装配时注入的，比对前先还原成占位符
    installedText = installedText.replace(/const INDEX_PATH = '[^']+';/, "const INDEX_PATH = '__DSH_CHEMFLOW_INDEX__';")
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
    'chem_aromatic', 'chem_esp', 'chem_render', 'chem_view', 'chem_views', 'chem_multiwfn']
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
      if (kinds.includes('chem-structure') && kinds.includes('chem-structure-index')) pass('tab 类型', kinds.join(' + '))
      else fail('tab 类型没注册全', JSON.stringify(kinds))
      if (slots.some((s) => s.name === 'conversation.session.header.utilities')) pass('头部按钮')
      else fail('头部按钮没注册')
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

console.log(`\n${failed === 0 ? '预检通过，可以重启。' : `预检发现 ${failed} 个问题，先别重启。`}`)
process.exit(failed === 0 ? 0 : 1)
