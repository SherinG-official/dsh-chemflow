/**
 * 给独立渲染页 / 客户端面板测试页用的极简服务（零依赖）。
 *
 *   node scripts/serve-view.mjs <viewDir> [port]
 *
 * 路由：
 *   /                 → viewer/index.html
 *   /viewer/*         → 包内 viewer 目录
 *   /data/*           → <viewDir> 里的文件（meta.json、*.bin）
 *   /lib/*            → 包内 lib 目录（独立页 import 的 surface.js）
 *   /client.js        → 包内 lib/client.js（**客户端面板的真代码**）
 *   /harness.html     → 把 client.js 当面板跑的最小宿主页（?meta=<绝对路径>）
 *   /api/file?path=   → 模拟 DSH 的鉴权文件通道（harness 用；仅本机回环）
 *   POST /shot        → 页面回传 canvas，落到 viewDir/shot.png
 */

import { createReadStream, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const [, , viewDirArg, portArg] = process.argv
if (!viewDirArg) {
  console.error('usage: node scripts/serve-view.mjs <viewDir> [port]')
  process.exit(2)
}

const viewDir = path.resolve(viewDirArg)
const pkgDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const viewerDir = path.join(pkgDir, 'viewer')
const port = Number(portArg ?? 0) || 4310

/** harness 页：用桩 __ModuleLoader__ 把 client.js 的 mountViewer 拿出来直接跑。 */
const HARNESS = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8" /><title>chemflow harness</title>
<style>html,body{margin:0;height:100%;background:#111}#root{position:absolute;inset:0}</style></head>
<body><div id="root"></div>
<script>
  window.__ModuleLoader__ = { load({ factory }) { window.__chemflowFactory = factory; } };
</script>
<script src="/client.js"></script>
<script>
  const params = new URLSearchParams(location.search);
  const metaPath = params.get('meta') ?? '';
  const mod = window.__chemflowFactory((name) => {
    if (name === 'react') return { createElement: () => null, useRef: () => ({}), useEffect: () => {} };
    throw new Error('unexpected require: ' + name);
  });
  const root = document.getElementById('root');
  mod.__internals.ensureStyle();
  mod.__internals.mountViewer(root, metaPath).then((stop) => {
    window.__stop = stop;
    // URL 参数直接设状态：?preset=vmd&style=licorice&color=index&axes=1
    const preset = params.get('preset');
    if (preset) {
      const el = document.querySelector('[data-role="preset"]');
      if (el) { el.value = preset; el.dispatchEvent(new Event('change')); }
    }
    const style = params.get('style');
    const color = params.get('color');
    const scale = params.get('scale');
    if (style) {
      const el = document.querySelector('[data-role="skelStyle"]');
      if (el) { el.value = style; el.dispatchEvent(new Event('change')); }
    }
    if (color) {
      const el = document.querySelector('[data-role="skelColorMode"]');
      if (el) { el.value = color; el.dispatchEvent(new Event('change')); }
    }
    if (params.get('axes') === '1') {
      const el = document.querySelector('[data-role="axes"]');
      if (el) { el.checked = true; el.dispatchEvent(new Event('change')); }
    }
    // ?only=0 → 只显示第 0 路体数据（截图时分开看 HOMO / LUMO）
    const only = params.get('only');
    if (only !== null) {
      document.querySelectorAll('[data-role="volumes"] [data-role="show"]').forEach((el, index) => {
        const want = index === Number(only);
        if (el.checked !== want) { el.checked = want; el.dispatchEvent(new Event('change')); }
      });
    }
    // 偶极矩箭头：?dipoleColor=#3fa34d&dipoleScale=2
    if (params.get('dipoleColor')) {
      const el = document.querySelector('[data-role="dipoleColor"]');
      if (el) { el.value = params.get('dipoleColor'); el.dispatchEvent(new Event('input')); }
    }
    if (params.get('dipoleScale')) {
      const el = document.querySelector('[data-role="dipoleScale"]');
      if (el) { el.value = params.get('dipoleScale'); el.dispatchEvent(new Event('input')); }
    }
    if (params.get('showH') === '0') {
      const el = document.querySelector('[data-role="showH"]');
      if (el) { el.checked = false; el.dispatchEvent(new Event('change')); }
    }
    if (scale) {
      const el = document.querySelector('[data-role="skelScale"]');
      if (el) { el.value = scale; el.dispatchEvent(new Event('input')); }
    }
    // autoshot：给 headless 截图用
    if (params.get('autoshot') === '1') {
      setTimeout(() => {
        const canvas = document.querySelector('.chem-view__canvas');
        if (canvas && canvas.toDataURL) fetch('/shot', { method: 'POST', body: canvas.toDataURL('image/png') });
      }, 2500);
    }
  }).catch((error) => {
    root.textContent = 'mount failed: ' + error.message;
  });
  // 让截图脚本能改状态：样式/配色/粗细
  window.__applyState = (state) => {
    if (state.style) { const el = document.querySelector('[data-role="skelStyle"]'); if (el) { el.value = state.style; el.dispatchEvent(new Event('change')); } }
    if (state.color) { const el = document.querySelector('[data-role="skelColorMode"]'); if (el) { el.value = state.color; el.dispatchEvent(new Event('change')); } }
    if (state.showH === false) { const el = document.querySelector('[data-role="showH"]'); if (el) { el.checked = false; el.dispatchEvent(new Event('change')); } }
    if (state.scale) { const el = document.querySelector('[data-role="skelScale"]'); if (el) { el.value = String(state.scale); el.dispatchEvent(new Event('input')); } }
  };
</script></body></html>`;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.bin': 'application/octet-stream',
  '.png': 'image/png',
  '.css': 'text/css; charset=utf-8',
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost')

  // 自检回传：页面把 canvas 的 dataURL POST 过来，落到 viewDir/shot.png
  if (req.method === 'POST' && url.pathname === '/shot') {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      const match = /^data:image\/png;base64,(.+)$/.exec(body)
      if (!match) {
        res.writeHead(400).end('bad payload')
        return
      }
      const file = path.join(viewDir, 'shot.png')
      writeFileSync(file, Buffer.from(match[1], 'base64'))
      console.log(`shot saved: ${file} (${statSync(file).size} bytes)`)
      res.writeHead(200, { 'content-type': 'text/plain' }).end('ok')
    })
    return
  }

  // 模拟 DSH 的鉴权文件通道：路径不带前导斜杠，和客户端 fileUrl() 的约定一致。
  if (url.pathname === '/api/file') {
    const raw = url.searchParams.get('path') ?? ''
    const target = path.resolve(raw)
    if (!existsSync(target) || !statSync(target).isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('missing')
      return
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(target).toLowerCase()] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    })
    createReadStream(target).pipe(res)
    return
  }

  if (url.pathname === '/client.js') {
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' })
    res.end(readFileSync(path.join(pkgDir, 'lib', 'client.js')))
    return
  }

  if (url.pathname === '/harness.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end(HARNESS)
    return
  }

  let file
  if (url.pathname === '/' || url.pathname === '/index.html') {
    file = path.join(viewerDir, 'index.html')
  } else if (url.pathname.startsWith('/viewer/')) {
    file = path.join(viewerDir, url.pathname.slice('/viewer/'.length))
  } else if (url.pathname.startsWith('/lib/')) {
    file = path.join(path.dirname(viewerDir), 'lib', url.pathname.slice('/lib/'.length))
  } else if (url.pathname.startsWith('/data/')) {
    file = path.join(viewDir, decodeURIComponent(url.pathname.slice('/data/'.length)))
  } else {
    res.writeHead(404).end('not found')
    return
  }

  // 只允许落在三个根里，防止 ../ 穿越
  const allowed = [path.resolve(viewerDir), path.resolve(viewDir), path.resolve(path.join(path.dirname(viewerDir), 'lib'))]
  const resolved = path.resolve(file)
  if (!allowed.some((root) => resolved === root || resolved.startsWith(root + path.sep))) {
    res.writeHead(403).end('forbidden')
    return
  }
  if (!existsSync(resolved) || !statSync(resolved).isFile()) {
    res.writeHead(404).end(`missing: ${resolved}`)
    return
  }

  res.writeHead(200, {
    'content-type': MIME[path.extname(resolved).toLowerCase()] ?? 'application/octet-stream',
    'cache-control': 'no-store',
  })
  createReadStream(resolved).pipe(res)
})

server.listen(port, '127.0.0.1', () => {
  const actual = server.address().port
  console.log(`viewer: http://127.0.0.1:${actual}/`)
  console.log(`view data: ${viewDir}`)
})
