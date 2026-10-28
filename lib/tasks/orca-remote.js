/**
 * ORCA 远程提交 / 查询 / 回传。
 *
 * ## 为什么默认是 nohup 而不是 Slurm
 *
 * 集群实测（2026-10，CentOS 8 / node01）：Slurm 分区 `chem` 存在，但
 * `AccountingStorageEnforce = associations,limits,qos` 而该账号**没有 account 关联**，
 * `sbatch` 会直接报 `Invalid account or account/partition combination specified`。
 * 用户实际用法也是直接 `orca job.inp`（历史里没有 sbatch）。所以默认走 `direct`：
 * 集群上 `nohup ./run.sh &`，本地按 PID 轮询，作业不占 SSH 连接、断线也不影响。
 * 等哪天管理员给了 account，把 `mode` 换成 `slurm` 即可（脚本模板已经写好）。
 *
 * ## 回传时顺手做两件 Multiwfn 需要的事
 *
 *   - `orca_2mkl job -molden` → `job.molden.input`
 *   - `cp job.out job.molden.out` ← Multiwfn 找的是 `.molden.out`，不是 `job.out`
 *
 * @module dsh-chemflow/tasks/orca-remote
 */

import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'

import { runProcess } from '../exec.js'
import { expandRemotePath, SshClient } from '../ssh.js'

/** 远程环境前缀：ORCA 不在 PATH 里，且不设 LD_LIBRARY_PATH 会缺 liborca_tools。 */
function remoteEnv(config) {
  return [
    `export PATH="${config.ssh.mpiRoot}/bin:${config.ssh.orcaRoot}:$PATH"`,
    `export LD_LIBRARY_PATH="${config.ssh.orcaRoot}:${config.ssh.mpiRoot}/lib:$LD_LIBRARY_PATH"`,
    'export OMP_NUM_THREADS=1',
    'export MKL_NUM_THREADS=1',
  ].join('\n')
}

/** 合法作业名（会进 shell 命令行与文件名，只留安全字符）。 */
export function safeName(name) {
  const cleaned = String(name)
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/^\.+/, '')
  return cleaned === '' ? `orca_${Date.now()}` : cleaned
}

/**
 * 后台直跑的启动脚本。
 *
 * @param {{ name: string, orcaRoot?: string, mpiRoot?: string }} spec
 * @returns {string}
 */
export function buildDirectScript(spec) {
  const { name, orcaRoot = '/opt/software/orca-5.0.3', mpiRoot = '/opt/software/openmpi-4.1.5' } = spec
  return `#!/bin/bash
export PATH="${mpiRoot}/bin:${orcaRoot}:$PATH"
export LD_LIBRARY_PATH="${orcaRoot}:${mpiRoot}/lib:$LD_LIBRARY_PATH"
export OMP_NUM_THREADS=1
export MKL_NUM_THREADS=1
cd "$(dirname "$0")" || exit 1
echo "start_epoch=$(date +%s) pid=$$ host=$(hostname)" > "${name}.runinfo"
"${orcaRoot}/orca" "${name}.inp" > "${name}.out" 2>&1
code=$?
echo "exit=$code end_epoch=$(date +%s)" >> "${name}.runinfo"
echo "$code" > "${name}.exit"
`
}

/**
 * Slurm 提交脚本（备用模式）。
 *
 * @param {{ name: string, cores?: number, timeLimit?: string, partition?: string, orcaRoot?: string, mpiRoot?: string }} spec
 * @returns {string}
 */
export function buildSlurmScript(spec) {
  const {
    name,
    cores = 16,
    timeLimit = '24:00:00',
    partition = 'chem',
    orcaRoot = '/opt/software/orca-5.0.3',
    mpiRoot = '/opt/software/openmpi-4.1.5',
  } = spec

  return `#!/bin/bash
#SBATCH --job-name=${name}
#SBATCH --partition=${partition}
#SBATCH --nodes=1
#SBATCH --ntasks-per-node=${cores}
#SBATCH --cpus-per-task=1
#SBATCH --time=${timeLimit}
#SBATCH --output=${name}.slurm.out
#SBATCH --error=${name}.slurm.err

export OMP_NUM_THREADS=1
export MKL_NUM_THREADS=1
export PATH="${mpiRoot}/bin:${orcaRoot}:$PATH"
export LD_LIBRARY_PATH="${orcaRoot}:${mpiRoot}/lib:$LD_LIBRARY_PATH"
cd "$SLURM_SUBMIT_DIR" || exit 1
"${orcaRoot}/orca" "${name}.inp" > "${name}.out" 2>&1
echo "$?" > "${name}.exit"
`
}

/**
 * 提交一个 ORCA 作业。
 *
 * @param {{
 *   config: Record<string, any>,
 *   localInput: string,
 *   name?: string,
 *   mode?: 'direct'|'slurm',
 *   cores?: number,
 *   timeLimit?: string,
 *   partition?: string,
 * }} options
 */
export async function orcaSubmit(options) {
  const { config, localInput } = options
  const mode = options.mode ?? 'direct'
  if (!existsSync(localInput)) {
    return { ok: false, stage: 'validate', reason: `输入文件不存在：${localInput}` }
  }

  const name = safeName(options.name ?? path.basename(localInput).replace(/\.inp$/i, ''))
  const ssh = new SshClient(config.ssh)

  try {
    await ssh.connect()
    const root = await expandRemotePath(ssh, config.ssh.remoteRoot)
    const dir = `${root}/${name}`

    await ssh.mustExec(`mkdir -p "${dir}"`, { what: '创建远程目录' })
    await ssh.putFile(localInput, `${dir}/${name}.inp`)

    if (mode === 'slurm') {
      await ssh.writeFile(`${dir}/run.slurm`, buildSlurmScript({ name, cores: options.cores ?? config.ssh.cores, timeLimit: options.timeLimit ?? config.ssh.timeLimit, partition: options.partition ?? config.ssh.partition, orcaRoot: config.ssh.orcaRoot, mpiRoot: config.ssh.mpiRoot }))
      const submit = await ssh.mustExec(`cd "${dir}" && sbatch run.slurm`, { what: '提交作业' })
      const jobId = (submit.stdout.match(/Submitted batch job\s+(\d+)/) ?? [])[1] ?? null
      return {
        ok: Boolean(jobId),
        stage: 'submitted',
        mode,
        jobId,
        name,
        remoteDir: dir,
        reason: jobId ? undefined : `没解析到作业号：${submit.stdout.trim() || '(空)'}`,
      }
    }

    // ---- direct：nohup 后台跑 ----
    await ssh.writeFile(`${dir}/run.sh`, buildDirectScript({ name, orcaRoot: config.ssh.orcaRoot, mpiRoot: config.ssh.mpiRoot }))
    const start = await ssh.mustExec(
      `cd "${dir}" && chmod +x run.sh && rm -f "${name}.exit" "${name}.runinfo" && nohup ./run.sh > "${name}.nohup" 2>&1 & echo $!`,
      { what: '启动 ORCA' },
    )
    const pid = start.stdout.trim().split(/\r?\n/).pop()?.trim() ?? ''

    return {
      ok: /^\d+$/.test(pid),
      stage: 'submitted',
      mode,
      jobId: pid,
      name,
      remoteDir: dir,
      cores: options.cores ?? config.ssh.cores,
      reason: /^\d+$/.test(pid) ? undefined : `没拿到 PID：${start.stdout.trim()}`,
    }
  } catch (error) {
    return { ok: false, stage: 'submit', reason: error instanceof Error ? error.message : String(error) }
  } finally {
    ssh.end()
  }
}

/**
 * 查作业状态。
 *
 * @param {{ config: Record<string, any>, jobId: string, remoteDir: string, name: string, mode?: string }} options
 */
export async function orcaStatus({ config, jobId, remoteDir, name, mode = 'direct' }) {
  const ssh = new SshClient(config.ssh)
  try {
    await ssh.connect()

    let running = false
    let exitCode = null
    let state = 'UNKNOWN'
    let elapsed = null
    let reason = null

    if (mode === 'slurm') {
      const queue = await ssh.exec(`squeue -h -j ${Number(jobId)} -o "%T|%M|%R"`)
      const q = queue.stdout.trim()
      running = q !== ''
      if (q) {
        state = q.split('|')[0]
        elapsed = q.split('|')[1]
      }
      const exitRead = await ssh.exec(`cd "${remoteDir}" && cat "${name}.exit" 2>/dev/null`)
      exitCode = exitRead.stdout.trim() === '' ? null : Number(exitRead.stdout.trim())
      if (exitCode !== null) state = exitCode === 0 ? 'COMPLETED' : 'FAILED'
    } else {
      const alive = await ssh.exec(`kill -0 ${Number(jobId)} 2>/dev/null && echo alive || echo gone`)
      running = alive.stdout.includes('alive')
      const exitRead = await ssh.exec(`cd "${remoteDir}" && cat "${name}.exit" 2>/dev/null`)
      exitCode = exitRead.stdout.trim() === '' ? null : Number(exitRead.stdout.trim())
      const runinfo = await ssh.exec(`cd "${remoteDir}" && cat "${name}.runinfo" 2>/dev/null`)
      const startEpoch = Number((runinfo.stdout.match(/start_epoch=(\d+)/) ?? [])[1] ?? 0)
      if (startEpoch > 0) {
        const since = Date.now() - startEpoch * 1000
        if (Number.isFinite(since) && since > 0) {
          const minutes = Math.floor(since / 60000)
          elapsed = minutes >= 60 ? `${Math.floor(minutes / 60)}h${minutes % 60}m` : `${minutes}m`
        }
      }
      state = running ? 'RUNNING' : exitCode === null ? 'GONE' : exitCode === 0 ? 'COMPLETED' : 'FAILED'
    }

    const outTail = await ssh.exec(`cd "${remoteDir}" && tail -n 25 "${name}.out" 2>/dev/null`)
    const errTail = await ssh.exec(`cd "${remoteDir}" && tail -n 10 "${name}.slurm.err" 2>/dev/null; tail -n 5 "${name}.nohup" 2>/dev/null`)
    const terminated = await ssh.exec(`cd "${remoteDir}" && grep -c "TERMINATED NORMALLY" "${name}.out" 2>/dev/null`)

    const done = !running && exitCode !== null
    return {
      ok: true,
      mode,
      jobId,
      state,
      elapsed,
      reason,
      exitCode,
      terminated: Number(terminated.stdout.trim()) > 0,
      done,
      outputTail: outTail.stdout.trim(),
      errorTail: errTail.stdout.trim(),
      hint:
        done && Number(terminated.stdout.trim()) === 0
          ? '作业结束但没有 TERMINATED NORMALLY —— 看 outputTail 末尾的 ORCA 报错。'
          : undefined,
    }
  } catch (error) {
    return { ok: false, stage: 'status', reason: error instanceof Error ? error.message : String(error) }
  } finally {
    ssh.end()
  }
}

/**
 * 回传结果：转 molden、补齐 `.molden.out`、打包下载、解包。
 *
 * @param {{
 *   config: Record<string, any>,
 *   remoteDir: string,
 *   name: string,
 *   toDir: string,
 *   includeCis?: boolean,
 * }} options
 */
export async function orcaFetch({ config, remoteDir, name, toDir, includeCis = true }) {
  const ssh = new SshClient(config.ssh)
  const localDir = path.join(path.resolve(toDir), safeName(name))
  mkdirSync(localDir, { recursive: true })
  const packName = `${name}.molden.tgz`
  const localPack = path.join(localDir, packName)

  try {
    await ssh.connect()

    const convert = await ssh.exec(
      `cd "${remoteDir}" && ${remoteEnv(config)} && ` +
        `"${config.ssh.orcaRoot}/orca_2mkl" "${name}" -molden && cp -f "${name}.out" "${name}.molden.out" && ` +
        `ls -l "${name}.molden.input" "${name}.molden.out"`,
      { timeoutMs: 600_000 },
    )
    if (convert.code !== 0) {
      return {
        ok: false,
        stage: 'convert',
        reason:
          'orca_2mkl 转换失败（或作业还没产出 .gbw）。\n' +
          `${convert.stderr || convert.stdout}`.trim().slice(-1200),
      }
    }

    const files = [`"${name}.molden.input"`, `"${name}.molden.out"`]
    if (includeCis) files.push(`"${name}.cis"`)
    await ssh.exec(`cd "${remoteDir}" && tar czf "${packName}" ${files.join(' ')} 2>/dev/null; ls -l "${packName}"`)

    await ssh.getFile(`${remoteDir}/${packName}`, localPack)

    const untar = await runProcess({
      exe: 'tar',
      args: ['-xzf', localPack, '-C', localDir],
      cwd: localDir,
      timeoutMs: 120_000,
      logPath: path.join(localDir, 'untar.log'),
    })
    if (untar.code !== 0) {
      return { ok: false, stage: 'extract', reason: `解包失败（退出码 ${untar.code}）。压缩包留在 ${localPack}。` }
    }

    const extracted = readdirSync(localDir).filter((f) => !f.endsWith('.tgz') && !f.endsWith('.log'))
    const sizes = Object.fromEntries(extracted.map((f) => [f, statSync(path.join(localDir, f)).size]))

    return {
      ok: true,
      stage: 'fetched',
      localDir,
      files: extracted.map((f) => path.join(localDir, f)),
      sizes,
      pack: localPack,
      moldenInput: path.join(localDir, `${name}.molden.input`),
      moldenOut: path.join(localDir, `${name}.molden.out`),
    }
  } catch (error) {
    return { ok: false, stage: 'fetch', reason: error instanceof Error ? error.message : String(error) }
  } finally {
    ssh.end()
  }
}

/**
 * 连接自检：能不能登录 / ORCA 在不在 / 队列 / 磁盘。
 *
 * @param {Record<string, any>} config
 */
export async function sshProbe(config) {
  const ssh = new SshClient(config.ssh)
  try {
    const t0 = Date.now()
    await ssh.connect()
    const connectMs = Date.now() - t0

    const info = await ssh.exec(
      [
        'hostname',
        'whoami',
        `test -x ${config.ssh.orcaRoot}/orca && echo orca:ok || echo orca:missing`,
        `${remoteEnv(config)}; "${config.ssh.orcaRoot}/orca" 2>&1 | head -2`,
        `sinfo -h -o "%P|%c|%a|%l" 2>/dev/null | head -3`,
        `sacctmgr -n show assoc user=$USER 2>/dev/null | head -3`,
        `ps -u $USER -o comm= | grep -c orca`,
        'df -h ~ | tail -1',
      ].join('; '),
    )

    return {
      ok: true,
      connectMs,
      host: config.ssh.host,
      username: config.ssh.username,
      info: info.stdout.trim(),
      stderr: info.stderr.trim(),
    }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  } finally {
    ssh.end()
  }
}
