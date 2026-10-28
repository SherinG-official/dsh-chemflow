/**
 * ORCA 输出解析（ORCA 5.0.3 实测格式）。
 *
 * 关注三件事：
 *   1. **是不是 TDA** —— 这是下游能不能接 Multiwfn 的生死线：
 *      全 TD 只打印 contribution，不打印 CI 系数，Multiwfn 的 hole/electron 分析会得到
 *      积分 0、D index = NaN。
 *   2. **算没算完** —— `TERMINATED NORMALLY`。
 *   3. **激发态表** —— 能量 / 波长 / 振子强度 / 旋转强度 / 主导组态。
 *
 * @module dsh-chemflow/parse/orca
 */

const STATE_RE = /^STATE\s+(\d+):\s+E=\s*(-?[\d.]+)\s+au\s+(-?[\d.]+)\s+eV\s+(-?[\d.]+)\s+cm/
const CONFIG_RE = /^\s*(\d+)([ab]?)\s*->\s*(\d+)([ab]?)\s*:\s*(-?[\d.]+)\s+\(c=\s*(-?[\d.]+)\)/
const ABS_RE = /^\s*(\d+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)(?:\s+(-?[\d.]+))?(?:\s+(-?[\d.]+))?(?:\s+(-?[\d.]+))?/
const CD_RE = /^\s*(\d+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)/

/**
 * 解析 ORCA 的 `.out`。
 *
 * @param {string} text
 * @returns {{
 *   version: string|null,
 *   tda: boolean,
 *   fullTd: boolean,
 *   terminated: boolean,
 *   terminatedCount: number,
 *   states: Array<{ index: number, eV: number, cm: number, configs: Array<{ from: string, to: string, weight: number, coef: number }> }>,
 *   absorption: Array<{ state: number, cm: number, nm: number, fosc: number, t2: number|null }>,
 *   cd: Array<{ state: number, cm: number, nm: number, r: number }>,
 *   issues: string[],
 * }}
 */
export function parseOrcaOut(text) {
  const lines = text.split(/\r?\n/)

  const versionMatch = text.match(/Program Version\s+([\d.]+)/)
  const version = versionMatch ? versionMatch[1] : null

  // 3.8 之前的版本把 TDA 块写成 "TD-DFT/TDA EXCITED STATES"；全 TD 是 "TD-DFT EXCITED STATES"。
  const tda = /TD-DFT\/TDA EXCITED STATES/i.test(text)
  const fullTd = !tda && /TD-DFT EXCITED STATES/i.test(text)
  const terminatedCount = (text.match(/TERMINATED NORMALLY/g) ?? []).length

  /** @type {Array<any>} */
  const states = []
  let current = null
  for (const line of lines) {
    const s = line.match(STATE_RE)
    if (s) {
      current = { index: Number(s[1]), eV: Number(s[3]), cm: Number(s[4]), configs: [] }
      states.push(current)
      continue
    }
    const c = line.match(CONFIG_RE)
    if (c && current) {
      current.configs.push({
        from: `${c[1]}${c[2]}`,
        to: `${c[3]}${c[4]}`,
        weight: Number(c[5]),
        coef: Number(c[6]),
      })
      continue
    }
    if (/^\s*$/.test(line) && current && current.configs.length > 0) {
      // 空行结束当前态（后面可能还有 S**2 之类）
    }
  }

  // ---- 吸收谱表（电偶极） ----
  const absorption = []
  const absStart = lines.findIndex((l) => /ABSORPTION SPECTRUM VIA TRANSITION ELECTRIC DIPOLE MOMENTS/i.test(l))
  if (absStart >= 0) {
    for (let i = absStart + 1; i < lines.length; i += 1) {
      const line = lines[i]
      if (/^\s*-{5,}/.test(line)) {
        if (absorption.length > 0) break
        continue
      }
      const m = line.match(ABS_RE)
      if (m) {
        absorption.push({
          state: Number(m[1]),
          cm: Number(m[2]),
          nm: Number(m[3]),
          fosc: Number(m[4]),
          t2: m[5] !== undefined ? Number(m[5]) : null,
        })
      } else if (absorption.length > 0) {
        break
      }
    }
  }

  // ---- CD 谱表 ----
  const cd = []
  const cdStart = lines.findIndex((l) => /^\s*CD SPECTRUM\s*$/i.test(l))
  if (cdStart >= 0) {
    for (let i = cdStart + 1; i < lines.length; i += 1) {
      const line = lines[i]
      if (/^\s*-{5,}/.test(line)) {
        if (cd.length > 0) break
        continue
      }
      const m = line.match(CD_RE)
      if (m) {
        cd.push({ state: Number(m[1]), cm: Number(m[2]), nm: Number(m[3]), r: Number(m[4]) })
      } else if (cd.length > 0) {
        break
      }
    }
  }

  const issues = []
  if (!terminatedCount) issues.push('输出里没有 "TERMINATED NORMALLY" —— 计算没有正常结束，结果不可用。')
  if (fullTd) {
    issues.push(
      '这是**全 TD** 的输出（只有 TD-DFT EXCITED STATES，没有 TDA 块）。' +
        'Multiwfn 的 hole/electron 分析读它只能对 contribution 开方硬凑，会得到积分 0、D index = NaN。' +
        '必须重算并加 `TDA true`。',
    )
  }
  if (!tda && !fullTd) issues.push('输出里没找到 TD-DFT 激发态块 —— 这个作业可能不是 TD-DFT。')

  // 把吸收谱的 fosc 合并进态（按序号对齐）
  const byState = new Map(absorption.map((a) => [a.state, a]))
  const cdByState = new Map(cd.map((c) => [c.state, c]))
  for (const state of states) {
    const a = byState.get(state.index)
    const c = cdByState.get(state.index)
    state.nm = a?.nm ?? (state.cm ? 1e7 / state.cm : null)
    state.fosc = a?.fosc ?? null
    state.r = c?.r ?? null
    const total = state.configs.reduce((sum, cfg) => sum + cfg.weight, 0)
    state.dominant = state.configs
      .slice()
      .sort((x, y) => y.weight - x.weight)
      .slice(0, 2)
      .map((cfg) => ({
        ...cfg,
        percent: total > 0 ? (cfg.weight / total) * 100 : null,
      }))
    state.weightSum = total
  }

  return { version, tda, fullTd, terminated: terminatedCount > 0, terminatedCount, states, absorption, cd, issues }
}

/**
 * 把激发态导成 CSV（Origin 直接能读：第一行表头，逗号分隔）。
 *
 * @param {ReturnType<typeof parseOrcaOut>} parsed
 * @returns {string}
 */
export function statesToCsv(parsed) {
  const header = [
    'State',
    'E(eV)',
    'Wavelength(nm)',
    'fosc',
    'R(1e40 cgs)',
    'Dominant configuration',
    'Weight(%)',
    'Second configuration',
    'Weight2(%)',
  ]
  const rows = [header.join(',')]
  for (const s of parsed.states) {
    const d0 = s.dominant?.[0]
    const d1 = s.dominant?.[1]
    rows.push(
      [
        s.index,
        s.eV.toFixed(4),
        s.nm !== null && s.nm !== undefined ? s.nm.toFixed(1) : '',
        s.fosc !== null && s.fosc !== undefined ? s.fosc.toFixed(6) : '',
        s.r !== null && s.r !== undefined ? s.r.toFixed(3) : '',
        d0 ? `${d0.from}→${d0.to}` : '',
        d0?.percent != null ? d0.percent.toFixed(1) : '',
        d1 ? `${d1.from}→${d1.to}` : '',
        d1?.percent != null ? d1.percent.toFixed(1) : '',
      ].join(','),
    )
  }
  return `${rows.join('\n')}\n`
}
