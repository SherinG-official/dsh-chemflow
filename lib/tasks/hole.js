/**
 * hole / electron 分析任务（Multiwfn 18 → 1 → …）。
 *
 * 这是整条链上最值钱的一个任务，因为它前面有一道**必须先过**的闸门：
 * ORCA 没开 TDA 时，Multiwfn 拿到的只能是 contribution，分析出来积分 0、D index = NaN，
 * 而它**不会报错**，只会给一串看起来正常的数字。所以这里先读 ORCA 的 `.out` 判定，
 * 不合格就直接拒绝，不让那 10~20 秒白跑、更不让模型拿着假数据往下画图。
 *
 * @module dsh-chemflow/tasks/hole
 */

import { copyFileSync, existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { verifyCube } from '../artifacts.js'
import { runMultiwfn } from '../multiwfn.js'
import { parseMultiwfnLog, classifyExcitation } from '../parse/multiwfn.js'
import { parseOrcaOut } from '../parse/orca.js'
import { holeElectronRecipe, validateRecipe } from '../recipes.js'
import { createRun, writeManifest } from '../runs.js'

/**
 * 找出与波函数文件配套的 ORCA 输出。
 *
 * Multiwfn 的规则是：给 `X.molden.input`，它自动找 **`X.molden.out`**（不是 `X.out`）。
 * 找不到会报 `Unable to find either X.molden.out or X.molden.log`。
 *
 * @param {string} inputFile
 * @param {string} [explicit]
 * @returns {{ path: string|null, expected: string, candidates: string[] }}
 */
export function findOrcaOut(inputFile, explicit) {
  const dir = path.dirname(inputFile)
  const base = path.basename(inputFile)
  const stem = base.replace(/\.molden\.input$/i, '').replace(/\.(molden|input)$/i, '')
  const expected = path.join(dir, `${stem}.molden.out`)
  const candidates = [explicit, expected, path.join(dir, `${stem}.out`), path.join(dir, `${stem}.log`)].filter(
    (item) => typeof item === 'string' && item !== '',
  )
  const found = candidates.find((item) => existsSync(item)) ?? null
  return { path: found, expected, candidates }
}

/**
 * 跑一次 hole/electron 分析。
 *
 * @param {{
 *   config: Record<string, any>,
 *   inputFile: string,
 *   outFile?: string,
 *   state: number,
 *   grid?: 'low'|'medium'|'high',
 *   outDir: string,
 *   timeoutMs?: number,
 *   force?: boolean,
 *   signal?: AbortSignal,
 * }} options
 */
export async function runHoleElectron(options) {
  const { config, inputFile, outFile, state, grid = 'high', outDir, timeoutMs, force = false, signal } = options

  if (!existsSync(inputFile)) {
    return { ok: false, stage: 'validate', reason: `波函数文件不存在：${inputFile}` }
  }

  // ---- 前置闸门 1：找得到配套 .out 吗 ----
  const outInfo = findOrcaOut(inputFile, outFile)
  if (!outInfo.path) {
    return {
      ok: false,
      stage: 'validate',
      reason:
        `找不到与 ${path.basename(inputFile)} 配套的 ORCA 输出。Multiwfn 会自动找同名的 ` +
        `${path.basename(outInfo.expected)}。\n` +
        `候选路径：\n${outInfo.candidates.map((c) => `  - ${c}`).join('\n')}\n` +
        '修法：把 ORCA 的 job.out 复制成 <同名>.molden.out 放在同一目录（这一步最容易漏）。',
    }
  }

  // ---- 前置闸门 2：TDA ----
  const orcaText = readFileSync(outInfo.path, 'utf8')
  const orca = parseOrcaOut(orcaText)
  const blocking = orca.issues.filter((issue) => issue.includes('全 TD') || issue.includes('TERMINATED'))
  if (blocking.length > 0 && !force) {
    return {
      ok: false,
      stage: 'gate',
      reason: blocking.join('\n'),
      orca: { tda: orca.tda, fullTd: orca.fullTd, terminated: orca.terminated, version: orca.version },
      hint: '确认要硬跑可以传 force: true（结果不可用于 CT 判据）。',
    }
  }
  if (orca.tda && orca.states.length > 0 && state > orca.states.length) {
    return {
      ok: false,
      stage: 'validate',
      reason: `要求分析第 ${state} 个激发态，但 ORCA 输出里只有 ${orca.states.length} 个态。`,
    }
  }

  // ---- 配方 ----
  const recipeLines = holeElectronRecipe({ state, grid })
  const check = validateRecipe(recipeLines, { allowEmptyAt: [2], allowZeroTail: 3 })
  if (!check.ok) return { ok: false, stage: 'recipe', reason: check.reason }

  // ---- 运行目录 ----
  const runDir = createRun(outDir, 'hole-electron')

  // 文件名不匹配时，把输入与输出复制进 run 目录并改成 Multiwfn 认的规范名。
  let runInput = inputFile
  let staged = false
  if (path.resolve(outInfo.path) !== path.resolve(outInfo.expected)) {
    const stagedInput = path.join(runDir, 'job.molden.input')
    const stagedOut = path.join(runDir, 'job.molden.out')
    copyFileSync(inputFile, stagedInput)
    copyFileSync(outInfo.path, stagedOut)
    runInput = stagedInput
    staged = true
  }

  // ---- 跑 ----
  const run = await runMultiwfn({
    config,
    runDir,
    inputFile: runInput,
    recipeLines,
    timeoutMs: timeoutMs ?? config.timeoutMs,
    signal,
  })

  // ---- 解析 ----
  const parsed = parseMultiwfnLog(run.log)
  const cubes = {
    hole: verifyCube(path.join(runDir, 'hole.cub')),
    electron: verifyCube(path.join(runDir, 'electron.cub')),
  }

  const issues = [...parsed.issues]
  if (run.result.timedOut) issues.push(`Multiwfn 超时被终止（${(run.result.ms / 1000).toFixed(0)} s）。`)
  if (run.result.code !== 0 && !issues.length) {
    issues.push(`Multiwfn 退出码 ${run.result.code}（产物可能仍然完整，需要看下面两条核对结果）。`)
  }
  if (!cubes.hole.ok) issues.push(`hole.cub 核对失败：${cubes.hole.reason}`)
  if (!cubes.electron.ok) issues.push(`electron.cub 核对失败：${cubes.electron.reason}`)

  const classification = classifyExcitation(parsed.metrics)
  const ok = cubes.hole.ok && cubes.electron.ok && parsed.metrics.integralHole !== null
  const warnings = []
  if (parsed.metrics.integralHole !== null && parsed.metrics.integralHole < 0.9) {
    warnings.push(
      `积分 ${parsed.metrics.integralHole.toFixed(3)} 略低于 1（网格未覆盖全部密度或该态弥散）。` +
        '如果要做定量判据，建议换更大网格（grid:"high"）或加大 extension。',
    )
  }

  /** @type {Record<string, any>} */
  const summary = {
    ok,
    stage: 'done',
    runDir,
    state,
    grid,
    metrics: parsed.metrics,
    classification,
    artifacts: {
      hole: { path: cubes.hole.path, bytes: cubes.hole.bytes, cube: cubes.hole.cube },
      electron: { path: cubes.electron.path, bytes: cubes.electron.bytes, cube: cubes.electron.cube },
      log: run.logPath,
      cmds: run.cmdsPath,
    },
    orca: {
      out: outInfo.path,
      version: orca.version,
      tda: orca.tda,
      terminated: orca.terminated,
      stateEnergy: orca.states.find((s) => s.index === state)?.eV ?? null,
    },
    staged,
    seconds: run.seconds,
    issues,
    warnings,
  }

  summary.manifestPath = writeManifest(runDir, {
    task: 'hole-electron',
    createdAt: new Date().toISOString(),
    input: inputFile,
    orcaOut: outInfo.path,
    state,
    grid,
    recipe: recipeLines,
    command: run.command,
    env: { multiwfnExe: config.multiwfnExe, settingsCopied: run.settingsCopied },
    seconds: run.seconds,
    exitCode: run.result.code,
    metrics: parsed.metrics,
    classification,
    artifacts: summary.artifacts,
    issues,
    warnings,
  })

  return summary
}
