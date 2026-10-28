/**
 * `chem_multiwfn` —— 逃生口：给任意 recipe 跑任意 Multiwfn 任务。
 *
 * 必须有这个工具：Multiwfn 的菜单号随版本变化，固定工具（hole/ESP/轨道/芳香性）
 * 总会有覆盖不到的情况。这里只做两件事：把会挂死的写法拦住（菜单 `0`），
 * 以及把产物核对干净（存在 + 大小）。
 *
 * @module dsh-chemflow/tools/multiwfn
 */

import { readdirSync, statSync } from 'node:fs'
import path from 'node:path'

import { defineTool } from '@deepseek-ai/dsh-tools'

import { verifyFile } from '../artifacts.js'
import { runMultiwfn } from '../multiwfn.js'
import { validateRecipe } from '../recipes.js'
import { createRun, writeManifest } from '../runs.js'
import { fail, humanBytes, ok, textOutput } from './shared.js'

/**
 * @param {any} ctx
 * @param {{ config: Record<string, any> }} deps
 */
export function registerMultiwfnTool(ctx, deps) {
  const { config } = deps

  ctx.tools.register(
    defineTool({
      name: 'chem_multiwfn',
      description:
        '直接给 Multiwfn 喂一段 stdin 配方（一行一个菜单号），用来跑还没有专门工具覆盖的分析，' +
        '或在菜单号随版本变化时临时兜底。会自动建独立运行目录、设私有 Multiwfnpath、收产物并核对大小。' +
        '禁止在配方中间出现 `0`（部分层级 = 打开图形窗口，会永远挂住）。',
      parameters: {
        file: { type: 'string', description: '波函数文件路径（.fch/.molden/.wfn/.fchk…）。', required: true },
        recipe: {
          type: 'string',
          description: '配方：一行一个输入，用 \\n 分隔。允许空行（表示直接回车）。必须以 q 结尾。',
          required: true,
        },
        outDir: { type: 'string', description: '产物目录（由用户指定）。', required: true },
        expectFiles: {
          type: 'array',
          items: { type: 'string' },
          description: '预期产物文件名（相对运行目录），例如 ["hole.cub"]。给了就逐个核对大小。',
        },
        allowZeroTail: { type: 'number', description: '结尾允许的 0 的个数（逐层返回用），默认 3。' },
        timeoutMs: { type: 'number', description: '超时（毫秒），默认 30 分钟。' },
      },
      output: textOutput((_args, value) => value.message),
      timeoutMs: 600_000,
      isConcurrencySafe: () => true,
      async execute(args) {
        const lines = String(args.recipe)
          .replace(/\r\n/g, '\n')
          .split('\n')
          .map((line) => line.trimEnd())
        // 末尾的换行会多出一个空串，它不是配方的一部分。
        while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()

        const allowZeroTail = args.allowZeroTail ?? 3
        const check = validateRecipe(lines, { allowEmptyAt: [], allowZeroTail, mustEndWithQ: true })
        if (!check.ok) {
          // 逃生口允许空行（有些菜单确实要直接回车），只拦「0 在中间」和「不以 q 结尾」。
          const zeroProblem = /第 \d+ 行是 0/.test(check.reason)
          const noQ = /必须以 q 结尾/.test(check.reason)
          if (zeroProblem || noQ) return fail(`配方被拒绝：${check.reason}`)
        }

        const runDir = createRun(args.outDir, 'multiwfn')
        const run = await runMultiwfn({
          config,
          runDir,
          inputFile: args.file,
          recipeLines: lines,
          timeoutMs: args.timeoutMs ?? config.timeoutMs,
        })

        const all = readdirSync(runDir)
          .filter((name) => !['cmds.txt', 'multiwfn.log', 'settings.used.ini', 'run.json', 'debug-env.json'].includes(name))
          .map((name) => {
            const file = path.join(runDir, name)
            const stat = statSync(file)
            return { name, bytes: stat.size }
          })
          .sort((a, b) => b.bytes - a.bytes)

        const expected = Array.isArray(args.expectFiles) ? args.expectFiles : []
        const checks = expected.map((name) => verifyFile(path.join(runDir, name), { minBytes: 1024 }))
        const bad = checks.filter((c) => !c.ok)

        const tail = run.log.split(/\r?\n/).filter((l) => l.trim() !== '').slice(-25).join('\n')
        const summary = [
          run.result.timedOut ? `✗ 超时（${(run.result.ms / 1000).toFixed(0)} s）` : `退出码 ${run.result.code}，${run.seconds.toFixed(1)} s`,
          `运行目录：${runDir}`,
          '',
          `配方（${lines.length} 行）：${lines.map((l) => (l === '' ? '⏎' : l)).join(' ')}`,
        ]

        if (all.length > 0) {
          summary.push('', '产物：')
          for (const file of all) summary.push(`  ${file.name}  (${humanBytes(file.bytes)})`)
        } else {
          summary.push('', '产物：**没有新文件** —— 这次运行没有产出任何东西。')
        }

        if (expected.length > 0) {
          summary.push('', '预期产物核对：')
          for (const c of checks) summary.push(`  ${c.ok ? '✓' : '✗'} ${path.basename(c.path)} ${c.ok ? humanBytes(c.bytes) : `— ${c.reason}`}`)
        }

        summary.push('', '日志末尾：', tail)

        writeManifest(runDir, {
          task: 'multiwfn',
          createdAt: new Date().toISOString(),
          input: args.file,
          recipe: lines,
          command: run.command,
          exitCode: run.result.code,
          seconds: run.seconds,
          files: all,
          expected,
        })

        const blocked = bad.length > 0 || run.result.timedOut
        return blocked ? fail(summary.join('\n')) : ok(summary.join('\n'))
      },
    }),
  )
}
