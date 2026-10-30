/**
 * 结构文件写出：XYZ / MOL(V2000) / SDF / PDB / SVG。
 *
 * 全部是纯字符串拼接，零依赖。2D 坐标由 `layout2d.js` 提供（mol/sdf/svg 需要）。
 *
 * 约定：
 * - `atoms[i]` = `{ element, x, y, z }`，单位 Å；
 * - `bonds` = `[[i, j], ...]`，只保证**连通性**，键级按距离估（`guessBondOrder`）；
 * - 写 MOL 时如果给的是 2D 坐标，z 一律写 0。
 *
 * @module dsh-chemflow/export/formats
 */

import { guessBondOrder } from './layout2d.js'

const CPK = {
  H: '#666666', C: '#333333', N: '#2b53c8', O: '#d63a2f', F: '#2f9e44',
  S: '#c8a01e', P: '#d2691e', Cl: '#2f9e44', Br: '#8b4513', I: '#6a3d9a',
}

const fixed = (value, width, digits) => value.toFixed(digits).padStart(width, ' ')

/** 化学式（Hill 排序：C 在最前，H 次之，其余按字母）。 */
export function formula(atoms) {
  const counts = new Map()
  for (const atom of atoms) counts.set(atom.element, (counts.get(atom.element) ?? 0) + 1)
  const keys = [...counts.keys()]
  keys.sort((a, b) => {
    if (a === 'C') return -1
    if (b === 'C') return 1
    if (a === 'H') return -1
    if (b === 'H') return 1
    return a.localeCompare(b)
  })
  return keys.map((key) => `${key}${counts.get(key) > 1 ? counts.get(key) : ''}`).join('')
}

/**
 * XYZ：第一行原子数，第二行注释，之后每行 `元素 x y z`。
 */
export function toXyz(atoms, comment = 'dsh-chemflow') {
  const lines = [String(atoms.length), comment]
  for (const atom of atoms) {
    lines.push(`${atom.element.padEnd(2)} ${atom.x.toFixed(6)} ${atom.y.toFixed(6)} ${atom.z.toFixed(6)}`)
  }
  return `${lines.join('\n')}\n`
}

/**
 * MDL Molfile V2000。
 *
 * @param {Array<{ element: string, x: number, y: number, z: number }>} atoms
 * @param {number[][]} bonds
 * @param {{ title?: string, coords?: Array<{ x: number, y: number }> }} [options]
 *        `coords` 给了就按 2D 写（z=0），否则用原子自带的 3D 坐标。
 */
export function toMolfile(atoms, bonds, options = {}) {
  const title = options.title ?? 'dsh-chemflow'
  const use2d = Array.isArray(options.coords) && options.coords.length === atoms.length
  const lines = []
  lines.push(title.slice(0, 80))
  lines.push('  dsh-chemflow          3D' + (use2d ? '2D' : '  '))
  lines.push('')
  lines.push(`${String(atoms.length).padStart(3)}${String(bonds.length).padStart(3)}  0  0  0  0  0  0  0  0999 V2000`)

  atoms.forEach((atom, index) => {
    const point = use2d ? options.coords[index] : atom
    const z = use2d ? 0 : atom.z
    lines.push(
      `${fixed(point.x, 10, 4)}${fixed(point.y, 10, 4)}${fixed(z, 10, 4)} ${atom.element.padEnd(3)} 0  0  0  0  0  0  0  0  0  0  0  0`,
    )
  })

  for (const [i, j] of bonds) {
    const a = atoms[i]
    const b = atoms[j]
    if (!a || !b) continue
    const pa = use2d ? options.coords[i] : a
    const pb = use2d ? options.coords[j] : b
    const distance = Math.hypot(pa.x - pb.x, pa.y - pb.y, (use2d ? 0 : a.z - b.z))
    const order = guessBondOrder(a.element, b.element, distance)
    lines.push(`${String(i + 1).padStart(3)}${String(j + 1).padStart(3)}${String(order).padStart(3)}  0  0  0  0`)
  }

  lines.push('M  END')
  return `${lines.join('\n')}\n`
}

/** SDF = Molfile + 分隔符（多分子文件只写一个分子）。 */
export function toSdf(atoms, bonds, options = {}) {
  return `${toMolfile(atoms, bonds, options)}$$$$\n`
}

/**
 * PDB：ATOM 记录 + CONECT。
 *
 * 不是给蛋白用的，只为了让 Chimera/PyMOL/Avogadro 能直接读小分子。
 */
export function toPdb(atoms, bonds, options = {}) {
  const title = (options.title ?? 'dsh-chemflow').slice(0, 60)
  const lines = [`HEADER    ${title}`, `TITLE     ${title}`, 'MODEL        1']
  atoms.forEach((atom, index) => {
    const serial = String(index + 1).padStart(5)
    const element = atom.element.padEnd(2)
    lines.push(
      `ATOM  ${serial} ${atom.element.padStart(2)}${'   MOL'.padEnd(4)} A   1    ` +
        `${fixed(atom.x, 8, 3)}${fixed(atom.y, 8, 3)}${fixed(atom.z, 8, 3)}  1.00  0.00          ${element}`,
    )
  })
  lines.push('TER')
  for (let index = 0; index < atoms.length; index += 1) {
    const partners = []
    for (const [i, j] of bonds) {
      if (i === index) partners.push(j + 1)
      else if (j === index) partners.push(i + 1)
    }
    if (partners.length === 0) continue
    const chunks = []
    for (let k = 0; k < partners.length; k += 4) chunks.push(partners.slice(k, k + 4))
    for (const chunk of chunks) {
      lines.push(`CONECT${String(index + 1).padStart(5)}${chunk.map((n) => String(n).padStart(5)).join('')}`)
    }
  }
  lines.push('END')
  return `${lines.join('\n')}\n`
}

/**
 * 2D 结构式 SVG。
 *
 * 画法：键为线段（双键/三键画多条平行线），杂原子标元素符号，碳原子不标。
 * 默认隐藏氢（结构式的惯例），`showH: true` 时全部画出来。
 */
export function toSvg(atoms, bonds, options = {}) {
  const coords = options.coords
  const showH = options.showH === true
  const padding = options.padding ?? 1.2
  const scale = options.scale ?? 48
  const keep = atoms.map((atom, index) => ({ atom, point: coords[index], index })).filter((item) => showH || item.atom.element !== 'H')
  const keptIndices = new Set(keep.map((item) => item.index))
  const visibleBonds = bonds.filter(([i, j]) => keptIndices.has(i) && keptIndices.has(j))

  const xs = keep.map((item) => item.point.x)
  const ys = keep.map((item) => item.point.y)
  const minX = Math.min(...xs, 0) - padding
  const maxX = Math.max(...xs, 0) + padding
  const minY = Math.min(...ys, 0) - padding
  const maxY = Math.max(...ys, 0) + padding
  const width = (maxX - minX) * scale
  const height = (maxY - minY) * scale
  const toX = (x) => (x - minX) * scale
  const toY = (y) => (maxY - y) * scale

  const parts = []
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width.toFixed(1)}" height="${height.toFixed(1)}" viewBox="0 0 ${width.toFixed(1)} ${height.toFixed(1)}">`)
  parts.push(`<rect width="100%" height="100%" fill="#ffffff"/>`)
  parts.push('<g stroke="#222222" stroke-linecap="round" fill="none">')

  for (const [i, j] of visibleBonds) {
    const a = coords[i]
    const b = coords[j]
    if (!a || !b) continue
    const x1 = toX(a.x)
    const y1 = toY(a.y)
    const x2 = toX(b.x)
    const y2 = toY(b.y)
    const dx = x2 - x1
    const dy = y2 - y1
    const length = Math.hypot(dx, dy) || 1
    const nx = -dy / length
    const ny = dx / length
    const order = guessBondOrder(atoms[i].element, atoms[j].element,
      Math.hypot(atoms[i].x - atoms[j].x, atoms[i].y - atoms[j].y, atoms[i].z - atoms[j].z))
    const offsets = order === 3 ? [-3.2, 0, 3.2] : order === 2 ? [-2.6, 2.6] : [0]
    const width2 = order === 1 ? 2.2 : 1.8
    for (const off of offsets) {
      parts.push(
        `<line x1="${(x1 + nx * off).toFixed(1)}" y1="${(y1 + ny * off).toFixed(1)}" ` +
          `x2="${(x2 + nx * off).toFixed(1)}" y2="${(y2 + ny * off).toFixed(1)}" stroke-width="${width2}"/>`,
      )
    }
  }
  parts.push('</g>')

  const fontSize = Math.max(11, scale * 0.42)

  // 隐含氢：删掉氢之后，杂原子要显示成 NH2 / OH 这种形式（结构式规范）。
  const hydrogens = atoms.map(() => 0)
  for (const [i, j] of bonds) {
    if (!atoms[i] || !atoms[j]) continue
    if (atoms[i].element === 'H') hydrogens[j] += 1
    if (atoms[j].element === 'H') hydrogens[i] += 1
  }

  for (const item of keep) {
    if (item.atom.element === 'C') continue
    const color = CPK[item.atom.element] ?? '#333333'
    const x = toX(item.point.x)
    const y = toY(item.point.y)
    const totalH = hydrogens[item.index]
    const label = totalH > 1
      ? `${item.atom.element}H<tspan baseline-shift="sub" font-size="${(fontSize * 0.7).toFixed(1)}">${totalH}</tspan>`
      : `${item.atom.element}${totalH === 1 ? 'H' : ''}`
    parts.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${(fontSize * 0.72).toFixed(1)}" fill="#ffffff"/>`)
    parts.push(
      `<text x="${x.toFixed(1)}" y="${(y + fontSize * 0.35).toFixed(1)}" text-anchor="middle" ` +
        `font-family="Arial, Helvetica, sans-serif" font-size="${fontSize.toFixed(1)}" fill="${color}">${label}</text>`,
    )
  }

  parts.push('</svg>')
  return `${parts.join('\n')}\n`
}
