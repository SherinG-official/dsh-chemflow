/**
 * 开发用：单独起画板服务（不装 DSH 也能测）。
 *
 *   node scripts/serve-sketch.mjs [port]
 *
 * 默认服务 `lib/sketch/spike`，落盘目录 `%TEMP%/chemflow-sketch/`，
 * token 随机生成并打印在 URL 里。
 */

import { mkdirSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'

import { startSketchServer } from '../lib/sketch/server.js'
import { writeSketchInfo } from '../lib/sketch/info.js'

const [, , portArg] = process.argv
const rootDir = path.join(homedir(), 'Documents', 'DS work', 'dsh-chemflow', 'lib', 'sketch', 'spike')
const outDir = path.join(tmpdir(), 'chemflow-sketch')
const dataDir = path.join(homedir(), '.dsh', 'dsh-chemflow')
const logFile = path.join(outDir, 'spike.log')
const requestLog = path.join(outDir, 'requests.log')
mkdirSync(outDir, { recursive: true })

const token = randomBytes(8).toString('hex')
const server = await startSketchServer({
  rootDir,
  outDir,
  token,
  port: Number(portArg ?? 0) || 0,
  logFile,
  requestLog,
})

// 客户端面板读这个文件拿 iframe 地址（路径在装插件时注入 client.js）
writeSketchInfo(dataDir, { url: server.url, origin: server.origin, port: server.port, rootDir })

console.log(`serve: ${rootDir}`)
console.log(`out:   ${outDir}`)
console.log(`url:   ${server.url}`)
console.log(`info:  ${path.join(dataDir, 'sketch.json')}`)
console.log(`log:   ${logFile}`)
console.log(`req:   ${requestLog}`)
