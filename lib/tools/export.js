/**
 * `chem_export` —— 把结构导出成通用化学格式（.xyz / .mol / .sdf / .pdb / .svg）。
 *
 * 输入来源：
 *   - 结构文件：`.xyz` / ORCA `.out` / `.molden` / `.cub`（复用 view/structure 的读取器）
 *   - 已有视图包：`<name>.view/meta.json`（直接拿面板里看到的原子和键）
 *
 * 说明（写在返回里，避免误用）：
 *   - **键是推断出来的连通性**，键级按距离估（单/双/三），不做芳香性识别；
 *   - 2D 坐标用 PCA 投影 + 弹簧松弛生成，能出可读的结构式，但不等于 ChemDraw 的排版。
 *
 * @module dsh-chemflow/tools/export
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { defineTool } from '@deepseek-ai/dsh-tools'

import { formula, toMolfile, toPdb, toSdf, toSvg, toXyz } from '../export/formats.js'
import { layout2d } from '../export/layout2d.js'
import { loadStructureForExport } from '../export/load.js'
import { fail, humanBytes, ok, textOutput } from './shared.js'

const ALL_FORMATS = ['xyz', 'mol', 'mol2d', 'sdf', 'pdb', 'svg']

/**
 * @param {any} ctx
 * @param {{ config: Record<string, any> }} deps
 */
export function registerExportTool(ctx, deps) {
  const { config } = deps

  ctx.tools.register(
    defineTool({
      name: 'chem_export',
      description:
        '把化学结构导出成通用格式：.xyz（3D 坐标）、.mol（V2000，3D）、.mol2d（2D 结构式）、.sdf、.pdb、.svg（2D 结构式图）。' +
        '输入可以是 .xyz / ORCA .out / .molden / .cub，也可以是已有的 <name>.view/meta.json（直接导出面板里看到的那个结构）。' +
        '键由距离推断，键级按键长估；2D 坐标由 PCA + 弹簧松弛生成。',
      parameters: {
        input: {
          type: 'string',
          description: '结构文件（.xyz / .out / .molden / .cub）或 <name>.view/meta.json 的绝对路径。',
          required: true,
        },
        outDir: { type: 'string', description: '输出目录（**由用户指定**）。', required: true },
        name: { type: 'string', description: '输出文件基名，默认取输入文件名。' },
        formats: {
          type: 'array',
          description: `要写哪些格式，默认 ["xyz","mol","mol2d","svg"]。可选：${ALL_FORMATS.join(' / ')}，写 ["all"] 等于全要。`,
        },
        showH: { type: 'boolean', description: 'SVG 里是否画氢（默认 false，结构式惯例）。' },
      },
      output: textOutput((_args, value) => value.message),
      timeoutMs: 120_000,
      isConcurrencySafe: () => true,
      async execute(args) {
        if (!args.input) return fail('input 不能为空。')
        if (!existsSync(args.input)) return fail(`输入文件不存在：${args.input}`)

        let formats = Array.isArray(args.formats) && args.formats.length > 0 ? args.formats : ['xyz', 'mol', 'mol2d', 'svg']
        if (formats.includes('all')) formats = ALL_FORMATS.slice()
        const unknown = formats.filter((item) => !ALL_FORMATS.includes(item))
        if (unknown.length > 0) return fail(`不认识的格式：${unknown.join(', ')}（可选 ${ALL_FORMATS.join(' / ')}）`)

        let loaded
        try {
          loaded = loadStructureForExport(args.input)
        } catch (error) {
          return fail(`读结构失败：${error instanceof Error ? error.message : String(error)}`)
        }

        const { atoms, bonds, source } = loaded
        if (atoms.length === 0) return fail('这个输入里没有原子。')

        const base = (() => {
          if (args.name) return args.name
          // 视图包：用 <name>.view 的目录名，而不是 "meta"
          const sourceDir = path.dirname(source)
          if (/\.view$/i.test(sourceDir)) return path.basename(sourceDir).replace(/\.view$/i, '')
          return path.basename(source).replace(/\.(json|cub|xyz|out|log|molden|input)$/i, '')
        })()
        const dir = path.resolve(args.outDir)
        mkdirSync(dir, { recursive: true })

        const need2d = formats.some((item) => item === 'mol2d' || item === 'sdf' || item === 'svg')
        let coords2d
        if (need2d) {
          try {
            coords2d = layout2d(atoms, bonds)
          } catch (error) {
            return fail(`2D 布局失败：${error instanceof Error ? error.message : String(error)}`)
          }
        }

        const title = args.title ?? path.basename(source)
        /** @type {Array<{ format: string, file: string, bytes: number }>} */
        const written = []

        const emit = (format, suffix, text) => {
          const file = path.join(dir, `${base}${suffix}`)
          writeFileSync(file, text, 'utf8')
          const bytes = statSync(file).size
          if (bytes === 0) throw new Error(`写出来的文件是空的：${file}`)
          written.push({ format, file, bytes })
        }

        try {
          for (const format of formats) {
            if (format === 'xyz') emit('xyz', '.xyz', toXyz(atoms, title))
            else if (format === 'mol') emit('mol', '.mol', toMolfile(atoms, bonds, { title }))
            else if (format === 'mol2d') emit('mol2d', '-2d.mol', toMolfile(atoms, bonds, { title, coords: coords2d }))
            else if (format === 'sdf') emit('sdf', '.sdf', toSdf(atoms, bonds, { title, coords: coords2d }))
            else if (format === 'pdb') emit('pdb', '.pdb', toPdb(atoms, bonds, { title }))
            else if (format === 'svg') emit('svg', '.svg', toSvg(atoms, bonds, { coords: coords2d, showH: args.showH === true }))
          }
        } catch (error) {
          return fail(`写文件失败：${error instanceof Error ? error.message : String(error)}`)
        }

        // 回读校验：xyz 的原子数、mol 的计数行，别只看"文件存在"
        const problems = []
        const xyz = written.find((item) => item.format === 'xyz')
        if (xyz) {
          const first = readFileSync(xyz.file, 'utf8').split(/\r?\n/)[0].trim()
          if (Number(first) !== atoms.length) problems.push(`xyz 首行原子数 ${first} ≠ ${atoms.length}`)
        }
        const mol = written.find((item) => item.format === 'mol' || item.format === 'mol2d')
        if (mol) {
          const text = readFileSync(mol.file, 'utf8')
          if (!text.includes('M  END')) problems.push(`${path.basename(mol.file)} 缺 M  END`)
          if (!text.includes('V2000')) problems.push(`${path.basename(mol.file)} 缺 V2000 标记`)
        }

        const lines = [
          `✓ 已导出 ${written.length} 个文件 → ${dir}`,
          `  分子式：${formula(atoms)}`,
          `  原子 ${atoms.length}，键 ${bonds.length}${need2d ? '（已生成 2D 坐标）' : ''}`,
          `  来源：${source}`,
          '',
          ...written.map((item) => `  ${path.basename(item.file).padEnd(24)} ${humanBytes(item.bytes)}`),
          '',
          '说明：键是**按距离推断的连通性**，键级按键长估（不识别芳香性）；',
          '2D 坐标由 PCA 投影 + 弹簧松弛生成，够看结构式，但不是 ChemDraw 级排版。',
        ]
        if (problems.length > 0) {
          lines.push('', '⚠ 回读校验有问题：', ...problems.map((item) => `  - ${item}`))
          return fail(lines.join('\n'))
        }
        return ok(lines.join('\n'))
      },
    }),
  )
}
