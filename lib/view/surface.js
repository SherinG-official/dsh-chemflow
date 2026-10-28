/**
 * Surface Nets（等值面网格化）+ 梯度法线。
 *
 * 选它而不是 marching cubes：不需要 256 项边表，代码短一个数量级；配合梯度法线
 * 着色足够顺滑。体数据 112×96×70 时在浏览器里几十毫秒。
 *
 * 约定：体数据 `field` 按 **x 最快、z 最慢** 排列（与 cube 一致）；
 * 返回的顶点已经在世界坐标（origin + index*spacing）。
 *
 * @module dsh-chemflow/view/surface
 */

/**
 * @param {Float32Array} field
 * @param {[number, number, number]} dims
 * @param {number} iso
 * @param {[number, number, number]} [origin]
 * @param {[number, number, number]} [spacing]
 * @returns {{ positions: Float32Array, normals: Float32Array, indices: Uint32Array, triangles: number }}
 */
export function surfaceNets(field, dims, iso, origin = [0, 0, 0], spacing = [1, 1, 1]) {
  const [nx, ny, nz] = dims
  const sx = 1
  const sy = nx
  const sz = nx * ny
  const cx = nx - 1
  const cy = ny - 1
  const cz = nz - 1
  const cellVertex = new Int32Array(cx * cy * cz).fill(-1)
  const positions = []
  const cellIndex = (x, y, z) => x + y * cx + z * cx * cy

  const corner = new Float32Array(8)
  for (let z = 0; z < cz; z += 1) {
    for (let y = 0; y < cy; y += 1) {
      for (let x = 0; x < cx; x += 1) {
        let mask = 0
        let k = 0
        for (let dz = 0; dz < 2; dz += 1) {
          for (let dy = 0; dy < 2; dy += 1) {
            for (let dx = 0; dx < 2; dx += 1) {
              const v = field[(x + dx) * sx + (y + dy) * sy + (z + dz) * sz]
              corner[k] = v
              if (v > iso) mask |= 1 << k
              k += 1
            }
          }
        }
        if (mask === 0 || mask === 255) continue

        // 12 条边里跨 iso 的，取交点平均。
        let sumX = 0
        let sumY = 0
        let sumZ = 0
        let count = 0
        for (let e = 0; e < 12; e += 1) {
          const a = EDGES[e][0]
          const b = EDGES[e][1]
          const va = corner[a]
          const vb = corner[b]
          if ((va > iso) === (vb > iso)) continue
          const t = (iso - va) / (vb - va)
          const ax = a & 1
          const ay = (a >> 1) & 1
          const az = (a >> 2) & 1
          const bx = b & 1
          const by = (b >> 1) & 1
          const bz = (b >> 2) & 1
          sumX += ax + (bx - ax) * t
          sumY += ay + (by - ay) * t
          sumZ += az + (bz - az) * t
          count += 1
        }
        if (count === 0) continue
        cellVertex[cellIndex(x, y, z)] = positions.length / 3
        positions.push(x + sumX / count, y + sumY / count, z + sumZ / count)
      }
    }
  }

  const indices = []
  const sample = (x, y, z) => field[x * sx + y * sy + z * sz]

  // 每条跨面的网格边连接 4 个相邻格子的顶点。边界要收一格，否则
  // cellIndex 会越界拿到 undefined，生成一堆退化三角形（实测就是"片状"等值面）。
  for (let z = 0; z < nz; z += 1) {
    for (let y = 0; y < ny; y += 1) {
      for (let x = 0; x < nx; x += 1) {
        const v0 = sample(x, y, z)

        if (x < nx - 1 && y >= 1 && y < ny - 1 && z >= 1 && z < nz - 1) {
          const v1 = sample(x + 1, y, z)
          if ((v0 > iso) !== (v1 > iso)) {
            pushQuad(
              indices,
              [
                cellVertex[cellIndex(x, y - 1, z - 1)],
                cellVertex[cellIndex(x, y, z - 1)],
                cellVertex[cellIndex(x, y, z)],
                cellVertex[cellIndex(x, y - 1, z)],
              ],
              v0 <= iso,
            )
          }
        }

        if (y < ny - 1 && x >= 1 && x < nx - 1 && z >= 1 && z < nz - 1) {
          const v1 = sample(x, y + 1, z)
          if ((v0 > iso) !== (v1 > iso)) {
            pushQuad(
              indices,
              [
                cellVertex[cellIndex(x - 1, y, z - 1)],
                cellVertex[cellIndex(x - 1, y, z)],
                cellVertex[cellIndex(x, y, z)],
                cellVertex[cellIndex(x, y, z - 1)],
              ],
              v0 <= iso,
            )
          }
        }

        if (z < nz - 1 && x >= 1 && x < nx - 1 && y >= 1 && y < ny - 1) {
          const v1 = sample(x, y, z + 1)
          if ((v0 > iso) !== (v1 > iso)) {
            pushQuad(
              indices,
              [
                cellVertex[cellIndex(x - 1, y - 1, z)],
                cellVertex[cellIndex(x, y - 1, z)],
                cellVertex[cellIndex(x, y, z)],
                cellVertex[cellIndex(x - 1, y, z)],
              ],
              v0 <= iso,
            )
          }
        }
      }
    }
  }

  const pos = new Float32Array(positions)
  const normals = new Float32Array(pos.length)
  const [dx, dy, dz] = spacing
  const [ox, oy, oz] = origin
  for (let i = 0; i < pos.length; i += 3) {
    const gx = pos[i]
    const gy = pos[i + 1]
    const gz = pos[i + 2]
    pos[i] = ox + gx * dx
    pos[i + 1] = oy + gy * dy
    pos[i + 2] = oz + gz * dz

    const x = Math.max(0, Math.min(nx - 2, Math.round(gx)))
    const y = Math.max(0, Math.min(ny - 2, Math.round(gy)))
    const z = Math.max(0, Math.min(nz - 2, Math.round(gz)))
    const gradX = (sample(x + 1, y, z) - sample(x, y, z)) / dx
    const gradY = (sample(x, y + 1, z) - sample(x, y, z)) / dy
    const gradZ = (sample(x, y, z + 1) - sample(x, y, z)) / dz
    const len = Math.hypot(gradX, gradY, gradZ) || 1
    // 密度场向外的法线是负梯度方向。
    normals[i] = -gradX / len
    normals[i + 1] = -gradY / len
    normals[i + 2] = -gradZ / len
  }

  return { positions: pos, normals, indices: new Uint32Array(indices), triangles: indices.length / 3 }
}

/** 8 个角点的 12 条边（角点编号 = dx + 2*dy + 4*dz）。 */
const EDGES = [
  [0, 1], [2, 3], [4, 5], [6, 7],
  [0, 2], [1, 3], [4, 6], [5, 7],
  [0, 4], [1, 5], [2, 6], [3, 7],
]

/**
 * 四边形 → 两个三角形。任一角点没有顶点（-1/undefined）就整块丢掉。
 *
 * @param {number[]} indices
 * @param {number[]} q
 * @param {boolean} flip
 */
function pushQuad(indices, q, flip) {
  for (const v of q) if (!Number.isInteger(v) || v < 0) return
  if (flip) {
    indices.push(q[0], q[2], q[1], q[0], q[3], q[2])
  } else {
    indices.push(q[0], q[1], q[2], q[0], q[2], q[3])
  }
}
