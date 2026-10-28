/**
 * Gaussian cube 读取（专门伺候 Multiwfn / ORCA 导出的那两种头）。
 *
 * ## 两件事必须记住，否则数字会错得很隐蔽
 *
 * 1. **坐标单位是 Bohr**，不是 Å。这里统一乘 0.529177 转成 Å，下游只认 Å。
 * 2. **数据按 x 最快、z 最慢排列**，即 `reshape(nz, ny, nx)`。
 *    文件里的线性下标是 `((z*ny)+y)*nx + x`；把它当成 `reshape(nx,ny,nz)`
 *    会让质心差一倍（实测踩过）。
 *
 * 头部差异（ORCA 的 orca_plot 与 Multiwfn 不一样）：只有第 3 行的原子数符号不同
 * （ORCA 用负数表示后面多一行轨道头），这里用 `abs()` 吃掉差异。
 *
 * @module dsh-chemflow/view/cube
 */

import { readFileSync } from 'node:fs'

/** Bohr → Ångström。 */
export const BOHR_TO_ANGSTROM = 0.529177210903

/** 元素序号 → 符号（只覆盖常见元素；其余用 X）。 */
const ELEMENTS = {
  1: 'H', 2: 'He', 3: 'Li', 4: 'Be', 5: 'B', 6: 'C', 7: 'N', 8: 'O', 9: 'F', 10: 'Ne',
  11: 'Na', 12: 'Mg', 13: 'Al', 14: 'Si', 15: 'P', 16: 'S', 17: 'Cl', 18: 'Ar',
  19: 'K', 20: 'Ca', 26: 'Fe', 29: 'Cu', 30: 'Zn', 35: 'Br', 46: 'Pd', 53: 'I', 78: 'Pt',
}

/**
 * 读一个 cube 文件。
 *
 * @param {string} file
 * @returns {{
 *   comment: string,
 *   natoms: number,
 *   atoms: Array<{ z: number, element: string, x: number, y: number, z: number, charge: number }>,
 *   origin: [number, number, number],
 *   dims: [number, number, number],
 *   spacing: [number, number, number],
 *   data: Float64Array,
 *   min: number,
 *   max: number,
 *   seconds: number,
 * }}
 */
export function readCube(file, options = {}) {
  const started = Date.now()
  const text = readFileSync(file, 'utf8')
  const lines = text.split(/\r?\n/)

  const comment = lines[0] ?? ''
  const atomLine = (lines[2] ?? '').trim().split(/\s+/)
  const rawNatoms = Number(atomLine[0])
  const natoms = Math.abs(rawNatoms)
  const originBohr = [Number(atomLine[1]), Number(atomLine[2]), Number(atomLine[3])]

  /** @type {[number, number, number]} */
  const dims = [0, 0, 0]
  /** @type {[number, number, number]} */
  const spacingBohr = [0, 0, 0]
  for (let axis = 0; axis < 3; axis += 1) {
    const parts = (lines[3 + axis] ?? '').trim().split(/\s+/)
    dims[axis] = Number(parts[0])
    spacingBohr[axis] = Number(parts[axis + 1])
  }

  /** @type {Array<{ z: number, element: string, x: number, y: number, z: number, charge: number }>} */
  const atoms = []
  for (let i = 0; i < natoms; i += 1) {
    const parts = (lines[6 + i] ?? '').trim().split(/\s+/)
    const z = Math.round(Number(parts[0]))
    atoms.push({
      z,
      element: ELEMENTS[z] ?? 'X',
      x: Number(parts[2]) * BOHR_TO_ANGSTROM,
      y: Number(parts[3]) * BOHR_TO_ANGSTROM,
      z: Number(parts[4]) * BOHR_TO_ANGSTROM,
      charge: Number(parts[1] ?? 0),
    })
  }

  const total = dims[0] * dims[1] * dims[2]
  const raw = new Float64Array(total)

  // 数据区：每个数值 13 字符宽、每行 6 个。逐行 split 比全文正则稳，也够快
  // （1.77M 个数约 0.4 s）。
  //
  // ORCA 的 cube（orca_plot 产出）用**负原子数**表示原子块后面多一行轨道头
  // （形如 `1 170`）。漏掉这一行会把轨道头当成两个数据点，整条数据流错位。
  const dataStart = 6 + natoms + (rawNatoms < 0 ? 1 : 0)
  let index = 0
  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY
  for (let line = dataStart; line < lines.length && index < total; line += 1) {
    const rawLine = lines[line]
    if (rawLine === undefined || rawLine === '') continue
    const parts = rawLine.trim().split(/\s+/)
    for (let k = 0; k < parts.length; k += 1) {
      const value = Number(parts[k])
      if (!Number.isFinite(value)) continue
      raw[index] = value
      index += 1
      if (value < min) min = value
      if (value > max) max = value
      if (index >= total) break
    }
  }

  if (index < total) {
    throw new Error(`cube 数据不足：头部声明 ${total} 个点，实际只读到 ${index} 个（文件可能被截断）`)
  }

  // ---- 轴向：Multiwfn 的 cube 是 z 最快 ----
  //
  // 标准 Gaussian cube 规定「x 最快」，但 Multiwfn 导出的文件**连续两个数沿 z 走**。
  // 按标准读法算质心会整体错位：实测 complex_tda 的 hole，
  //   标准读法 (2.82, -0.35, -1.82) Å
  //   z 最快   (-0.14,  1.93,  0.10) Å  ← 与 Multiwfn 自己打印的质心逐位一致
  // 所以这里按来源判定，并统一转成内部约定（x 最快、z 最慢）。
  const layout =
    options.layout === 'x' || options.layout === 'z'
      ? options.layout
      : /multiwfn/i.test(comment)
        ? 'z'
        : 'x'

  let data = raw
  if (layout === 'z') {
    data = new Float64Array(total)
    let k = 0
    for (let ix = 0; ix < dims[0]; ix += 1) {
      for (let iy = 0; iy < dims[1]; iy += 1) {
        for (let iz = 0; iz < dims[2]; iz += 1) {
          data[ix + iy * dims[0] + iz * dims[0] * dims[1]] = raw[k]
          k += 1
        }
      }
    }
  }

  return {
    comment,
    natoms,
    atoms,
    origin: originBohr.map((v) => v * BOHR_TO_ANGSTROM),
    dims,
    spacing: spacingBohr.map((v) => v * BOHR_TO_ANGSTROM),
    data,
    layout,
    min,
    max,
    seconds: (Date.now() - started) / 1000,
  }
}

/**
 * 按距离推化学键（VMD 的"球棍"也这么干，只是它的阈值在原子半径表里）。
 *
 * @param {Array<{ element: string, x: number, y: number, z: number }>} atoms
 * @returns {number[][]} 成对的下标，形如 [[0,1], ...]
 */
export function inferBonds(atoms) {
  const radii = { H: 0.31, C: 0.76, N: 0.71, O: 0.66, F: 0.57, S: 1.05, P: 1.07, Cl: 1.02, Br: 1.2, I: 1.39 }
  /** @type {number[][]} */
  const bonds = []
  for (let i = 0; i < atoms.length; i += 1) {
    for (let j = i + 1; j < atoms.length; j += 1) {
      const a = atoms[i]
      const b = atoms[j]
      if (a.element === 'H' && b.element === 'H') continue
      const dx = a.x - b.x
      const dy = a.y - b.y
      const dz = a.z - b.z
      const distance = Math.sqrt(dx * dx + dy * dy + dz * dz)
      const limit = (radii[a.element] ?? 0.77) + (radii[b.element] ?? 0.77) + 0.45
      if (distance > 0.4 && distance <= limit) bonds.push([i, j])
    }
  }
  return bonds
}
