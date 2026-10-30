/**
 * 2D 坐标生成。
 *
 * 化学信息学里"2D 结构式"不是简单投影：平面分子投影就对，螺环/多环就会叠成一团。
 * 这里分两步：
 *
 *   1. **PCA 投影**（主平面）——平面对称分子（苯、卟啉、大多数共轭体系）直接就是正确的 2D；
 *   2. **弹簧松弛**——把每个键拉到统一键长、非键原子互相排斥，迭代几百次。
 *      初始值用 PCA 结果，避免随机初值带来的旋转/翻面。
 *
 * 不追求 ChemDraw 级别（那需要环系识别、模板库、立体化学布局），但对
 * "从 3D 导出一个能看的 2D 结构式" 这个目标够用，而且零依赖。
 *
 * @module dsh-chemflow/export/layout2d
 */

/** 归一化的主成分方向（3x3 协方差的最大/次大特征向量）。 */
function principalAxes(points) {
  const n = points.length;
  if (n === 0) return [[1, 0, 0], [0, 1, 0]];
  const center = [0, 0, 0];
  for (const p of points) {
    center[0] += p[0] / n;
    center[1] += p[1] / n;
    center[2] += p[2] / n;
  }
  const cov = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (const p of points) {
    const d = [p[0] - center[0], p[1] - center[1], p[2] - center[2]];
    for (let i = 0; i < 3; i += 1) {
      for (let j = 0; j < 3; j += 1) cov[i][j] += (d[i] * d[j]) / n;
    }
  }

  const dominant = (matrix, seed) => {
    let v = seed.slice();
    for (let iter = 0; iter < 64; iter += 1) {
      const next = [
        matrix[0][0] * v[0] + matrix[0][1] * v[1] + matrix[0][2] * v[2],
        matrix[1][0] * v[0] + matrix[1][1] * v[1] + matrix[1][2] * v[2],
        matrix[2][0] * v[0] + matrix[2][1] * v[1] + matrix[2][2] * v[2],
      ];
      const len = Math.hypot(next[0], next[1], next[2]) || 1;
      v = [next[0] / len, next[1] / len, next[2] / len];
    }
    return v;
  };

  const u1 = dominant(cov, [1, 0, 0]);
  // 抹掉 u1 方向后再求第二主成分（deflation）
  const deflated = cov.map((row, i) => row.map((value, j) => value - (u1[i] * u1[j] * 0) - 0));
  const lambda1 =
    u1[0] * (cov[0][0] * u1[0] + cov[0][1] * u1[1] + cov[0][2] * u1[2]) +
    u1[1] * (cov[1][0] * u1[0] + cov[1][1] * u1[1] + cov[1][2] * u1[2]) +
    u1[2] * (cov[2][0] * u1[0] + cov[2][1] * u1[1] + cov[2][2] * u1[2]);
  for (let i = 0; i < 3; i += 1) {
    for (let j = 0; j < 3; j += 1) deflated[i][j] = cov[i][j] - lambda1 * u1[i] * u1[j];
  }
  const u2 = dominant(deflated, [0, 1, 0]);
  return [u1, u2];
}

/**
 * 生成 2D 坐标。
 *
 * @param {Array<{ x: number, y: number, z: number }>} atoms
 * @param {number[][]} bonds
 * @param {{ bondLength?: number, iterations?: number }} [options]
 * @returns {Array<{ x: number, y: number }>}
 */
export function layout2d(atoms, bonds, options = {}) {
  const bondLength = options.bondLength ?? 1.5;
  const iterations = options.iterations ?? 500;
  if (atoms.length === 0) return [];

  const [u1, u2] = principalAxes(atoms.map((a) => [a.x, a.y, a.z]));
  const pos = atoms.map((a) => [a.x * u1[0] + a.y * u1[1] + a.z * u1[2], a.x * u2[0] + a.y * u2[1] + a.z * u2[2]]);

  // 完全共线（比如双原子分子）时 PCA 给不出平面，人工张开一点
  const spread = Math.max(...pos.map((p) => Math.hypot(p[0], p[1])), 0);
  if (spread < 1e-6) {
    pos.forEach((p, i) => {
      const ang = (i / Math.max(1, atoms.length)) * Math.PI * 2;
      p[0] = Math.cos(ang) * bondLength * 0.5;
      p[1] = Math.sin(ang) * bondLength * 0.5;
    });
  }

  const neighbours = atoms.map(() => []);
  for (const [i, j] of bonds) {
    if (neighbours[i] && neighbours[j]) {
      neighbours[i].push(j);
      neighbours[j].push(i);
    }
  }

  const force = pos.map(() => [0, 0]);
  for (let iter = 0; iter < iterations; iter += 1) {
    for (const f of force) {
      f[0] = 0;
      f[1] = 0;
    }

    // 键：弹簧拉到目标键长
    for (const [i, j] of bonds) {
      if (!pos[i] || !pos[j]) continue;
      const dx = pos[j][0] - pos[i][0];
      const dy = pos[j][1] - pos[i][1];
      const distance = Math.hypot(dx, dy) || 1e-6;
      const pull = (distance - bondLength) * 0.6;
      const ux = dx / distance;
      const uy = dy / distance;
      force[i][0] += ux * pull;
      force[i][1] += uy * pull;
      force[j][0] -= ux * pull;
      force[j][1] -= uy * pull;
    }

    // 非键：短程排斥（1-2、1-3 除外，否则会跟键力打架）
    for (let i = 0; i < pos.length; i += 1) {
      for (let j = i + 1; j < pos.length; j += 1) {
        if (neighbours[i].includes(j)) continue;
        const near = neighbours[i].some((k) => neighbours[j].includes(k));
        const dx = pos[j][0] - pos[i][0];
        const dy = pos[j][1] - pos[i][1];
        const distance = Math.hypot(dx, dy) || 1e-6;
        // 1-3 对的理想距离是 bondLength*sin(60°)*2 ≈ 1.73*bondLength；
        // 拿这个当"舒适距离"，环就能被撑成规整的多边形而不是被压扁。
        const limit = near ? bondLength * 1.55 : bondLength * 2.1;
        if (distance > limit * 1.6) continue;
        const push = ((limit - distance) / limit) * (near ? 0.28 : 0.5);
        if (push <= 0) continue;
        const ux = dx / distance;
        const uy = dy / distance;
        force[i][0] -= ux * push;
        force[i][1] -= uy * push;
        force[j][0] += ux * push;
        force[j][1] += uy * push;
      }
    }

    let maxStep = 0;
    for (let i = 0; i < pos.length; i += 1) {
      const step = Math.hypot(force[i][0], force[i][1]);
      maxStep = Math.max(maxStep, step);
      pos[i][0] += force[i][0];
      pos[i][1] += force[i][1];
    }
    if (maxStep < 1e-4) break;
  }

  // 居中并做一次整体缩放，让最短键长回到 bondLength 附近（力场收敛不完美时兜底）
  const cx = pos.reduce((s, p) => s + p[0], 0) / pos.length;
  const cy = pos.reduce((s, p) => s + p[1], 0) / pos.length;
  let sum = 0;
  let count = 0;
  for (const [i, j] of bonds) {
    if (!pos[i] || !pos[j]) continue;
    sum += Math.hypot(pos[j][0] - pos[i][0], pos[j][1] - pos[i][1]);
    count += 1;
  }
  const mean = count > 0 ? sum / count : bondLength;
  const scale = mean > 1e-6 ? bondLength / mean : 1;
  return pos.map((p) => ({ x: (p[0] - cx) * scale, y: (p[1] - cy) * scale }));
}

/** 按距离估键级：只用共价半径比，不区分芳香。 */
const COVALENT = { H: 0.31, C: 0.76, N: 0.71, O: 0.66, F: 0.57, S: 1.05, P: 1.07, Cl: 1.02, Br: 1.2, I: 1.39 }

/**
 * @param {string} elementA
 * @param {string} elementB
 * @param {number} distance
 * @returns {1|2|3}
 */
export function guessBondOrder(elementA, elementB, distance) {
  const single = (COVALENT[elementA] ?? 0.77) + (COVALENT[elementB] ?? 0.77)
  const ratio = distance / single
  if (ratio <= 0.82) return 3
  if (ratio <= 0.9) return 2
  return 1
}
