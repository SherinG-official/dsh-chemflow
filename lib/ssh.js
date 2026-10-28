/**
 * SSH / SFTP 薄封装（基于 vendored 的 ssh2，不依赖系统 ssh.exe）。
 *
 * 为什么不用系统自带的 `ssh.exe`：Windows OpenSSH 不接受非交互式密码（它只从控制台
 * 读密码），而首台集群通常只给密码。ssh2 既能密码认证也能密钥认证，还能直接 SFTP
 * 传文件，省掉 scp 的子进程与 known_hosts 麻烦。
 *
 * 依赖是**随包 vendor** 的（vendor/node_modules），不要求用户 npm install。
 *
 * @module dsh-chemflow/ssh
 */

import { readFileSync } from 'node:fs'

import ssh2 from '../vendor/node_modules/ssh2/lib/index.js'

const { Client } = ssh2

/** 单条命令输出上限，防止 `cat` 大文件把内存吃光。 */
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024

/**
 * 一次 SSH 会话。
 */
export class SshClient {
  /**
   * @param {{ host: string, port?: number, username: string, password?: string, keyPath?: string }} sshConfig
   * @param {{ readyTimeoutMs?: number, debug?: boolean }} [options]
   */
  constructor(sshConfig, options = {}) {
    this.config = sshConfig
    this.options = options
    this.client = null
  }

  /** 是否已连接。 */
  get connected() {
    return this.client !== null
  }

  /**
   * 建立连接。
   *
   * @returns {Promise<void>}
   */
  connect() {
    if (this.client) return Promise.resolve()

    const { host, port = 22, username, password, keyPath } = this.config
    if (!host) throw new Error('SSH 未配置 host（在 profile 的 cordis.patch.yml 里设 ssh.host）')
    if (!username) throw new Error('SSH 未配置 username')

    /** @type {Record<string, any>} */
    const opts = {
      host,
      port,
      username,
      readyTimeout: this.options.readyTimeoutMs ?? 30_000,
      keepaliveInterval: 15_000,
    }

    if (keyPath) {
      try {
        opts.privateKey = readFileSync(keyPath)
      } catch (error) {
        throw new Error(`读不了私钥 ${keyPath}：${error instanceof Error ? error.message : String(error)}`)
      }
    } else if (password) {
      opts.password = password
    } else {
      throw new Error('SSH 既没有 keyPath 也没有 password —— 至少给一个（推荐 keyPath）。')
    }

    return new Promise((resolve, reject) => {
      const client = new Client()
      let settled = false

      client.on('ready', () => {
        settled = true
        this.client = client
        resolve()
      })
      client.on('error', (error) => {
        if (settled) return
        settled = true
        reject(normalizeSshError(error, this.config))
      })
      client.on('close', () => {
        this.client = null
      })
      client.connect(opts)
    })
  }

  /**
   * 跑一条远程命令。
   *
   * @param {string} command
   * @param {{ timeoutMs?: number }} [options]
   * @returns {Promise<{ code: number|null, stdout: string, stderr: string }>}
   */
  async exec(command, options = {}) {
    await this.connect()
    const timeoutMs = options.timeoutMs ?? 120_000

    return new Promise((resolve, reject) => {
      let done = false
      const timer = setTimeout(() => {
        if (done) return
        done = true
        reject(new Error(`远程命令超时（${Math.round(timeoutMs / 1000)} s）：${command.slice(0, 120)}`))
      }, timeoutMs)

      this.client.exec(command, (error, stream) => {
        if (error) {
          clearTimeout(timer)
          if (!done) {
            done = true
            reject(normalizeSshError(error, this.config))
          }
          return
        }

        let stdout = ''
        let stderr = ''
        stream.on('data', (chunk) => {
          if (stdout.length < MAX_OUTPUT_BYTES) stdout += chunk.toString()
        })
        stream.stderr.on('data', (chunk) => {
          if (stderr.length < MAX_OUTPUT_BYTES) stderr += chunk.toString()
        })
        stream.on('close', (code) => {
          clearTimeout(timer)
          if (done) return
          done = true
          resolve({ code: typeof code === 'number' ? code : null, stdout, stderr })
        })
      })
    })
  }

  /**
   * 跑一条必须成功的命令（非 0 退出码直接抛，带 stderr）。
   *
   * @param {string} command
   * @param {{ timeoutMs?: number, what?: string }} [options]
   */
  async mustExec(command, options = {}) {
    const result = await this.exec(command, options)
    if (result.code !== 0) {
      const detail = (result.stderr || result.stdout).trim().slice(-1500)
      throw new Error(`${options.what ?? '远程命令'}失败（退出码 ${result.code}）：\n${detail}`)
    }
    return result
  }

  /**
   * 打开 SFTP 通道。
   *
   * @returns {Promise<any>}
   */
  async sftp() {
    await this.connect()
    return new Promise((resolve, reject) => {
      this.client.sftp((error, channel) => {
        if (error) reject(normalizeSshError(error, this.config))
        else resolve(channel)
      })
    })
  }

  /**
   * 上传本地文件。
   *
   * @param {string} local
   * @param {string} remote
   */
  async putFile(local, remote) {
    const channel = await this.sftp()
    return new Promise((resolve, reject) => {
      channel.fastPut(local, remote, (error) => (error ? reject(error) : resolve()))
    })
  }

  /**
   * 下载远程文件。
   *
   * @param {string} remote
   * @param {string} local
   */
  async getFile(remote, local) {
    const channel = await this.sftp()
    return new Promise((resolve, reject) => {
      channel.fastGet(remote, local, (error) => (error ? reject(error) : resolve()))
    })
  }

  /**
   * 把一段文本写成远程文件（SFTP 写流，避免在命令行里拼多行 heredoc）。
   *
   * @param {string} remote
   * @param {string} content
   */
  async writeFile(remote, content) {
    const channel = await this.sftp()
    return new Promise((resolve, reject) => {
      const stream = channel.createWriteStream(remote)
      stream.on('close', () => resolve())
      stream.on('error', reject)
      stream.end(content, 'utf8')
    })
  }

  /**
   * 读远程文件（小文件用）。
   *
   * @param {string} remote
   * @param {number} [maxBytes]
   * @returns {Promise<string>}
   */
  async readFile(remote, maxBytes = 256 * 1024) {
    const channel = await this.sftp()
    return new Promise((resolve, reject) => {
      const chunks = []
      let size = 0
      const stream = channel.createReadStream(remote)
      stream.on('data', (chunk) => {
        if (size < maxBytes) {
          chunks.push(chunk)
          size += chunk.length
        }
      })
      stream.on('close', () => resolve(Buffer.concat(chunks).toString('utf8')))
      stream.on('error', reject)
    })
  }

  /**
   * 关掉连接。
   */
  end() {
    try {
      this.client?.end()
    } catch {
      /* 已断 */
    }
    this.client = null
  }
}

/**
 * 把 ssh2 的错误翻成人能读的话。
 *
 * @param {any} error
 * @param {{ host: string, port?: number, username: string }} config
 */
export function normalizeSshError(error, config) {
  const message = error instanceof Error ? error.message : String(error)
  const where = `${config.username}@${config.host}:${config.port ?? 22}`
  if (/All configured authentication methods failed|authentication/i.test(message)) {
    return new Error(`SSH 认证失败（${where}）：账号或密码/私钥不对。`)
  }
  if (/Timed out while waiting for handshake|ECONNREFUSED|EHOSTUNREACH|ENOTFOUND|ETIMEDOUT/i.test(message)) {
    return new Error(`连不上 ${where}：${message}。检查主机/端口/网络。`)
  }
  return new Error(`SSH 错误（${where}）：${message}`)
}

/**
 * 把 `~/x` 展开成绝对路径。
 *
 * 不能靠 `cd ~/x && pwd` —— 目录还不存在时 `cd` 会失败，回退成字面量 `~`，
 * 然后在用户家目录里建出一个名字就叫 `~` 的目录（实测踩过）。所以先单独问到家目录。
 *
 * @param {SshClient} ssh
 * @param {string} remotePath
 * @returns {Promise<string>}
 */
export async function expandRemotePath(ssh, remotePath) {
  const raw = String(remotePath ?? '').trim()
  if (raw === '' ) return raw
  if (!raw.startsWith('~')) return raw

  const result = await ssh.exec('cd ~ && pwd -P')
  const home = result.stdout.trim()
  if (result.code !== 0 || !home) return raw

  if (raw === '~') return home
  if (raw.startsWith('~/')) return `${home}/${raw.slice(2)}`
  return raw
}
