/**
 * 三个预设分析工具：分子轨道 / 芳香性 HOMA / ESP 表面。
 *
 * 它们都是 `chem_multiwfn` 的「带校验的快捷方式」：参数更少、结果有结构，
 * 并且会核对产物真的写出来了。配方来自本机 3.8 的实测（见 docs/recipes-extra.md）。
 *
 * @module dsh-chemflow/tools/presets
 */

import { defineTool } from '@deepseek-ai/dsh-tools'

import { runAromatic, runEsp, runOrbital, tail } from '../tasks/presets.js'
import { runRender } from '../tasks/render.js'
import { fail, humanBytes, ok, textOutput } from './shared.js'

/**
 * @param {any} ctx
 * @param {{ config: Record<string, any> }} deps
 */
export function registerOrbitalTool(ctx, deps) {
  const { config } = deps

  ctx.tools.register(
    defineTool({
      name: 'chem_orbital',
      description:
        '导出分子轨道的 cube 文件（顺手可渲染成等值面图）。orbital 支持 h / l / h-1 / l+2 / 171 这类写法；' +
        '数字索引会导出 orb000171.cub 这样的文件名。默认高精度网格（~177 万点，约 25 MB）。',
      parameters: {
        file: { type: 'string', description: '波函数文件（.fch / .molden.input / .wfn …）。', required: true },
        orbital: { type: 'string', description: '轨道写法：h / l / h-1 / l+2 / 171（数字索引可写 "171,172"）。', required: true },
        outDir: { type: 'string', description: '产物目录（由用户指定）。', required: true },
        grid: { type: 'string', enum: ['low', 'medium', 'high'], description: '网格质量，默认 high。' },
        render: { type: 'boolean', description: 'true 时用 VMD 渲染等值面（默认阈值 0.02）。' },
        iso: { type: 'number', description: '渲染阈值，默认 0.02（轨道比 hole/electron 的 0.003 大一个量级）。' },
      },
      output: textOutput((_args, value) => value.message),
      timeoutMs: 600_000,
      isConcurrencySafe: () => true,
      async execute(args) {
        const result = await runOrbital({
          config,
          file: args.file,
          orbital: args.orbital,
          grid: args.grid ?? 'high',
          outDir: args.outDir,
        })

        if (!result.ok) {
          return fail(
            [`✗ 轨道导出未完成（${result.stage}）`, ...result.issues.map((i) => `- ${i}`), '', '日志末尾：', tail(result.log)].join('\n'),
          )
        }

        const lines = [
          `✓ 轨道 ${result.orbital} 已导出（${result.seconds.toFixed(1)} s）`,
          ...result.cubes.map((c) => `  ${c.path}  (${humanBytes(c.bytes)})`),
        ]

        if (args.render && result.cubes.length > 0) {
          const render = await runRender({
            config,
            outDir: args.outDir,
            molecules: [{ file: result.cubes[0].path, style: 'both', iso: args.iso ?? 0.02, colorId: 21, material: 'Transparent' }],
          })
          lines.push('')
          if (render.ok) {
            lines.push(`图：${render.figure.path}（${render.size?.[0]}×${render.size?.[1]}）`, '用 read_image 看一眼再交付。')
          } else {
            lines.push(`渲染失败：${render.reason ?? render.issues?.join('；')}`)
          }
        }

        return ok(lines.join('\n'))
      },
    }),
  )
}

/**
 * @param {any} ctx
 * @param {{ config: Record<string, any> }} deps
 */
export function registerAromaticTool(ctx, deps) {
  const { config } = deps

  ctx.tools.register(
    defineTool({
      name: 'chem_aromatic',
      description:
        '算 HOMA 芳香性指数（Multiwfn 主菜单 25 → 6）：给每个环的原子序号（按成键顺序），返回 HOMA 值与键长贡献。' +
        'HOMA 越接近 1 越芳香。注意：FLU / PDI 需要先跑模糊分析模块（主菜单 15），不在这个工具里。',
      parameters: {
        file: { type: 'string', description: '波函数文件。', required: true },
        rings: {
          type: 'array',
          items: { type: 'string' },
          description: '环原子序号，按成键顺序，如 ["1,2,3,4,5,6"]；多个环就多个字符串。',
          required: true,
        },
        outDir: { type: 'string', description: '产物目录（由用户指定）。', required: true },
      },
      output: textOutput((_args, value) => value.message),
      timeoutMs: 600_000,
      isConcurrencySafe: () => true,
      async execute(args) {
        const result = await runAromatic({ config, file: args.file, rings: args.rings, outDir: args.outDir })
        if (!result.ok) {
          return fail(
            [`✗ HOMA 未完成（${result.stage}）`, ...result.issues.map((i) => `- ${i}`), '', '日志末尾：', tail(result.log)].join('\n'),
          )
        }

        const rows = result.values.map((value, index) => `环 ${index + 1}（${result.rings[index]}）：HOMA = ${value.toFixed(4)}`)
        return ok(
          [
            `✓ HOMA 计算完成（${result.seconds.toFixed(1)} s）`,
            ...rows,
            '',
            '判据：HOMA → 1 完全芳香；> 0.9 芳香性强；< 0.5 明显非芳香。',
            `产物日志：${result.log}`,
          ].join('\n'),
        )
      },
    }),
  )
}

/**
 * @param {any} ctx
 * @param {{ config: Record<string, any> }} deps
 */
export function registerEspTool(ctx, deps) {
  const { config } = deps

  ctx.tools.register(
    defineTool({
      name: 'chem_esp',
      description:
        '静电势（ESP）表面定量分析 + 导出 surf.cub（Multiwfn 12 → 0 → -2）：给出表面积、正/负区面积、' +
        'ESP 极值与 σ²、电荷平衡度 ν 等论文常用量。表面默认是电子密度 0.001 a.u. 等值面。',
      parameters: {
        file: { type: 'string', description: '波函数文件。', required: true },
        outDir: { type: 'string', description: '产物目录（由用户指定）。', required: true },
      },
      output: textOutput((_args, value) => value.message),
      timeoutMs: 600_000,
      isConcurrencySafe: () => true,
      async execute(args) {
        const result = await runEsp({ config, file: args.file, outDir: args.outDir })
        if (!result.ok) {
          return fail(
            [`✗ ESP 分析未完成（${result.stage}）`, ...result.issues.map((i) => `- ${i}`), '', '日志末尾：', tail(result.log)].join('\n'),
          )
        }

        const m = result.metrics
        const fmt = (v, digits = 3) => (v === null || v === undefined ? '—' : Number(v).toFixed(digits))
        return ok(
          [
            `✓ ESP 表面分析完成（${result.seconds.toFixed(1)} s）`,
            '',
            `表面积 ${fmt(m.areaAngstrom2, 2)} Å²（正区 ${fmt(m.positiveArea, 2)} / 负区 ${fmt(m.negativeArea, 2)}）`,
            `ESP 全局最小 ${fmt(m.espMin, 4)} a.u.，最大 ${fmt(m.espMax, 4)} a.u.`,
            `平均值 ${fmt(m.average, 5)} a.u.，σ² ${fmt(m.sigma2, 6)} a.u.²，电荷平衡 ν ${fmt(m.balance, 4)}`,
            `（σ² 与 ν 的乘积是极性描述符，越小越「非极性」）`,
            '',
            `表面网格：${result.surf?.path}（${humanBytes(result.surf?.bytes ?? 0)}）`,
            `日志：${result.log}`,
            '',
            '注意：surf.cub 是表面网格数据，VMD 里还需要选合适的等值面阈值；' +
              '要出「ESP 着色表面」这类图，推荐在 VMD 里用 vtx.pdb + Beta 着色（chem_multiwfn 可以导出）。',
          ].join('\n'),
        )
      },
    }),
  )
}
