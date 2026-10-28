/**
 * 单次 Multiwfn 执行：准备私有环境 → 写配方 → 跑 → 收日志。
 *
 * ## 私有 Multiwfnpath（两条实测逼出来的规则）
 *
 * 1. **不能指向安装目录**。Multiwfn 退出时会回写 settings.ini；装在 `D:\Program Files\`
 *    下时回写被拒 → `forrtl: severe (47): write to READONLY file` → 进程当场退出。
 *    解法是把 settings.ini 复制进一个私有目录，`Multiwfnpath` 指向它。
 * 2. **这个目录的绝对路径必须短于 ~80 字符**（实测：79 可以，89 就不行）。
 *    超了之后 Multiwfn 会说「settings.ini was found neither in current folder nor in
 *    the path defined by Multiwfnpath」，然后**多吃一行输入**（"Press ENTER"），
 *    把后面整个菜单序列打乱 —— 症状看起来像 recipe 写错了，其实是路径太长。
 *    所以 mfhome 用 `%TEMP%\cf\<8位随机>`，而不是放在用户指定的运行目录里（那个可能很深）。
 *
 * 副作用全是好的：不碰安装目录、并发运行各写各的、用的 settings 被冻结一份进 run 目录。
 *
 * @module dsh-chemflow/multiwfn
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { runProcess } from './exec.js'
import { recipeToText } from './recipes.js'

/** Multiwfn 读 GETENV 的缓冲上限（实测 79 可用 / 89 不可用，取 76 留余量）。 */
const mfhomeMaxLength = 76

/**
 * 挑一个够短的私有目录。
 *
 * @param {string} runDir
 * @returns {{ dir: string, tooLong: boolean }}
 */
function pickMfhome(runDir) {
  const tag = randomBytes(4).toString('hex')
  const short = path.join(tmpdir(), 'cf', tag)
  if (short.length < mfhomeMaxLength) return { dir: short, tooLong: false }

  // TEMP 本身就很长时的退路：放进 run 目录（至少不会更糟），并标记出来提醒调用方。
  const fallback = path.join(runDir, 'mfhome')
  return { dir: fallback, tooLong: fallback.length >= mfhomeMaxLength }
}

/**
 * 跑一次 Multiwfn。
 *
 * @param {{
 *   config: Record<string, any>,
 *   runDir: string,
 *   inputFile: string,
 *   recipeLines: string[],
 *   timeoutMs?: number,
 *   signal?: AbortSignal,
 * }} options
 */
export async function runMultiwfn(options) {
  const { config, runDir, inputFile, recipeLines, timeoutMs = 1_800_000, signal } = options

  const { dir: mfhome, tooLong } = pickMfhome(runDir)
  mkdirSync(mfhome, { recursive: true })

  const settingsSrc = path.join(config.multiwfnHome, 'settings.ini')
  let settingsCopied = false
  if (existsSync(settingsSrc)) {
    copyFileSync(settingsSrc, path.join(mfhome, 'settings.ini'))
    // 冻结一份进 run 目录：以后要复现「当时到底用的哪套设置」就靠它。
    copyFileSync(settingsSrc, path.join(runDir, 'settings.used.ini'))
    settingsCopied = true
  }

  // settings.ini 缺失时 Multiwfn 会先打印 Warning 再等一个 ENTER。那一行会把整个
  // 菜单序列往后顶一格，所以这里先补一个空行；settings 正常时它就是主菜单上的无效
  // 输入，Multiwfn 会忽略并重新提示（实测不影响后续 recipe）。
  const effectiveRecipe = settingsCopied ? recipeLines : ['', ...recipeLines]

  const cmdsPath = path.join(runDir, 'cmds.txt')
  writeFileSync(cmdsPath, recipeToText(effectiveRecipe), 'utf8')

  const logPath = path.join(runDir, 'multiwfn.log')
  const started = Date.now()

  // 排障用：DSH_CHEMFLOW_DEBUG=1 时把这次实际用的环境写进 run 目录。
  if (process.env.DSH_CHEMFLOW_DEBUG) {
    writeFileSync(
      path.join(runDir, 'debug-env.json'),
      `${JSON.stringify(
        {
          mfhome,
          mfhomeLength: mfhome.length,
          tooLong,
          settingsExists: existsSync(path.join(mfhome, 'settings.ini')),
          settingsCopied,
          effectiveRecipe,
        },
        null,
        2,
      )}\n`,
      'utf8',
    )
  }

  const result = await runProcess({
    exe: config.multiwfnExe,
    args: [inputFile],
    cwd: runDir,
    env: { Multiwfnpath: mfhome },
    stdinFile: cmdsPath,
    timeoutMs,
    logPath,
    signal,
  })

  const log = existsSync(logPath) ? readFileSync(logPath, 'utf8') : ''

  // 跑完就可以收掉私有目录；里面有价值的只有那份 settings，已经冻结进 run 目录了。
  try {
    if (mfhome.includes(`${path.sep}cf${path.sep}`)) rmSync(mfhome, { recursive: true, force: true })
  } catch {
    /* 收不掉也不影响结果 */
  }

  return {
    result,
    log,
    logPath,
    cmdsPath,
    mfhome,
    mfhomeTooLong: tooLong,
    settingsCopied,
    effectiveRecipe,
    seconds: (Date.now() - started) / 1000,
    command: `"${config.multiwfnExe}" "${inputFile}" < cmds.txt`,
  }
}
