/**
 * 三个「预设分析」：分子轨道 cube / 芳香性 HOMA / ESP 表面。
 *
 * 三条 recipe 都是在本机 Multiwfn 3.8 上一步步探出来的（见 docs/recipes-extra.md），
 * 菜单入口和退出层级不能想当然：
 *   - 轨道：`200 → 3 → 轨道 → 网格 → [1] → 0 → q`（数字索引会多问一句「分开存还是合并存」）
 *   - HOMA：`25 → 6 → 0 → 环原子 → q → -1 → 0 → q`
 *   - ESP ：`12 → 0 → -2 → -1 → -1 → q`（-2 = 把表面网格导出成 surf.cub）
 *
 * 共同点：真正耗时的不是计算（phenanthrene 都是秒级），而是**把菜单退干净** ——
 * 少一层 `0` 就会在某个子菜单上遇到 EOF，退出码变 24/59，但产物其实已经写好了。
 * 所以这里以「产物为准」，退出码只进 issues。
 *
 * @module dsh-chemflow/tasks/presets
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

import { verifyCube } from '../artifacts.js'
import { runMultiwfn } from '../multiwfn.js'
import { createRun, writeManifest } from '../runs.js'

const GRID_CODE = { low: '1', medium: '2', high: '3' }

/**
 * 收集运行目录里新出现的 cube（按大小降序）。
 *
 * @param {string} runDir
 */
export function collectCubes(runDir) {
  return readdirSync(runDir)
    .filter((name) => name.toLowerCase().endsWith('.cub') || name.toLowerCase().endsWith('.cube'))
    .map((name) => {
      const file = path.join(runDir, name)
      const bytes = statSync(file).size
      return { name, path: file, bytes }
    })
    .sort((a, b) => b.bytes - a.bytes)
}

/**
 * 分子轨道 cube。
 *
 * @param {{
 *   config: Record<string, any>,
 *   file: string,
 *   orbital: string,
 *   grid?: 'low'|'medium'|'high',
 *   outDir: string,
 *   timeoutMs?: number,
 * }} options
 */
export async function runOrbital(options) {
  const { config, file, orbital, grid = 'high', outDir, timeoutMs } = options
  const gridCode = GRID_CODE[grid]
  if (!gridCode) return { ok: false, stage: 'validate', reason: `未知网格：${grid}` }

  const spec = String(orbital).trim()
  if (spec === '') return { ok: false, stage: 'validate', reason: 'orbital 不能为空（可用 h / l / h-1 / 171 这类写法）' }

  // 数字索引（可能带逗号/范围）会多一级「分开存 / 合并存」的询问。
  const numeric = /^[\d,\-\s]+$/.test(spec)
  const recipe = ['200', '3', spec, gridCode, ...(numeric ? ['1'] : []), '0', 'q']

  const runDir = createRun(outDir, 'orbital')
  const run = await runMultiwfn({ config, runDir, inputFile: file, recipeLines: recipe, timeoutMs })
  const cubes = collectCubes(runDir)

  const checks = cubes.map((cube) => ({ ...cube, verify: verifyCube(cube.path) }))
  const issues = []
  if (cubes.length === 0) {
    issues.push('没有产出任何 cube。轨道索引写法可能不被接受（`h` / `l` / `47` 这类才行）。')
  }
  for (const check of checks) if (!check.verify.ok) issues.push(`${check.name}：${check.verify.reason}`)

  const ok = cubes.length > 0 && issues.length === 0

  const manifestPath = writeManifest(runDir, {
    task: 'orbital',
    createdAt: new Date().toISOString(),
    input: file,
    orbital: spec,
    grid,
    recipe,
    command: run.command,
    exitCode: run.result.code,
    seconds: run.seconds,
    cubes: checks.map((c) => ({ name: c.name, bytes: c.bytes })),
    issues,
  })

  return {
    ok,
    stage: ok ? 'done' : 'run',
    runDir,
    orbital: spec,
    cubes: checks.map((c) => ({ name: c.name, path: c.path, bytes: c.bytes, cube: c.verify.cube })),
    seconds: run.seconds,
    exitCode: run.result.code,
    issues,
    log: run.logPath,
    manifestPath,
  }
}

/**
 * HOMA（芳香性）。
 *
 * @param {{
 *   config: Record<string, any>,
 *   file: string,
 *   rings: string[],
 *   outDir: string,
 *   timeoutMs?: number,
 * }} options
 */
export async function runAromatic(options) {
  const { config, file, rings, outDir, timeoutMs } = options
  const clean = (Array.isArray(rings) ? rings : [rings])
    .map((ring) => String(ring).trim())
    .filter((ring) => /^\d+([,\-]\d+)+$/.test(ring))
  if (clean.length === 0) {
    return {
      ok: false,
      stage: 'validate',
      reason:
        'rings 必须是「按成键顺序排列的环原子序号」，例如 ["1,2,3,4,5,6"]。' +
        '原子序号与波函数文件里的顺序一致（Multiwfn 主菜单 26 可以看）。',
    }
  }

  const recipe = ['25', '6', '0', ...clean, 'q', '-1', '0', 'q']
  const runDir = createRun(outDir, 'aromatic')
  const run = await runMultiwfn({ config, file, runDir, inputFile: file, recipeLines: recipe, timeoutMs })

  const values = [...run.log.matchAll(/HOMA value is\s+(-?[\d.]+)/g)].map((m) => Number(m[1]))
  const pairs = [...run.log.matchAll(/^\s*(\d+)\(([A-Za-z ]+)\)\s*--\s*(\d+)\(([A-Za-z ]+)\):\s*(-?[\d.]+)\s+([\d.]+)/gm)].map(
    (m) => ({
      a: Number(m[1]),
      aElement: m[2].trim(),
      b: Number(m[3]),
      bElement: m[4].trim(),
      contribution: Number(m[5]),
      bondLength: Number(m[6]),
    }),
  )

  const issues = []
  if (values.length === 0) issues.push('没有解析到 "HOMA value" —— 环原子序号可能不是一条闭合的环，或这个分子里没有这些原子。')
  if (values.length < clean.length) issues.push(`给了 ${clean.length} 个环，只算出 ${values.length} 个 HOMA 值。`)

  const ok = values.length > 0
  const manifestPath = writeManifest(runDir, {
    task: 'aromatic',
    createdAt: new Date().toISOString(),
    input: file,
    rings: clean,
    recipe,
    command: run.command,
    exitCode: run.result.code,
    seconds: run.seconds,
    homa: values,
    issues,
  })

  return { ok, stage: ok ? 'done' : 'run', runDir, rings: clean, values, bonds: pairs, seconds: run.seconds, exitCode: run.result.code, issues, log: run.logPath, manifestPath }
}

/**
 * ESP（静电势）表面定量 + 导出 surf.cub。
 *
 * @param {{
 *   config: Record<string, any>,
 *   file: string,
 *   outDir: string,
 *   timeoutMs?: number,
 * }} options
 */
export async function runEsp(options) {
  const { config, file, outDir, timeoutMs } = options
  const recipe = ['12', '0', '-2', '-1', '-1', 'q']

  const runDir = createRun(outDir, 'esp')
  const run = await runMultiwfn({ config, file, runDir, inputFile: file, recipeLines: recipe, timeoutMs })
  const log = run.log

  const num = (pattern) => {
    const match = log.match(pattern)
    return match ? Number(match[1]) : null
  }

  const metrics = {
    areaAngstrom2: num(/Overall surface area:\s+-?[\d.]+\s+Bohr\^2\s+\(\s*(-?[\d.]+)\s+Angstrom\^2/),
    positiveArea: num(/Positive surface area:\s+-?[\d.]+\s+Bohr\^2\s+\(\s*(-?[\d.]+)/),
    negativeArea: num(/Negative surface area:\s+-?[\d.]+\s+Bohr\^2\s+\(\s*(-?[\d.]+)/),
    espMin: num(/Global surface minimum:\s+(-?[\d.]+)\s+a\.u\./),
    espMax: num(/Global surface maximum:\s+(-?[\d.]+)\s+a\.u\./),
    average: num(/Overall average value:\s+(-?[\d.]+)\s+a\.u\./),
    sigma2: num(/Overall variance \(sigma\^2_tot\):\s+(-?[\d.]+)\s+a\.u\./),
    balance: num(/Balance of charges \(nu\):\s+(-?[\d.]+)/),
  }

  const surf = path.join(runDir, 'surf.cub')
  const issues = []
  if (!existsSync(surf)) issues.push('没有产出 surf.cub —— ESP 表面导出那一步没走到。')
  if (metrics.areaAngstrom2 === null) issues.push('没解析到表面面积 —— 分析可能没真正跑完。')

  const ok = existsSync(surf) && metrics.areaAngstrom2 !== null
  const surfCheck = existsSync(surf) ? verifyCube(surf, { minBytes: 100_000 }) : null

  const manifestPath = writeManifest(runDir, {
    task: 'esp',
    createdAt: new Date().toISOString(),
    input: file,
    recipe,
    command: run.command,
    exitCode: run.result.code,
    seconds: run.seconds,
    metrics,
    surface: surfCheck,
    issues,
  })

  return {
    ok,
    stage: ok ? 'done' : 'run',
    runDir,
    metrics,
    surf: existsSync(surf) ? { path: surf, bytes: statSync(surf).size } : null,
    seconds: run.seconds,
    exitCode: run.result.code,
    issues,
    log: run.logPath,
    manifestPath,
  }
}

/**
 * 读日志末尾（给工具层拼错误信息用）。
 *
 * @param {string} logPath
 * @param {number} [lines]
 */
export function tail(logPath, lines = 15) {
  try {
    const all = readFileSync(logPath, 'utf8').split(/\r?\n/).filter((l) => l.trim() !== '')
    return all.slice(-lines).join('\n')
  } catch {
    return ''
  }
}
