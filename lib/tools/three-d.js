/**
 * `chem_3d` —— 2D 结构 → 3D 坐标（Open Babel `--gen3d`）。
 *
 * 为什么单独一个工具：2D 画板/导出出来的坐标 z 全是 0，不能直接拿去算性质。
 * Open Babel 的 `--gen3d` 会做「碎片模板 + MMFF94/UFF 优化」，秒级出可用的初始构象。
 *
 * **必须设 `BABEL_DATADIR`**：找不到 UFF.prm 时 obabel 不报错，而是静默返回 z=0。
 * 这个工具会在写盘前检查 z 跨度，太小就直接失败并说明原因——不让你拿着一张"看起来成功"的平面结构去算。
 *
 * @module dsh-chemflow/tools/three-d
 */

import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'

import { defineTool } from '@deepseek-ai/dsh-tools'

import { formula, toXyz } from '../export/formats.js'
import { geometryStats, parseMolCoordinates, THINNESS_THRESHOLD } from '../export/geometry.js'
import { fail, humanBytes, ok, textOutput } from './shared.js'

const run = promisify(execFile)

/**
 * @param {any} ctx
 * @param {{ config: Record<string, any> }} deps
 */
export function registerThreeDTool(ctx, deps) {
  const { config } = deps

  ctx.tools.register(
    defineTool({
      name: 'chem_3d',
      description:
        '把 2D 结构转成 3D 坐标（Open Babel --gen3d，Avogadro2 自带）：输入 mol/sdf/smiles/任意结构文件，' +
        '输出带坐标的 .sdf 和 .xyz。会自动设 BABEL_DATADIR，并检查 z 跨度——找数据文件失败时会直接报错而不是给一张平面结构。',
      parameters: {
        input: { type: 'string', description: '结构文件（.mol/.sdf/.smi/.xyz，或画板保存的 .mol）', required: true },
        outDir: { type: 'string', description: '输出目录（**由用户指定**）。', required: true },
        name: { type: 'string', description: '输出文件基名，默认取输入文件名。' },
        forceField: { type: 'string', description: '力场：mmff94（默认，有机分子）/ uff（金属、少见元素）。' },
      },
      output: textOutput((_args, value) => value.message),
      timeoutMs: 180_000,
      isConcurrencySafe: () => true,
      async execute(args) {
        if (!args.input) return fail('input 不能为空。')
        if (!existsSync(args.input)) return fail(`输入文件不存在：${args.input}`)
        if (!config.obabelExe) {
          return fail(
            '找不到 obabel.exe。装 Avogadro2 后它会自带（通常在 `D:\\Program Files\\Avogadro2\\bin\\obabel.exe`），' +
              '或者在插件配置里填 obabelExe。',
          )
        }
        const dataDir = config.babelDataDir
        if (!dataDir || !existsSync(path.join(dataDir, 'UFF.prm'))) {
          return fail(
            `找不到 Open Babel 的数据目录（需要在 ${dataDir || '(未知)'} 里有 UFF.prm）。` +
              '没有它 --gen3d 会静默返回 z=0。可以在插件配置里填 babelDataDir。',
          )
        }

        const base = args.name ?? path.basename(args.input).replace(/\.[^.]+$/, '')
        const dir = path.resolve(args.outDir)
        mkdirSync(dir, { recursive: true })
        const sdfPath = path.join(dir, `${base}.3d.sdf`)
        const xyzPath = path.join(dir, `${base}.3d.xyz`)

        const ffFlag = String(args.forceField ?? 'mmff94').toLowerCase() === 'uff' ? '--uff' : '--mmff94'
        let stderr = ''
        try {
          const result = await run(
            config.obabelExe,
            [args.input, '-osdf', '--gen3d', ffFlag, '-O', sdfPath],
            { env: { ...process.env, BABEL_DATADIR: dataDir }, timeout: 150_000, windowsHide: true },
          )
          stderr = `${result.stdout ?? ''}${result.stderr ?? ''}`
        } catch (error) {
          return fail(
            `obabel 失败：${error instanceof Error ? error.message : String(error)}\n` +
              `命令：${config.obabelExe} --gen3d ${ffFlag}\n${String(error?.stderr ?? '').slice(0, 600)}`,
          )
        }

        if (!existsSync(sdfPath) || statSync(sdfPath).size === 0) {
          return fail(`obabel 没写出文件：${sdfPath}\n${stderr.slice(0, 600)}`)
        }

        let atoms
        try {
          atoms = parseMolCoordinates(readFileSync(sdfPath, 'utf8'))
        } catch (error) {
          return fail(`生成的 SDF 解析失败：${error instanceof Error ? error.message : String(error)}`)
        }
        const stats = geometryStats(atoms)

        // 核心防呆：平面结构 = gen3d 实际上没干活（典型原因是缺 BABEL_DATADIR）
        if (stats.thinness < THINNESS_THRESHOLD) {
          return fail(
            `生成的坐标几乎是平的（最薄方向跨度 ${stats.thinness.toFixed(3)} Å），说明 --gen3d 没有真正生效。\n` +
              `最常见原因：Open Babel 找不到数据文件。当前 BABEL_DATADIR=${dataDir}\n` +
              `obabel 输出：${stderr.trim().slice(0, 400) || '(空)'}`,
          )
        }

        // 顺手写一份 xyz（VMD / ORCA 都能直接吃）
        try {
          writeFileSync(
            xyzPath,
            toXyz(atoms.map((atom) => ({ element: atom.element, x: atom.x, y: atom.y, z: atom.z })), `${base} · obabel gen3d`),
            'utf8',
          )
        } catch (error) {
          return fail(`写 xyz 失败：${error instanceof Error ? error.message : String(error)}`)
        }

        // 回读校验
        const problems = []
        const xyzHead = readFileSync(xyzPath, 'utf8').split(/\r?\n/)[0].trim()
        if (Number(xyzHead) !== atoms.length) problems.push(`xyz 首行 ${xyzHead} ≠ ${atoms.length}`)

        const lines = [
          `✓ 3D 结构已生成`,
          `  分子式：${formula(atoms)}（${atoms.length} 原子）`,
          `  力场：${ffFlag === '--uff' ? 'UFF' : 'MMFF94'}`,
          `  三维跨度：x ${stats.spanX.toFixed(2)} / y ${stats.spanY.toFixed(2)} / z ${stats.spanZ.toFixed(2)} Å`,
          `  最薄方向：${stats.thinness.toFixed(2)} Å（≥0.2 才算真 3D）`,
          '',
          `  ${path.basename(sdfPath).padEnd(28)} ${humanBytes(statSync(sdfPath).size)}`,
          `  ${path.basename(xyzPath).padEnd(28)} ${humanBytes(statSync(xyzPath).size)}`,
          '',
          '下一步：chem_view（3D 面板）/ chem_export（转格式）/ 上传集群算优化。',
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
