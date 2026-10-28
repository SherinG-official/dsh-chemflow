/**
 * `chem_hole_electron` —— 空穴/电子分析（Multiwfn 18 → 1）。
 *
 * 这道工具的价值不在"调个 exe"，而在**开跑前就把全 TD 的作业拦下来**，
 * 以及跑完之后核对 cube 真的写完整了（Multiwfn 打印 "Done!" 时 cube 仍可能是 0 字节）。
 *
 * @module dsh-chemflow/tools/hole
 */

import { defineTool } from '@deepseek-ai/dsh-tools'

import { readTail } from '../exec.js'
import { runHoleElectron } from '../tasks/hole.js'
import { runRender } from '../tasks/render.js'
import { fail, humanBytes, ok, textOutput } from './shared.js'

/**
 * @param {any} ctx
 * @param {{ config: Record<string, any> }} deps
 */
export function registerHoleTool(ctx, deps) {
  const { config } = deps

  ctx.tools.register(
    defineTool({
      name: 'chem_hole_electron',
      description:
        '对 ORCA 的 TDA 激发态做空穴/电子（hole/electron）分析：产出 hole.cub + electron.cub，' +
        '并解析 Integral / Sr / Sm / D index / HDI / EDI 等判据。' +
        '开跑前会自动检查 ORCA 输出是不是 TDA —— 全 TD 会被直接拒绝（那种输出在 Multiwfn 里只会得到积分 0、D=NaN）。' +
        '需要与波函数同名的 `.molden.out`；没有的话先用 chem_orca(action=fetch) 从集群回传。',
      parameters: {
        file: {
          type: 'string',
          description: '波函数文件路径（通常是 job.molden.input）。同目录下必须有 job.molden.out。',
          required: true,
        },
        state: { type: 'number', description: '要分析的激发态序号（从 1 开始，对应 ORCA 输出的 STATE 编号）。', required: true },
        outDir: {
          type: 'string',
          description: '这次分析产物的落盘目录（**必须由用户指定**：不同课题放不同目录，不要用默认值）。',
          required: true,
        },
        grid: {
          type: 'string',
          enum: ['low', 'medium', 'high'],
          description: '网格质量。默认 high（92 原子约 177 万点、10 秒、每个 cube 约 25 MB）。',
        },
        outFile: { type: 'string', description: '可选：显式指定 ORCA 输出文件（名字不是 <stem>.molden.out 时用）。' },
        render: { type: 'boolean', description: 'true 时顺手用 VMD 渲染一张 hole+electron 等值面图。' },
        iso: { type: 'number', description: '渲染等值面阈值，默认 0.003。' },
        force: {
          type: 'boolean',
          description: 'true 时跳过 TDA / 终止状态闸门硬跑（结果不可用于 CT 判据，仅用于排障）。',
        },
        timeoutMs: { type: 'number', description: '超时（毫秒），默认 30 分钟。' },
      },
      output: textOutput((_args, value) => value.message),
      timeoutMs: 600_000,
      isConcurrencySafe: () => true,
      async execute(args) {
        const result = await runHoleElectron({
          config,
          inputFile: args.file,
          outFile: args.outFile,
          state: args.state,
          grid: args.grid ?? 'high',
          outDir: args.outDir,
          force: args.force === true,
          timeoutMs: args.timeoutMs ?? config.timeoutMs,
        })

        if (!result.ok) {
          const parts = [`✗ ${result.stage === 'gate' ? '拒绝执行（前置校验）' : '未完成'}：${result.reason}`]
          if (result.hint) parts.push(result.hint)
          if (result.issues?.length) parts.push(...result.issues.map((i) => `- ${i}`))
          return fail(parts.join('\n'))
        }

        const m = result.metrics
        const lines = [
          `✓ hole/electron 分析完成 —— 第 ${result.state} 激发态` +
            `（${result.grid} 网格${m.gridPoints ? `，${m.gridPoints.toLocaleString('en-US')} 点` : ''}，${result.seconds.toFixed(1)} s）`,
          '',
          `Integral：hole ${fmt(m.integralHole)} / electron ${fmt(m.integralElectron)}`,
          `Sr ${fmt(m.sr)}   Sm ${fmt(m.sm)}   D ${fmt(m.dIndex)} Å   H ${fmt(m.hIndex)} Å   t ${fmt(m.tIndex)} Å`,
          `HDI ${fmt(m.hdi)}   EDI ${fmt(m.edi)}`,
          `判据：${result.classification.reason}`,
          '',
          '产物：',
          `  ${result.artifacts.hole.path}  (${humanBytes(result.artifacts.hole.bytes)})`,
          `  ${result.artifacts.electron.path}  (${humanBytes(result.artifacts.electron.bytes)})`,
          `  ${result.artifacts.log}`,
          `  ${result.manifestPath}`,
        ]

        if (result.warnings.length > 0) lines.push('', '警告：', ...result.warnings.map((w) => `- ${w}`))

        if (args.render) {
          const render = await runRender({
            config,
            outDir: args.outDir,
            molecules: [
              { file: result.artifacts.hole.path, style: 'both', iso: args.iso ?? 0.003, colorId: 21, material: 'Transparent' },
              { file: result.artifacts.electron.path, style: 'isosurface', iso: args.iso ?? 0.003, colorId: 31, material: 'Transparent' },
            ],
          })
          lines.push('')
          if (render.ok) {
            lines.push(
              `图：${render.figure.path}（${render.size?.[0]}×${render.size?.[1]}，非白像素 ${render.nonWhitePercent}%）`,
              '用 read_image 看一眼再交付 —— 阈值是否合适、两个面有没有糊在一起，只有看图能判断。',
            )
          } else {
            lines.push(`渲染失败：${render.reason ?? render.issues?.join('；')}`)
            if (render.log) lines.push(readTail(render.log, 8))
          }
        }

        return ok(lines.join('\n'))
      },
    }),
  )
}

/**
 * @param {number|null} value
 */
function fmt(value) {
  if (value === null || value === undefined) return '—'
  return Number(value).toFixed(value >= 100 ? 1 : 3)
}
