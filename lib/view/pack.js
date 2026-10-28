/**
 * 组装「视图包」：一个目录，里面是浏览器端直接能渲染的东西。
 *
 * ```
 * <name>.view/
 *   ├─ meta.json       尺寸/原点/间距/量化范围/原子/键/指标
 *   ├─ hole.bin        Int16 体数据（x 最快），每路体数据一个
 *   └─ electron.bin
 * ```
 *
 * 客户端只做两件事：fetch meta.json → fetch *.bin → ArrayBuffer 当成 Int16Array。
 * 不需要宿主再参与，所以面板可以在没有 RPC 的情况下独立工作。
 *
 * **不限 hole/electron**：体数据可以是任意多路（轨道、ESP、自旋密度…），
 * 也可以一路都没有（只看优化后的几何）。
 *
 * @module dsh-chemflow/view/pack
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { inferBonds, readCube } from './cube.js'
import { quantizeInt16, resampleTrilinear, targetDims } from './resample.js'

/** 多路体数据没指定颜色时按顺序取，红/蓝/绿/橙… */
const PALETTE = [
  [0.85, 0.25, 0.25],
  [0.25, 0.35, 0.85],
  [0.20, 0.65, 0.35],
  [0.90, 0.60, 0.15],
  [0.55, 0.30, 0.75],
  [0.20, 0.65, 0.70],
]

/** 体数据名字里的空白与特殊字符换成下划线（要当文件名用）。 */
function safeName(raw) {
  const cleaned = String(raw ?? 'vol').trim().replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '')
  return cleaned === '' ? 'vol' : cleaned
}

/**
 * 建一个视图包。
 *
 * @param {{
 *   outDir: string,
 *   name: string,
 *   title?: string,
 *   volumes?: Array<{ name?: string, label?: string, file: string, color?: number[], iso?: number }>,
 *   atoms?: Array<{ element: string, x: number, y: number, z: number }>,
 *   bonds?: number[][],
 *   dipole?: { origin: number[], vector: number[], magnitude: number, unit?: string, label?: string },
 *   metrics?: Record<string, any>,
 *   maxDim?: number,
 * }} options
 *
 * `dipole` 里的 origin / vector 都用 Å（vector 已按显示比例缩放），
 * magnitude 保留 Debye 原值用来标注。
 */
export function buildViewPack(options) {
  const { outDir, name, title, metrics = {}, maxDim = 160 } = options
  const volumes = Array.isArray(options.volumes) ? options.volumes : []
  const hasStructure = Array.isArray(options.atoms) && options.atoms.length > 0
  if (volumes.length === 0 && !hasStructure) throw new Error('既没有体数据也没有原子，没什么可画的')

  const dir = path.join(path.resolve(outDir), `${name}.view`)
  mkdirSync(dir, { recursive: true })

  /** @type {Array<Record<string, any>>} */
  const volumeMeta = []
  /** @type {Array<{ element: string, x: number, y: number, z: number }>} */
  let atoms = hasStructure ? options.atoms : []
  /** @type {number[][]} */
  let bonds = Array.isArray(options.bonds) ? options.bonds : []

  for (const [index, volume] of volumes.entries()) {
    const cube = readCube(volume.file)
    // 没有显式给结构时，用第一路 cube 头里的原子。
    if (atoms.length === 0) {
      atoms = cube.atoms.map((a) => ({ element: a.element, x: a.x, y: a.y, z: a.z }))
      bonds = inferBonds(atoms)
    }

    const target = targetDims(cube.dims, maxDim)
    const resampled = resampleTrilinear(cube.data, cube.dims, target)

    // 等值面阈值先算出来：下面的裁剪要用它。
    const iso = volume.iso ?? (cube.max <= 0.1 ? Number((cube.max * 0.1).toFixed(5)) : 0.02)

    // **按阈值裁剪再量化**。密度场在核附近能到 27 a.u.，而表面在 0.001——
    // 直接 16 位量化，0.001 只落在两三个量化级上，等值面会变成梯田。
    // 裁到 20×iso 后，量化的每一级是 0.0003×iso，表面就平滑了。
    // 不影响已有的 hole/electron（max 0.028 < 20×0.003）和轨道（0.1 < 20×0.02）。
    const clipHi = Number.isFinite(volume.clip) ? Math.abs(volume.clip) : Math.abs(iso) * 20
    if (clipHi > 0 && cube.max > clipHi) {
      const data = resampled
      for (let i = 0; i < data.length; i += 1) {
        if (data[i] > clipHi) data[i] = clipHi
        else if (data[i] < -clipHi) data[i] = -clipHi
      }
    }
    const quantized = quantizeInt16(resampled)

    // 量化后各轴间距按比例缩放（原点不变）。
    const spacing = cube.spacing.map((d, axis) => (d * (cube.dims[axis] - 1)) / Math.max(1, target[axis] - 1))

    const stem = safeName(volume.name ?? path.basename(volume.file).replace(/\.(cub|cube)$/i, ''))
    const file = `${stem}.bin`
    writeFileSync(path.join(dir, file), Buffer.from(quantized.data.buffer, quantized.data.byteOffset, quantized.data.byteLength))

    volumeMeta.push({
      name: stem,
      label: volume.label ?? stem,
      file,
      dims: target,
      origin: cube.origin,
      spacing,
      min: quantized.min,
      max: quantized.max,
      iso,
      clipped: cube.max > clipHi ? clipHi : undefined,
      color: volume.color ?? PALETTE[index % PALETTE.length],
      // 负值瓣：画 field < -iso（ESP、轨道相位这类正负成对的场用）
      negative: volume.negative === true,
      // 用第 j 路体数据给这一路的等值面顶点着色（ESP 表面就是这么来的）
      colorBy: Number.isInteger(volume.colorBy) ? volume.colorBy : undefined,
      // 只当「数据源」用的那一路可以不显示（比如给表面着色的 ESP 体数据）
      visible: volume.visible !== false,
      bytes: quantized.data.byteLength,
      source: volume.file,
      sourceDims: cube.dims,
      sourceMax: cube.max,
      seconds: cube.seconds,
    })
  }

  if (bonds.length === 0 && atoms.length > 0 && !Array.isArray(options.bonds)) bonds = inferBonds(atoms)

  const meta = {
    version: 1,
    name,
    title: title ?? name,
    createdAt: new Date().toISOString(),
    atoms,
    bonds,
    volumes: volumeMeta,
    metrics,
    units: { length: 'angstrom' },
  }
  if (options.dipole) {
    meta.dipole = {
      origin: options.dipole.origin,
      vector: options.dipole.vector,
      magnitude: options.dipole.magnitude,
      unit: options.dipole.unit ?? 'debye',
      label: options.dipole.label ?? 'μ',
    }
  }

  const metaPath = path.join(dir, 'meta.json')
  writeFileSync(metaPath, `${JSON.stringify(meta)}\n`, 'utf8')

  const totalBytes = volumeMeta.reduce((sum, v) => sum + v.bytes, 0) + Buffer.byteLength(JSON.stringify(meta))
  return { dir, metaPath, meta, totalBytes }
}
