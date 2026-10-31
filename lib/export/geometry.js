/**
 * 几何解析与统计（不碰宿主接口，工具和测试共用）。
 *
 * @module dsh-chemflow/export/geometry
 */

/**
 * 解析 SDF / molfile 的坐标块（只要一个分子）。
 *
 * @param {string} text
 * @returns {Array<{ element: string, x: number, y: number, z: number }>}
 */
export function parseMolCoordinates(text) {
  const lines = text.split(/\r?\n/)
  const counts = lines[3] ?? ''
  const atomCount = Number(counts.slice(0, 3))
  if (!Number.isFinite(atomCount) || atomCount <= 0) throw new Error('SDF 计数行解析失败')
  const atoms = []
  for (let index = 0; index < atomCount; index += 1) {
    const line = lines[4 + index]
    if (!line) throw new Error(`SDF 缺第 ${index + 1} 个原子行`)
    atoms.push({
      x: Number(line.slice(0, 10)),
      y: Number(line.slice(10, 20)),
      z: Number(line.slice(20, 30)),
      element: line.slice(31, 34).trim(),
    })
  }
  return atoms
}

/**
 * 分子几何的基本统计量。
 *
 * `thinness` = 三个方向跨度的最小值：真 3D 至少有 ~0.5 Å，
 * 平面结构（比如 gen3d 没跑起来）会接近 0 —— 这是判断「有没有真的做 3D」的核心指标。
 *
 * @param {Array<{ x: number, y: number, z: number }>} atoms
 */
export function geometryStats(atoms) {
  const xs = atoms.map((atom) => atom.x)
  const ys = atoms.map((atom) => atom.y)
  const zs = atoms.map((atom) => atom.z)
  const span = (values) => Math.max(...values) - Math.min(...values)
  const spanX = span(xs)
  const spanY = span(ys)
  const spanZ = span(zs)
  return {
    atoms: atoms.length,
    spanX,
    spanY,
    spanZ,
    thinness: Math.min(spanX, spanY, spanZ),
  }
}

/** 判定「是不是真 3D」。阈值 0.2 Å：平面芳香环也就在 0.01 量级。 */
export const THINNESS_THRESHOLD = 0.2
