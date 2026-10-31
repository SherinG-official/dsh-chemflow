/**
 * `chem_sketch` —— 管理画板本地服务（启动 / 状态 / 停止）。
 *
 * 为什么需要它：画板是 iframe 里的一个独立网页（后面会换成 Ketcher），跑在宿主起的
 * 本地 HTTP 服务上。服务不能常驻在插件里（会随应用重启消失），所以做成按需启动：
 *
 *   chem_sketch(action:"serve")  → 起服务、写好 `sketch.json`、返回 iframe 地址
 *   chem_sketch(action:"status") → 服务在不在、监听哪个端口
 *   chem_sketch(action:"stop")   → 关掉
 *
 * 面板读 `sketch.json` 拿地址；服务没起来时面板会提示「让 agent 跑 chem_sketch serve」。
 *
 * @module dsh-chemflow/tools/sketch
 */

import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { defineTool } from '@deepseek-ai/dsh-tools'

import { sketchInfoPath, writeSketchInfo } from '../sketch/info.js'
import { startSketchServer } from '../sketch/server.js'
import { fail, ok, textOutput } from './shared.js'

/**
 * 画板前端资源目录。
 *
 * 优先用 `~/.dsh/dsh-chemflow/sketch/`（`scripts/build-sketcher.mjs` 装出来的 Ketcher），
 * 没装就退回插件自带的 spike 自检页（`lib/sketch/spike`），至少不会白屏。
 */
function sketchUiDir(dataDir) {
  const ketcher = path.join(dataDir, 'sketch')
  if (existsSync(path.join(ketcher, 'index.html'))) return { dir: ketcher, kind: 'ketcher' }
  return { dir: path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'sketch', 'spike'), kind: 'spike' }
}

/**
 * @param {any} ctx
 * @param {{ config: Record<string, any> }} deps
 */
export function registerSketchTool(ctx, deps) {
  const { config } = deps
  /** @type {{ url: string, port: number, outDir: string, close: () => Promise<void> } | null} */
  let running = null

  ctx.tools.register(
    defineTool({
      name: 'chem_sketch',
      description:
        '管理「画板」本地服务：serve 启动并返回 iframe 地址、status 查状态、stop 关闭。' +
        '画板页签（右栏铅笔图标）打开时需要它；保存的结构会写到 outDir（默认 ~/.dsh/dsh-chemflow/sketches）。',
      parameters: {
        action: { type: 'string', description: 'serve / status / stop', required: true },
        port: { type: 'number', description: '监听端口，默认随机（只绑 127.0.0.1）。' },
        outDir: { type: 'string', description: '画板保存结构的目录（**建议由用户指定**），默认放在插件数据目录下。' },
      },
      output: textOutput((_args, value) => value.message),
      timeoutMs: 60_000,
      isConcurrencySafe: () => false,
      async execute(args) {
        const action = String(args.action ?? '').toLowerCase()

        if (action === 'status') {
          const infoFile = sketchInfoPath(config.dataDir)
          if (!running) {
            return ok(`画板服务当前**没有运行**。\n登记文件：${infoFile}\n启动：chem_sketch(action:"serve")`)
          }
          return ok(`画板服务运行中：${running.url}\n保存目录：${running.outDir}\n登记文件：${infoFile}`)
        }

        if (action === 'stop') {
          if (!running) return ok('画板服务本来就没在运行。')
          const url = running.url
          await running.close()
          running = null
          try {
            rmSync(sketchInfoPath(config.dataDir), { force: true })
          } catch {
            /* 登记文件删不掉不影响 */
          }
          return ok(`✓ 已停止画板服务（${url}）。面板里会显示「服务没启动」。`)
        }

        if (action !== 'serve') return fail(`不认识的 action：${args.action}（可选 serve / status / stop）`)

        if (running) {
          return ok(`画板服务已在运行：${running.url}\n保存目录：${running.outDir}\n（要换端口/目录先 action:"stop"）`)
        }

        const outDir = path.resolve(args.outDir ?? path.join(config.dataDir, 'sketches'))
        mkdirSync(outDir, { recursive: true })
        const token = randomBytes(8).toString('hex')

        try {
          const ui = sketchUiDir(config.dataDir)
          const server = await startSketchServer({
            rootDir: ui.dir,
            outDir,
            token,
            port: Number(args.port ?? 0) || 0,
            requestLog: path.join(config.dataDir, 'sketch-requests.log'),
            logFile: path.join(config.dataDir, 'sketch-panel.log'),
          })
          running = { url: server.url, port: server.port, outDir, close: server.close }
          writeSketchInfo(config.dataDir, { url: server.url, origin: server.origin, port: server.port, rootDir: ui.dir })

          return ok(
            [
              `✓ 画板服务已启动：${server.url}`,
              `  前端：${ui.kind === 'ketcher' ? 'Ketcher' : '自检页（还没装 Ketcher：先跑 scripts/build-sketcher.mjs）'}`,
              `  保存目录：${outDir}`,
              `  只监听 127.0.0.1:${server.port}，token 在路径里`,
              '',
              '现在点右上角铅笔图标就能看到画板；保存的结构会落到上面的目录。',
            ].join('\n'),
          )
        } catch (error) {
          return fail(`启动失败：${error instanceof Error ? error.message : String(error)}`)
        }
      },
    }),
  )
}
