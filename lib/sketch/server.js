/**
 * 画板用的**本地服务**（宿主侧）。
 *
 * 为什么需要它：Ketcher 是带 WASM + Web Worker 的独立网页应用，塞不进我们的客户端
 * bundle（没有打包器、跑在 `dsh-app://` 自定义协议下）。所以由宿主起一个只监听
 * 127.0.0.1 的最小 HTTP 服务，面板用 iframe 打开它，两边用 postMessage / fetch 通信。
 *
 * 安全约束（都是刻意的）：
 *   - 只 bind `127.0.0.1`，不对外网开放；
 *   - 端口默认随机（0），避免和别的服务抢；
 *   - 每个请求都要带 token（页面 URL 里带 `?t=`，页面再用 header 回传）；
 *   - 静态资源只能落在 `rootDir` 里，写接口只能落在调用方给的 `outDir` 里；
 *   - 进程随 DSH 退出（服务不开 unref，不常驻）。
 *
 * @module dsh-chemflow/sketch/server
 */

import { createReadStream, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import path from 'node:path'

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
}

/**
 * @param {{
 *   rootDir: string,
 *   outDir?: string,
 *   token: string,
 *   port?: number,
 *   logFile?: string,
 * }} options
 */
export function startSketchServer(options) {
  const rootDir = path.resolve(options.rootDir)
  const outDir = options.outDir ? path.resolve(options.outDir) : undefined
  const token = options.token
  if (!token) throw new Error('startSketchServer 需要 token')

  // 每个请求记一行：排查「面板里白屏」时，能立刻分清是 iframe 压根没请求，
  // 还是请求了但被 403/404（比盯着截图猜快得多）。
  const logRequest = (line) => {
    if (!options.requestLog) return
    try {
      mkdirSync(path.dirname(options.requestLog), { recursive: true })
      writeFileSync(options.requestLog, `${new Date().toISOString()} ${line}\n`, { encoding: 'utf8', flag: 'a' })
    } catch {
      /* 日志写不了不影响服务 */
    }
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    // 每个响应记一行（方法 / 路径 / 状态码），用来判断 iframe 到底有没有发出请求。
    const writeHead = res.writeHead.bind(res)
    res.writeHead = (status, headers) => {
      logRequest(`${req.method ?? 'GET'} ${url.pathname} -> ${status}${req.headers.referer ? ` (ref=${String(req.headers.referer).slice(0, 60)})` : ''}`)
      return writeHead(status, headers)
    }
    // **token 放路径里**（`/s/<token>/...`），不用 cookie：
    // iframe 是第三方上下文，`SameSite=Strict` 的 cookie 在子资源请求里根本不发，
    // 页面能进、脚本/wasm 全 403 —— 表现就是「能打开但全白」（Phase 0 实测踩过）。
    // 路径前缀还有个好处：页面里的相对路径（./spike.js、worker.js）自动带上 token。
    const prefix = `/s/${token}`
    let relativePath = url.pathname
    if (relativePath === prefix) relativePath = `${prefix}/`
    if (!relativePath.startsWith(`${prefix}/`)) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' }).end('forbidden: 缺少 token 前缀')
      return
    }
    relativePath = relativePath.slice(prefix.length)

    const json = (status, payload) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify(payload))
    }

    // 页面把自检结果发回来，宿主/agent 直接读文件判断，不用截图猜。
    if (req.method === 'POST' && relativePath === '/api/log') {
      let body = ''
      req.on('data', (chunk) => { body += chunk })
      req.on('end', () => {
        try {
          const line = `${new Date().toISOString()} ${body.slice(0, 2000)}\n`
          if (options.logFile) {
            mkdirSync(path.dirname(options.logFile), { recursive: true })
            writeFileSync(options.logFile, line, { encoding: 'utf8', flag: 'a' })
          }
          json(200, { ok: true })
        } catch (error) {
          json(500, { ok: false, error: String(error) })
        }
      })
      return
    }

    // 保存画板内容：只写 outDir，文件名做白名单。
    if (req.method === 'POST' && url.pathname === '/api/save') {
      let body = ''
      req.on('data', (chunk) => {
        body += chunk
        if (body.length > 8 * 1024 * 1024) req.destroy()
      })
      req.on('end', () => {
        try {
          if (!outDir) return json(500, { ok: false, error: '没有配置 outDir' })
          const payload = JSON.parse(body)
          const rawName = String(payload.name ?? 'sketch').replace(/[^\w.-]+/g, '_').slice(0, 60) || 'sketch'
          const files = []
          mkdirSync(outDir, { recursive: true })
          for (const [key, extension] of [['mol', '.mol'], ['svg', '.svg']]) {
            const content = payload[key]
            if (typeof content !== 'string' || content.length === 0) continue
            const file = path.join(outDir, `${rawName}${extension}`)
            writeFileSync(file, content, 'utf8')
            files.push({ kind: key, file, bytes: statSync(file).size })
          }
          if (files.length === 0) return json(400, { ok: false, error: '没收到 mol/svg 内容' })
          return json(200, { ok: true, files })
        } catch (error) {
          return json(500, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      })
      return
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end('method not allowed')
      return
    }

    const relative = relativePath === '/' ? 'index.html' : decodeURIComponent(relativePath.replace(/^\/+/, ''))
    const file = path.resolve(rootDir, relative)
    if (file !== rootDir && !file.startsWith(rootDir + path.sep)) {
      res.writeHead(403).end('forbidden')
      return
    }
    if (!existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404).end('not found')
      return
    }

    res.writeHead(200, {
      'content-type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    })
    if (req.method === 'HEAD') {
      res.end()
      return
    }
    createReadStream(file).pipe(res)
  })

  return new Promise((resolve, reject) => {
    server.on('error', reject)
    server.listen(options.port ?? 0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : options.port
      resolve({
        server,
        port,
        origin: `http://127.0.0.1:${port}`,
        // 页面地址带 token 前缀，页面内相对路径自动继承（不需要 cookie）
        url: `http://127.0.0.1:${port}/s/${token}/`,
        close: () => new Promise((done) => server.close(() => done())),
      })
    })
  })
}
