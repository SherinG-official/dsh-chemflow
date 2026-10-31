import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveConfig } from '../lib/config.js'
import { geometryStats, parseMolCoordinates, THINNESS_THRESHOLD } from '../lib/export/geometry.js'

const SDF = `test
  dsh 3D

  3  2  0  0  0  0  0  0  0  0999 V2000
    0.0000    0.0000    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0
    1.5400    0.0000    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0
    0.7700    1.3340    0.8900 O   0  0  0  0  0  0  0  0  0  0  0  0
  1  2  1  0  0  0  0
  2  3  1  0  0  0  0
M  END
`

test('parseMolCoordinates 读出坐标与元素', () => {
  const atoms = parseMolCoordinates(SDF)
  assert.equal(atoms.length, 3)
  assert.deepEqual(atoms.map((a) => a.element), ['C', 'C', 'O'])
  assert.equal(atoms[1].x, 1.54)
  assert.equal(atoms[2].z, 0.89)
})

test('parseMolCoordinates 对坏数据报错', () => {
  assert.throws(() => parseMolCoordinates('garbage'), /解析失败/)
})

test('geometryStats：平整结构的最薄方向接近 0', () => {
  const flat = [
    { x: 0, y: 0, z: 0 },
    { x: 1.4, y: 0, z: 0 },
    { x: 0.7, y: 1.2, z: 0 },
    { x: 0.7, y: -1.2, z: 0 },
  ]
  const stats = geometryStats(flat)
  assert.ok(stats.thinness < THINNESS_THRESHOLD, `平面结构 thinness=${stats.thinness}，应被判为平面`)
})

test('geometryStats：真 3D 结构最薄方向有量', () => {
  const chair = [
    { x: 1.26, y: 0.72, z: 0.35 },
    { x: 1.26, y: -0.72, z: -0.35 },
    { x: 0, y: -1.45, z: 0.35 },
    { x: -1.26, y: -0.72, z: -0.35 },
    { x: -1.26, y: 0.72, z: 0.35 },
    { x: 0, y: 1.45, z: -0.35 },
  ]
  const stats = geometryStats(chair)
  assert.ok(stats.thinness > 0.5, `椅式 thinness=${stats.thinness}，应 > 0.5`)
  assert.equal(stats.atoms, 6)
})

test('配置能自动找到 obabel 与数据目录（本机装了 Avogadro2 时）', () => {
  const config = resolveConfig({})
  if (!config.obabelExe) {
    // 没装 Avogadro2 的机器上跳过，不当作失败
    return
  }
  assert.match(config.obabelExe, /obabel\.exe$/i)
  assert.ok(config.babelDataDir.length > 0, '应推出 data 目录')
})

test('配置允许显式指定并校验数据目录', () => {
  const config = resolveConfig({ babelDataDir: 'C:/definitely/not/here' })
  // 路径不存在时退回自动推断，不能把一个坏路径透传下去
  assert.ok(!config.babelDataDir.startsWith('C:/definitely'), '坏路径应被丢弃')
})
