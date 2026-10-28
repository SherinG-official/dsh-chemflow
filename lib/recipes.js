/**
 * Multiwfn 菜单配方。
 *
 * ## 为什么 recipe 是「数据」而不是「代码」
 *
 * 菜单号随版本漂移（3.8 与旧版的 hole-electron 出口就是不一样的：3.8 多一层
 * Post-processing 菜单，结尾要多两个 `0` 才能回到主菜单）。把配方做成数组，
 * 版本变了改一行；同时让 {@link validateRecipe} 在运行前拦住两种**实测会出事**的写法。
 *
 * ## 两条硬规则（都踩过）
 *
 * 1. **菜单里的 `0` 不是退出**：在部分层级 `0` 是「显示分子结构」——会开图形窗口并
 *    永久挂住。所以只允许在结尾用有限个 `0` 逐层返回，中间一律拒绝。
 * 2. **多余空行会被当成菜单输入**：实测会让进程提前退出，`hole.cub` 写成 0 字节，
 *    而日志里照样打印 "Done!"。空行只允许出现在「让 Multiwfn 自己找同名 .out」
 *    那一步。
 *
 * @module dsh-chemflow/recipes
 */

/**
 * hole/electron 分析配方（Multiwfn 3.8 实测）。
 *
 * 逐行含义：
 * ```
 * 18           主菜单 → Electronic excitation analysis
 * 1            → Analyze and visualize hole&electron ...
 * (空行)        让它自动加载 <输入文件名>.molden.out
 * <state>      要分析的激发态序号
 * 1            → Visualize and analyze hole, electron ...
 * <grid>       网格：1 低 / 2 中 / 3 高（实测 92 原子 1.77M 点约 10 s）
 * 10 / 1       导出 hole cube（1 = Total：local + cross）
 * 11 / 1       导出 electron cube
 * 0 0 0        逐层返回：后处理 → hole&electron → 激发态分析
 * q            主菜单退出
 * ```
 *
 * @param {{ state: number, grid?: 'low'|'medium'|'high' }} options
 * @returns {string[]}
 */
export function holeElectronRecipe({ state, grid = 'high' }) {
  const gridCode = { low: '1', medium: '2', high: '3' }[grid]
  if (!gridCode) throw new Error(`未知网格档位：${grid}（可选 low/medium/high）`)
  if (!Number.isInteger(state) || state < 1) throw new Error(`激发态序号必须是正整数，收到：${state}`)
  return ['18', '1', '', String(state), '1', gridCode, '10', '1', '11', '1', '0', '0', '0', 'q']
}

/**
 * 配方校验：运行前把「会挂死 / 会写出 0 字节」的写法拦下来。
 *
 * @param {string[]} lines
 * @param {{ allowEmptyAt?: number[], allowZeroTail?: number, mustEndWithQ?: boolean }} [rules]
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function validateRecipe(lines, rules = {}) {
  const { allowEmptyAt = [], allowZeroTail = 3, mustEndWithQ = true } = rules
  if (!Array.isArray(lines) || lines.length === 0) return { ok: false, reason: '配方为空' }

  const body = mustEndWithQ && lines[lines.length - 1] === 'q' ? lines.slice(0, -1) : lines

  // 只有**结尾连续的那一串** 0 才算「逐层返回」；中间出现的一律拒绝。
  let trailingZeros = 0
  for (let i = body.length - 1; i >= 0 && String(body[i]) === '0'; i -= 1) trailingZeros += 1
  if (trailingZeros > allowZeroTail) {
    return {
      ok: false,
      reason: `结尾有 ${trailingZeros} 个 0，超过允许的 ${allowZeroTail} 个 —— 多出来的 0 很可能落在某个菜单上被当成「显示分子结构」。`,
    }
  }
  const tailStart = body.length - trailingZeros

  for (let i = 0; i < body.length; i += 1) {
    const line = String(body[i])
    if (line === '0' && i < tailStart) {
      return {
        ok: false,
        reason:
          `第 ${i + 1} 行是 0 —— 菜单里的 0 在部分层级是「显示分子结构」，会开图形窗口并永久挂住。` +
          `只允许结尾连续用 ${allowZeroTail} 个 0 逐层返回。`,
      }
    }
    if (line.trim() === '' && !allowEmptyAt.includes(i)) {
      return {
        ok: false,
        reason:
          `第 ${i + 1} 行是空行 —— 多余的空行会被当成菜单输入，实测会让 cube 写成 0 字节而日志仍打印 "Done!"。` +
          (allowEmptyAt.length ? `只允许出现在第 ${allowEmptyAt.map((n) => n + 1).join('、')} 行。` : ''),
      }
    }
  }

  if (mustEndWithQ && lines[lines.length - 1] !== 'q') {
    return { ok: false, reason: '配方必须以 q 结尾（退出主菜单）。' }
  }
  return { ok: true }
}

/**
 * 把配方写成 Multiwfn 的 stdin 文件内容（一行一个，末尾带换行）。
 *
 * @param {string[]} lines
 * @returns {string}
 */
export function recipeToText(lines) {
  return `${lines.join('\n')}\n`
}
