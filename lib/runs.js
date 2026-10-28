/**
 * 运行目录与清单。
 *
 * 每次分析落一个独立目录：Multiwfn 会往 **cwd** 写 cube，并发跑同一目录会互相覆盖。
 * 目录名带时间戳，`run.json` 记录这一次到底跑了什么（模型下一轮/以后复现都靠它）。
 *
 * 注意：**不自动删旧目录**。这些是用户课题的产物，删错了没法恢复；清理交给用户。
 *
 * @module dsh-chemflow/runs
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/**
 * `yyyyMMdd-HHmmss` 本地时间戳。
 *
 * @param {Date} [date]
 * @returns {string}
 */
export function stamp(date = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0')
  return (
    `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}` +
    `-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
  )
}

/**
 * 在 outDir 下建本次运行目录。同名时加 `-2`、`-3` 后缀，绝不覆盖。
 *
 * @param {string} outDir 用户指定的课题目录
 * @param {string} task 任务名（hole-electron / render / esp …）
 * @returns {string} 运行目录绝对路径
 */
export function createRun(outDir, task) {
  const root = path.resolve(outDir)
  mkdirSync(root, { recursive: true })
  const base = `${task}-${stamp()}`
  let dir = path.join(root, base)
  let n = 2
  while (existsSync(dir)) {
    dir = path.join(root, `${base}-${n}`)
    n += 1
  }
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * 写 `run.json`。
 *
 * @param {string} runDir
 * @param {Record<string, any>} manifest
 */
export function writeManifest(runDir, manifest) {
  const file = path.join(runDir, 'run.json')
  writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  return file
}

/**
 * 读回 `run.json`（没有就返回 null）。
 *
 * @param {string} runDir
 * @returns {Record<string, any> | null}
 */
export function readManifest(runDir) {
  const file = path.join(runDir, 'run.json')
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/**
 * 列出 outDir 下最近的运行目录（按名字倒序 = 按时间倒序）。
 *
 * @param {string} outDir
 * @param {number} [limit]
 * @returns {string[]}
 */
export function listRuns(outDir, limit = 20) {
  try {
    return readdirSync(outDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
      .reverse()
      .slice(0, limit)
      .map((name) => path.join(path.resolve(outDir), name))
  } catch {
    return []
  }
}
