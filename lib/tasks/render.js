/**
 * VMD 渲染任务：cube / xyz → BMP → PNG（裁白边）。
 *
 * ## 为什么固定写 BMP
 *
 * Windows 版 VMD 的 Tachyon 只认 BMP：脚本里写 `fig.png` 会报
 * `Unrecognized image file extension, writing Windows Bitmap file`，**产物是 BMP 但
 * 文件名是 .png** —— 后处理再按扩展名打开就炸。所以这里自己写 `.bmp`，再交给 Pillow 转。
 *
 * ## 分辨率
 *
 * 由 `display resize` 决定，不是 Tachyon 参数。默认 1600×1200（投稿够用，渲染几秒）。
 *
 * @module dsh-chemflow/tasks/render
 */

import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { runProcess } from '../exec.js'
import { createRun, writeManifest } from '../runs.js'

/**
 * 生成 VMD Tcl 脚本。
 *
 * @param {{
 *   molecules: Array<{
 *     file: string,
 *     type?: string,
 *     style?: 'isosurface'|'licorice'|'both',
 *     iso?: number,
 *     colorId?: number,
 *     material?: string,
 *     selection?: string,
 *   }>,
 *   size?: [number, number],
 *   background?: string,
 *   scale?: number,
 *   rotate?: Array<[string, number]>,
 *   outFile: string,
 * }} spec
 * @returns {string}
 */
export function buildVmdScript(spec) {
  const {
    molecules,
    size = [1600, 1200],
    background = 'white',
    scale = 1.8,
    rotate = [],
    outFile,
    colorChanges = [],
    opacity = 0.55,
  } = spec

  const lines = [
    `color Display Background ${background}`,
    'axes location off',
    'display projection Orthographic',
    `display resize ${size[0]} ${size[1]}`,
    '',
  ]

  // 重定义 ColorID 的 RGB。VMD 的 `color Element C {...}` 不生效，改元素表用的 ColorID 才行。
  for (const change of colorChanges) {
    lines.push(`color change rgb ${change.id} ${change.rgb.join(' ')}`)
  }
  if (opacity !== null) lines.push(`material change opacity Transparent ${opacity}`)
  if (colorChanges.length > 0 || opacity !== null) lines.push('')

  molecules.forEach((mol, index) => {
    const type = mol.type ?? (mol.file.toLowerCase().endsWith('.cub') ? 'cube' : 'xyz')
    lines.push(`mol new {${mol.file}} type ${type} waitfor all`)

    if (mol.selection) lines.push(`mol modselect 0 ${index} "${mol.selection}"`)

    const style = mol.style ?? 'isosurface'
    if (style === 'isosurface' || style === 'both') {
      const iso = mol.iso ?? 0.003
      // 参数：阈值, 体编号 0, 是否显示内部等值面 0, 步长 0, 是否显示 1, 是否使用体数据 1
      lines.push(`mol modstyle 0 ${index} Isosurface ${iso} 0 0 0 1 1`)
      lines.push(`mol modcolor 0 ${index} ColorID ${mol.colorId ?? 0}`)
      lines.push(`mol modmaterial 0 ${index} ${mol.material ?? 'Transparent'}`)
    }

    if (style === 'licorice' || style === 'both') {
      if (style === 'both') lines.push(`mol addrep ${index}`)
      const rep = style === 'both' ? 1 : 0
      const selection = mol.licoriceSelection ?? 'not name H'
      if (style === 'both' && selection) lines.push(`mol modselect ${rep} ${index} "${selection}"`)
      lines.push(`mol modstyle ${rep} ${index} Licorice 0.18 20.0 20.0`)
      lines.push(`mol modcolor ${rep} ${index} Element`)
    }
    lines.push('')
  })

  lines.push('display resetview')
  if (scale && scale !== 1) lines.push(`scale by ${scale}`)
  for (const [axis, deg] of rotate) lines.push(`rotate ${axis} by ${deg}`)
  lines.push(`render TachyonInternal {${outFile}}`)
  lines.push('quit')
  lines.push('')
  return lines.join('\n')
}

/**
 * 本机出图常用的元素配色（改的是 VMD 元素表用的 ColorID）。
 *
 * 注意 `color Element C {…}` 这种写法**不生效**，要改 ColorID 的 rgb 才行 ——
 * 这是 VMD 的坑，不是风格问题。
 */
export const DEFAULT_COLOR_CHANGES = [
  { id: 10, rgb: [0.24, 0.24, 0.24] }, // C
  { id: 0, rgb: [0.16, 0.3, 0.82] }, // N
  { id: 1, rgb: [0.78, 0.1, 0.1] }, // O
  { id: 21, rgb: [0.85, 0.25, 0.25] }, // hole
  { id: 31, rgb: [0.25, 0.35, 0.85] }, // electron
]

/**
 * 渲染一张图。
 *
 * @param {{
 *   config: Record<string, any>,
 *   outDir: string,
 *   molecules: Array<Record<string, any>>,
 *   size?: [number, number],
 *   background?: string,
 *   scale?: number,
 *   rotate?: Array<[string, number]>,
 *   format?: 'png'|'tiff'|'bmp',
 *   trim?: boolean,
 *   colorChanges?: Array<{ id: number, rgb: number[] }>,
 *   opacity?: number|null,
 *   timeoutMs?: number,
 *   signal?: AbortSignal,
 * }} options
 */
export async function runRender(options) {
  const {
    config,
    outDir,
    molecules,
    size = [1600, 1200],
    background = 'white',
    scale = 1.8,
    rotate = [],
    format = 'png',
    trim = true,
    colorChanges = DEFAULT_COLOR_CHANGES,
    opacity = 0.55,
    timeoutMs = 600_000,
    signal,
  } = options

  if (!Array.isArray(molecules) || molecules.length === 0) {
    return { ok: false, stage: 'validate', reason: '至少要给一个分子/体数据文件（molecules）。' }
  }
  for (const mol of molecules) {
    if (!existsSync(mol.file)) return { ok: false, stage: 'validate', reason: `文件不存在：${mol.file}` }
  }

  const runDir = createRun(outDir, 'render')
  const bmpPath = path.join(runDir, 'render.bmp')

  const script = buildVmdScript({ molecules, size, background, scale, rotate, outFile: bmpPath, colorChanges, opacity })
  const scriptPath = path.join(runDir, 'render.vmd')
  writeFileSync(scriptPath, script, 'utf8')

  const logPath = path.join(runDir, 'vmd.log')
  const result = await runProcess({
    exe: config.vmdExe,
    args: ['-dispdev', 'text', '-e', scriptPath],
    cwd: runDir,
    timeoutMs,
    logPath,
    signal,
  })

  if (!existsSync(bmpPath)) {
    return {
      ok: false,
      stage: 'render',
      runDir,
      reason:
        `VMD 没有产出渲染文件。退出码 ${result.code}，耗时 ${(result.ms / 1000).toFixed(1)} s。` +
        '\n常见原因：等值面阈值太大（数据被滤空）、cube 路径含特殊字符、VMD 找不到 Tachyon。',
      log: readTailSafe(logPath),
    }
  }
  const bmpBytes = statSync(bmpPath).size
  if (bmpBytes < 10_000) {
    return { ok: false, stage: 'render', runDir, reason: `渲染文件只有 ${bmpBytes} 字节，基本是空图。`, log: readTailSafe(logPath) }
  }

  // ---- BMP → PNG / TIFF（顺带裁白边 + 自检） ----
  const outFile = path.join(runDir, `figure.${format === 'tiff' ? 'tiff' : 'png'}`)
  const pyLog = path.join(runDir, 'convert.log')

  // 本文件在 lib/tasks/ 下，图像脚本在包根的 py/image.py。
  const here = path.dirname(fileURLToPath(import.meta.url))
  const scriptPy = path.join(here, '..', '..', 'py', 'image.py')

  const py = await runProcess({
    exe: config.pythonExe,
    args: [scriptPy, 'convert', bmpPath, outFile, ...(trim ? ['--trim'] : [])],
    cwd: runDir,
    timeoutMs: 120_000,
    logPath: pyLog,
    signal,
  })

  const stats = parseJsonLine(readTailSafe(pyLog, 5))
  const ok = existsSync(outFile) && stats?.ok === true
  const issues = []
  if (!ok) issues.push(`BMP 转 ${format.toUpperCase()} 失败：${readTailSafe(pyLog, 3)}`)
  if (stats && typeof stats.nonWhitePercent === 'number' && stats.nonWhitePercent < 0.5) {
    issues.push(
      `图里非白像素只有 ${stats.nonWhitePercent}% —— 大概是空图（等值面阈值太大，或视角/缩放把分子挪出了画布）。`,
    )
  }

  const summary = {
    ok: ok && issues.length === 0,
    stage: 'done',
    runDir,
    figure: { path: outFile, bytes: existsSync(outFile) ? statSync(outFile).size : 0 },
    raw: { path: bmpPath, bytes: bmpBytes },
    size: stats?.outSize ?? null,
    nonWhitePercent: stats?.nonWhitePercent ?? null,
    seconds: result.ms / 1000,
    issues,
    script: scriptPath,
    log: logPath,
  }

  summary.manifestPath = writeManifest(runDir, {
    task: 'render',
    createdAt: new Date().toISOString(),
    molecules,
    size,
    background,
    scale,
    rotate,
    format,
    exitCode: result.code,
    seconds: summary.seconds,
    figure: summary.figure,
    stats,
    issues,
  })

  return summary
}

/**
 * @param {string} logPath
 * @param {number} [lines]
 */
function readTailSafe(logPath, lines = 20) {
  try {
    const all = readFileSync(logPath, 'utf8').split(/\r?\n/)
    return all.slice(Math.max(0, all.length - lines)).join('\n').trim()
  } catch {
    return ''
  }
}

/**
 * @param {string} text
 */
function parseJsonLine(text) {
  if (!text) return null
  const line = text
    .split(/\r?\n/)
    .reverse()
    .find((l) => l.trim().startsWith('{'))
  if (!line) return null
  try {
    return JSON.parse(line)
  } catch {
    return null
  }
}
