/**
 * 离线冒烟：不经 DSH，直接跑真实文件，验证执行层 + 解析 + 渲染。
 *
 *   node scripts/smoke.mjs <molden.input> <outDir> [state]
 */

import path from 'node:path'

import { resolveConfig } from '../lib/config.js'
import { runHoleElectron } from '../lib/tasks/hole.js'
import { runRender } from '../lib/tasks/render.js'

const [, , input, outDirArg, stateArg] = process.argv
if (!input || !outDirArg) {
  console.error('usage: node scripts/smoke.mjs <molden.input> <outDir> [state]')
  process.exit(2)
}

const config = resolveConfig({})
console.log('config:', JSON.stringify({ multiwfn: config.multiwfnExe, vmd: config.vmdExe, python: config.pythonExe, source: config.pythonSource }, null, 2))

const hole = await runHoleElectron({
  config,
  inputFile: path.resolve(input),
  state: Number(stateArg ?? 3),
  grid: 'high',
  outDir: path.resolve(outDirArg),
})

console.log(
  'HOLE:',
  JSON.stringify(
    {
      ok: hole.ok,
      stage: hole.stage,
      reason: hole.reason,
      runDir: hole.runDir,
      metrics: hole.metrics,
      classification: hole.classification,
      artifacts: hole.artifacts && {
        hole: { path: hole.artifacts.hole?.path, bytes: hole.artifacts.hole?.bytes },
        electron: { path: hole.artifacts.electron?.path, bytes: hole.artifacts.electron?.bytes },
      },
      issues: hole.issues,
      warnings: hole.warnings,
      seconds: hole.seconds,
    },
    null,
    2,
  ),
)

if (hole.ok) {
  const render = await runRender({
    config,
    outDir: path.resolve(outDirArg),
    molecules: [
      { file: hole.artifacts.hole.path, style: 'isosurface', iso: 0.003, colorId: 21, material: 'Transparent' },
      { file: hole.artifacts.electron.path, style: 'isosurface', iso: 0.003, colorId: 31, material: 'Transparent' },
    ],
    size: [1600, 1200],
    scale: 1.8,
    rotate: [
      ['x', -12],
      ['y', 8],
    ],
  })
  console.log(
    'RENDER:',
    JSON.stringify(
      {
        ok: render.ok,
        stage: render.stage,
        figure: render.figure,
        size: render.size,
        nonWhitePercent: render.nonWhitePercent,
        issues: render.issues,
        reason: render.reason,
      },
      null,
      2,
    ),
  )
}
