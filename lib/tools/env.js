/**
 * `chem_env` —— 环境自检。
 *
 * 只读、无副作用，回答三件事：Multiwfn 在不在（含 settings/DLL）、VMD 在不在、
 * Python 有没有 Pillow；（action=ssh 时）集群连不连得上、ORCA 在不在。
 *
 * 连不上也返回 ok:true + 可照做的说明 —— 模型需要的是「下一步做什么」，
 * 而不是一句 stack trace。
 *
 * @module dsh-chemflow/tools/env
 */

import { existsSync } from 'node:fs'
import path from 'node:path'

import { defineTool } from '@deepseek-ai/dsh-tools'

import { readTail, runProcess } from '../exec.js'
import { sshProbe } from '../tasks/orca-remote.js'
import { failFrom, ok, textOutput } from './shared.js'

/**
 * @param {any} ctx
 * @param {{ config: Record<string, any> }} deps
 */
export function registerEnvTool(ctx, deps) {
  const { config } = deps

  ctx.tools.register(
    defineTool({
      name: 'chem_env',
      description:
        '检查化学计算工作流环境：Multiwfn 路径/版本/settings.ini/DLL、VMD、Python+Pillow，' +
        '以及（action=ssh 时）集群登录与 ORCA。任何工具报错时先调它定位。不会修改任何东西。',
      parameters: {
        action: {
          type: 'string',
          enum: ['local', 'ssh', 'all'],
          description: 'local=只看本机（默认）；ssh=只看集群；all=两边都看。',
        },
      },
      output: textOutput((_args, value) => value.message),
      timeoutMs: 120_000,
      isConcurrencySafe: () => true,
      async execute(args) {
        const action = args.action ?? 'local'
        const lines = []

        if (action !== 'ssh') lines.push(...(await checkLocal(config)))
        if (action !== 'local') {
          lines.push('', '## 集群（SSH）')
          lines.push(...(await checkSsh(config)))
        }

        return ok(lines.join('\n'))
      },
    }),
  )
}

/**
 * 本机检查。
 *
 * @param {Record<string, any>} config
 * @returns {Promise<string[]>}
 */
async function checkLocal(config) {
  const lines = ['## 本机']

  const exeOk = existsSync(config.multiwfnExe)
  lines.push(`Multiwfn：${exeOk ? config.multiwfnExe : `**找不到** ${config.multiwfnExe}`}`)
  if (exeOk) {
    const settings = path.join(config.multiwfnHome, 'settings.ini')
    const dll = path.join(config.multiwfnHome, 'libiomp5md.dll')
    lines.push(`  settings.ini：${existsSync(settings) ? '有' : '**缺**'}（${settings}）`)
    lines.push(`  libiomp5md.dll：${existsSync(dll) ? '有' : '**缺** —— 缺了双击无反应、命令行报 0xC0000135'}`)
    lines.push('  运行时会把 settings.ini 复制到短路径私有目录（Multiwfnpath 超过 ~80 字符会失效）')
  } else {
    lines.push('  修法：在 profile 的 cordis.patch.yml 里把 multiwfnExe 指到 Multiwfn.exe。')
  }

  const vmdOk = existsSync(config.vmdExe)
  lines.push(`VMD：${vmdOk ? config.vmdExe : `**找不到** ${config.vmdExe}`}`)
  if (!vmdOk) lines.push('  修法：设 vmdExe；没有 VMD 的话 chem_render 用不了（Multiwfn 自身也能出图，但样式有限）。')

  lines.push(`Python：${config.pythonExe}（来源 ${config.pythonSource}）`)
  const py = await probePython(config)
  lines.push(py.ok ? `  Pillow ${py.pil} / numpy ${py.numpy} —— 图像后处理可用` : `  **不可用**：${py.reason}`)

  lines.push(`数据目录：${config.dataDir}`)
  return lines
}

/**
 * 探 Python + Pillow + numpy。
 *
 * @param {Record<string, any>} config
 * @returns {Promise<{ ok: boolean, pil?: string, numpy?: string, reason?: string }>}
 */
export async function probePython(config) {
  const logPath = path.join(config.tmpDir, 'py-probe.log')
  try {
    const result = await runProcess({
      exe: config.pythonExe,
      args: ['-c', 'import PIL, numpy; print(PIL.__version__); print(numpy.__version__)'],
      cwd: config.tmpDir,
      timeoutMs: 30_000,
      logPath,
    })
    if (result.code !== 0) return { ok: false, reason: readTail(logPath, 3) || `退出码 ${result.code}` }
    const [pil, numpy] = readTail(logPath, 3).split(/\r?\n/).map((s) => s.trim())
    return { ok: true, pil, numpy }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * 集群检查。
 *
 * @param {Record<string, any>} config
 * @returns {Promise<string[]>}
 */
async function checkSsh(config) {
  if (!config.ssh.host || !config.ssh.username) return ['未配置 ssh.host / ssh.username。']
  if (!config.ssh.password && !config.ssh.keyPath) {
    return ['未配置 ssh.password 或 ssh.keyPath —— 至少需要一个才能登录。']
  }
  try {
    const probe = await sshProbe(config)
    if (!probe.ok) return [`连接失败：${probe.reason}`]
    return [
      `已连接 ${probe.username}@${probe.host}（${probe.connectMs} ms，方式：${config.ssh.keyPath ? '密钥' : '密码'}）`,
      probe.info,
      '说明：本机集群的 Slurm 未给该账号 account 关联，提交默认走 nohup 直跑（mode=direct）。',
    ]
  } catch (error) {
    return [failFrom(error).message]
  }
}
