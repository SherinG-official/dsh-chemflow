/**
 * Multiwfn 输出解析。
 *
 * 只认**实测出现过**的字段（Multiwfn 3.8，hole-electron 分析），全部用宽松正则，
 * 因为列对齐宽度会随数值大小变。
 *
 * 解析失败不抛异常 —— 返回 `issues`，由调用方决定是「警告」还是「判失败」。
 *
 * @module dsh-chemflow/parse/multiwfn
 */

/**
 * @param {string} text Multiwfn 的 stdout 全文
 */
export function parseMultiwfnLog(text) {
  const num = (re) => {
    const m = text.match(re)
    return m ? Number(m[1]) : null
  }
  const vec = (re) => {
    const m = text.match(re)
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
  }

  const metrics = {
    state: num(/loading configuration coefficients of excited state\s+(\d+)/i),
    gridPoints: num(/Total:\s+(\d+)\s*$/m),
    excitationWeight: num(/Sum of square of excitation coefficients:\s+(-?[\d.]+)/i),
    integralHole: num(/Integral of hole:\s+(-?[\d.]+)/i),
    integralElectron: num(/Integral of electron:\s+(-?[\d.]+)/i),
    integralTransition: num(/Integral of transition density:\s+(-?[\d.]+)/i),
    sm: num(/Sm index \(integral of Sm function\):\s+(-?[\d.]+)/i),
    sr: num(/Sr index \(integral of Sr function\):\s+(-?[\d.]+)/i),
    centroidHole: vec(/Centroid of hole in X\/Y\/Z:\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)/i),
    centroidElectron: vec(/Centroid of electron in X\/Y\/Z:\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)/i),
    dIndex: num(/D index:\s+(-?[\d.]+)\s*Angstrom/i),
    hIndex: num(/H index:\s+(-?[\d.]+)\s*Angstrom/i),
    hct: num(/H_CT:\s+(-?[\d.]+)/i),
    tIndex: num(/t index:\s+(-?[\d.]+)\s*Angstrom/i),
    hdi: num(/Hole delocalization index \(HDI\):\s+(-?[\d.]+)/i),
    edi: num(/Electron delocalization index \(EDI\):\s+(-?[\d.]+)/i),
  }

  const issues = []

  // ---- 进程级异常 ----
  if (/forrtl:\s+severe/i.test(text)) {
    const line = text.split(/\r?\n/).find((l) => /forrtl:\s+severe/i.test(l))
    issues.push(`Multiwfn 运行时报错：${line?.trim() ?? 'forrtl: severe'}`)
  }
  if (/^\s*Error[:!]/m.test(text)) {
    const line = text.split(/\r?\n/).find((l) => /^\s*Error[:!]/m.test(l))
    issues.push(`Multiwfn 输出里有 Error：${line?.trim() ?? '(未捕获)'}`)
  }

  // ---- 数值健全性 ----
  const hasHole = metrics.integralHole !== null
  if (!hasHole) issues.push('没找到 "Integral of hole" —— 分析可能没有真正执行完')

  for (const [label, value] of [
    ['hole', metrics.integralHole],
    ['electron', metrics.integralElectron],
  ]) {
    if (value !== null && Math.abs(value) < 0.5) {
      issues.push(
        `Integral of ${label} = ${value}，远低于 1 —— 典型原因是 ORCA 用了全 TD（没开 TDA），` +
          'Multiwfn 只能对 contribution 开方硬凑，结果不可用。',
      )
    }
  }

  return { metrics, issues, ok: hasHole && !issues.some((i) => i.includes('全 TD')) }
}

/**
 * 按 D index / Sr 给激发态分类（判据见 ORCA-Multiwfn-VMD 工作流 3.3 节）。
 *
 * @param {{ dIndex: number|null, sr: number|null }} metrics
 * @returns {{ kind: string, reason: string }}
 */
export function classifyExcitation({ dIndex, sr }) {
  const bits = []
  if (dIndex !== null) {
    if (dIndex < 2) bits.push('D < 2 Å → 局域激发 (LE)')
    else if (dIndex > 3) bits.push('D > 3 Å → 电荷转移 (CT)')
    else bits.push('2 ≤ D ≤ 3 Å → 居间/部分 CT')
  }
  if (sr !== null) {
    if (sr > 0.5) bits.push('Sr > 0.5 → 空穴-电子重叠强 (LE)')
    else if (sr < 0.2) bits.push('Sr < 0.2 → 重叠弱 (CT)')
  }
  if (bits.length === 0) return { kind: 'unknown', reason: '缺少 D index / Sr，无法判据' }
  return { kind: dIndex !== null ? (dIndex > 3 ? 'CT' : dIndex < 2 ? 'LE' : 'mixed') : 'unknown', reason: bits.join('；') }
}
