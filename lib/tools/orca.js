/**
 * `chem_orca` —— 远程 ORCA：提交 / 查询 / 回传。
 *
 * 集群实测：Slurm 未给该账号 account 关联，`sbatch` 会报 Invalid account，
 * 所以默认 `mode=direct`（nohup 后台 + PID 轮询）。
 *
 * @module dsh-chemflow/tools/orca
 */

import { defineTool } from '@deepseek-ai/dsh-tools'

import { orcaFetch, orcaStatus, orcaSubmit } from '../tasks/orca-remote.js'
import { fail, humanBytes, ok, textOutput } from './shared.js'

/**
 * @param {any} ctx
 * @param {{ config: Record<string, any> }} deps
 */
export function registerOrcaTool(ctx, deps) {
  const { config } = deps

  ctx.tools.register(
    defineTool({
      name: 'chem_orca',
      description:
        '在集群上跑 ORCA：action=submit 上传 .inp 并后台启动；action=status 查状态与输出末尾；' +
        'action=fetch 在集群上转 molden、补齐 .molden.out、打包回传并解包到本机。' +
        'fetch 回来的目录可以直接喂给 chem_hole_electron。默认 nohup 直跑（该机 Slurm 无 account 关联）。',
      parameters: {
        action: {
          type: 'string',
          enum: ['submit', 'status', 'fetch'],
          description: 'submit=提交；status=查状态；fetch=回传结果。',
          required: true,
        },
        input: { type: 'string', description: '[submit] 本地 .inp 路径。' },
        name: { type: 'string', description: '[submit/fetch] 作业名（远程目录名、文件名前缀）。默认取 .inp 的文件名。' },
        mode: {
          type: 'string',
          enum: ['direct', 'slurm'],
          description: '[submit/status] direct=nohup 后台直跑（默认）；slurm=sbatch（需要账号有 account 关联）。',
        },
        cores: { type: 'number', description: '[submit] 核数提示。实际并行度以 .inp 里的 %pal / PALn 为准。' },
        timeLimit: { type: 'string', description: '[submit+slurm] 时限，如 24:00:00。' },
        jobId: { type: 'string', description: '[status] submit 返回的 PID（direct）或 Slurm 作业号。' },
        remoteDir: { type: 'string', description: '[status/fetch] submit 返回的远程目录。' },
        toDir: { type: 'string', description: '[fetch] 回传到本机的目录（由用户指定，插件会再建一个 <name>/ 子目录）。' },
      },
      output: textOutput((_args, value) => value.message),
      timeoutMs: 600_000,
      isConcurrencySafe: () => false,
      async execute(args) {
        const action = args.action

        if (action === 'submit') {
          if (!args.input) return fail('submit 需要 input（本地 .inp 路径）。')
          const result = await orcaSubmit({
            config,
            localInput: args.input,
            name: args.name,
            mode: args.mode ?? 'direct',
            cores: args.cores,
            timeLimit: args.timeLimit,
          })
          if (!result.ok) return fail(`提交失败（${result.stage}）：${result.reason}`)
          return ok(
            [
              `✓ 已提交：${result.name}`,
              `模式：${result.mode}    作业号/PID：${result.jobId}`,
              `远程目录：${result.remoteDir}`,
              '',
              '下一步：等几分钟后用 chem_orca(action=status, jobId=…, remoteDir=…) 看状态；' +
                '看到 terminated=true 再 action=fetch 回传。',
              '提示：ORCA 的 TD-DFT 只要下游要接 Multiwfn，输入里必须有 `TDA true`。',
            ].join('\n'),
          )
        }

        if (action === 'status') {
          if (!args.remoteDir) return fail('status 需要 remoteDir（submit 返回过）。')
          if (!args.jobId) return fail('status 需要 jobId（submit 返回的 PID / Slurm 号）。')
          const result = await orcaStatus({
            config,
            jobId: String(args.jobId),
            remoteDir: args.remoteDir,
            name: args.name ?? 'job',
            mode: args.mode ?? 'direct',
          })
          if (!result.ok) return fail(`查询失败：${result.reason}`)
          const lines = [
            `${result.done ? (result.terminated ? '✓ 已完成' : '✗ 已结束但没正常终止') : '⏳ 运行中'}` +
              `　状态 ${result.state}${result.elapsed ? `，已跑 ${result.elapsed}` : ''}`,
          ]
          if (result.exitCode !== null && result.exitCode !== undefined) lines.push(`ORCA 退出码：${result.exitCode}`)
          if (result.hint) lines.push(result.hint)
          lines.push('', '输出末尾：', result.outputTail || '(空)')
          if (result.errorTail) lines.push('', '错误输出：', result.errorTail)
          return ok(lines.join('\n'))
        }

        if (action === 'fetch') {
          if (!args.remoteDir) return fail('fetch 需要 remoteDir。')
          if (!args.toDir) return fail('fetch 需要 toDir（回传到哪个本机目录）。')
          const name = args.name ?? String(args.remoteDir).split('/').filter(Boolean).pop()
          if (!name) return fail('fetch 需要 name（作业名）。')
          const result = await orcaFetch({ config, remoteDir: args.remoteDir, name, toDir: args.toDir })
          if (!result.ok) return fail(`回传失败（${result.stage}）：${result.reason}`)
          return ok(
            [
              `✓ 已回传并解包：${result.localDir}`,
              ...Object.entries(result.sizes).map(([file, bytes]) => `  ${file}  (${humanBytes(bytes)})`),
              '',
              `下一步：chem_hole_electron(file="${result.moldenInput}", state=1, outDir=…)`,
              '（`.molden.out` 已在同一目录，Multiwfn 会自动找到它。）',
            ].join('\n'),
          )
        }

        return fail(`未知 action：${action}`)
      },
    }),
  )
}
