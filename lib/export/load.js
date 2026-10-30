/**
 * 为导出准备结构：从**结构文件**或**视图包**里取出原子与键。
 *
 * 单独一个模块（不碰宿主接口），这样工具、测试、脚本可以共用同一份逻辑。
 *
 * @module dsh-chemflow/export/load
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'

import { inferBonds } from '../view/cube.js'
import { readStructure } from '../view/structure.js'

/**
 * @param {string} input 结构文件路径，或 `<name>.view/meta.json`、`<name>.view` 目录
 * @returns {{ atoms: Array<{ element: string, x: number, y: number, z: number }>, bonds: number[][], source: string }}
 */
export function loadStructureForExport(input) {
  const resolved = path.resolve(input)
  const lower = resolved.toLowerCase()

  // 视图包：目录或任意 .json（按**内容**判断，不要求一定叫 meta.json）
  if (lower.endsWith('.view')) {
    return readPack(path.join(resolved, 'meta.json'))
  }
  if (lower.endsWith('.json')) {
    return readPack(resolved)
  }

  const { atoms, bonds } = readStructure(resolved)
  return { atoms, bonds: bonds.length > 0 ? bonds : inferBonds(atoms), source: resolved }
}

/**
 * 读一个视图包的 meta.json（也接受手写的等价 JSON）。
 *
 * @param {string} metaPath
 */
function readPack(metaPath) {
  /** @type {any} */
  let meta
  try {
    meta = JSON.parse(readFileSync(metaPath, 'utf8'))
  } catch (error) {
    throw new Error(`不是合法的视图包 JSON：${metaPath}（${error instanceof Error ? error.message : error}）`)
  }
  const atoms = Array.isArray(meta?.atoms) ? meta.atoms : []
  if (atoms.length === 0) throw new Error(`视图包里没有原子：${metaPath}`)
  const bonds = Array.isArray(meta.bonds) && meta.bonds.length > 0 ? meta.bonds : inferBonds(atoms)
  return { atoms, bonds, source: metaPath }
}
