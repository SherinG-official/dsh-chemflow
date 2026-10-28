/**
 * 从**任意结构文件**里把原子（和键）读出来，交给视图包。
 *
 * 面板不该只认 hole/electron 这一种体系：优化完的几何、轨道、ESP、自旋密度、
 * 甚至一个裸 .xyz，都应该能丢进去看。所以这里按扩展名分派：
 *
 *   .xyz            → 用户/ORCA 导出的标准 xyz
 *   .out / .log     → ORCA 输出，取**最后一块**直角坐标（优化后的几何）
 *   .molden(.input) → [Atoms] 段
 *   .cub            → cube 头里的原子块
 *
 * 键一律按距离推断（VMD 的 ball-and-stick 也是这么干的）。
 *
 * @module dsh-chemflow/view/structure
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'

import { inferBonds, readCube } from './cube.js'

/** 元素符号表，用来把 ORCA/Molden 里的原子序数换算回符号。 */
const ELEMENTS = [
  'X', 'H', 'He', 'Li', 'Be', 'B', 'C', 'N', 'O', 'F', 'Ne', 'Na', 'Mg', 'Al', 'Si', 'P', 'S', 'Cl', 'Ar', 'K',
  'Ca', 'Sc', 'Ti', 'V', 'Cr', 'Mn', 'Fe', 'Co', 'Ni', 'Cu', 'Zn', 'Ga', 'Ge', 'As', 'Se', 'Br', 'Kr', 'Rb',
  'Sr', 'Y', 'Zr', 'Nb', 'Mo', 'Tc', 'Ru', 'Rh', 'Pd', 'Ag', 'Cd', 'In', 'Sn', 'Sb', 'Te', 'I', 'Xe', 'Cs',
  'Ba', 'La', 'Ce', 'Pr', 'Nd', 'Pm', 'Sm', 'Eu', 'Gd', 'Tb', 'Dy', 'Ho', 'Er', 'Tm', 'Yb', 'Lu', 'Hf', 'Ta',
  'W', 'Re', 'Os', 'Ir', 'Pt', 'Au', 'Hg', 'Tl', 'Pb', 'Bi', 'Po', 'At', 'Rn',
]

/** 元素符号规范化：`cl` → `Cl`，`CL` → `Cl`。 */
function normalizeElement(raw) {
  const text = String(raw ?? '').trim().replace(/[^A-Za-z]/g, '')
  if (text === '') return 'X'
  return text[0].toUpperCase() + text.slice(1).toLowerCase()
}

/** 原子序数 → 符号。 */
function elementByZ(z) {
  const index = Number(z)
  return ELEMENTS[index] ?? 'X'
}

function parseXyz(text) {
  const lines = text.split(/\r?\n/)
  const count = Number(lines[0]?.trim())
  if (!Number.isFinite(count) || count <= 0) throw new Error('xyz 第一行不是原子数')
  const atoms = []
  for (let i = 0; i < count; i += 1) {
    const line = lines[2 + i]
    if (!line) break
    const parts = line.trim().split(/\s+/)
    if (parts.length < 4) continue
    atoms.push({
      element: normalizeElement(parts[0]),
      x: Number(parts[1]),
      y: Number(parts[2]),
      z: Number(parts[3]),
    })
  }
  return atoms
}

/**
 * ORCA 输出：取**最后一块** `CARTESIAN COORDINATES (ANGSTROEM)`。
 * 优化作业里前面还有输入坐标、每一步的坐标，所以要最后一块。
 */
function parseOrcaOut(text) {
  const marker = /CARTESIAN COORDINATES\s*\(ANGSTROEM\)/g
  let last = -1
  let match
  while ((match = marker.exec(text)) !== null) last = match.index
  if (last < 0) throw new Error('ORCA 输出里没找到 CARTESIAN COORDINATES (ANGSTROEM)')

  const rest = text.slice(last).split(/\r?\n/)
  const atoms = []
  // 0: 标题行，1: 分隔线，之后是 元素 x y z，直到空行或非数据行
  for (let i = 2; i < rest.length; i += 1) {
    const line = rest[i]
    if (line.trim() === '') break
    const parts = line.trim().split(/\s+/)
    if (parts.length < 4) break
    const element = normalizeElement(parts[0])
    if (!/^[A-Za-z]{1,2}$/.test(parts[0])) break
    const x = Number(parts[1])
    const y = Number(parts[2])
    const z = Number(parts[3])
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) break
    atoms.push({ element, x, y, z })
  }
  if (atoms.length === 0) throw new Error('ORCA 坐标块解析结果为空')
  return atoms
}

/** Molden：`[Atoms] AU|Angs`，每行 `元素 序号 原子序数 x y z`。 */
function parseMolden(text) {
  const lines = text.split(/\r?\n/)
  const start = lines.findIndex((line) => /^\s*\[Atoms\]/i.test(line))
  if (start < 0) throw new Error('molden 里没有 [Atoms] 段')
  const header = lines[start]
  const isBohr = /au/i.test(header) && !/angs/i.test(header)
  const atoms = []
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i]
    if (/^\s*\[/.test(line)) break
    if (line.trim() === '') continue
    const parts = line.trim().split(/\s+/)
    if (parts.length < 6) continue
    const scale = isBohr ? 0.529177210903 : 1
    atoms.push({
      element: normalizeElement(parts[0]),
      x: Number(parts[3]) * scale,
      y: Number(parts[4]) * scale,
      z: Number(parts[5]) * scale,
    })
  }
  if (atoms.length === 0) throw new Error('molden [Atoms] 解析结果为空')
  return atoms
}

/** cube 头里的原子块。 */
function parseCubeAtoms(file) {
  const cube = readCube(file)
  return cube.atoms.map((atom) => ({ element: atom.element, x: atom.x, y: atom.y, z: atom.z }))
}

/**
 * 从 ORCA 输出里读偶极矩（Debye），取**最后一次**打印的那块。
 *
 * ORCA 的格式是：
 *   Total Dipole Moment    :  0.000  0.000  1.234     ← a.u.（e·bohr）
 *   Magnitude (Debye)      :  3.137
 * 这里只用 Total 三列换算成 Debye，不依赖 Magnitude 行是否被截断。
 *
 * @param {string} file
 * @returns {{ vector: number[], magnitude: number, unit: string } | null}
 */
export function readDipole(file) {
  const text = readFileSync(file, 'utf8')
  const lines = text.split(/\r?\n/)
  const DEBYE_PER_AU = 2.541746473

  /** @type {{ vector: number[], magnitude: number } | null} */
  let found = null
  for (const line of lines) {
    const match = /Total Dipole Moment\s*:\s*(-?\d+\.\d+)\s+(-?\d+\.\d+)\s+(-?\d+\.\d+)/.exec(line)
    if (!match) continue
    const vector = [Number(match[1]) * DEBYE_PER_AU, Number(match[2]) * DEBYE_PER_AU, Number(match[3]) * DEBYE_PER_AU]
    found = { vector, magnitude: Math.hypot(...vector) }
  }
  if (!found) return null
  return { ...found, unit: 'debye' }
}

/**
 * 读一个结构文件，返回原子与键。
 *
 * @param {string} file
 * @returns {{ atoms: Array<{ element: string, x: number, y: number, z: number }>, bonds: number[][], source: string }}
 */
export function readStructure(file) {
  const ext = path.extname(file).toLowerCase()
  const text = ['.xyz', '.out', '.log', '.molden', '.input'].includes(ext) ? readFileSync(file, 'utf8') : ''

  let atoms
  if (ext === '.xyz') atoms = parseXyz(text)
  else if (ext === '.cub' || ext === '.cube') atoms = parseCubeAtoms(file)
  else if (ext === '.out' || ext === '.log') atoms = parseOrcaOut(text)
  else if (ext === '.molden' || (ext === '.input' && text.includes('[Atoms]'))) atoms = parseMolden(text)
  else throw new Error(`不认识的结构文件类型：${ext || '(无扩展名)'}`)

  return { atoms, bonds: inferBonds(atoms), source: file }
}

export const __internals = { parseXyz, parseOrcaOut, parseMolden, readDipole, normalizeElement, elementByZ }
