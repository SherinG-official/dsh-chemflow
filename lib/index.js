/**
 * dsh-chemflow —— 从化学计算到成图的工作流插件。
 *
 * 三条链，共用一套执行核心：
 *
 *   1. **集群**：chem_orca（submit → status → fetch）→ 本机拿到 .molden.input + .molden.out
 *   2. **分析**：chem_hole_electron / chem_multiwfn / chem_orbital / chem_esp / chem_aromatic
 *   3. **出图**：chem_render（VMD）→ PNG/TIFF；数值图交给已有的 origin_* 工具
 *
 * 设计上最值钱的不是"包一层 exe"，而是把实测踩过的坑写成了**前置闸门与后置核对**：
 * 全 TD 的作业在开跑前就被拦下、菜单 `0` 被拒绝、settings.ini 写进短路径私有目录、
 * cube 大小与头部的点数自洽才认成功、VMD 只写 BMP 所以自己转 PNG。
 *
 * @module dsh-chemflow
 */

import { mkdirSync, writeFileSync } from 'node:fs'

import z from '@deepseek-ai/schemastery'

import { resolveConfig } from './config.js'
import { registerEnvTool } from './tools/env.js'
import { registerHoleTool } from './tools/hole.js'
import { registerMultiwfnTool } from './tools/multiwfn.js'
import { registerOrcaTool } from './tools/orca.js'
import { registerOrcaStatesTool } from './tools/orca-states.js'
import { registerAromaticTool, registerEspTool, registerOrbitalTool } from './tools/presets.js'
import { registerRenderTool } from './tools/render.js'
import { registerViewsTool, registerViewTool } from './tools/view.js'

/** Cordis 插件名。 */
export const name = 'dsh-chemflow'

/** 需要的宿主服务（可选服务不要写进来，否则没有它的宿主会让插件停在 PENDING）。 */
export const inject = ['tools', 'systemPrompt']

/** 系统提示词段落名。 */
export const PROMPT_SECTION = 'dsh-chemflow:guide'

/** 本插件注册的工具名（诊断、测试、文档共用这一份）。 */
export const TOOL_NAMES = [
  'chem_env',
  'chem_orca',
  'chem_orca_states',
  'chem_hole_electron',
  'chem_orbital',
  'chem_aromatic',
  'chem_esp',
  'chem_render',
  'chem_view',
  'chem_views',
  'chem_multiwfn',
]

/** 插件配置。 */
export const Config = z.object({
  multiwfnExe: z
    .string()
    .default('D:\\Program Files\\Multiwfn\\Multiwfn.exe')
    .description('Multiwfn.exe 的绝对路径。'),
  multiwfnHome: z
    .string()
    .default('')
    .description('Multiwfn 安装目录（settings.ini 所在）。留空则用 exe 所在目录。'),
  vmdExe: z.string().default('D:\\Program Files\\VMD2\\vmd.exe').description('vmd.exe 的绝对路径。'),
  pythonExe: z
    .string()
    .default('')
    .description('图像后处理用的 Python（需要 Pillow + numpy）。留空则自动找 DSH 自带 runtime。'),
  dataDir: z.string().default('').description('插件数据目录，默认 ~/.dsh/dsh-chemflow。'),
  timeoutMs: z.number().default(1_800_000).description('单次计算/渲染的默认超时（毫秒）。'),
  maxArtifactMB: z.number().default(2000).description('单个产物的期望上限（MB），超了会在返回里提示。'),
  prompt: z.boolean().default(true).description('是否把使用指南注入系统提示词。'),
  debug: z.boolean().default(false).description('打开后把解析出的路径写进宿主日志，便于排障。'),

  // ---- 集群（扁平字段：不用嵌套对象，避免配置校验出幺蛾子）----
  sshHost: z.string().default('').description('集群主机名或 IP。'),
  sshPort: z.number().default(22).description('SSH 端口。'),
  sshUsername: z.string().default('').description('登录用户名。'),
  sshPassword: z.string().default('').description('密码（留空则用 sshKeyPath，推荐密钥）。'),
  sshKeyPath: z.string().default('').description('私钥路径（优先于密码）。'),
  sshRemoteRoot: z.string().default('~/chemflow').description('远程工作根目录。'),
  sshPartition: z.string().default('chem').description('Slurm 分区（mode=slurm 时用）。'),
  sshCores: z.number().default(16).description('核数提示值。'),
  sshMaxcore: z.number().default(2048).description('每个核的内存（MB）。'),
  sshTimeLimit: z.string().default('24:00:00').description('Slurm 时限。'),
  sshOrcaRoot: z.string().default('/opt/software/orca-5.0.3').description('远程 ORCA 安装目录。'),
  sshMpiRoot: z.string().default('/opt/software/openmpi-4.1.5').description('远程 OpenMPI 目录。'),
})

/** 工具可用时才注入这段引导。 */
const PROMPT_TEXT = `## 化学计算工作流(dsh-chemflow)

本机接了一条「ORCA 计算 → Multiwfn 波函数分析 → VMD 出图」的链路。**数值图仍走 origin_*，结构图走 chem_render。**

- chem_env:环境自检。任何 chem_* 报错先调它（本机 Multiwfn/VMD/Python，action=ssh 查集群）。
- chem_orca:在集群上跑 ORCA。action=submit 上传 .inp 并后台启动 → action=status 查状态 → action=fetch 转 molden 并回传。
- chem_orca_states:解析本地 .out，出激发态表（能量/λ/f/R/主导组态）并写 CSV；同时判定是不是 TDA。
- chem_hole_electron:对 TDA 激发态做 hole/electron 分析，出两个 cube + Sr/Sm/D/HDI 判据；可顺手渲染。
- chem_orbital:导出分子轨道 cube（h / l / h-1 / 171），可顺手渲染等值面（轨道阈值用 0.02）。
- chem_aromatic:HOMA 芳香性。必须给环原子序号（按成键顺序），如 ["1,2,3,4,5,6"]；HOMA→1 越芳香。
- chem_esp:ESP 表面定量（面积 / 正负区 / 极值 / σ² / 电荷平衡 ν）+ 导出 surf.cub。
- chem_render:VMD 出图（等值面/球棍，可叠骨架），PNG/TIFF，自动裁白边。
- chem_view:生成「结构视图包」，供应用内 3D 面板打开（像点开 .md 那样）。**不限于空穴/电子**：volumes 给 0~6 路任意 cube（轨道/ESP/自旋密度…），structure 给 .xyz / ORCA .out / .molden / .cub 看优化后的几何；只给 structure 就是纯结构图。
- chem_views:管理右侧栏「结构视图」列表（list/add/remove/prune），只改列表不删文件。用户说「把这条删掉」「把这个包加进来」时用它。
- chem_multiwfn:逃生口。给任意 stdin recipe 跑 Multiwfn（菜单号随版本变时兜底）。

**三条典型流程**

1. 集群计算：chem_orca(submit) → chem_orca(status) → chem_orca(fetch) → chem_hole_electron → chem_render。
2. 本地已有文件：chem_hole_electron → chem_render。
3. 光谱/能级：chem_orca_states(outDir=…) → origin_import CSV → origin_plot / origin_template_plot。

**铁律**

1. **产物目录必须由用户给**（outDir）。不同课题放不同目录，绝不自己编一个默认路径。
2. **要接 Multiwfn 的 TD-DFT 必须开 \`TDA true\`**。全 TD 只打印 contribution，Multiwfn 会得到积分 0、D=NaN。chem_hole_electron 会拦，但输入阶段就该避免。
3. **Multiwfn 要的同名配套文件是 \`<stem>.molden.out\`**，不是 \`<stem>.out\`。缺了会报 Unable to find。
4. **"Done!" 不等于写成功**。cube 可能是 0 字节。工具已经核对大小与头部点数，返回里 issues 非空就**不许**说成功。
5. **看图再交付**。chem_render 成功后用 read_image 看一眼：视角有没有把分子切掉、两个等值面是否糊在一起、阈值是否合适。
6. chem_multiwfn 的 recipe 里**中间不能出现 0**（部分层级 = 开图形窗口，会永久挂住）；空行会被当菜单输入，只在你确实要"直接回车"时用。
7. 长作业（几十分钟）用 chem_orca 提交后隔几分钟查一次状态，不要原地等。`

/**
 * 插件入口。
 *
 * @param {any} ctx
 * @param {Record<string, unknown>} config
 */
export function apply(ctx, config = {}) {
  const resolved = resolveConfig(config)
  const deps = { config: resolved }

  // 启动标记：插件到底有没有被宿主 import + apply 成功。
  // 没有这个文件 = 没加载（模块解析 / import 失败）；有文件但工具没出现 = 注册阶段失败。
  // 排查「重启后工具没出现」时先看它，比猜快得多。
  try {
    mkdirSync(resolved.dataDir, { recursive: true })
    writeFileSync(
      `${resolved.dataDir}/loaded.json`,
      `${JSON.stringify({ at: new Date().toISOString(), tools: TOOL_NAMES, multiwfn: resolved.multiwfnExe }, null, 2)}\n`,
      'utf8',
    )
  } catch {
    /* 标记写不了不影响插件本体 */
  }

  if (config?.debug) {
    console.log(
      `[dsh-chemflow] multiwfn=${resolved.multiwfnExe} vmd=${resolved.vmdExe} ` +
        `python=${resolved.pythonExe}(${resolved.pythonSource}) dataDir=${resolved.dataDir}`,
    )
  }

  if (config?.prompt !== false) {
    ctx.systemPrompt.section({
      name: PROMPT_SECTION,
      order: 3100,
      text: ({ scope }) =>
        ctx.tools.get('chem_env', scope) === undefined && ctx.tools.get('chem_hole_electron', scope) === undefined
          ? ''
          : PROMPT_TEXT,
    })
  }

  registerEnvTool(ctx, deps)
  registerOrcaTool(ctx, deps)
  registerOrcaStatesTool(ctx, deps)
  registerHoleTool(ctx, deps)
  registerOrbitalTool(ctx, deps)
  registerAromaticTool(ctx, deps)
  registerEspTool(ctx, deps)
  registerRenderTool(ctx, deps)
  registerViewTool(ctx, deps)
  registerViewsTool(ctx, deps)
  registerMultiwfnTool(ctx, deps)
}
