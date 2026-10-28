/**
 * 产物核对。
 *
 * 存在的理由只有一条：**Multiwfn 打印 "Done!" 不代表文件写对了**。实测过 cube 导出
 * 写成 0 字节、日志里照样两个 "Done!" 的情况。所以「没产物就是失败，不许返回完成」
 * 必须写进代码，而不是写在文档里靠自觉。
 *
 * @module dsh-chemflow/artifacts
 */

import { existsSync, readFileSync, statSync } from 'node:fs'

/**
 * 核对一个普通文件。
 *
 * @param {string} file
 * @param {{ minBytes?: number }} [options]
 */
export function verifyFile(file, { minBytes = 1 } = {}) {
  if (!existsSync(file)) return { path: file, ok: false, bytes: 0, reason: '文件不存在' }
  const bytes = statSync(file).size
  if (bytes < minBytes) return { path: file, ok: false, bytes, reason: `只有 ${bytes} 字节（下限 ${minBytes}）` }
  return { path: file, ok: true, bytes }
}

/**
 * 核对 cube：文件在、够大、并且头部能解出「原子数 / 三个方向点数」。
 *
 * ## 头部差异（ORCA 与 Multiwfn 不一样）
 *
 * ```
 *   行1 注释
 *   行2 注释
 *   行3 natoms ox oy oz        ← ORCA 这里 natoms 是负数
 *   行4 nx dx 0 0
 *   行5 ny 0 dy 0
 *   行6 nz 0 0 dz
 * ```
 * 点数是 `nx*ny*nz`，数据按 x 最快、z 最慢排（`reshape(nz, ny, nx)`）。
 *
 * 每点约 13~14 字节（`%13.5E`），所以用「字节数 / 点数」做量级自检 —— 头对、数据
 * 缺一半这种半成功写法会被它抓住。
 *
 * @param {string} file
 * @param {{ minBytes?: number }} [options]
 */
export function verifyCube(file, { minBytes = 1_000_000 } = {}) {
  const base = verifyFile(file, { minBytes })
  if (!base.ok) return { ...base, cube: null }

  let head = ''
  try {
    // 头只有几行，读前 1 KB 就够；用 readFileSync 全读 25 MB 太浪费。
    const buf = readFileSync(file).subarray(0, 1024)
    head = buf.toString('utf8')
  } catch (error) {
    return { ...base, ok: false, reason: `读不出头部：${error instanceof Error ? error.message : String(error)}`, cube: null }
  }

  const lines = head.split(/\r?\n/)
  if (lines.length < 6) return { ...base, ok: false, reason: '头部不足 6 行', cube: null }

  const atomLine = lines[2].trim().split(/\s+/)
  const nxLine = lines[3].trim().split(/\s+/)
  const nyLine = lines[4].trim().split(/\s+/)
  const nzLine = lines[5].trim().split(/\s+/)

  const natoms = Math.abs(Number(atomLine[0]))
  const nx = Number(nxLine[0])
  const ny = Number(nyLine[0])
  const nz = Number(nzLine[0])

  if (!Number.isFinite(natoms) || !Number.isFinite(nx) || !Number.isFinite(ny) || !Number.isFinite(nz)) {
    return { ...base, ok: false, reason: `头部解析失败：${lines.slice(2, 6).join(' | ')}`, cube: null }
  }

  const points = nx * ny * nz
  const bytesPerPoint = base.bytes / points
  const cube = { natoms, nx, ny, nz, points, bytes: base.bytes, bytesPerPoint }
  if (bytesPerPoint < 8 || bytesPerPoint > 24) {
    return {
      ...base,
      ok: false,
      cube,
      reason: `每点 ${bytesPerPoint.toFixed(1)} 字节，明显不对（预期 13~14）—— 数据可能没写完`,
    }
  }
  return { ...base, ok: true, cube }
}
