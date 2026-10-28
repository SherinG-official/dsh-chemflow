/**
 * 体数据重采样与量化。
 *
 * ## 为什么不是简单抽点
 *
 * cube 是 149×128×93；浏览器端做 marching cubes 要的是"够快"的网格。
 * 直接隔点抽样（factor=2 → 75×64×47）会让等值面出现台阶；三线性重采样到
 * 目标分辨率（默认最长边 112）能在**同样点数**下把面画得更顺。
 *
 * ## 为什么量化成 Int16
 *
 * Float32 的 1.77M 点 = 7 MB/路，两路 14 MB，走 HTTP 文件通道加载明显拖。
 * Int16 + 头里记 min/max 后体积减半，等值面精度远超显示需要（1/65535 量级）。
 *
 * @module dsh-chemflow/view/resample
 */

/**
 * 三线性重采样到目标分辨率。
 *
 * @param {Float64Array} data 源数据，x 最快、z 最慢
 * @param {[number, number, number]} dims
 * @param {[number, number, number]} target 目标各轴点数
 * @returns {Float64Array}
 */
export function resampleTrilinear(data, dims, target) {
  const [nx, ny, nz] = dims
  const [tx, ty, tz] = target

  // 每个目标格点对应的源坐标与两个邻居 + 权重，先算好，内层循环只做乘法。
  const axis = (n, t) => {
    const idx0 = new Int32Array(t)
    const idx1 = new Int32Array(t)
    const frac = new Float64Array(t)
    for (let i = 0; i < t; i += 1) {
      const s = t === 1 ? 0 : (i * (n - 1)) / (t - 1)
      const i0 = Math.min(n - 1, Math.floor(s))
      const i1 = Math.min(n - 1, i0 + 1)
      idx0[i] = i0
      idx1[i] = i1
      frac[i] = s - i0
    }
    return { idx0, idx1, frac }
  }

  const ax = axis(nx, tx)
  const ay = axis(ny, ty)
  const az = axis(nz, tz)

  const out = new Float64Array(tx * ty * tz)
  let o = 0
  for (let z = 0; z < tz; z += 1) {
    const z0 = az.idx0[z]
    const z1 = az.idx1[z]
    const fz = az.frac[z]
    const rowZ0 = z0 * ny * nx
    const rowZ1 = z1 * ny * nx
    for (let y = 0; y < ty; y += 1) {
      const y0 = ay.idx0[y]
      const y1 = ay.idx1[y]
      const fy = ay.frac[y]
      const base00 = rowZ0 + y0 * nx
      const base01 = rowZ0 + y1 * nx
      const base10 = rowZ1 + y0 * nx
      const base11 = rowZ1 + y1 * nx
      for (let x = 0; x < tx; x += 1) {
        const x0 = ax.idx0[x]
        const x1 = ax.idx1[x]
        const fx = ax.frac[x]

        const c000 = data[base00 + x0]
        const c100 = data[base00 + x1]
        const c010 = data[base01 + x0]
        const c110 = data[base01 + x1]
        const c001 = data[base10 + x0]
        const c101 = data[base10 + x1]
        const c011 = data[base11 + x0]
        const c111 = data[base11 + x1]

        const c00 = c000 + (c100 - c000) * fx
        const c01 = c010 + (c110 - c010) * fx
        const c10 = c001 + (c101 - c001) * fx
        const c11 = c011 + (c111 - c011) * fx

        const c0 = c00 + (c01 - c00) * fy
        const c1 = c10 + (c11 - c10) * fy

        out[o] = c0 + (c1 - c0) * fz
        o += 1
      }
    }
  }
  return out
}

/**
 * 计算目标分辨率：最长边不超过 `maxDim`，保持长宽比，每轴至少 8。
 *
 * @param {[number, number, number]} dims
 * @param {number} maxDim
 * @returns {[number, number, number]}
 */
export function targetDims(dims, maxDim) {
  const longest = Math.max(...dims)
  // 已经不超限就原样返回：不做无意义的放大（放大只会变慢，不会变清楚）。
  if (longest <= maxDim) return [...dims]
  const scale = maxDim / longest
  return dims.map((n) => Math.max(4, Math.round(n * scale)))
}

/**
 * 把浮点体数据量化成 Int16，并返回反量化所需的 min/max。
 *
 * @param {Float64Array} data
 * @returns {{ data: Int16Array, min: number, max: number, scale: number }}
 */
export function quantizeInt16(data) {
  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY
  for (let i = 0; i < data.length; i += 1) {
    const v = data[i]
    if (v < min) min = v
    if (v > max) max = v
  }
  const span = max - min
  const out = new Int16Array(data.length)
  if (span === 0) return { data: out, min, max, scale: 0 }
  const scale = 65535 / span
  for (let i = 0; i < data.length; i += 1) {
    out[i] = Math.round((data[i] - min) * scale) - 32768
  }
  return { data: out, min, max, scale }
}
