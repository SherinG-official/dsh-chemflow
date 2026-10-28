/**
 * `chem_orca_states` —— 解析 ORCA 输出，出激发态表（含 TDA 判定）。
 *
 * 这张表是后面所有图的输入端：能级图、棒谱、双 Y、ECD 都从它来。
 * 同时它承担「这个作业能不能接 Multiwfn」的判定 —— 全 TD 会在返回里被标红。
 *
 * @module dsh-chemflow/tools/orca-states
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { defineTool } from '@deepseek-ai/dsh-tools'

import { parseOrcaOut, statesToCsv } from '../parse/orca.js'
import { fail, formatTable, ok, textOutput } from './shared.js'

/**
 * @param {any} ctx
 * @param {{ config: Record<string, any> }} deps
 */
export function registerOrcaStatesTool(ctx, deps) {
  ctx.tools.register(
    defineTool({
      name: 'chem_orca_states',
      description:
        '解析 ORCA 的 .out：列出激发态（能量/波长/振子强度 f/旋转强度 R/主导组态及权重），' +
        '并判定这个作业是不是 TDA（决定能不能接 Multiwfn 做 hole/electron）、有没有正常终止。' +
        '给了 outDir 会顺手写一份 CSV，可直接喂给 origin_* 画能级图/棒谱/双 Y。',
      parameters: {
        file: { type: 'string', description: 'ORCA 输出文件（.out）路径。', required: true },
        outDir: { type: 'string', description: '可选：CSV 落盘目录（由用户指定）。不给就只返回表格。' },
        maxStates: { type: 'number', description: '表格里最多列几个态，默认 12。' },
      },
      output: textOutput((_args, value) => value.message),
      timeoutMs: 60_000,
      isConcurrencySafe: () => true,
      async execute(args) {
        if (!existsSync(args.file)) return fail(`文件不存在：${args.file}`)

        const text = readFileSync(args.file, 'utf8')
        const parsed = parseOrcaOut(text)
        if (parsed.states.length === 0) {
          return fail(
            `没解析到激发态。${parsed.issues.join(' ')}\n` +
              `文件：${args.file}\n` +
              '如果这个作业确实不是 TD-DFT，那这张表本来就没有意义。',
          )
        }

        const max = args.maxStates ?? 12
        const rows = [['态', 'E(eV)', 'λ(nm)', 'f', 'R(1e40)', '主导组态', '权重']]
        for (const state of parsed.states.slice(0, max)) {
          const d0 = state.dominant?.[0]
          rows.push([
            String(state.index),
            state.eV.toFixed(3),
            state.nm !== null && state.nm !== undefined ? state.nm.toFixed(1) : '—',
            state.fosc !== null && state.fosc !== undefined ? state.fosc.toFixed(5) : '—',
            state.r !== null && state.r !== undefined ? state.r.toFixed(2) : '—',
            d0 ? `${d0.from}→${d0.to}` : '—',
            d0?.percent != null ? `${d0.percent.toFixed(1)}%` : '—',
          ])
        }

        const lines = [
          `${path.basename(args.file)}：ORCA ${parsed.version ?? '(版本未知)'}，` +
            `${parsed.tda ? '**TDA**' : parsed.fullTd ? '**全 TD**' : '未识别出 TD-DFT'}` +
            `，${parsed.terminated ? '正常终止' : '**未正常终止**'}，共 ${parsed.states.length} 个激发态`,
          '',
          formatTable(rows),
        ]

        if (parsed.states.length > max) lines.push(`…（只列了前 ${max} 个，共 ${parsed.states.length} 个）`)

        if (parsed.fullTd) {
          lines.push(
            '',
            '⚠ 这是全 TD：ORCA 只打印 contribution、不打印 CI 系数。Multiwfn 的 hole/electron 分析会得到' +
              '积分 0、D index = NaN。**要用 Multiwfn 就必须重算并加 `TDA true`**（代价是能量约 0.1 eV 偏差）。',
          )
        }
        if (!parsed.terminated) lines.push('', '⚠ 输出里没有 TERMINATED NORMALLY —— 作业没跑完，数据不可靠。')

        if (args.outDir) {
          mkdirSync(args.outDir, { recursive: true })
          const stem = path.basename(args.file).replace(/\.(out|log)$/i, '')
          const csvPath = path.join(args.outDir, `${stem}.states.csv`)
          writeFileSync(csvPath, statesToCsv(parsed), 'utf8')
          lines.push('', `CSV：${csvPath}`, '可直接用 origin_import 导入后画能级图 / 棒谱 / 双 Y。')
        }

        return ok(lines.join('\n'))
      },
    }),
  )
}
