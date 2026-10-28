/**
 * 把 dsh-chemflow 装进 DSH 的 desktop profile。
 *
 * ## 为什么是「复制」而不是 junction
 *
 * 实测：用 junction 把插件目录链进 profile 的 node_modules 后，`package.json` 里能看到、
 * `createRequire` 也能解析到，但**宿主重启后插件没有注册任何工具**。
 * 对比已知可用的 `dsh-origin-api`：它是 `file:` 依赖，pnpm 以 injected 方式把**实体文件**
 * 放进 profile 的 `.pnpm` 存档，真实路径在 profile 内部。
 *
 * 宿主的加载器对「链到 profile 外面的包」走的是另一条解析路径（linkedRoots），
 * 插件内部的 `@deepseek-ai/dsh-tools` 这类 import 在那条路径上解析不到，import 失败后
 * 整个 bundle 被静默跳过。复制成实体目录就与 origin 的布局一致。
 *
 * 代价：改完插件代码要 `--sync` 再重启。
 *
 * 用法：
 *   node scripts/install-profile.mjs <pluginDir> <profileDir> [--dry-run] [--sync]
 */

import { copyFileSync, cpSync, existsSync, lstatSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const [, , pluginDirArg, profileDirArg, ...flags] = process.argv
const dryRun = flags.includes('--dry-run')
const sync = flags.includes('--sync')

if (!pluginDirArg || !profileDirArg) {
  console.error('usage: node scripts/install-profile.mjs <pluginDir> <profileDir> [--dry-run] [--sync]')
  process.exit(2)
}

const pluginDir = path.resolve(pluginDirArg)
const profileDir = path.resolve(profileDirArg)
const pkgPath = path.join(profileDir, 'package.json')
const ymlPath = path.join(profileDir, 'cordis.patch.yml')
const targetDir = path.join(profileDir, 'node_modules', 'dsh-chemflow')

if (!existsSync(pkgPath)) {
  console.error(`找不到 profile 的 package.json：${pkgPath}`)
  process.exit(2)
}

const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
pkg.dependencies = pkg.dependencies ?? {}
pkg.dependencies['dsh-chemflow'] = `file:${pluginDir.replace(/\\/g, '/')}`
pkg.dsh = pkg.dsh ?? {}
pkg.dsh.profile = pkg.dsh.profile ?? {}
pkg.dsh.profile.bundles = pkg.dsh.profile.bundles ?? []
if (!pkg.dsh.profile.bundles.includes('dsh-chemflow')) pkg.dsh.profile.bundles.push('dsh-chemflow')

const yml = readFileSync(ymlPath, 'utf8')

// 密码不写进仓库：优先读环境变量 DSH_CHEMFLOW_SSH_PASSWORD，
// 其次读 profile 里已有的旧值（这样重复安装不会把密码清掉）。
const previousPassword = (() => {
  const match = /sshPassword:\s*'([^']*)'/.exec(yml)
  return match ? match[1] : ''
})()
const sshPassword = process.env.DSH_CHEMFLOW_SSH_PASSWORD ?? previousPassword

const ymlBlock = `
# ---- dsh-chemflow:化学计算工作流(ORCA → Multiwfn → VMD) ----
# 注意:profile 层的 config 会**整体覆盖** bundle 层,所以这里写全量,不是只写密码。
# 字段是扁平的(sshHost…),插件没有用嵌套配置对象。
- id: dsh-chemflow
  name: dsh-chemflow
  config:
    multiwfnExe: 'D:\\Program Files\\Multiwfn\\Multiwfn.exe'
    multiwfnHome: 'D:\\Program Files\\Multiwfn'
    vmdExe: 'D:\\Program Files\\VMD2\\vmd.exe'
    sshHost: '114.214.201.249'
    sshPort: 520
    sshUsername: 'SherinG'
    sshPassword: '${sshPassword}'
    sshRemoteRoot: '~/chemflow'
    sshPartition: 'chem'
    sshCores: 16
    sshOrcaRoot: '/opt/software/orca-5.0.3'
    sshMpiRoot: '/opt/software/openmpi-4.1.5'
`

const marker = '# ---- dsh-chemflow'
const markerIndex = yml.indexOf(marker)

/**
 * 原地替换 chemflow 配置块，**保留它之后的所有条目**。
 *
 * 旧实现是 `yml.slice(0, markerIndex) + 新块`：chemflow 块之后的一切都被丢掉。
 * 后果是每跑一次本脚本，`llm-pi-ai`(ustc provider)、`agent-default-model`、
 * 以及任何排在 chemflow 后面的插件配置都会静默消失 —— 2026-10-27 与 10-28
 * 两次「ustc 模型掉线」都是它干的。
 *
 * 定位方式：从 chemflow 标记行起，到下一个顶层条目（顶格 `- ` 或下一节 `# ----`）
 * 之前；紧贴下一个条目上方的注释与空行属于那个条目，原样保留。
 */
function mergeChemflowBlock(text, block) {
  const body = block.trim()

  if (!text.includes(marker)) return `${text.trimEnd()}\n\n${body}\n`

  const at = text.indexOf(marker)
  const head = text.slice(0, at).trimEnd()
  const lines = text.slice(at).split('\n')

  // 标记行与条目之间只有注释；从 chemflow 条目自己那一行之后开始找下一个顶层条目
  let own = lines.findIndex((line) => /^- id: (dsh-)?chemflow\s*$/.test(line))
  if (own < 0) own = 0
  let end = lines.length
  for (let i = own + 1; i < lines.length; i++) {
    if (lines[i].startsWith('- ') || lines[i].startsWith('# ----')) {
      end = i
      break
    }
  }

  const rest = lines.slice(end).join('\n').replace(/^\n+/, '')
  return `${head}\n\n${body}\n${rest === '' ? '' : `\n${rest}`}`
}

const countEntries = (text) => (text.match(/^- id: /gm) ?? []).length
const ymlMerged = mergeChemflowBlock(yml, ymlBlock)

const exists = existsSync(targetDir)
const isLink = exists && lstatSync(targetDir).isSymbolicLink()
const isDir = exists && !isLink && lstatSync(targetDir).isDirectory()
const plan = isLink
  ? '删掉 junction，复制实体目录'
  : isDir
    ? sync
      ? '同步复制（覆盖）'
      : '已是实体目录（加 --sync 可强制覆盖）'
    : '复制实体目录'

console.log('计划：')
console.log(`  插件目录   ${pluginDir}`)
console.log(`  profile    ${profileDir}${dryRun ? '（dry-run，不写）' : ''}`)
console.log(`  package.json  file:${pluginDir.replace(/\\/g, '/')}`)
console.log(`  node_modules  ${plan}`)
console.log(`  cordis.patch.yml  ${markerIndex >= 0 ? '替换已有配置块' : '追加配置块'}，条目 ${countEntries(yml)} → ${countEntries(ymlMerged)}（其余条目原样保留）`)

if (dryRun) process.exit(0)

copyFileSync(pkgPath, `${pkgPath}.bak-${stamp}`)
copyFileSync(ymlPath, `${ymlPath}.bak-${stamp}`)
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8')

if (isLink) {
  try {
    unlinkSync(targetDir)
  } catch {
    rmSync(targetDir, { recursive: true, force: true })
  }
}
if (!existsSync(targetDir) || sync) {
  if (existsSync(targetDir)) rmSync(targetDir, { recursive: true, force: true })
  cpSync(pluginDir, targetDir, {
    recursive: true,
    // 只排除**顶层** node_modules（插件自己的依赖目录，本来就没有）；
    // vendor/node_modules 是必须带的（vendored ssh2），别一起排掉。
    filter: (src) => {
      const rel = path.relative(pluginDir, src)
      return !(rel === 'node_modules' || rel.startsWith(`node_modules${path.sep}`))
    },
  })
  console.log(`  已复制 → ${targetDir}`)
}

writeFileSync(ymlPath, ymlMerged, 'utf8')
console.log('  已写入 cordis.patch.yml 配置（含 SSH 密码，明文存在本机）')

// 「结构视图」列表文件的绝对路径要写进客户端 bundle：
// 浏览器拿不到宿主配置，只能像动画库面板那样把一个绝对路径烘焙进去。
const dataDir = path.resolve(profileDir, '..', '..', 'dsh-chemflow')
const indexPath = path.join(dataDir, 'views.json').replace(/\\/g, '/')
const clientPath = path.join(targetDir, 'lib', 'client.js')
if (existsSync(clientPath)) {
  const source = readFileSync(clientPath, 'utf8')
  if (!source.includes('__DSH_CHEMFLOW_INDEX__')) {
    console.warn('  ⚠ client.js 里没找到 __DSH_CHEMFLOW_INDEX__ 占位符，跳过路径注入')
  } else {
    writeFileSync(clientPath, source.replaceAll('__DSH_CHEMFLOW_INDEX__', indexPath), 'utf8')
    console.log(`  已注入视图列表路径 → ${indexPath}`)
  }
}

console.log('')
console.log(`完成。备份：${pkgPath}.bak-${stamp}`)
console.log('下一步：**重启 DSH 桌面端**。重启后如果工具没出现，先看 ~/.dsh/dsh-chemflow/loaded.json 在不在。')
