/**
 * 画板服务的“登记簿”：把运行中服务的 URL/端口写到 `<dataDir>/sketch.json`。
 *
 * 客户端面板拿不到宿主的运行时状态，只能读文件——和结构视图列表（views.json）同一套思路：
 * 路径在装插件时注入进客户端 bundle，内容由宿主每次启动服务时刷新。
 *
 * @module dsh-chemflow/sketch/info
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/** 登记文件路径。 */
export function sketchInfoPath(dataDir) {
  return path.join(dataDir, 'sketch.json')
}

/**
 * @param {string} dataDir
 * @param {{ url: string, port: number, origin: string, rootDir?: string, startedAt?: string }} info
 */
export function writeSketchInfo(dataDir, info) {
  mkdirSync(dataDir, { recursive: true })
  const payload = {
    url: info.url,
    origin: info.origin,
    port: info.port,
    rootDir: info.rootDir,
    startedAt: info.startedAt ?? new Date().toISOString(),
    version: 1,
  }
  writeFileSync(sketchInfoPath(dataDir), `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  return payload
}

/** 读登记簿；没有或坏了就返回 null。 */
export function readSketchInfo(dataDir) {
  try {
    const raw = readFileSync(sketchInfoPath(dataDir), 'utf8')
    const info = JSON.parse(raw)
    return info && typeof info.url === 'string' ? info : null
  } catch {
    return null
  }
}
