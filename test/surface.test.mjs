import assert from 'node:assert/strict'
import test from 'node:test'

import { surfaceNets } from '../lib/view/surface.js'

/**
 * 造一个球体标量场：球内大于 iso、球外小于 iso。
 *
 * @param {number} n
 * @param {number} radius 以格点为单位
 */
function sphereField(n, radius) {
  const field = new Float32Array(n * n * n)
  const c = (n - 1) / 2
  for (let z = 0; z < n; z += 1) {
    for (let y = 0; y < n; y += 1) {
      for (let x = 0; x < n; x += 1) {
        const d = Math.hypot(x - c, y - c, z - c)
        field[x + y * n + z * n * n] = radius - d
      }
    }
  }
  return field
}

test('surfaceNets 在球体场上生成闭合网格：无越界、无退化三角形', () => {
  const n = 24
  const radius = 8
  const field = sphereField(n, radius)
  const mesh = surfaceNets(field, [n, n, n], 0)

  assert.ok(mesh.positions.length > 0, '应该生成了顶点')
  assert.ok(mesh.triangles > 0, '应该生成了三角形')
  assert.equal(mesh.indices.length % 3, 0)

  // 所有索引都在范围内
  const vertexCount = mesh.positions.length / 3
  for (const index of mesh.indices) {
    assert.ok(Number.isInteger(index) && index >= 0 && index < vertexCount, `越界索引 ${index}`)
  }

  // 顶点必须落在球面附近（±1 格）
  for (let i = 0; i < mesh.positions.length; i += 3) {
    const d = Math.hypot(mesh.positions[i] - (n - 1) / 2, mesh.positions[i + 1] - (n - 1) / 2, mesh.positions[i + 2] - (n - 1) / 2)
    assert.ok(Math.abs(d - radius) < 1.2, `顶点离球面太远：${d.toFixed(2)}`)
  }

  // 没有退化三角形（面积 > 0）
  let degenerate = 0
  for (let t = 0; t < mesh.indices.length; t += 3) {
    const [a, b, c] = [mesh.indices[t], mesh.indices[t + 1], mesh.indices[t + 2]]
    const ax = mesh.positions[a * 3], ay = mesh.positions[a * 3 + 1], az = mesh.positions[a * 3 + 2]
    const bx = mesh.positions[b * 3], by = mesh.positions[b * 3 + 1], bz = mesh.positions[b * 3 + 2]
    const cx = mesh.positions[c * 3], cy = mesh.positions[c * 3 + 1], cz = mesh.positions[c * 3 + 2]
    const ab = [bx - ax, by - ay, bz - az]
    const ac = [cx - ax, cy - ay, cz - az]
    const crossLen = Math.hypot(
      ab[1] * ac[2] - ab[2] * ac[1],
      ab[2] * ac[0] - ab[0] * ac[2],
      ab[0] * ac[1] - ab[1] * ac[0],
    )
    if (crossLen < 1e-6) degenerate += 1
  }
  assert.equal(degenerate, 0, '不应有退化三角形')
})

test('surfaceNets 把顶点换到世界坐标（origin + index*spacing）', () => {
  const n = 16
  const field = sphereField(n, 5)
  const origin = [10, -4, 2]
  const spacing = [0.2, 0.3, 0.4]
  const mesh = surfaceNets(field, [n, n, n], 0, origin, spacing)
  let minX = Infinity
  let maxX = -Infinity
  for (let i = 0; i < mesh.positions.length; i += 3) {
    minX = Math.min(minX, mesh.positions[i])
    maxX = Math.max(maxX, mesh.positions[i])
  }
  // 球在网格中间（约 7.5），换算后 x 应在 10 + 7.5*0.2 = 11.5 附近
  assert.ok(minX > origin[0] && maxX > origin[0], 'x 应该被平移到 origin 之后')
  assert.ok(Math.abs((minX + maxX) / 2 - (origin[0] + ((n - 1) / 2) * spacing[0])) < 1)
})

test('surfaceNets 对空场返回空网格而不是崩', () => {
  const field = new Float32Array(8 * 8 * 8).fill(-1)
  const mesh = surfaceNets(field, [8, 8, 8], 0)
  assert.equal(mesh.positions.length, 0)
  assert.equal(mesh.indices.length, 0)
})
