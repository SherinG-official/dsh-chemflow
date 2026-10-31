// 构建 Ketcher 静态页，并装到数据目录（产物不进仓库）。
//
//   node scripts/build-sketcher.mjs            # 构建 + 安装
//   node scripts/build-sketcher.mjs --keep     # 构建后不删临时依赖目录
//
// 为什么不用官方打包版：ketcher-standalone 的打包版把 worker 内联成 blob，
// worker 里 `new URL('indigo-ketcher-*.wasm', import.meta.url)` 会以 blob: 为基准，
// wasm 永远找不到。这里用未打包的 `dist/binaryWasm/main.js` 自己打，worker/wasm 与原文件同目录。
//
// 另外 worker 源码里有 bare import（`@babel/runtime/helpers/*`），浏览器 module worker
// 解析不了，所以 worker 也要过一遍 esbuild（文件名保持不变，main.js 里写死了 hash 名）。

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.join(here, '..')
const work = path.join(tmpdir(), 'chemflow-ketcher-build')
const dataDir = path.join(homedir(), '.dsh', 'dsh-chemflow', 'sketch')
const keep = process.argv.includes('--keep')

const shim =
  "if (typeof globalThis.process === 'undefined') { globalThis.process = { env: { NODE_ENV: 'production' }, platform: 'browser', browser: true, versions: { node: '0' } }; }\n" +
  "if (typeof globalThis.global === 'undefined') { globalThis.global = globalThis; }"

const ENTRY = `import React from 'react'
import { createRoot } from 'react-dom/client'
import { Editor } from 'ketcher-react'
import { StandaloneStructServiceProvider } from 'ketcher-standalone/dist/binaryWasm'
import 'ketcher-react/dist/index.css'

const structServiceProvider = new StandaloneStructServiceProvider()

function post(payload) {
  window.parent?.postMessage({ source: 'chemflow-sketch', ...payload }, '*')
}

function App() {
  return (
    <Editor
      staticResourcesUrl=""
      structServiceProvider={structServiceProvider}
      onInit={(ketcher) => {
        window.ketcher = ketcher
        post({ type: 'ready' })
      }}
    />
  )
}

// 面板 → 画板：保存 / 取结构
window.addEventListener('message', async (event) => {
  const data = event.data
  if (!data || data.source !== 'chemflow-panel') return
  const ketcher = window.ketcher
  if (!ketcher) return
  if (data.type === 'save') {
    try {
      const mol = await ketcher.getMolfile()
      const smiles = await ketcher.getSmiles().catch(() => '')
      const response = await fetch('api/save', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: data.name || 'sketch', mol, smiles }),
      })
      const result = await response.json()
      post({ type: 'saved', ok: result.ok, files: result.files ?? [], smiles, error: result.error })
    } catch (error) {
      post({ type: 'saved', ok: false, error: String(error && error.message ? error.message : error) })
    }
  }
})

createRoot(document.getElementById('root')).render(<App />)
`

console.log(`[1/4] 准备临时构建目录 ${work}`)
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })
writeFileSync(path.join(work, 'entry.jsx'), ENTRY, 'utf8')
writeFileSync(path.join(work, 'package.json'), JSON.stringify({ name: 'chemflow-ketcher-build', private: true }, null, 2), 'utf8')

console.log('[2/4] 安装依赖（ketcher-react / ketcher-standalone / react / esbuild / events）')
execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', [
  'i', '--no-audit', '--no-fund', '--registry=https://registry.npmmirror.com',
  'ketcher-react', 'ketcher-standalone', 'react', 'react-dom', 'esbuild', 'events',
], { cwd: work, stdio: 'inherit' })

const esbuild = await import(path.join(work, 'node_modules', 'esbuild', 'lib', 'main.js').replace(/\\/g, '/'))
const standalone = path.join(work, 'node_modules', 'ketcher-standalone', 'dist', 'binaryWasm')
const out = path.join(work, 'dist')
mkdirSync(out, { recursive: true })

console.log('[3/4] 打包 app + worker')
await esbuild.build({
  entryPoints: [path.join(work, 'entry.jsx')],
  bundle: true, format: 'esm', target: 'chrome110',
  outfile: path.join(out, 'app.js'),
  alias: { events: 'events' },
  loader: { '.woff2': 'file', '.woff': 'file', '.ttf': 'file', '.svg': 'file', '.png': 'file', '.wasm': 'file' },
  assetNames: 'assets/[name]-[hash]',
  define: { 'process.env.NODE_ENV': '"production"', 'process.env.PUBLIC_URL': '""' },
  banner: { js: shim },
  logLevel: 'warning',
})
await esbuild.build({
  entryPoints: [path.join(standalone, 'indigoWorker-d22340fa.js')],
  bundle: true, format: 'esm', target: 'chrome110',
  outfile: path.join(out, 'indigoWorker-d22340fa.js'),
  alias: { events: 'events' },
  define: { 'process.env.NODE_ENV': '"production"' },
  banner: { js: shim },
  logLevel: 'warning',
})
cpSync(path.join(standalone, 'indigo-ketcher-1.46.0.wasm'), path.join(out, 'indigo-ketcher-1.46.0.wasm'))

writeFileSync(path.join(out, 'index.html'), `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <title>chemflow 画板</title>
  <style>html, body, #root { height: 100%; margin: 0; overflow: hidden; } body { font: 13px system-ui, sans-serif; }</style>
  <link rel="stylesheet" href="app.css" />
</head>
<body>
  <div id="root"></div>
  <script type="module" src="app.js"></script>
</body>
</html>
`, 'utf8')

console.log(`[4/4] 安装到 ${dataDir}`)
rmSync(dataDir, { recursive: true, force: true })
mkdirSync(dataDir, { recursive: true })
for (const name of readdirSync(out)) cpSync(path.join(out, name), path.join(dataDir, name), { recursive: true })

let total = 0
for (const name of readdirSync(dataDir)) {
  const size = statSync(path.join(dataDir, name)).size
  total += size
  console.log(`  ${(size / 1024 / 1024).toFixed(2).padStart(7)} MB  ${name}`)
}
console.log(`合计 ${(total / 1024 / 1024).toFixed(1)} MB`)

if (!keep) rmSync(work, { recursive: true, force: true })
console.log('完成。重启 DSH 后 chem_sketch(action:"serve") 就会用这份 Ketcher。')
