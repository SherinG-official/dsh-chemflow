import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { formula, toMolfile, toPdb, toSdf, toSvg, toXyz } from '../lib/export/formats.js'
import { guessBondOrder, layout2d } from '../lib/export/layout2d.js'
import { loadStructureForExport } from '../lib/export/load.js'

const dir = mkdtempSync(path.join(tmpdir(), 'chemflow-export-'))
process.on('exit', () => rmSync(dir, { recursive: true, force: true }))

/** 苯环（正六边形，C-C 1.40）+ 6 个 H，平面分子。 */
function benzene() {
  const atoms = []
  for (let k = 0; k < 6; k += 1) {
    const a = (k * 60 * Math.PI) / 180
    atoms.push({ element: 'C', x: 1.4 * Math.cos(a), y: 1.4 * Math.sin(a), z: 0 })
  }
  for (let k = 0; k < 6; k += 1) {
    const a = (k * 60 * Math.PI) / 180
    atoms.push({ element: 'H', x: 2.48 * Math.cos(a), y: 2.48 * Math.sin(a), z: 0 })
  }
  const bonds = []
  for (let k = 0; k < 6; k += 1) bonds.push([k, (k + 1) % 6])
  for (let k = 0; k < 6; k += 1) bonds.push([k, 6 + k])
  return { atoms, bonds }
}

test('分子式按 Hill 排序', () => {
  const { atoms } = benzene()
  assert.equal(formula(atoms), 'C6H6')
  assert.equal(formula([{ element: 'O' }, { element: 'H' }, { element: 'H' }]), 'H2O')
})

test('xyz：首行原子数 + 每行四个字段，能被读回', () => {
  const { atoms } = benzene()
  const text = toXyz(atoms, 'benzene')
  const lines = text.trim().split('\n')
  assert.equal(Number(lines[0]), atoms.length)
  assert.equal(lines[1], 'benzene')
  assert.equal(lines.length, atoms.length + 2)
  assert.equal(lines[2].trim().split(/\s+/).length, 4)
})

test('molfile：计数行 / M  END / 原子行数正确', () => {
  const { atoms, bonds } = benzene()
  const text = toMolfile(atoms, bonds, { title: 'benzene' })
  const lines = text.split('\n')
  assert.equal(lines[0], 'benzene')
  const counts = lines[3]
  assert.match(counts, /V2000/)
  assert.equal(Number(counts.slice(0, 3)), atoms.length)
  assert.equal(Number(counts.slice(3, 6)), bonds.length)
  assert.ok(text.includes('M  END'))
  // 原子行 + 键行
  assert.equal(lines.length, 4 + atoms.length + bonds.length + 1 + 1)
})

test('2D molfile：z 全为 0，且坐标有区分度', () => {
  const { atoms, bonds } = benzene()
  const coords = layout2d(atoms, bonds)
  const text = toMolfile(atoms, bonds, { coords, title: 'benzene-2d' })
  const lines = text.split('\n').slice(4, 4 + atoms.length)
  const zs = lines.map((line) => Number(line.slice(20, 30)))
  assert.ok(zs.every((z) => z === 0), 'z 应全为 0')
  const unique = new Set(lines.map((line) => `${line.slice(0, 10)}|${line.slice(10, 20)}`))
  assert.equal(unique.size, atoms.length, '2D 坐标不应重合')
})

test('2D 布局：键长接近目标值，且没有 NaN', () => {
  const { atoms, bonds } = benzene()
  const coords = layout2d(atoms, bonds, { bondLength: 1.5 })
  for (const point of coords) {
    assert.ok(Number.isFinite(point.x) && Number.isFinite(point.y))
  }
  const lengths = bonds.map(([i, j]) => Math.hypot(coords[i].x - coords[j].x, coords[i].y - coords[j].y))
  const mean = lengths.reduce((s, v) => s + v, 0) / lengths.length
  assert.ok(Math.abs(mean - 1.5) < 0.15, `平均键长 ${mean.toFixed(2)}`)
  assert.ok(Math.min(...lengths) > 0.4, '不应有重叠原子')
})

test('键级按距离估：单/双/三键能分开', () => {
  assert.equal(guessBondOrder('C', 'C', 1.54), 1)
  assert.equal(guessBondOrder('C', 'C', 1.34), 2)
  assert.equal(guessBondOrder('C', 'C', 1.20), 3)
  assert.equal(guessBondOrder('C', 'O', 1.43), 1)
  assert.equal(guessBondOrder('C', 'O', 1.23), 2)
})

test('sdf 以 $$$$ 结尾，pdb 的 ATOM 行数与原子数一致', () => {
  const { atoms, bonds } = benzene()
  assert.ok(toSdf(atoms, bonds).trimEnd().endsWith('$$$$'))
  const pdb = toPdb(atoms, bonds, { title: 'benzene' })
  const atomLines = pdb.split('\n').filter((line) => line.startsWith('ATOM'))
  assert.equal(atomLines.length, atoms.length)
  assert.ok(pdb.includes('CONECT'))
  assert.ok(pdb.trimEnd().endsWith('END'))
})

test('svg：只画非氢原子（默认），含键线', () => {
  const { atoms, bonds } = benzene()
  const coords = layout2d(atoms, bonds)
  const svg = toSvg(atoms, bonds, { coords })
  assert.ok(svg.startsWith('<svg'))
  assert.ok(svg.includes('</svg>'))
  // 默认不画 H：不该出现 >H< 文本
  assert.ok(!/>H</.test(svg))
  const lines = svg.split('\n').filter((line) => line.includes('<line'))
  assert.ok(lines.length >= 6, `键线数 ${lines.length}`)

  const withH = toSvg(atoms, bonds, { coords, showH: true })
  assert.ok(/>H</.test(withH), 'showH 时应出现 H 标签')
})

test('loadStructureForExport：xyz 与视图包都能读', () => {
  const { atoms, bonds } = benzene()
  const xyzFile = path.join(dir, 'benzene.xyz')
  writeFileSync(xyzFile, toXyz(atoms), 'utf8')
  const fromXyz = loadStructureForExport(xyzFile)
  assert.equal(fromXyz.atoms.length, 12)
  assert.ok(fromXyz.bonds.length >= 6)

  const viewDir = path.join(dir, 'demo.view')
  const meta = { atoms, bonds, volumes: [] }
  writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta), 'utf8')
  const fromMeta = loadStructureForExport(path.join(dir, 'meta.json'))
  assert.equal(fromMeta.atoms.length, 12)
  assert.equal(fromMeta.bonds.length, bonds.length)
  assert.equal(viewDir.includes('demo'), true)
})

test('视图包缺 bonds 时按距离补出来', () => {
  const { atoms } = benzene()
  const file = path.join(dir, 'nobonds.json')
  writeFileSync(file, JSON.stringify({ atoms, volumes: [] }), 'utf8')
  const loaded = loadStructureForExport(file)
  assert.ok(loaded.bonds.length >= 6, `推断出 ${loaded.bonds.length} 根键`)
})

test('空视图包要报错而不是写出空文件', () => {
  const file = path.join(dir, 'empty.json')
  writeFileSync(file, JSON.stringify({ atoms: [], volumes: [] }), 'utf8')
  assert.throws(() => loadStructureForExport(file), /没有原子/)
})

test('写出的 xyz 能被 readStructure 读回（往返一致）', async () => {
  const { readStructure } = await import('../lib/view/structure.js')
  const { atoms } = benzene()
  const file = path.join(dir, 'roundtrip.xyz')
  writeFileSync(file, toXyz(atoms), 'utf8')
  const back = readStructure(file)
  assert.equal(back.atoms.length, atoms.length)
  assert.equal(back.atoms[0].element, 'C')
  assert.ok(Math.abs(back.atoms[0].x - atoms[0].x) < 1e-5)
  // 读回来的键数应与六元环 + 6 根 C-H 一致
  assert.equal(back.bonds.length, 12)
})

test('非平面分子也能布局（不做共线退化）', () => {
  // 四面体
  const atoms = [
    { element: 'C', x: 0, y: 0, z: 0 },
    { element: 'H', x: 1, y: 1, z: 1 },
    { element: 'H', x: -1, y: -1, z: 1 },
    { element: 'H', x: -1, y: 1, z: -1 },
    { element: 'H', x: 1, y: -1, z: -1 },
  ]
  const bonds = [[0, 1], [0, 2], [0, 3], [0, 4]]
  const coords = layout2d(atoms, bonds)
  assert.equal(coords.length, 5)
  for (const point of coords) assert.ok(Number.isFinite(point.x) && Number.isFinite(point.y))
  const unique = new Set(coords.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`))
  assert.ok(unique.size >= 4, '五个原子不应挤在同一点')
})

test('文件读得回来（写盘后内容非空）', () => {
  const { atoms, bonds } = benzene()
  const file = path.join(dir, 'w.mol')
  writeFileSync(file, toMolfile(atoms, bonds), 'utf8')
  const text = readFileSync(file, 'utf8')
  assert.ok(text.length > 100)
  assert.ok(text.includes('M  END'))
})
