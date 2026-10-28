/**
 * 进程执行核心。
 *
 * ## 为什么 stdout/stderr 都写文件、而不是用管道
 *
 * 1. **Multiwfn 必须拿到「真文件句柄」当 stdin**。用管道喂在 Fortran 里读到的是
 *    `CONIN$`，直接 `end-of-file during read` 退出。`stdio: [fdIn, fdOut, fdOut]`
 *    是唯一实测可行的形态（本机 3.8 验证：10.5 s、exit 0）。
 * 2. 输出量可能很大（Multiwfn 的进度条能刷几千行），管道需要边读边排空，写文件没有
 *    这个负担，且失败时日志天然就在盘上，可以直接把末 N 行回给模型。
 * 3. DSH 的沙箱下，带管道的子进程会 EPERM；写文件这条路径在沙箱内外都成立 ——
 *    自测脚本因此可以在沙箱里跑同一套代码。
 *
 * ## 超时
 *
 * 波函数分析可能跑几十分钟，超时必须可配、并且要**杀进程树**（ORCA 会拉起 mpirun
 * 子进程，只杀父进程会留下孤儿占着 104 核）。
 *
 * @module dsh-chemflow/exec
 */

import { spawn } from 'node:child_process'
import { closeSync, mkdirSync, openSync, readFileSync } from 'node:fs'
import path from 'node:path'

/**
 * 杀进程树。Windows 上 taskkill /T 是唯一可靠的办法。
 *
 * @param {import('node:child_process').ChildProcess} child
 */
function killTree(child) {
  if (!child || child.killed) return
  try {
    if (process.platform === 'win32' && child.pid) {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    } else {
      child.kill('SIGKILL')
    }
  } catch {
    try {
      child.kill()
    } catch {
      /* 已经死了 */
    }
  }
}

/**
 * 跑一个进程，stdout+stderr 落到日志文件。
 *
 * @param {{
 *   exe: string,
 *   args?: string[],
 *   cwd: string,
 *   env?: Record<string, string>,
 *   stdinFile?: string | null,
 *   timeoutMs?: number,
 *   logPath: string,
 *   signal?: AbortSignal,
 * }} options
 * @returns {Promise<{ code: number | null, signal: string | null, timedOut: boolean, ms: number, logPath: string }>}
 */
export function runProcess(options) {
  const {
    exe,
    args = [],
    cwd,
    env = {},
    stdinFile = null,
    timeoutMs = 600_000,
    logPath,
    signal,
  } = options

  return new Promise((resolve) => {
    const started = Date.now()
    let timedOut = false
    let settled = false

    mkdirSync(path.dirname(logPath), { recursive: true })

    let fdIn = null
    let fdOut = null
    try {
      fdIn = stdinFile ? openSync(stdinFile, 'r') : 'ignore'
      fdOut = openSync(logPath, 'w')
    } catch (error) {
      if (fdIn && typeof fdIn === 'number') closeSync(fdIn)
      resolve({
        code: -1,
        signal: null,
        timedOut: false,
        ms: Date.now() - started,
        logPath,
        spawnError: error instanceof Error ? error.message : String(error),
      })
      return
    }

    let child
    try {
      child = spawn(exe, args, {
        cwd,
        env: { ...process.env, ...env },
        stdio: [fdIn, fdOut, fdOut],
        windowsHide: true,
      })
    } catch (error) {
      closeSync(fdOut)
      if (typeof fdIn === 'number') closeSync(fdIn)
      resolve({
        code: -1,
        signal: null,
        timedOut: false,
        ms: Date.now() - started,
        logPath,
        spawnError: error instanceof Error ? error.message : String(error),
      })
      return
    }

    // 父进程不再需要这两个句柄的副本，子进程已各自持有。
    if (typeof fdIn === 'number') closeSync(fdIn)
    closeSync(fdOut)

    const finish = (code, sig) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (signal) signal.removeEventListener?.('abort', onAbort)
      resolve({
        code: typeof code === 'number' ? code : null,
        signal: sig ?? null,
        timedOut,
        ms: Date.now() - started,
        logPath,
      })
    }

    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true
            killTree(child)
            // 给 taskkill 一点时间；超时仍然没退出就当它挂了。
            setTimeout(() => finish(null, 'SIGKILL'), 5000)
          }, timeoutMs)
        : null

    const onAbort = () => {
      timedOut = true
      killTree(child)
      setTimeout(() => finish(null, 'SIGKILL'), 5000)
    }
    if (signal) {
      if (signal.aborted) onAbort()
      else signal.addEventListener?.('abort', onAbort, { once: true })
    }

    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({
        code: -1,
        signal: null,
        timedOut,
        ms: Date.now() - started,
        logPath,
        spawnError: error.message,
      })
    })
    child.on('exit', (code, sig) => finish(code, sig))
  })
}

/**
 * 读日志末尾若干行。
 *
 * @param {string} logPath
 * @param {number} [lines]
 * @returns {string}
 */
export function readTail(logPath, lines = 30) {
  try {
    const text = readFileSync(logPath, 'utf8')
    const all = text.split(/\r?\n/)
    return all.slice(Math.max(0, all.length - lines)).join('\n')
  } catch {
    return ''
  }
}
