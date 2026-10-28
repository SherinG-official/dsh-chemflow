/**
 * `chem_view` —— 生成结构视图包（供应用内 3D 面板打开）。
 *
 * 它不渲染任何东西：把 cube 变成浏览器读得动的体数据 + 原子/键，写进一个 `.view/`
 * 目录。渲染在客户端面板里做，这样调阈值、改颜色都不用再回到宿主。
 *
 * @module dsh-chemflow/tools/view
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { defineTool } from '@deepseek-ai/dsh-tools'

import { buildViewPack } from '../view/pack.js'
import { readDipole, readStructure } from '../view/structure.js'
import { fail, humanBytes, ok, textOutput } from './shared.js'

/**
 * @param {any} ctx
 * @param {{ config: Record<string, any> }} deps
 */
export function registerViewTool(ctx, deps) {
  const { config } = deps

  ctx.tools.register(
    defineTool({
      name: 'chem_view',
      description:
        '生成「结构视图包」，供应用内的 3D 查看器面板打开（像点开 .md 那样）。' +
        '**不限于空穴/电子**：可给任意多路 cube（轨道、ESP、自旋密度、密度差…），也可以只给一个结构文件' +
        '（.xyz / ORCA .out / .molden / .cub）只看优化后的几何。输出 <name>.view/：量化体数据 + 原子/键。' +
        '投稿级光追图仍用 chem_render（VMD）。',
      parameters: {
        volumes: {
          type: 'array',
          description:
            '体数据（0~6 路）。每项可以是文件路径字符串，或 { file, label?, name?, color?, iso?, negative?, colorBy?, visible? }。' +
            'negative=true 画负值瓣（field < -iso）；' +
            'colorBy=<另一路的下标> 用那一路的数值给这层的等值面着色（ESP 表面就是这么做的：密度层 + ESP 层）；' +
            'visible=false 只当数据源、不显示。' +
            '例：["homo.cub","lumo.cub"]，或 ESP 表面 [{file:"density.cub", iso:0.001, colorBy:1}, {file:"totesp.cub", visible:false}]。',
        },
        structure: {
          type: 'string',
          description: '结构文件（可选）：.xyz / ORCA .out / .molden / .cub。不给就用第一路 cube 里的原子。',
        },
        hole: { type: 'string', description: '（旧参数）空穴 cube，等价于 volumes[0]。' },
        electron: { type: 'string', description: '（旧参数）电子 cube，等价于 volumes[1]。' },
        xyz: { type: 'string', description: '（旧参数）.xyz，等价于 structure。' },
        outDir: { type: 'string', description: '视图包落盘目录（**由用户指定**，通常就是这次分析的 run 目录）。', required: true },
        name: { type: 'string', description: '视图包名字（目录名与标题），默认取第一个文件的名字。' },
        title: { type: 'string', description: '面板上显示的标题，如 "complex_tda · 第 3 激发态"。' },
        maxDim: { type: 'number', description: '体数据最长边重采样点数，默认 160（原始 149×128×93 时不缩放；只有超大网格才降采样）。' },
      },
      output: textOutput((_args, value) => value.message),
      timeoutMs: 300_000,
      isConcurrencySafe: () => true,
      async execute(args) {
        /** @type {Array<{ file: string, label?: string, name?: string, color?: number[], iso?: number }>} */
        const volumes = []

        const pushVolume = (entry, fallback) => {
          if (!entry) return
          if (typeof entry === 'string') {
            volumes.push(fallback ? { file: entry, ...fallback } : { file: entry })
            return
          }
          if (entry.file) volumes.push(entry)
        }

        if (Array.isArray(args.volumes)) for (const entry of args.volumes) pushVolume(entry)
        // 旧参数继续可用：hole/electron 带上原来的语义与配色。
        if (args.hole) pushVolume(args.hole, { label: '空穴', name: 'hole' })
        if (args.electron) pushVolume(args.electron, { label: '电子', name: 'electron' })

        const structureFile = args.structure ?? args.xyz
        if (volumes.length === 0 && !structureFile) {
          return fail('至少给一样东西：volumes（体数据）或 structure（结构文件）。')
        }

        const sources = [...volumes.map((v) => v.file), structureFile].filter(Boolean)
        const missing = sources.filter((file) => !existsSync(file))
        if (missing.length > 0) return fail(`文件不存在：\n${missing.join('\n')}`)

        const firstName = path.basename(structureFile ?? volumes[0].file)
        const name = args.name ?? firstName.replace(/\.(cub|cube|xyz|out|log|molden|input)$/i, '')

        try {
          const structure = structureFile ? readStructure(structureFile) : undefined

          // ORCA 输出里带了偶极矩就顺手画个箭头：长度按 0.6 Å/D 缩放，位置放在质心。
          let dipole
          if (structureFile && /\.(out|log)$/i.test(structureFile)) {
            const raw = readDipole(structureFile)
            if (raw && structure && structure.atoms.length > 0) {
              const center = [0, 0, 0]
              for (const atom of structure.atoms) {
                center[0] += atom.x
                center[1] += atom.y
                center[2] += atom.z
              }
              const n = structure.atoms.length
              const SCALE = 0.6
              dipole = {
                origin: center.map((v) => Number((v / n).toFixed(4))),
                vector: raw.vector.map((v) => Number((v * SCALE).toFixed(4))),
                magnitude: Number(raw.magnitude.toFixed(3)),
                unit: 'debye',
              }
            }
          }

          const pack = buildViewPack({
            outDir: args.outDir,
            name,
            title: args.title ?? name,
            volumes,
            atoms: structure?.atoms,
            bonds: structure?.bonds,
            dipole,
            maxDim: args.maxDim ?? 160,
          })

          const volumeLine = pack.meta.volumes.length > 0
            ? pack.meta.volumes.map((v) => `${v.label} ${v.dims.join('×')}（${humanBytes(v.bytes)}）`).join('，')
            : '（无，只有骨架）'

          const lines = [
            `✓ 视图包已生成：${pack.dir}`,
            `  标题：${pack.meta.title}`,
            `  体数据：${volumeLine}`,
            `  原子：${pack.meta.atoms.length}，键：${pack.meta.bonds.length}`,
            `  合计：${humanBytes(pack.totalBytes)}`,
            '',
            '打开方式（推荐）：右侧栏的「结构视图」→ 列表里直接点这一条。',
            '（也可以点同目录的 .cub；点 meta.json 只会得到 JSON 文本预览，那是内置预览接管了 .json。）',
            `meta.json：${pack.metaPath}`,
          ]
          const index = appendToIndex(config.dataDir, {
            title: pack.meta.title ?? name,
            metaPath: pack.metaPath,
            viewDir: pack.dir,
            createdAt: pack.meta.createdAt,
          })
          lines.push('', `「结构视图」列表：${index.file}（共 ${index.count} 条）`)
          return ok(lines.join('\n'))
        } catch (error) {
          return fail(`生成视图包失败：${error instanceof Error ? error.message : String(error)}`)
        }
      },
    }),
  )
}

/**
 * 把这次生成的视图包登记进「结构视图」列表。
 *
 * 客户端面板读的是这个文件（装配时会把路径写进 client.js）。同一条记录（按 metaPath）
 * 只保留最新的，最多 30 条。
 *
 * @param {string} dataDir
 * @param {{ title: string, metaPath: string, viewDir: string, createdAt?: string }} entry
 */
export function appendToIndex(dataDir, entry) {
  const file = path.join(dataDir, 'views.json')
  mkdirSync(dataDir, { recursive: true })

  /** @type {{ items: Array<Record<string, any>> }} */
  let data = { items: [] }
  try {
    data = JSON.parse(readFileSync(file, 'utf8'))
    if (!Array.isArray(data.items)) data = { items: [] }
  } catch {
    data = { items: [] }
  }

  const item = {
    title: entry.title,
    metaPath: String(entry.metaPath).replace(/\\/g, '/'),
    viewDir: String(entry.viewDir).replace(/\\/g, '/'),
    createdAt: entry.createdAt ?? new Date().toISOString(),
    addedAt: new Date().toISOString(),
  }
  data.items = [item, ...data.items.filter((old) => old?.metaPath !== item.metaPath)].slice(0, 30)
  data.updatedAt = new Date().toISOString()
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
  return { file, count: data.items.length }
}

/** 读「结构视图」列表；坏了就当空列表。 */
function readIndexFile(dataDir) {
  const file = path.join(dataDir, 'views.json')
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'))
    return { file, items: Array.isArray(data.items) ? data.items : [] }
  } catch {
    return { file, items: [] }
  }
}

function writeIndexFile(dataDir, items) {
  const file = path.join(dataDir, 'views.json')
  mkdirSync(dataDir, { recursive: true })
  const data = { updatedAt: new Date().toISOString(), items: items.slice(0, 30) }
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
  return { file, count: data.items.length }
}

/**
 * `chem_views` —— 管理右侧栏「结构视图」列表。
 *
 * 只动列表（views.json），**不删视图包文件**；要删文件自己在资源管理器里删。
 *
 * @param {any} ctx
 * @param {{ config: Record<string, any> }} deps
 */
export function registerViewsTool(ctx, deps) {
  const { config } = deps

  ctx.tools.register(
    defineTool({
      name: 'chem_views',
      description:
        '管理「结构视图」列表（右侧栏那个列表）：list 看全部、add 手动加一条、remove 删一条、prune 清理失效条目。' +
        '**只改列表，不动磁盘上的 .view 文件**。用户说「把这条删掉」「把那个包加进来」时用它。',
      parameters: {
        action: { type: 'string', description: 'list / add / remove / prune', required: true },
        metaPath: { type: 'string', description: 'add 用：<name>.view/meta.json 的绝对路径（给 .view 目录也行）。' },
        index: { type: 'number', description: 'remove 用：list 显示的序号（从 1 起）。' },
        match: { type: 'string', description: 'remove 用：按标题/路径的子串匹配（给了就不看 index）。' },
      },
      output: textOutput((_args, value) => value.message),
      timeoutMs: 30_000,
      isConcurrencySafe: () => false,
      async execute(args) {
        const action = String(args.action ?? '').toLowerCase()
        const { file, items } = readIndexFile(config.dataDir)

        if (action === 'list') {
          if (items.length === 0) return ok(`「结构视图」列表是空的。\n文件：${file}`)
          const lines = items.map((item, i) => {
            const exists = item.metaPath && existsSync(item.metaPath)
            return `${String(i + 1).padStart(2, ' ')}. ${exists ? '✓' : '✗'} ${item.title ?? '(无标题)'}\n     ${item.metaPath}`
          })
          return ok([`「结构视图」共 ${items.length} 条（✗ = 文件已不在）：`, ...lines, '', `列表文件：${file}`].join('\n'))
        }

        if (action === 'add') {
          let target = args.metaPath
          if (!target) return fail('add 需要 metaPath。')
          target = path.resolve(target)
          if (!target.toLowerCase().endsWith('.json')) target = path.join(target, 'meta.json')
          if (!existsSync(target)) return fail(`找不到：${target}`)
          let title = path.basename(path.dirname(target)).replace(/\.view$/i, '')
          try {
            const meta = JSON.parse(readFileSync(target, 'utf8'))
            title = meta.title ?? meta.name ?? title
          } catch {
            return fail(`这个文件不是合法的视图包 meta.json：${target}`)
          }
          const entry = {
            title,
            metaPath: target.replace(/\\/g, '/'),
            viewDir: path.dirname(target).replace(/\\/g, '/'),
            createdAt: new Date().toISOString(),
            addedAt: new Date().toISOString(),
          }
          const next = [entry, ...items.filter((old) => old?.metaPath !== entry.metaPath)]
          const result = writeIndexFile(config.dataDir, next)
          return ok(`✓ 已加入列表：${title}\n  现在共 ${result.count} 条`)
        }

        if (action === 'remove') {
          let index = -1
          if (args.match) {
            const needle = String(args.match).toLowerCase()
            index = items.findIndex(
              (item) => String(item.title ?? '').toLowerCase().includes(needle) || String(item.metaPath ?? '').toLowerCase().includes(needle),
            )
            if (index < 0) return fail(`没有标题或路径包含「${args.match}」的条目。`)
          } else if (Number.isFinite(args.index)) {
            index = Number(args.index) - 1
            if (index < 0 || index >= items.length) return fail(`序号超出范围（1~${items.length}）。`)
          } else {
            return fail('remove 需要 index 或 match。')
          }
          const [removed] = items.splice(index, 1)
          const result = writeIndexFile(config.dataDir, items)
          return ok(`✓ 已从列表移除：${removed.title ?? removed.metaPath}\n  剩下 ${result.count} 条（磁盘上的文件没动）`)
        }

        if (action === 'prune') {
          const alive = items.filter((item) => item.metaPath && existsSync(item.metaPath))
          const dropped = items.length - alive.length
          writeIndexFile(config.dataDir, alive)
          return ok(`✓ 清理完成：移除 ${dropped} 条失效记录，剩 ${alive.length} 条`)
        }

        return fail(`不认识的 action：${args.action}（可选 list / add / remove / prune）`)
      },
    }),
  )
}
