/**
 * 配置解析与路径发现。
 *
 * 设计原则：**能自动发现的就不要让用户填**，但发现不了要给出可照做的下一步。
 * 这里只做纯解析，不触碰文件系统以外的任何东西（不建目录、不写文件）。
 *
 * @module dsh-chemflow/config
 */

import { existsSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'

/** 本机 Multiwfn 的默认位置（实测装在这里）。 */
export const DEFAULT_MULTIWFN = 'D:\\Program Files\\Multiwfn\\Multiwfn.exe'

/** 本机 VMD 的默认位置（实测装在这里；注意不在 C 盘）。 */
export const DEFAULT_VMD = 'D:\\Program Files\\VMD2\\vmd.exe'

/**
 * 找 Python 解释器。顺序：
 *   1. 配置显式给的
 *   2. DSH 自带 runtime（带 numpy + Pillow，实测 3.12.14）
 *   3. py -3 / python
 *
 * 只在 Windows 上找 DSH 自带那份；其它平台直接回落到命令名。
 *
 * @param {string} configured
 * @returns {{ path: string, source: string }}
 */
export function resolvePython(configured) {
  if (configured && existsSync(configured)) return { path: configured, source: 'config' }

  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA
    if (local) {
      const bundled = path.join(
        local,
        'Dsh_Desktop',
        'resources',
        'runtime',
        'primary-runtime',
        'dependencies',
        'python',
        'python.exe',
      )
      if (existsSync(bundled)) return { path: bundled, source: 'dsh-runtime' }
    }
  }

  return { path: 'python', source: 'PATH' }
}

/**
 * 解析插件配置。
 *
 * @param {Record<string, any>} raw 宿主传进来的配置（可能只有一部分）
 * @returns {Record<string, any>} 补齐默认值后的配置
 */
export function resolveConfig(raw = {}) {
  const home = homedir()
  const dataDir = raw.dataDir && String(raw.dataDir).trim() !== ''
    ? path.resolve(String(raw.dataDir))
    : path.join(home, '.dsh', 'dsh-chemflow')

  const multiwfnExe =
    raw.multiwfnExe && existsSync(String(raw.multiwfnExe)) ? String(raw.multiwfnExe) : DEFAULT_MULTIWFN
  const multiwfnHome =
    raw.multiwfnHome && String(raw.multiwfnHome).trim() !== ''
      ? String(raw.multiwfnHome)
      : path.dirname(multiwfnExe)

  const vmdExe = raw.vmdExe && existsSync(String(raw.vmdExe)) ? String(raw.vmdExe) : DEFAULT_VMD

  const python = resolvePython(raw.pythonExe ? String(raw.pythonExe) : '')

  const sshLegacy = raw.ssh ?? {}
  /**
   * 取 SSH 配置：优先扁平字段（sshHost…），兼容旧的嵌套写法（ssh.host…）。
   *
   * @param {string} flatKey
   * @param {string} nestedKey
   * @param {any} fallback
   */
  const pick = (flatKey, nestedKey, fallback) => {
    const flat = raw[flatKey]
    if (flat !== undefined && flat !== null && flat !== '') return flat
    const nested = sshLegacy[nestedKey]
    if (nested !== undefined && nested !== null && nested !== '') return nested
    return fallback
  }

  const ssh = {
    host: String(pick('sshHost', 'host', '')),
    port: Number(pick('sshPort', 'port', 22)),
    username: String(pick('sshUsername', 'username', '')),
    password: String(pick('sshPassword', 'password', '')),
    keyPath: String(pick('sshKeyPath', 'keyPath', '')),
    remoteRoot: String(pick('sshRemoteRoot', 'remoteRoot', '~/chemflow')),
    partition: String(pick('sshPartition', 'partition', 'chem')),
    cores: Number(pick('sshCores', 'cores', 16)),
    maxcore: Number(pick('sshMaxcore', 'maxcore', 2048)),
    timeLimit: String(pick('sshTimeLimit', 'timeLimit', '24:00:00')),
    orcaRoot: String(pick('sshOrcaRoot', 'orcaRoot', '/opt/software/orca-5.0.3')),
    mpiRoot: String(pick('sshMpiRoot', 'mpiRoot', '/opt/software/openmpi-4.1.5')),
  }

  return {
    multiwfnExe,
    multiwfnHome,
    vmdExe,
    pythonExe: python.path,
    pythonSource: python.source,
    dataDir,
    tmpDir: path.join(tmpdir(), 'dsh-chemflow'),
    timeoutMs: Number(raw.timeoutMs ?? 1_800_000),
    maxArtifactMB: Number(raw.maxArtifactMB ?? 2000),
    prompt: raw.prompt !== false,
    ssh,
  }
}
