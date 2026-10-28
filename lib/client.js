/**
 * dsh-chemflow 的客户端面板：应用内 3D 结构查看器。
 *
 * 形态与内置的文档预览一致 —— 注册一个**资源 tab 类型**，点开 `.cub`（或视图包里的
 * meta.json）就在右栏打开，像点开 `.md` 一样。
 *
 * 数据走 DSH 已经鉴权的 `/api/file?path=…` 通道（路径不带前导斜杠，见下方 fileUrl 的注释）。
 * 渲染是自写的 WebGL2：客户端 bundle 由 __ModuleLoader__ 加载，没有 import map，
 * 引 three.js 只能内联几百 KB，不如自己写这 300 行。
 *
 * 与独立页 viewer/ 的关系：算法一致（surfaceNets 内联在本文件里），独立页用来调渲染，
 * 这里负责接入 DSH。改算法时两边都要动 —— 单元测试在 test/surface.test.mjs。
 */

/*
 * 整个 bundle 包进 IIFE。
 *
 * 实测宿主会把这个客户端入口**拼接进页面两次**（同一个 client.js 出现两遍）。
 * 顶层一旦有 `const`/`let`，第二次就是 `SyntaxError: Identifier ... has already
 * been declared` —— 直接让 web boot 失败、应用进崩溃页。
 * 包进函数作用域后，重复执行只是多跑一遍，注册那一步由 registerClientBundle 幂等兜住。
 */
(function () {
  'use strict';

/**
 * 注册 id **必须等于包名**。
 *
 * 宿主把客户端入口的 URL 拼成 `…/plugins/??<包名>/client.js&rev=…`，激活时按
 * `stripClientSuffix(id)` 去 factory 表里找 —— 所以 id 写成别的（比如 `-viewer` 后缀），
 * 脚本会正常执行、factory 也注册上了，但宿主永远找不到它，报
 * "web boot: 1 entry did not activate" 且**没有任何 console 错误**（实测踩过）。
 */
const CLIENT_BUNDLE_ID = 'dsh-chemflow';

/**
 * 注册客户端 bundle —— **必须幂等**。
 *
 * 实测：同一个包被两个 URL 各加载一次时，第二次 `load()` 会抛
 * `duplicate factory registration`，而这个异常会让整个 web boot 失败
 * （应用直接进崩溃页，报 "web boot: 1 entry did not activate"）。
 * 第一次注册的 factory 已经够用，第二次忽略即可 —— 不要让它把宿主带崩。
 */
function registerClientBundle(factory) {
  const loader = globalThis.window && globalThis.window.__ModuleLoader__;
  if (!loader || typeof loader.load !== 'function') {
    throw new Error('client-modules: __ModuleLoader__ 不存在');
  }
  try {
    loader.load({ id: CLIENT_BUNDLE_ID, factory });
  } catch (error) {
    const message = String((error && error.message) || error);
    if (!/duplicate factory registration/.test(message)) throw error;
    globalThis.__DSH_CHEMFLOW_VIEWER_DUP__ = true;
    console.warn('[chemflow-viewer] 重复注册已忽略：', message);
  }
}

registerClientBundle((require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const react = require('react');
    const h = react.createElement;

    /** tab 类型 id；body 也注册在这个 key 下（两者必须一致）。 */
    const VIEWER_ID = 'dsh-chemflow-viewer';
    const VIEWER_KIND = 'chem-structure';
    const STYLE_ID = '@dsh-chemflow/viewer.css';

    /** 「结构视图」页签：不依赖资源路由，入口是一个头部按钮（照抄动画库面板的做法）。 */
    const INDEX_ID = 'dsh-chemflow-index';
    const INDEX_KIND = 'chem-structure-index';

    /** 「最近的视图包」列表文件；装配时由 install-profile.mjs 把占位符替换成绝对路径。 */
    const INDEX_PATH = '__DSH_CHEMFLOW_INDEX__';

    /* ------------------------------------------------------------ 样式 */

    const CSS = `
.chem-view { position: relative; display: block; width: 100%; height: 100%; min-height: 320px; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); overflow: hidden; }
/* 绝对铺满，不依赖父级 flex 高度：实测 tab 挂载时容器高度可能是 0 或很小，
   flex:1 会让 canvas 永远停在一条。 */
.chem-view__canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; cursor: grab; }
.chem-view__canvas.is-dragging { cursor: grabbing; }
.chem-view__panel { position: absolute; top: 10px; left: 10px; width: 230px; max-height: calc(100% - 20px); overflow: auto; display: flex; flex-direction: column; gap: 8px; padding: 10px 12px; border-radius: 10px; background: var(--dsw-alias-bg-base, #ffffff); background: color-mix(in srgb, var(--dsw-alias-bg-base) 88%, transparent); border: 1px solid var(--dsw-alias-border-l2); backdrop-filter: blur(6px); font-size: 12px; }
.chem-view__title { font-size: 13px; font-weight: 600; }
.chem-view__meta { color: var(--dsw-alias-label-tertiary); font-size: 11px; }
.chem-view__group { display: flex; flex-direction: column; gap: 6px; border-top: 1px solid var(--dsw-alias-border-l2); padding-top: 8px; }
.chem-view__group:first-of-type { border-top: none; padding-top: 0; }
.chem-view__row { display: flex; align-items: center; justify-content: space-between; gap: 6px; }
.chem-view__value { font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-secondary); }
.chem-view__btn { padding: 3px 8px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 6px; background: transparent; color: inherit; cursor: pointer; font: inherit; }
.chem-view__btn:hover { background: var(--dsw-alias-interactive-bg-hover); }
.chem-view__btn.is-active { background: var(--dsw-alias-label-primary); color: var(--dsw-alias-bg-base); border-color: transparent; }
.chem-view__hint { color: var(--dsw-alias-label-tertiary); font-size: 10px; line-height: 1.5; }
.chem-view__seg { display: inline-flex; align-items: center; gap: 4px; }
.chem-view__panel select { padding: 2px 4px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 6px; background: var(--dsw-alias-bg-base); color: inherit; font: inherit; font-size: 11px; }
.chem-view__chips { display: flex; flex-wrap: wrap; gap: 6px; }
.chem-view__chip { display: inline-flex; align-items: center; gap: 3px; font-size: 11px; color: var(--dsw-alias-label-secondary); }
.chem-view__chip input { width: 22px; height: 18px; padding: 0; border: 1px solid var(--dsw-alias-border-l2); border-radius: 4px; background: transparent; }
.chem-view__panel details { border-top: 1px solid var(--dsw-alias-border-l2); padding-top: 6px; }
.chem-view__panel details > summary { cursor: pointer; font-size: 12px; font-weight: 600; list-style: none; display: flex; justify-content: space-between; }
.chem-view__panel details > summary::after { content: '▾'; opacity: 0.6; font-weight: 400; }
.chem-view__panel details[open] > summary::after { content: '▴'; }
.chem-view__panel details > *:not(summary) { margin-top: 6px; }
.chem-view__bar { display: flex; flex-direction: column; gap: 4px; }
.chem-view__scale { position: absolute; right: 12px; bottom: 12px; display: flex; align-items: center; gap: 6px; padding: 2px 8px; border-radius: 6px; font-size: 11px; color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-base, #ffffff); background: color-mix(in srgb, var(--dsw-alias-bg-base) 70%, transparent); pointer-events: none; }
.chem-view__scale b { display: block; height: 3px; border-radius: 2px; background: currentColor; }
.chem-view__scale.is-hidden { display: none; }
.chem-view__legend { position: absolute; right: 12px; bottom: 44px; display: flex; flex-direction: column; gap: 3px; padding: 6px 8px; border-radius: 8px; background: var(--dsw-alias-bg-base, #ffffff); background: color-mix(in srgb, var(--dsw-alias-bg-base) 78%, transparent); font-size: 10px; color: var(--dsw-alias-label-secondary); pointer-events: none; }
.chem-view__legend[hidden] { display: none; }
.chem-view__legendBar { width: 150px; height: 8px; border-radius: 4px; border: 1px solid var(--dsw-alias-border-l2); background: linear-gradient(90deg, #2959d9, #dbdbdf, #d12e2e); }
.chem-view__legendLabels { display: flex; justify-content: space-between; width: 150px; font-variant-numeric: tabular-nums; }
.chem-view__empty { position: absolute; inset: 0; display: grid; place-items: center; padding: 24px; text-align: center; color: var(--dsw-alias-label-tertiary); font-size: 13px; line-height: 1.7; }
.chem-view__error { color: var(--dsw-alias-label-error, #b91c1c); white-space: pre-wrap; }
.chem-view__index { height: 100%; overflow: auto; padding: 14px 16px; display: flex; flex-direction: column; gap: 10px; }
.chem-view__indexHead { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.chem-view__item { display: flex; flex-direction: column; gap: 3px; padding: 9px 11px; text-align: left; border: 1px solid var(--dsw-alias-border-l2); border-radius: 9px; background: var(--dsw-alias-bg-base); color: inherit; cursor: pointer; font: inherit; }
.chem-view__item:hover { border-color: var(--dsw-alias-label-primary); }
.chem-view__itemTitle { font-size: 13px; font-weight: 600; }
.chem-view__itemMeta { font-size: 11px; color: var(--dsw-alias-label-tertiary); overflow-wrap: anywhere; }
.chem-view__back { position: absolute; top: 10px; right: 10px; z-index: 2; padding: 3px 9px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-base, #ffffff); background: color-mix(in srgb, var(--dsw-alias-bg-base) 88%, transparent); color: inherit; cursor: pointer; font: inherit; }
.chem-view__stage { position: absolute; inset: 0; }
.chem-view__headerBtn { display: inline-flex; align-items: center; gap: 5px; padding: 3px 9px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 7px; background: transparent; color: var(--dsw-alias-label-secondary); cursor: pointer; font: inherit; }
.chem-view__headerBtn:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
`;

    function ensureStyle() {
      const doc = globalThis.document;
      if (!doc) return;
      if (doc.querySelector(`style[data-plugin-css="${STYLE_ID}"]`)) return;
      const tag = doc.createElement('style');
      tag.dataset.plugin = 'dsh-chemflow-viewer';
      tag.dataset.pluginCss = STYLE_ID;
      tag.textContent = CSS;
      doc.head.appendChild(tag);
    }

    /* ------------------------------------------------------------ 地址与文件 */

    /**
     * 把任意形状的 meta.json 收敛成面板能安全使用的结构。
     *
     * 为什么要这一步：视图包格式是演进的（volumes 以前叫 hole/electron，dipole/colorBy
     * 是后加的）。直接读 `meta.volumes` 遇到老包或手写包会 undefined 抛错，面板就白屏。
     * 这里把缺失/类型不对的字段统一补成安全默认值，渲染层就不用到处 `?.`。
     */
    function normalizeMeta(raw) {
      const meta = raw && typeof raw === 'object' ? raw : {};
      const atoms = Array.isArray(meta.atoms)
        ? meta.atoms.filter((atom) => atom && Number.isFinite(atom.x) && Number.isFinite(atom.y) && Number.isFinite(atom.z))
        : [];
      const bonds = Array.isArray(meta.bonds)
        ? meta.bonds.filter((pair) => Array.isArray(pair) && pair.length === 2 && Number.isInteger(pair[0]) && Number.isInteger(pair[1]))
        : [];
      const volumes = Array.isArray(meta.volumes)
        ? meta.volumes
            .filter(
              (volume) =>
                volume &&
                typeof volume.file === 'string' &&
                Array.isArray(volume.dims) &&
                volume.dims.length === 3 &&
                Array.isArray(volume.origin) &&
                Array.isArray(volume.spacing),
            )
            // 数值字段给安全默认值：滑块 min/max 用 NaN 会直接失效。
            .map((volume) => ({
              ...volume,
              label: volume.label ?? volume.name ?? '体数据',
              min: Number.isFinite(volume.min) ? volume.min : 0,
              max: Number.isFinite(volume.max) && volume.max > 0 ? volume.max : 1,
              iso: Number.isFinite(volume.iso) ? volume.iso : 0.02,
            }))
        : [];
      const dipole =
        meta.dipole &&
        Array.isArray(meta.dipole.vector) &&
        meta.dipole.vector.length === 3 &&
        meta.dipole.vector.every(Number.isFinite) &&
        Array.isArray(meta.dipole.origin) &&
        meta.dipole.origin.length === 3 &&
        meta.dipole.origin.every(Number.isFinite)
          ? meta.dipole
          : undefined;

      return {
        ...meta,
        atoms,
        bonds,
        volumes,
        dipole,
        metrics: meta.metrics && typeof meta.metrics === 'object' ? meta.metrics : {},
      };
    }

    /**
     * 把 `dsh-resource://file/absolute/...` 还原成绝对路径。
     * 其它形状（没有前缀）就当作已经是路径。
     */
    function decodeAddress(address) {
      const raw = String(address ?? '');
      const marker = 'dsh-resource://file/absolute/';
      if (!raw.startsWith(marker)) return raw.replace(/^file:\/\//, '');
      return decodeURIComponent(raw.slice(marker.length));
    }

    /**
     * 走 DSH 的鉴权文件通道。
     *
     * 路径**不能带前导斜杠**：`/api/file` 用 `node:path.resolve(cwd, path)` 解析，
     * Windows 上 `resolve(cwd, "/D:/x")` 会变成 `C:\D:\x`，直接 404。
     */
    function fileUrl(absolutePath) {
      const slashed = String(absolutePath).replace(/\\/g, '/').replace(/^\/+/, '');
      return `/api/file?path=${encodeURIComponent(slashed)}`;
    }

    function joinPath(dir, name) {
      return `${String(dir).replace(/[\\/]+$/, '')}/${name}`;
    }

    function dirname(p) {
      const s = String(p).replace(/\\/g, '/');
      const i = s.lastIndexOf('/');
      return i < 0 ? '' : s.slice(0, i);
    }

    function basename(p) {
      const s = String(p).replace(/\\/g, '/');
      return s.slice(s.lastIndexOf('/') + 1);
    }

    async function fetchJson(path) {
      const r = await fetch(fileUrl(path));
      if (!r.ok) throw new Error(`读不到 ${path}（HTTP ${r.status}）`);
      return r.json();
    }

    /**
     * 从被点开的地址推断视图包里的 meta.json。
     *
     * 支持两种点击：
     *   1. 直接点 `<name>.view/meta.json`；
     *   2. 点某个 `.cub` —— 找同目录的 `<stem>.view/meta.json`（chem_view 的默认落法）。
     */
    function resolveMetaPath(path) {
      const normalized = String(path).replace(/\\/g, '/');
      if (/\.view\/meta\.json$/i.test(normalized)) return normalized;
      if (/\.cub$/i.test(normalized)) {
        const stem = basename(normalized).replace(/\.cub$/i, '');
        return joinPath(dirname(normalized), `${stem}.view/meta.json`);
      }
      return normalized;
    }

    /* ------------------------------------------------------------ 数学 */

    const mat4 = {
      perspective(out, fovy, aspect, near, far) {
        const f = 1 / Math.tan(fovy / 2);
        out.fill(0);
        out[0] = f / aspect; out[5] = f; out[11] = -1;
        out[10] = (far + near) / (near - far);
        out[14] = (2 * far * near) / (near - far);
        return out;
      },
      ortho(out, left, right, bottom, top, near, far) {
        out.fill(0);
        out[0] = 2 / (right - left); out[5] = 2 / (top - bottom); out[10] = -2 / (far - near);
        out[12] = -(right + left) / (right - left); out[13] = -(top + bottom) / (top - bottom);
        out[14] = -(far + near) / (far - near); out[15] = 1;
        return out;
      },
      lookAt(out, eye, center, up) {
        let z0 = eye[0] - center[0], z1 = eye[1] - center[1], z2 = eye[2] - center[2];
        let len = Math.hypot(z0, z1, z2) || 1;
        z0 /= len; z1 /= len; z2 /= len;
        let x0 = up[1] * z2 - up[2] * z1, x1 = up[2] * z0 - up[0] * z2, x2 = up[0] * z1 - up[1] * z0;
        len = Math.hypot(x0, x1, x2) || 1;
        x0 /= len; x1 /= len; x2 /= len;
        const y0 = z1 * x2 - z2 * x1, y1 = z2 * x0 - z0 * x2, y2 = z0 * x1 - z1 * x0;
        out.fill(0);
        out[0] = x0; out[1] = y0; out[2] = z0;
        out[4] = x1; out[5] = y1; out[6] = z1;
        out[8] = x2; out[9] = y2; out[10] = z2;
        out[12] = -(x0 * eye[0] + x1 * eye[1] + x2 * eye[2]);
        out[13] = -(y0 * eye[0] + y1 * eye[1] + y2 * eye[2]);
        out[14] = -(z0 * eye[0] + z1 * eye[1] + z2 * eye[2]);
        out[15] = 1;
        return out;
      },
      multiply(out, a, b) {
        const t = new Float32Array(16);
        for (let i = 0; i < 4; i += 1) {
          for (let j = 0; j < 4; j += 1) {
            t[i * 4 + j] = a[j] * b[i * 4] + a[4 + j] * b[i * 4 + 1] + a[8 + j] * b[i * 4 + 2] + a[12 + j] * b[i * 4 + 3];
          }
        }
        out.set(t);
        return out;
      },
    };

    const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    function normalize(v) {
      const l = Math.hypot(v[0], v[1], v[2]) || 1;
      return [v[0] / l, v[1] / l, v[2] / l];
    }
    const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

    /* ------------------------------------------------------------ Surface Nets */

    /** 8 个角点的 12 条边（角点编号 = dx + 2*dy + 4*dz）。 */
    const EDGES = [
      [0, 1], [2, 3], [4, 5], [6, 7],
      [0, 2], [1, 3], [4, 6], [5, 7],
      [0, 4], [1, 5], [2, 6], [3, 7],
    ];

    function pushQuad(indices, q, flip) {
      for (const v of q) if (!Number.isInteger(v) || v < 0) return;
      if (flip) indices.push(q[0], q[2], q[1], q[0], q[3], q[2]);
      else indices.push(q[0], q[1], q[2], q[0], q[2], q[3]);
    }

    function surfaceNets(field, dims, iso, origin = [0, 0, 0], spacing = [1, 1, 1]) {
      const [nx, ny, nz] = dims;
      const sy = nx;
      const sz = nx * ny;
      const cx = nx - 1;
      const cy = ny - 1;
      const cz = nz - 1;
      const cellVertex = new Int32Array(cx * cy * cz).fill(-1);
      const positions = [];
      const cellIndex = (x, y, z) => x + y * cx + z * cx * cy;
      const corner = new Float32Array(8);

      for (let z = 0; z < cz; z += 1) {
        for (let y = 0; y < cy; y += 1) {
          for (let x = 0; x < cx; x += 1) {
            let mask = 0;
            let k = 0;
            for (let dz = 0; dz < 2; dz += 1) {
              for (let dy = 0; dy < 2; dy += 1) {
                for (let dx = 0; dx < 2; dx += 1) {
                  const v = field[x + dx + (y + dy) * sy + (z + dz) * sz];
                  corner[k] = v;
                  if (v > iso) mask |= 1 << k;
                  k += 1;
                }
              }
            }
            if (mask === 0 || mask === 255) continue;

            let sumX = 0, sumY = 0, sumZ = 0, count = 0;
            for (let e = 0; e < 12; e += 1) {
              const a = EDGES[e][0];
              const b = EDGES[e][1];
              const va = corner[a];
              const vb = corner[b];
              if ((va > iso) === (vb > iso)) continue;
              const t = (iso - va) / (vb - va);
              const ax = a & 1, ay = (a >> 1) & 1, az = (a >> 2) & 1;
              const bx = b & 1, by = (b >> 1) & 1, bz = (b >> 2) & 1;
              sumX += ax + (bx - ax) * t;
              sumY += ay + (by - ay) * t;
              sumZ += az + (bz - az) * t;
              count += 1;
            }
            if (count === 0) continue;
            cellVertex[cellIndex(x, y, z)] = positions.length / 3;
            positions.push(x + sumX / count, y + sumY / count, z + sumZ / count);
          }
        }
      }

      const indices = [];
      const sample = (x, y, z) => field[x + y * sy + z * sz];

      // 边界各收一格：否则 cellIndex 越界拿到 undefined，会生成退化三角形。
      for (let z = 0; z < nz; z += 1) {
        for (let y = 0; y < ny; y += 1) {
          for (let x = 0; x < nx; x += 1) {
            const v0 = sample(x, y, z);
            if (x < nx - 1 && y >= 1 && y < ny - 1 && z >= 1 && z < nz - 1) {
              const v1 = sample(x + 1, y, z);
              if ((v0 > iso) !== (v1 > iso)) {
                pushQuad(indices, [
                  cellVertex[cellIndex(x, y - 1, z - 1)],
                  cellVertex[cellIndex(x, y, z - 1)],
                  cellVertex[cellIndex(x, y, z)],
                  cellVertex[cellIndex(x, y - 1, z)],
                ], v0 <= iso);
              }
            }
            if (y < ny - 1 && x >= 1 && x < nx - 1 && z >= 1 && z < nz - 1) {
              const v1 = sample(x, y + 1, z);
              if ((v0 > iso) !== (v1 > iso)) {
                pushQuad(indices, [
                  cellVertex[cellIndex(x - 1, y, z - 1)],
                  cellVertex[cellIndex(x - 1, y, z)],
                  cellVertex[cellIndex(x, y, z)],
                  cellVertex[cellIndex(x, y, z - 1)],
                ], v0 <= iso);
              }
            }
            if (z < nz - 1 && x >= 1 && x < nx - 1 && y >= 1 && y < ny - 1) {
              const v1 = sample(x, y, z + 1);
              if ((v0 > iso) !== (v1 > iso)) {
                pushQuad(indices, [
                  cellVertex[cellIndex(x - 1, y - 1, z)],
                  cellVertex[cellIndex(x, y - 1, z)],
                  cellVertex[cellIndex(x, y, z)],
                  cellVertex[cellIndex(x - 1, y, z)],
                ], v0 <= iso);
              }
            }
          }
        }
      }

      const pos = new Float32Array(positions);
      const normals = new Float32Array(pos.length);
      const [dx, dy, dz] = spacing;
      const [ox, oy, oz] = origin;
      for (let i = 0; i < pos.length; i += 3) {
        const gx = pos[i], gy = pos[i + 1], gz = pos[i + 2];
        pos[i] = ox + gx * dx;
        pos[i + 1] = oy + gy * dy;
        pos[i + 2] = oz + gz * dz;
        const x = Math.max(0, Math.min(nx - 2, Math.round(gx)));
        const y = Math.max(0, Math.min(ny - 2, Math.round(gy)));
        const z = Math.max(0, Math.min(nz - 2, Math.round(gz)));
        const gradX = (sample(x + 1, y, z) - sample(x, y, z)) / dx;
        const gradY = (sample(x, y + 1, z) - sample(x, y, z)) / dy;
        const gradZ = (sample(x, y, z + 1) - sample(x, y, z)) / dz;
        const len = Math.hypot(gradX, gradY, gradZ) || 1;
        normals[i] = -gradX / len;
        normals[i + 1] = -gradY / len;
        normals[i + 2] = -gradZ / len;
      }
      return { positions: pos, normals, indices: new Uint32Array(indices), triangles: indices.length / 3 };
    }

    /* ------------------------------------------------------------ 元素表 */

    const ELEMENT_COLORS = {
      H: [0.93, 0.93, 0.93], C: [0.28, 0.28, 0.30], N: [0.25, 0.35, 0.85],
      O: [0.85, 0.25, 0.25], F: [0.35, 0.75, 0.45], S: [0.85, 0.75, 0.25],
      P: [0.95, 0.55, 0.2], Cl: [0.35, 0.75, 0.35], Br: [0.6, 0.35, 0.2], I: [0.5, 0.3, 0.7],
    };
    const ELEMENT_RADIUS = { H: 0.3, C: 0.36, N: 0.36, O: 0.35, F: 0.33, S: 0.42, P: 0.42, Cl: 0.4, Br: 0.44, I: 0.48 };

    function dequantize(int16, min, max) {
      const span = max - min;
      const out = new Float32Array(int16.length);
      if (span === 0) return out;
      const scale = span / 65535;
      for (let i = 0; i < int16.length; i += 1) out[i] = (int16[i] + 32768) * scale + min;
      return out;
    }

    /**
     * 在某一路体数据上做三线性采样（世界坐标 Å 进，标量出）。
     * ESP 着色表面就是拿它把 ESP 值采到密度等值面的每个顶点上。
     */
    function sampleVolume(volume, x, y, z) {
      const { dims, origin, spacing } = volume.spec;
      const [nx, ny, nz] = dims;
      // 越界不要补 0：着色源（ESP）的网格常常比表面网格小，
      // 补 0 会把大半表面染成「中性白」。钳到边界格点更接近真实。
      const gx = Math.min(nx - 1, Math.max(0, (x - origin[0]) / spacing[0]));
      const gy = Math.min(ny - 1, Math.max(0, (y - origin[1]) / spacing[1]));
      const gz = Math.min(nz - 1, Math.max(0, (z - origin[2]) / spacing[2]));

      const x0 = Math.floor(gx);
      const y0 = Math.floor(gy);
      const z0 = Math.floor(gz);
      const x1 = Math.min(nx - 1, x0 + 1);
      const y1 = Math.min(ny - 1, y0 + 1);
      const z1 = Math.min(nz - 1, z0 + 1);
      const fx = gx - x0;
      const fy = gy - y0;
      const fz = gz - z0;
      const field = volume.field;
      const at = (i, j, k) => field[i + j * nx + k * nx * ny];

      const c00 = at(x0, y0, z0) * (1 - fx) + at(x1, y0, z0) * fx;
      const c10 = at(x0, y1, z0) * (1 - fx) + at(x1, y1, z0) * fx;
      const c01 = at(x0, y0, z1) * (1 - fx) + at(x1, y0, z1) * fx;
      const c11 = at(x0, y1, z1) * (1 - fx) + at(x1, y1, z1) * fx;
      const c0 = c00 * (1 - fy) + c10 * fy;
      const c1 = c01 * (1 - fy) + c11 * fy;
      return c0 * (1 - fz) + c1 * fz;
    }

    /** 蓝 → 浅灰 → 红 的发散色标（0.5 对应零点）。中点用浅灰而不是纯白：
     *  纯白在白底上会把「中性区」整块隐形，看起来像表面破了个洞。 */
    function divergingColor(t) {
      const x = Math.min(1, Math.max(0, t));
      const blue = [0.16, 0.35, 0.85];
      const white = [0.86, 0.86, 0.88];
      const red = [0.82, 0.18, 0.18];
      const mix = (a, b, f) => [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
      return x < 0.5 ? mix(blue, white, x * 2) : mix(white, red, (x - 0.5) * 2);
    }

    /* ------------------------------------------------------------ GL 工具 */

    const MESH_VS = `
attribute vec3 aPos; attribute vec3 aNormal; attribute vec3 aColor;
uniform mat4 uMVP; uniform mat4 uModelView;
varying vec3 vNormal; varying vec3 vView; varying vec3 vColor;
void main() {
  vec4 mv = uModelView * vec4(aPos, 1.0);
  vView = mv.xyz;
  vNormal = mat3(uModelView) * aNormal;
  vColor = aColor;
  gl_Position = uMVP * vec4(aPos, 1.0);
}`;

    const MESH_FS = `
precision mediump float;
uniform vec3 uColor; uniform float uAlpha;
uniform float uVertexColor;
uniform vec3 uLightDir;
uniform float uAmbient; uniform float uDiffuseK; uniform float uSpecular; uniform float uShininess;
uniform vec3 uFogColor; uniform float uFogNear; uniform float uFogFar; uniform float uFogOn;
uniform float uFlat;
varying vec3 vNormal; varying vec3 vView; varying vec3 vColor;
void main() {
  vec3 n = normalize(vNormal);
  vec3 v = normalize(-vView);
  vec3 l = normalize(uLightDir);
  float diff = max(dot(n, l), 0.0);
  float back = max(dot(-n, l), 0.0);
  float rim = pow(1.0 - abs(dot(n, v)), 2.2);
  // 骨架走逐顶点颜色（元素色 / 单色），等值面走统一颜色。
  vec3 base = uVertexColor > 0.5 ? vColor : uColor;
  vec3 h = normalize(l + v);
  float spec = pow(max(dot(n, h), 0.0), max(uShininess, 1.0)) * uSpecular * (1.0 - uFlat);
  // uFlat=1：ESP 这类「按值着色」的表面平涂，保住色标本来的饱和度，
  // 否则会被环境光/高光冲成一片白（白底上直接看不见）。
  vec3 shade = uFlat > 0.5 ? vec3(0.94 + 0.06 * diff) : vec3(uAmbient + uDiffuseK * max(diff, back * 0.35));
  vec3 c = base * shade + vec3(spec) + vec3(rim * 0.12 * (1.0 - uFlat));
  if (uFogOn > 0.5) {
    float fog = clamp((-vView.z - uFogNear) / max(0.001, uFogFar - uFogNear), 0.0, 1.0);
    c = mix(c, uFogColor, fog);
  }
  gl_FragColor = vec4(c, uAlpha);
}`;

    /* 背景：全屏三角形 + 上下渐变（纯色就是把两端设成同色）。 */
    const BG_VS = `
attribute vec2 aPos;
varying vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

    const BG_FS = `
precision mediump float;
uniform vec3 uTop; uniform vec3 uBottom; uniform float uAlpha;
varying vec2 vUv;
void main() { gl_FragColor = vec4(mix(uBottom, uTop, vUv.y), uAlpha); }`;

    /* 坐标轴：线段 + 顶点色。 */
    const LINE_VS = `
attribute vec3 aPos; attribute vec3 aColor;
uniform mat4 uMVP;
varying vec3 vColor;
void main() { vColor = aColor; gl_Position = uMVP * vec4(aPos, 1.0); }`;

    const LINE_FS = `
precision mediump float;
varying vec3 vColor;
void main() { gl_FragColor = vec4(vColor, 1.0); }`;

    const POINT_VS = `
attribute vec3 aPos; attribute float aRadius; attribute vec3 aColor;
uniform mat4 uMVP; uniform mat4 uModelView;
uniform float uProjScale; uniform float uOrthoPix; uniform float uOrtho;
varying vec3 vColor; varying float vDepth;
void main() {
  vec4 mv = uModelView * vec4(aPos, 1.0);
  vColor = aColor;
  vDepth = -mv.z;
  float size = uOrtho > 0.5 ? aRadius * uOrthoPix : aRadius * uProjScale / max(0.001, -mv.z);
  gl_PointSize = clamp(size, 1.0, 320.0);
  gl_Position = uMVP * vec4(aPos, 1.0);
}`;

    const POINT_FS = `
precision mediump float;
varying vec3 vColor; varying float vDepth;
uniform vec3 uLight;
uniform float uAmbient; uniform float uDiffuseK; uniform float uSpecular; uniform float uShininess;
uniform vec3 uFogColor; uniform float uFogNear; uniform float uFogFar; uniform float uFogOn;
void main() {
  vec2 d = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(d, d);
  if (r2 > 1.0) discard;
  vec3 n = vec3(d.x, -d.y, sqrt(max(0.0, 1.0 - r2)));
  vec3 l = normalize(uLight);
  float diff = max(dot(n, l), 0.0);
  float spec = pow(max(dot(n, normalize(l + vec3(0.0, 0.0, 1.0))), 0.0), max(uShininess, 1.0)) * uSpecular;
  vec3 c = vColor * (uAmbient + uDiffuseK * diff) + vec3(spec);
  if (uFogOn > 0.5) {
    float fog = clamp((vDepth - uFogNear) / max(0.001, uFogFar - uFogNear), 0.0, 1.0);
    c = mix(c, uFogColor, fog);
  }
  gl_FragColor = vec4(c, 1.0);
}`;

    function compile(gl, type, source) {
      const shader = gl.createShader(type);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
      return shader;
    }

    function program(gl, vsSource, fsSource, attribs) {
      const p = gl.createProgram();
      gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vsSource));
      gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fsSource));
      attribs.forEach((name, index) => gl.bindAttribLocation(p, index, name));
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
      const u = {};
      const count = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
      for (let i = 0; i < count; i += 1) {
        const info = gl.getActiveUniform(p, i);
        u[info.name] = gl.getUniformLocation(p, info.name);
      }
      return { program: p, u };
    }

    function createMesh(gl, mesh) {
      const vao = gl.createVertexArray();
      gl.bindVertexArray(vao);
      const pos = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, pos);
      gl.bufferData(gl.ARRAY_BUFFER, mesh.positions, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
      const nrm = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, nrm);
      gl.bufferData(gl.ARRAY_BUFFER, mesh.normals, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);
      if (mesh.colors) {
        const col = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, col);
        gl.bufferData(gl.ARRAY_BUFFER, mesh.colors, gl.STATIC_DRAW);
        gl.enableVertexAttribArray(2);
        gl.vertexAttribPointer(2, 3, gl.FLOAT, false, 0, 0);
      }
      const idx = gl.createBuffer();
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idx);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW);
      gl.bindVertexArray(null);
      return { vao, count: mesh.indices.length };
    }

    function createPoints(gl, data) {
      const vao = gl.createVertexArray();
      gl.bindVertexArray(vao);
      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      const stride = 8 * 4;
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 3, gl.FLOAT, false, stride, 0);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 1, gl.FLOAT, false, stride, 12);
      gl.enableVertexAttribArray(2);
      gl.vertexAttribPointer(2, 3, gl.FLOAT, false, stride, 16);
      gl.bindVertexArray(null);
      return { vao, count: data.length / 8 };
    }

    function toHex(rgb) {
      const f = (v) => Math.round(clamp(v, 0, 1) * 255).toString(16).padStart(2, '0');
      return `#${f(rgb[0])}${f(rgb[1])}${f(rgb[2])}`;
    }
    function fromHex(hex) {
      const v = parseInt(hex.replace('#', ''), 16);
      return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
    }

    function escapeHtml(value) {
      return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    function relativeTime(iso) {
      const t = Date.parse(iso ?? '');
      if (!Number.isFinite(t)) return '';
      const minutes = Math.floor((Date.now() - t) / 60000);
      if (minutes < 1) return '刚刚';
      if (minutes < 60) return `${minutes} 分钟前`;
      const hours = Math.floor(minutes / 60);
      if (hours < 24) return `${hours} 小时前`;
      return `${Math.floor(hours / 24)} 天前`;
    }

    /* ------------------------------------------------------------ 面板主体 */

    /**
     * 在容器里挂一个查看器；返回卸载函数。
     *
     * **自己建 DOM**：两条入口（资源 tab、列表页）给的容器都可能是空的 ——
     * 之前假设外层已经把 canvas/面板渲染好，从列表点进去时 querySelector 全是 null，
     * 第一个 `status.hidden = true` 就抛 TypeError，面板一片空白。
     *
     * @param {HTMLElement} container
     * @param {string} address 资源地址，或直接的 meta.json 路径
     */
    async function mountViewer(container, address) {
      const path = decodeAddress(address);
      const metaPath = resolveMetaPath(path);

      container.innerHTML = '';
      const canvas = document.createElement('canvas');
      canvas.className = 'chem-view__canvas';
      const status = document.createElement('div');
      status.className = 'chem-view__empty';
      status.textContent = '正在读取视图包…';
      const panel = document.createElement('div');
      panel.className = 'chem-view__panel';
      panel.hidden = true;
      panel.innerHTML = `
        <div class="chem-view__title" data-role="title">结构视图</div>
        <div class="chem-view__meta" data-role="meta"></div>
        <div class="chem-view__group">
          <div class="chem-view__row"><span class="chem-view__meta">风格</span>
            <select data-role="preset">
              <option value="paper-light">论文·浅底</option>
              <option value="paper-dark">论文·深底</option>
              <option value="vmd">VMD 默认</option>
              <option value="talk">演示·高对比</option>
              <option value="neon">暗场·发光</option>
              <option value="custom">自定义</option>
            </select></div>
        </div>
        <div class="chem-view__group" data-role="volumes"></div>
        <div class="chem-view__group">
          <div class="chem-view__row"><label><input type="checkbox" data-role="skeleton" checked /> 骨架</label>
            <label><input type="checkbox" data-role="showH" checked /> 氢</label></div>
          <div class="chem-view__row"><span class="chem-view__meta">样式</span>
            <select data-role="skelStyle">
              <option value="ballstick">球棍</option>
              <option value="licorice">棍状</option>
              <option value="lines">线</option>
              <option value="vdw">球体</option>
              <option value="points">点</option>
            </select></div>
          <div class="chem-view__row"><span class="chem-view__meta">配色</span>
            <select data-role="skelColorMode">
              <option value="element">元素</option>
              <option value="uniform">单色</option>
              <option value="index">按序号</option>
              <option value="mass">按质量</option>
              <option value="x">按 X 坐标</option>
              <option value="y">按 Y 坐标</option>
              <option value="z">按 Z 坐标</option>
              <option value="custom">自定义</option>
            </select></div>
          <div class="chem-view__row"><span class="chem-view__meta">单色</span>
            <input type="color" data-role="skelColor" value="#8c9199" /></div>
          <div class="chem-view__row"><span class="chem-view__meta">粗细</span>
            <input type="range" data-role="skelScale" min="0.3" max="2.5" step="0.05" value="1" /></div>
          <div class="chem-view__row">
            <button class="chem-view__btn is-active" data-proj="persp">透视</button>
            <button class="chem-view__btn" data-proj="ortho">正交</button>
          </div>
        </div>
        <details class="chem-view__group" data-role="lookBox">
          <summary>外观</summary>
          <div class="chem-view__row"><span class="chem-view__meta">背景</span>
            <select data-role="bg">
              <option value="white">白</option>
              <option value="light">浅灰</option>
              <option value="dark">深灰</option>
              <option value="black">黑</option>
              <option value="gradient">深蓝渐变</option>
              <option value="transparent">透明</option>
            </select></div>
          <div class="chem-view__row"><label><input type="checkbox" data-role="axes" /> 坐标轴</label>
            <label><input type="checkbox" data-role="scalebar" checked /> 比例尺</label></div>
          <div class="chem-view__row" data-role="dipoleRow" hidden>
            <label><input type="checkbox" data-role="dipole" checked /> 偶极矩 <span class="chem-view__value" data-role="dipoleVal"></span></label>
            <input type="color" data-role="dipoleColor" value="#e042b8" />
          </div>
          <div class="chem-view__bar" data-role="dipoleBar" hidden>
            <span class="chem-view__meta">箭头长度 <span class="chem-view__value" data-role="dipoleScaleVal">1.0×</span></span>
            <input type="range" data-role="dipoleScale" min="0.3" max="3" step="0.05" value="1" />
          </div>
          <div class="chem-view__bar"><span class="chem-view__meta">深度雾化</span>
            <input type="range" data-role="fog" min="0" max="1" step="0.05" value="0" /></div>
          <div class="chem-view__bar"><span class="chem-view__meta">环境光</span>
            <input type="range" data-role="ambient" min="0.05" max="0.9" step="0.05" value="0.35" /></div>
          <div class="chem-view__bar"><span class="chem-view__meta">漫反射</span>
            <input type="range" data-role="diffuse" min="0.2" max="1.2" step="0.05" value="0.65" /></div>
          <div class="chem-view__bar"><span class="chem-view__meta">高光</span>
            <input type="range" data-role="specular" min="0" max="0.8" step="0.02" value="0.06" /></div>
        </details>
        <div class="chem-view__group" data-role="elementBox">
          <div class="chem-view__meta">元素配色（点色块改）</div>
          <div class="chem-view__chips" data-role="elementChips"></div>
        </div>
        <div class="chem-view__group">
          <div class="chem-view__meta">逐原子上色：选颜色后 <b>Alt + 点击原子</b></div>
          <div class="chem-view__row">
            <input type="color" data-role="brush" value="#f2a33c" />
            <button class="chem-view__btn" data-role="clearAtom">清除单原子</button>
          </div>
        </div>
        <div class="chem-view__group">
          <div class="chem-view__row">
            <button class="chem-view__btn" data-role="reset">重置视角</button>
            <button class="chem-view__btn" data-role="spin">自旋</button>
          </div>
          <div class="chem-view__row"><span class="chem-view__meta">导出</span>
            <select data-role="exportScale">
              <option value="1">1×</option>
              <option value="2" selected>2×</option>
              <option value="4">4×</option>
            </select>
            <button class="chem-view__btn" data-role="shot">PNG</button>
          </div>
        </div>
        <div class="chem-view__hint">左键旋转 · 右键平移 · 滚轮缩放 · r 重置 · 空格自旋 · Alt+点击给原子上色</div>`;
      const scaleEl = document.createElement('div');
      scaleEl.className = 'chem-view__scale';
      scaleEl.innerHTML = '<b></b><span></span>';
      // ESP 这类「按值着色」的表面需要色标；没有就不显示。
      const legendEl = document.createElement('div');
      legendEl.className = 'chem-view__legend';
      legendEl.hidden = true;
      legendEl.innerHTML =
        '<div class="chem-view__legendBar"></div>' +
        '<div class="chem-view__legendLabels"><span data-role="legendLo"></span><span data-role="legendHi"></span></div>';
      container.append(canvas, status, panel, scaleEl, legendEl);

      const showError = (message) => {
        status.hidden = false;
        status.innerHTML = `<div class="chem-view__error">${String(message).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))}</div>`;
      };

      let meta;
      try {
        meta = normalizeMeta(await fetchJson(metaPath));
      } catch (error) {
        showError(
          `这里还没有视图包。\n\n点的是：${path}\n找的是：${metaPath}\n\n先让 agent 跑 chem_view 生成视图包（会落在 cube 旁边的 <名字>.view/），再点里面的 meta.json。`,
        );
        return () => {};
      }

      if (meta.atoms.length === 0 && meta.volumes.length === 0) {
        showError(
          `这个视图包是空的（既没有原子也没有体数据）。\n\n${metaPath}\n\n重新跑一次 chem_view 生成它，或者在「结构视图」列表里把这条删掉。`,
        );
        return () => {};
      }

      // 用 remove 而不是 hidden：即使后续有第二次挂载，也不会留下一条“正在读取…”挡住画面。
      status.remove();
      panel.hidden = false;

      // alpha: true —— 导出「透明背景」时要保留 alpha 通道。
      const gl = canvas.getContext('webgl2', { antialias: true, alpha: true, preserveDrawingBuffer: true });
      if (!gl) {
        showError('这个环境不支持 WebGL2。');
        return () => {};
      }

      const meshProgram = program(gl, MESH_VS, MESH_FS, ['aPos', 'aNormal', 'aColor']);
      const pointProgram = program(gl, POINT_VS, POINT_FS, ['aPos', 'aRadius', 'aColor']);
      const bgProgram = program(gl, BG_VS, BG_FS, ['aPos']);
      const lineProgram = program(gl, LINE_VS, LINE_FS, ['aPos', 'aColor']);

      // 全屏三角形（背景）
      const bgVao = gl.createVertexArray();
      gl.bindVertexArray(bgVao);
      const bgBuf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, bgBuf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      gl.bindVertexArray(null);
      bgProgram.u.aPos = 0;

      const metaDir = dirname(metaPath);
      const volumes = [];
      for (const spec of meta.volumes) {
        const r = await fetch(fileUrl(joinPath(metaDir, spec.file)));
        if (!r.ok) {
          showError(`读不到体数据 ${spec.file}（HTTP ${r.status}）`);
          return () => {};
        }
        volumes.push({
          spec,
          field: dequantize(new Int16Array(await r.arrayBuffer()), spec.min, spec.max),
          // 只当数据源的那一路默认不显示（例如给 ESP 表面着色的 ESP 体数据）
          visible: spec.visible !== false,
          iso: spec.iso ?? 0.003,
          color: spec.color ?? [0.85, 0.25, 0.25],
          // 按值着色的表面（ESP）画成实心：半透明会让正反面叠加发白。
          alpha: Number.isInteger(spec.colorBy) ? 1 : 0.5,
        });
      }

      // 骨架：几何按「样式 / 配色 / 粗细 / 是否显示氢」重建（原子少，重建只要几毫秒）。
      const atoms = meta.atoms ?? [];
      const bonds = meta.bonds ?? [];
      const skel = {
        show: true,
        showH: true,
        style: 'ballstick',
        colorMode: 'element',
        color: [0.55, 0.57, 0.6],
        scale: 1,
        elementColors: { ...ELEMENT_COLORS },
        atomColors: new Map(),
        brush: [0.95, 0.64, 0.24],
      };

      // 观感参数：背景 / 雾化 / 材质。预设一键搞定，滑杆只做微调。
      const look = {
        bg: 'white',
        fog: 0,
        ambient: 0.42,
        diffuse: 0.62,
        specular: 0.05,
        shininess: 24,
        axes: false,
        scalebar: true,
        dipole: true,
        dipoleColor: [0.88, 0.26, 0.72],
        dipoleScale: 1,
        exportScale: 2,
      };

      const BG_COLORS = {
        white: [[1, 1, 1], [1, 1, 1]],
        light: [[0.95, 0.95, 0.96], [0.86, 0.86, 0.89]],
        dark: [[0.24, 0.25, 0.27], [0.13, 0.13, 0.15]],
        black: [[0, 0, 0], [0, 0, 0]],
        gradient: [[0.10, 0.14, 0.24], [0.01, 0.01, 0.02]],
        transparent: null,
      };

      /** 风格预设：背景 + 雾化 + 材质 + 骨架参数 + 元素配色，一次设定。 */
      const PRESETS = {
        'paper-light': {
          look: { bg: 'white', fog: 0, ambient: 0.42, diffuse: 0.62, specular: 0.05 },
          skel: { style: 'ballstick', scale: 1, colorMode: 'element', showH: true },
          palette: {
            H: [0.95, 0.95, 0.95], C: [0.30, 0.30, 0.32], N: [0.22, 0.34, 0.85],
            O: [0.86, 0.24, 0.24], F: [0.35, 0.75, 0.45], S: [0.88, 0.76, 0.24], P: [0.95, 0.55, 0.2],
          },
          surfaceAlpha: 0.45,
        },
        'paper-dark': {
          look: { bg: 'gradient', fog: 0.35, ambient: 0.28, diffuse: 0.72, specular: 0.14 },
          skel: { style: 'licorice', scale: 1.15, colorMode: 'element', showH: true },
          palette: {
            H: [0.96, 0.96, 0.96], C: [0.62, 0.64, 0.68], N: [0.35, 0.52, 0.98],
            O: [0.98, 0.42, 0.38], F: [0.45, 0.88, 0.55], S: [0.98, 0.85, 0.35], P: [0.99, 0.62, 0.25],
          },
          surfaceAlpha: 0.5,
        },
        vmd: {
          look: { bg: 'black', fog: 0.25, ambient: 0.22, diffuse: 0.78, specular: 0.35 },
          skel: { style: 'ballstick', scale: 1, colorMode: 'element', showH: true },
          palette: {
            H: [1, 1, 1], C: [0.5, 0.5, 0.5], N: [0.19, 0.31, 0.97],
            O: [1, 0.05, 0.05], F: [0.12, 0.94, 0.12], S: [1, 0.78, 0.19], P: [1, 0.5, 0],
          },
          surfaceAlpha: 0.6,
        },
        talk: {
          look: { bg: 'white', fog: 0, ambient: 0.5, diffuse: 0.55, specular: 0.02 },
          skel: { style: 'ballstick', scale: 1.35, colorMode: 'element', showH: false },
          palette: {
            H: [0.9, 0.9, 0.9], C: [0.15, 0.15, 0.17], N: [0.1, 0.25, 0.95],
            O: [0.95, 0.15, 0.12], F: [0.1, 0.8, 0.35], S: [1, 0.8, 0.1], P: [1, 0.45, 0],
          },
          surfaceAlpha: 0.35,
        },
        neon: {
          look: { bg: 'black', fog: 0.5, ambient: 0.14, diffuse: 0.9, specular: 0.5 },
          skel: { style: 'licorice', scale: 1.1, colorMode: 'element', showH: false },
          palette: {
            H: [0.75, 0.85, 1], C: [0.35, 0.42, 0.55], N: [0.25, 0.55, 1],
            O: [1, 0.35, 0.3], F: [0.3, 1, 0.6], S: [1, 0.9, 0.3], P: [1, 0.6, 0.2],
          },
          surfaceAlpha: 0.7,
        },
      };

      let bondGpu = null;
      let atomGpu = null;

      /* ---- 偶极矩箭头（pack 里带 meta.dipole 才有） ---- */

      const dipoleInfo = meta.dipole && Array.isArray(meta.dipole.vector) && Array.isArray(meta.dipole.origin)
        ? meta.dipole
        : null;
      let dipoleGpu = null;

      /**
       * 重建箭头几何。颜色和长度都能调，所以这里做成可重复调用的。
       * 长度按 `|vector| × look.dipoleScale`：pack 里的 vector 已经是 0.6 Å/D 的参考长度。
       */
      const rebuildDipole = () => {
        if (dipoleGpu) {
          gl.deleteVertexArray(dipoleGpu.vao);
          dipoleGpu = null;
        }
        if (!dipoleInfo) return;

        const { origin, vector } = dipoleInfo;
        const baseLength = Math.hypot(vector[0], vector[1], vector[2]);
        const length = baseLength * (look.dipoleScale ?? 1);
        if (!(length > 1e-6)) return;

        const dir = [vector[0] / baseLength, vector[1] / baseLength, vector[2] / baseLength];
        const tip = [origin[0] + dir[0] * length, origin[1] + dir[1] * length, origin[2] + dir[2] * length];
        const head = Math.min(length * 0.32, 0.7 * Math.max(0.6, look.dipoleScale ?? 1));
        const shaftEnd = [tip[0] - dir[0] * head, tip[1] - dir[1] * head, tip[2] - dir[2] * head];
        const color = look.dipoleColor ?? [0.88, 0.26, 0.72];
        const positions = [];
        const normals = [];
        const colors = [];
        const indices = [];

        /** 一段圆柱/圆锥（r1 = 0 就是锥尖）。 */
        const addCone = (a, b, r0, r1, seg = 14) => {
          const axis = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
          const len = Math.hypot(axis[0], axis[1], axis[2]) || 1;
          const n = [axis[0] / len, axis[1] / len, axis[2] / len];
          const up = Math.abs(n[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
          const u = normalize(cross(n, up));
          const v = normalize(cross(n, u));
          const base = positions.length / 3;
          for (let k = 0; k < seg; k += 1) {
            const ang = (k / seg) * Math.PI * 2;
            const cu = Math.cos(ang);
            const su = Math.sin(ang);
            const radial = [
              u[0] * cu + v[0] * su,
              u[1] * cu + v[1] * su,
              u[2] * cu + v[2] * su,
            ];
            for (const [point, radius] of [[a, r0], [b, r1]]) {
              positions.push(point[0] + radial[0] * radius, point[1] + radial[1] * radius, point[2] + radial[2] * radius);
              normals.push(radial[0], radial[1], radial[2]);
              colors.push(color[0], color[1], color[2]);
            }
          }
          for (let k = 0; k < seg; k += 1) {
            const k2 = (k + 1) % seg;
            const i0 = base + k * 2;
            const i1 = i0 + 1;
            const j0 = base + k2 * 2;
            const j1 = j0 + 1;
            indices.push(i0, i1, j1, i0, j1, j0);
          }
        };

        addCone(origin, shaftEnd, 0.055, 0.055);
        addCone(shaftEnd, tip, 0.16, 0.002);
        dipoleGpu = createMesh(gl, {
          positions: new Float32Array(positions),
          normals: new Float32Array(normals),
          colors: new Float32Array(colors),
          indices: new Uint32Array(indices),
        });
      };

      const disposeSkeleton = () => {
        if (bondGpu) gl.deleteVertexArray(bondGpu.vao);
        if (atomGpu) gl.deleteVertexArray(atomGpu.vao);
        bondGpu = null;
        atomGpu = null;
      };

      const VDW = { H: 1.2, C: 1.7, N: 1.55, O: 1.52, F: 1.47, P: 1.8, S: 1.8, Cl: 1.75, Br: 1.85, I: 1.98 };
      const MASS = { H: 1, C: 12, N: 14, O: 16, F: 19, P: 31, S: 32, Cl: 35.5, Br: 80, I: 127 };

      const extent = { min: [1e9, 1e9, 1e9], max: [-1e9, -1e9, -1e9] };
      for (const atom of atoms) {
        for (const [k, axis] of [['x', 0], ['y', 1], ['z', 2]]) {
          extent.min[axis] = Math.min(extent.min[axis], atom[k]);
          extent.max[axis] = Math.max(extent.max[axis], atom[k]);
        }
      }

      /** 冷→暖渐变，给「按序号 / 质量 / 坐标」这类标量配色用。 */
      const rampColor = (t) => {
        const x = Math.min(1, Math.max(0, Number.isFinite(t) ? t : 0.5));
        const stops = [
          [0.16, 0.28, 0.62],
          [0.18, 0.62, 0.66],
          [0.42, 0.78, 0.36],
          [0.92, 0.78, 0.22],
          [0.85, 0.28, 0.22],
        ];
        const pos = x * (stops.length - 1);
        const i = Math.min(stops.length - 2, Math.floor(pos));
        const f = pos - i;
        return [0, 1, 2].map((c) => stops[i][c] + (stops[i + 1][c] - stops[i][c]) * f);
      };

      const colorOf = (index, atom) => {
        const override = skel.atomColors.get(index);
        if (skel.colorMode === 'custom') return override ?? skel.elementColors[atom.element] ?? [0.6, 0.6, 0.6];
        if (skel.colorMode === 'uniform') return skel.color;
        if (skel.colorMode === 'index') return rampColor(index / Math.max(1, atoms.length - 1));
        if (skel.colorMode === 'mass') return rampColor((MASS[atom.element] ?? 12) / 80);
        if (skel.colorMode === 'x' || skel.colorMode === 'y' || skel.colorMode === 'z') {
          const axis = { x: 0, y: 1, z: 2 }[skel.colorMode];
          const lo = extent.min[axis];
          const hi = extent.max[axis];
          return rampColor(hi > lo ? (atom[skel.colorMode] - lo) / (hi - lo) : 0.5);
        }
        return skel.elementColors[atom.element] ?? [0.6, 0.6, 0.6];
      };

      const stickRadius = () => {
        const base = 0.085 * skel.scale;
        if (skel.style === 'lines') return base * 0.24;
        if (skel.style === 'licorice') return base * 1.35;
        return base;
      };
      const atomRadius = (atom) => {
        if (skel.style === 'vdw') return (VDW[atom.element] ?? 1.7) * 0.9 * skel.scale;
        if (skel.style === 'points') return 0.06 * skel.scale;
        if (skel.style === 'licorice') return stickRadius();
        if (skel.style === 'lines') return stickRadius() * 0.9;
        return (ELEMENT_RADIUS[atom.element] ?? 0.35) * skel.scale;
      };
      const drawsBonds = () => skel.style !== 'vdw' && skel.style !== 'points';

      const rebuildSkeleton = () => {
        disposeSkeleton();
        const hidden = (atom) => !skel.showH && atom.element === 'H';

        const pointData = [];
        for (let index = 0; index < atoms.length; index += 1) {
          const atom = atoms[index];
          if (hidden(atom)) continue;
          const c = colorOf(index, atom);
          pointData.push(atom.x, atom.y, atom.z, atomRadius(atom), c[0], c[1], c[2], atom.element === 'H' ? 1 : 0);
        }
        atomGpu = createPoints(gl, new Float32Array(pointData));

        const positions = [];
        const normals = [];
        const colors = [];
        const indices = [];
        if (drawsBonds()) {
          const radius = stickRadius();
          const seg = 8;
          for (const [i, j] of bonds) {
            const a = atoms[i];
            const b = atoms[j];
            if (!a || !b || hidden(a) || hidden(b)) continue;
            const dir = [b.x - a.x, b.y - a.y, b.z - a.z];
            const len = Math.hypot(dir[0], dir[1], dir[2]) || 1;
            const n = [dir[0] / len, dir[1] / len, dir[2] / len];
            const up = Math.abs(n[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
            const u = normalize(cross(n, up));
            const v = normalize(cross(n, u));
            const ca = colorOf(i, a);
            const cb = colorOf(j, b);
            const base = positions.length / 3;
            for (let k = 0; k < seg; k += 1) {
              const ang = (k / seg) * Math.PI * 2;
              const off = [
                (u[0] * Math.cos(ang) + v[0] * Math.sin(ang)) * radius,
                (u[1] * Math.cos(ang) + v[1] * Math.sin(ang)) * radius,
                (u[2] * Math.cos(ang) + v[2] * Math.sin(ang)) * radius,
              ];
              const nrm = normalize(off);
              positions.push(a.x + off[0], a.y + off[1], a.z + off[2]);
              normals.push(nrm[0], nrm[1], nrm[2]);
              colors.push(ca[0], ca[1], ca[2]);
              positions.push(b.x + off[0], b.y + off[1], b.z + off[2]);
              normals.push(nrm[0], nrm[1], nrm[2]);
              colors.push(cb[0], cb[1], cb[2]);
            }
            for (let k = 0; k < seg; k += 1) {
              const k2 = (k + 1) % seg;
              const a0 = base + k * 2;
              const a1 = a0 + 1;
              const b0 = base + k2 * 2;
              const b1 = b0 + 1;
              indices.push(a0, a1, b1, a0, b1, b0);
            }
          }
        }

        if (positions.length > 0) {
          bondGpu = createMesh(gl, {
            positions: new Float32Array(positions),
            normals: new Float32Array(normals),
            colors: new Float32Array(colors),
            indices: new Uint32Array(indices),
          });
        }
        dirty = true;
      };

      // 包围盒与相机
      const box = { min: [1e9, 1e9, 1e9], max: [-1e9, -1e9, -1e9] };
      for (const atom of atoms) {
        box.min[0] = Math.min(box.min[0], atom.x); box.max[0] = Math.max(box.max[0], atom.x);
        box.min[1] = Math.min(box.min[1], atom.y); box.max[1] = Math.max(box.max[1], atom.y);
        box.min[2] = Math.min(box.min[2], atom.z); box.max[2] = Math.max(box.max[2], atom.z);
      }
      const center = [(box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2, (box.min[2] + box.max[2]) / 2];
      const radius = Math.max(box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]) * 0.75 + 1;
      const HOME = { yaw: -0.35, pitch: 0.35, distance: radius * 2.3 };
      const camera = { yaw: HOME.yaw, pitch: HOME.pitch, distance: HOME.distance, target: center.slice(), ortho: false };

      // 坐标轴：原点起，长度按包围盒定（VMD 的 axes 就是这么画的）。
      const axisLength = Math.max(2, radius * 0.9);
      const axisVao = gl.createVertexArray();
      gl.bindVertexArray(axisVao);
      {
        const data = [
          0, 0, 0, 0.85, 0.22, 0.22, axisLength, 0, 0, 0.85, 0.22, 0.22,
          0, 0, 0, 0.25, 0.75, 0.30, 0, axisLength, 0, 0.25, 0.75, 0.30,
          0, 0, 0, 0.28, 0.48, 0.95, 0, 0, axisLength, 0.28, 0.48, 0.95,
        ];
        const buffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.STATIC_DRAW);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
        gl.enableVertexAttribArray(1);
        gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
      }
      gl.bindVertexArray(null);

      const meshOf = (v) => {
        // 负值瓣：把场取反再等值面化，等价于 field < -iso。
        const field = v.spec.negative ? v.field.map((value) => -value) : v.field;
        return surfaceNets(field, v.spec.dims, v.iso, v.spec.origin, v.spec.spacing);
      };

      /**
       * 建/重建一路体数据的 GPU 资源。
       * 带 `spec.colorBy` 的（ESP 表面）会把另一路的标量采到顶点上按蓝白红上色。
       */
      const buildVolumeGpu = (v) => {
        v.mesh = meshOf(v);
        const source = Number.isInteger(v.spec.colorBy) ? volumes[v.spec.colorBy] : null;
        if (!source) {
          v.gpu = createMesh(gl, v.mesh);
          v.colorRange = null;
          return;
        }

        const positions = v.mesh.positions;
        const count = positions.length / 3;
        const values = new Float32Array(count);
        for (let i = 0; i < count; i += 1) {
          values[i] = sampleVolume(source, positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
        }

        // 色标范围：取 5%~95% 分位后再**对称化**（白点落在 0）。
        // 不用 min/max：个别顶点会钻到核附近，把范围拉到 ±0.5，整张图就淡成一片白。
        const sorted = Float32Array.from(values).sort();
        const p5 = sorted[Math.floor((count - 1) * 0.05)] ?? 0;
        const p95 = sorted[Math.floor((count - 1) * 0.95)] ?? 1;
        const limit = Math.max(Math.abs(p5), Math.abs(p95), 1e-6);
        const lo = -limit;
        const hi = limit;
        const span = 2 * limit;
        const colors = new Float32Array(count * 3);
        for (let i = 0; i < count; i += 1) {
          const c = divergingColor((values[i] - lo) / span);
          colors[i * 3] = c[0];
          colors[i * 3 + 1] = c[1];
          colors[i * 3 + 2] = c[2];
        }
        v.gpu = createMesh(gl, { ...v.mesh, colors });
        v.colorRange = { lo, hi };
      };

      for (const v of volumes) buildVolumeGpu(v);

      let spinning = false;
      let dirty = true;
      let raf = 0;
      const view = new Float32Array(16);
      const proj = new Float32Array(16);
      const mvp = new Float32Array(16);
      const lastMVP = new Float32Array(16);
      const modelView = new Float32Array(16);

      /** 屏幕坐标 → 最近的原子序号（按投影后距离挑，够近才算）。 */
      const pickAtom = (clientX, clientY) => {
        const rect = canvas.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return null;
        const px = ((clientX - rect.left) / rect.width) * 2 - 1;
        const py = -(((clientY - rect.top) / rect.height) * 2 - 1);
        let best = null;
        for (let index = 0; index < atoms.length; index += 1) {
          const atom = atoms[index];
          if (!skel.showH && atom.element === 'H') continue;
          const w = lastMVP[3] * atom.x + lastMVP[7] * atom.y + lastMVP[11] * atom.z + lastMVP[15];
          if (w <= 0) continue;
          const cx = (lastMVP[0] * atom.x + lastMVP[4] * atom.y + lastMVP[8] * atom.z + lastMVP[12]) / w;
          const cy = (lastMVP[1] * atom.x + lastMVP[5] * atom.y + lastMVP[9] * atom.z + lastMVP[13]) / w;
          const d2 = (cx - px) ** 2 + (cy - py) ** 2;
          if (d2 > 0.004) continue;
          if (!best || d2 < best.d2) best = { index, d2 };
        }
        return best ? best.index : null;
      };

      const eyePosition = () => {
        const cp = Math.cos(camera.pitch);
        return [
          camera.target[0] + camera.distance * cp * Math.sin(camera.yaw),
          camera.target[1] + camera.distance * Math.sin(camera.pitch),
          camera.target[2] + camera.distance * cp * Math.cos(camera.yaw),
        ];
      };

      const resize = () => {
        const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
        canvas.width = Math.max(1, Math.floor(canvas.clientWidth * dpr));
        canvas.height = Math.max(1, Math.floor(canvas.clientHeight * dpr));
        dirty = true;
      };

      /** 允许导出时临时把画布切到「透明背景」。 */
      let transparentPass = false;

      /** 把任意长度取成 1 / 2 / 5 × 10ⁿ，比例尺用它才好看。 */
      const niceLength = (raw) => {
        const value = Math.max(raw, 1e-6);
        const base = 10 ** Math.floor(Math.log10(value));
        for (const step of [1, 2, 5]) if (value <= step * base) return step * base;
        return 10 * base;
      };

      const draw = () => {
        const w = canvas.width;
        const hgt = canvas.height;
        gl.viewport(0, 0, w, hgt);

        const bgPair = transparentPass ? null : BG_COLORS[look.bg];
        if (bgPair) {
          gl.clearColor(bgPair[1][0], bgPair[1][1], bgPair[1][2], 1);
        } else {
          gl.clearColor(0, 0, 0, 0);
        }
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

        // 背景：全屏三角形铺一层渐变（纯色就是两端相同）。
        if (bgPair) {
          gl.disable(gl.DEPTH_TEST);
          gl.useProgram(bgProgram.program);
          const gpu = bgProgram.u;
          if (gpu.uTop) gl.uniform3f(gpu.uTop, bgPair[0][0], bgPair[0][1], bgPair[0][2]);
          if (gpu.uBottom) gl.uniform3f(gpu.uBottom, bgPair[1][0], bgPair[1][1], bgPair[1][2]);
          if (gpu.uAlpha) gl.uniform1f(gpu.uAlpha, 1);
          gl.bindVertexArray(bgVao);
          gl.drawArrays(gl.TRIANGLES, 0, 3);
          gl.enable(gl.DEPTH_TEST);
        }
        gl.enable(gl.DEPTH_TEST);
        gl.enable(gl.CULL_FACE);
        gl.cullFace(gl.BACK);

        const eye = eyePosition();
        mat4.lookAt(view, eye, camera.target, [0, 1, 0]);
        const aspect = w / Math.max(1, hgt);
        if (camera.ortho) {
          const halfH = camera.distance * 0.45;
          mat4.ortho(proj, -halfH * aspect, halfH * aspect, -halfH, halfH, 0.1, camera.distance * 8);
        } else {
          mat4.perspective(proj, (40 * Math.PI) / 180, aspect, 0.1, camera.distance * 8);
        }
        mat4.multiply(mvp, proj, view);
        lastMVP.set(mvp); // 拾取（Alt+点击）用同一套矩阵
        mat4.multiply(modelView, view, IDENTITY);

        // 材质与雾化：骨架、等值面共用同一组参数。
        const fogColor = bgPair ? bgPair[1] : [1, 1, 1];
        const fogOn = look.fog > 0.01 ? 1 : 0;
        const fogNear = camera.distance - radius * 1.6;
        const fogFar = camera.distance + radius * (2 + (1 - look.fog) * 8);
        const lightDir = [0.45, 0.62, 0.78];
        const applyLook = (prog) => {
          const u = prog.u;
          if (u.uLightDir) gl.uniform3f(u.uLightDir, lightDir[0], lightDir[1], lightDir[2]);
          if (u.uLight) gl.uniform3f(u.uLight, lightDir[0], lightDir[1], lightDir[2]);
          if (u.uAmbient) gl.uniform1f(u.uAmbient, look.ambient);
          if (u.uDiffuseK) gl.uniform1f(u.uDiffuseK, look.diffuse);
          if (u.uSpecular) gl.uniform1f(u.uSpecular, look.specular);
          if (u.uShininess) gl.uniform1f(u.uShininess, look.shininess);
          if (u.uFogColor) gl.uniform3f(u.uFogColor, fogColor[0], fogColor[1], fogColor[2]);
          if (u.uFogNear) gl.uniform1f(u.uFogNear, fogNear);
          if (u.uFogFar) gl.uniform1f(u.uFogFar, fogFar);
          if (u.uFogOn) gl.uniform1f(u.uFogOn, fogOn);
        };

        if (skel.show && (bondGpu || atomGpu)) {
          if (bondGpu) {
            gl.useProgram(meshProgram.program);
            gl.uniformMatrix4fv(meshProgram.u.uMVP, false, mvp);
            gl.uniformMatrix4fv(meshProgram.u.uModelView, false, modelView);
            gl.uniform1f(meshProgram.u.uVertexColor, 1);
            gl.uniform1f(meshProgram.u.uFlat, 0);
            gl.uniform3f(meshProgram.u.uColor, 1, 1, 1);
            gl.uniform1f(meshProgram.u.uAlpha, 1);
            applyLook(meshProgram);
            gl.disable(gl.BLEND);
            gl.depthMask(true);
            gl.bindVertexArray(bondGpu.vao);
            gl.drawElements(gl.TRIANGLES, bondGpu.count, gl.UNSIGNED_INT, 0);
          }

          if (atomGpu) {
            gl.useProgram(pointProgram.program);
            gl.uniformMatrix4fv(pointProgram.u.uMVP, false, mvp);
            gl.uniformMatrix4fv(pointProgram.u.uModelView, false, modelView);
            gl.uniform1f(pointProgram.u.uProjScale, (hgt * proj[5]) / 2);
            gl.uniform1f(pointProgram.u.uOrthoPix, hgt / (camera.distance * 0.9));
            gl.uniform1f(pointProgram.u.uOrtho, camera.ortho ? 1 : 0);
            applyLook(pointProgram);
            gl.enable(gl.BLEND);
            gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
            gl.depthMask(true);
            gl.bindVertexArray(atomGpu.vao);
            gl.drawArrays(gl.POINTS, 0, atomGpu.count);
          }
        }

        const ordered = volumes
          .filter((v) => v.visible && v.mesh.triangles > 0)
          .map((v) => {
            const [nx, ny, nz] = v.spec.dims;
            const [ox, oy, oz] = v.spec.origin;
            const [dx, dy, dz] = v.spec.spacing;
            const c = [ox + (nx / 2) * dx, oy + (ny / 2) * dy, oz + (nz / 2) * dz];
            return { v, d: Math.hypot(c[0] - eye[0], c[1] - eye[1], c[2] - eye[2]) };
          })
          .sort((a, b) => b.d - a.d);

        gl.useProgram(meshProgram.program);
        gl.uniformMatrix4fv(meshProgram.u.uMVP, false, mvp);
        gl.uniformMatrix4fv(meshProgram.u.uModelView, false, modelView);
        applyLook(meshProgram);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        gl.depthMask(false);
        gl.disable(gl.CULL_FACE);
        for (const item of ordered) {
          // 按值着色的表面（ESP）走逐顶点色，其余用统一色。
          const solid = Boolean(item.v.colorRange) && item.v.alpha >= 0.99;
          gl.uniform1f(meshProgram.u.uVertexColor, item.v.colorRange ? 1 : 0);
          gl.uniform1f(meshProgram.u.uFlat, item.v.colorRange ? 1 : 0);
          gl.uniform3f(meshProgram.u.uColor, item.v.color[0], item.v.color[1], item.v.color[2]);
          gl.uniform1f(meshProgram.u.uAlpha, item.v.alpha);
          // 实心表面：关混合、写深度 —— 否则正反面叠加会发白，而且会被自身背面剔除。
          if (solid) {
            gl.disable(gl.BLEND);
            gl.depthMask(true);
          } else {
            gl.enable(gl.BLEND);
            gl.depthMask(false);
          }
          gl.bindVertexArray(item.v.gpu.vao);
          gl.drawElements(gl.TRIANGLES, item.v.gpu.count, gl.UNSIGNED_INT, 0);
        }
        gl.depthMask(true);
        gl.enable(gl.CULL_FACE);

        // 偶极矩箭头
        if (look.dipole && dipoleGpu) {
          gl.useProgram(meshProgram.program);
          gl.uniformMatrix4fv(meshProgram.u.uMVP, false, mvp);
          gl.uniformMatrix4fv(meshProgram.u.uModelView, false, modelView);
          gl.uniform1f(meshProgram.u.uVertexColor, 1);
          gl.uniform1f(meshProgram.u.uFlat, 0);
          gl.uniform1f(meshProgram.u.uAlpha, 1);
          applyLook(meshProgram);
          gl.disable(gl.BLEND);
          gl.depthMask(true);
          gl.bindVertexArray(dipoleGpu.vao);
          gl.drawElements(gl.TRIANGLES, dipoleGpu.count, gl.UNSIGNED_INT, 0);
        }

        // 坐标轴画在最后：让分子能挡住它，跟 VMD 一致。
        if (look.axes) {
          gl.useProgram(lineProgram.program);
          if (lineProgram.u.uMVP) gl.uniformMatrix4fv(lineProgram.u.uMVP, false, mvp);
          gl.disable(gl.BLEND);
          gl.bindVertexArray(axisVao);
          gl.drawArrays(gl.LINES, 0, 6);
        }

        // 屏幕上的比例尺（导出时会用 2D canvas 另画一条，尺寸按导出分辨率算）。
        if (look.scalebar) {
          scaleEl.classList.remove('is-hidden');
          const cssH = canvas.clientHeight || 1;
          const worldH = camera.ortho
            ? camera.distance * 0.9
            : 2 * camera.distance * Math.tan((20 * Math.PI) / 180);
          const perPx = worldH / cssH;
          const len = niceLength((canvas.clientWidth || 600) * 0.16 * perPx);
          const px = Math.max(10, Math.round(len / perPx));
          scaleEl.querySelector('b').style.width = `${px}px`;
          scaleEl.querySelector('span').textContent = `${len >= 10 ? len.toFixed(0) : len.toFixed(1)} Å`;
        } else {
          scaleEl.classList.add('is-hidden');
        }
      };

      const loop = () => {
        if (spinning) {
          camera.yaw += 0.006;
          dirty = true;
        }
        if (dirty) {
          draw();
          dirty = false;
        }
        raf = requestAnimationFrame(loop);
      };

      /* ---- 控件 ---- */

      const titleEl = container.querySelector('[data-role="title"]');
      const metaEl = container.querySelector('[data-role="meta"]');
      titleEl.textContent = meta.title ?? meta.name ?? '结构视图';
      const m = meta.metrics ?? {};
      metaEl.textContent = [
        `${atoms.length} 原子`,
        // 偶极矩放在标题下面，不用展开「外观」也能看到数值。
        meta.dipole && Number.isFinite(meta.dipole.magnitude) ? `μ ${Number(meta.dipole.magnitude).toFixed(2)} D` : '',
        m.integralHole != null ? `Integral ${Number(m.integralHole).toFixed(3)}` : '',
        m.sr != null ? `Sr ${Number(m.sr).toFixed(3)}` : '',
        m.dIndex != null ? `D ${Number(m.dIndex).toFixed(2)} Å` : '',
      ].filter(Boolean).join(' · ');

      const volumeBox = container.querySelector('[data-role="volumes"]');

      /** 有色标就显示色标（取第一路带 colorRange 的，范围用 2%~98% 分位）。 */
      const updateLegend = () => {
        const colored = volumes.find((v) => v.colorRange);
        if (!colored) {
          legendEl.hidden = true;
          return;
        }
        legendEl.hidden = false;
        legendEl.querySelector('[data-role="legendLo"]').textContent = colored.colorRange.lo.toFixed(3);
        legendEl.querySelector('[data-role="legendHi"]').textContent = colored.colorRange.hi.toFixed(3);
      };

      for (const v of volumes) {
        const wrap = globalThis.document.createElement('div');
        wrap.className = 'chem-view__group';
        wrap.innerHTML = `
          <div class="chem-view__row"><label><input type="checkbox" ${v.visible ? 'checked' : ''} data-role="show" /> ${v.spec.label}</label>
            <input type="color" data-role="color" value="${toHex(v.color)}" /></div>
          <input type="range" data-role="iso" min="0.0002" max="${(v.spec.max * 0.35).toFixed(4)}" step="0.0001" value="${v.iso}" />
          <div class="chem-view__row"><span class="chem-view__value" data-role="isoLabel">${v.iso.toFixed(4)}</span>
            <span class="chem-view__value" data-role="triLabel">${v.mesh.triangles.toLocaleString()} 面</span></div>
          <input type="range" data-role="alpha" min="0.05" max="1" step="0.01" value="${v.alpha}" />`;
        volumeBox.appendChild(wrap);

        wrap.querySelector('[data-role="show"]').addEventListener('change', (e) => { v.visible = e.target.checked; dirty = true; });
        wrap.querySelector('[data-role="color"]').addEventListener('input', (e) => { v.color = fromHex(e.target.value); dirty = true; });
        wrap.querySelector('[data-role="alpha"]').addEventListener('input', (e) => { v.alpha = Number(e.target.value); dirty = true; });

        const iso = wrap.querySelector('[data-role="iso"]');
        let timer = 0;
        iso.addEventListener('input', (e) => {
          v.iso = Number(e.target.value);
          wrap.querySelector('[data-role="isoLabel"]').textContent = v.iso.toFixed(4);
          clearTimeout(timer);
          timer = setTimeout(() => {
            buildVolumeGpu(v);
            wrap.querySelector('[data-role="triLabel"]').textContent = `${v.mesh.triangles.toLocaleString()} 面`;
            updateLegend();
            dirty = true;
          }, 40);
        });
      }
      updateLegend();

      // 骨架控件：显隐只重画，其余要重建几何。
      container.querySelector('[data-role="skeleton"]').addEventListener('change', (e) => {
        skel.show = e.target.checked;
        dirty = true;
      });
      container.querySelector('[data-role="showH"]').addEventListener('change', (e) => {
        skel.showH = e.target.checked;
        rebuildSkeleton();
      });
      container.querySelector('[data-role="skelStyle"]').addEventListener('change', (e) => {
        skel.style = e.target.value;
        rebuildSkeleton();
      });
      container.querySelector('[data-role="skelColorMode"]').addEventListener('change', (e) => {
        skel.colorMode = e.target.value;
        elementBox.hidden = skel.colorMode !== 'element';
        rebuildSkeleton();
      });
      container.querySelector('[data-role="skelColor"]').addEventListener('input', (e) => {
        skel.color = fromHex(e.target.value);
        if (skel.colorMode !== 'uniform') {
          skel.colorMode = 'uniform';
          container.querySelector('[data-role="skelColorMode"]').value = 'uniform';
          elementBox.hidden = true;
        }
        rebuildSkeleton();
      });
      container.querySelector('[data-role="skelScale"]').addEventListener('input', (e) => {
        skel.scale = Number(e.target.value);
        rebuildSkeleton();
      });

      // 元素配色表：只列这个体系里出现的元素，点色块直接改该元素所有原子。
      const elementBox = container.querySelector('[data-role="elementBox"]');
      const chips = container.querySelector('[data-role="elementChips"]');
      const present = [...new Set(atoms.map((atom) => atom.element))];
      const renderChips = () => {
        chips.innerHTML = '';
        for (const element of present) {
          const label = document.createElement('label');
          label.className = 'chem-view__chip';
          label.innerHTML = `<input type="color" value="${toHex(skel.elementColors[element] ?? [0.6, 0.6, 0.6])}" /> ${element}`;
          label.querySelector('input').addEventListener('input', (e) => {
            skel.elementColors[element] = fromHex(e.target.value);
            rebuildSkeleton();
          });
          chips.appendChild(label);
        }
      };
      renderChips();

      /* ---- 风格预设与外观 ---- */

      const ui = (role) => container.querySelector(`[data-role="${role}"]`);

      // 有「按值着色的表面」（ESP）时默认藏骨架：文献里 ESP 图只给表面，
      // 骨架露在表面外面反而脏；需要时可以手动打开。
      if (volumes.some((v) => Number.isInteger(v.spec.colorBy))) {
        skel.show = false;
        ui('skeleton').checked = false;
      }

      /** 把 look / skel / 配色同步到界面控件上（预设应用后要回填）。 */
      const syncLookUi = () => {
        ui('bg').value = look.bg;
        ui('fog').value = String(look.fog);
        ui('ambient').value = String(look.ambient);
        ui('diffuse').value = String(look.diffuse);
        ui('specular').value = String(look.specular);
        ui('axes').checked = look.axes;
        ui('scalebar').checked = look.scalebar;
        ui('skelStyle').value = skel.style;
        ui('skelColorMode').value = skel.colorMode;
        ui('skelScale').value = String(skel.scale);
        ui('showH').checked = skel.showH;
        elementBox.hidden = skel.colorMode !== 'element';
      };

      const applyPreset = (name) => {
        const preset = PRESETS[name];
        if (!preset) return;
        Object.assign(look, preset.look);
        Object.assign(skel, preset.skel);
        if (preset.palette) skel.elementColors = { ...skel.elementColors, ...preset.palette };
        if (preset.surfaceAlpha != null) {
          const alphaInputs = container.querySelectorAll('[data-role="alpha"]');
          volumes.forEach((v, index) => {
            v.alpha = preset.surfaceAlpha;
            if (alphaInputs[index]) alphaInputs[index].value = String(v.alpha);
          });
        }
        renderChips();
        syncLookUi();
        rebuildSkeleton();
      };
      ui('preset').addEventListener('change', (e) => {
        if (e.target.value === 'custom') return;
        applyPreset(e.target.value);
      });

      // 手动改任何一项观感参数 → 预设切到「自定义」，避免下拉框骗人。
      const markCustom = () => {
        const select = ui('preset');
        if (select.value !== 'custom') select.value = 'custom';
      };
      ui('bg').addEventListener('change', (e) => { look.bg = e.target.value; markCustom(); dirty = true; });
      ui('fog').addEventListener('input', (e) => { look.fog = Number(e.target.value); markCustom(); dirty = true; });
      ui('ambient').addEventListener('input', (e) => { look.ambient = Number(e.target.value); markCustom(); dirty = true; });
      ui('diffuse').addEventListener('input', (e) => { look.diffuse = Number(e.target.value); markCustom(); dirty = true; });
      ui('specular').addEventListener('input', (e) => { look.specular = Number(e.target.value); markCustom(); dirty = true; });
      ui('axes').addEventListener('change', (e) => { look.axes = e.target.checked; dirty = true; });
      ui('scalebar').addEventListener('change', (e) => { look.scalebar = e.target.checked; dirty = true; });

      // 偶极矩：pack 里有 meta.dipole 才显示这两行。
      if (dipoleInfo) {
        ui('dipoleRow').hidden = false;
        ui('dipoleBar').hidden = false;
        ui('dipoleVal').textContent = `${Number(meta.dipole.magnitude ?? 0).toFixed(2)} D`;
        ui('dipole').addEventListener('change', (e) => { look.dipole = e.target.checked; dirty = true; });
        ui('dipoleColor').addEventListener('input', (e) => {
          look.dipoleColor = fromHex(e.target.value);
          rebuildDipole();
          dirty = true;
        });
        ui('dipoleScale').addEventListener('input', (e) => {
          look.dipoleScale = Number(e.target.value) || 1;
          ui('dipoleScaleVal').textContent = `${look.dipoleScale.toFixed(1)}×`;
          rebuildDipole();
          dirty = true;
        });
      }

      // 逐原子上色：选颜色 → Alt + 点击原子。
      container.querySelector('[data-role="brush"]').addEventListener('input', (e) => {
        skel.brush = fromHex(e.target.value);
      });
      container.querySelector('[data-role="clearAtom"]').addEventListener('click', () => {
        skel.atomColors.clear();
        rebuildSkeleton();
      });
      container.querySelector('[data-role="reset"]').addEventListener('click', () => {
        camera.yaw = HOME.yaw; camera.pitch = HOME.pitch; camera.distance = HOME.distance; dirty = true;
      });
      const spinBtn = container.querySelector('[data-role="spin"]');
      spinBtn.addEventListener('click', () => {
        spinning = !spinning;
        spinBtn.classList.toggle('is-active', spinning);
      });
      container.querySelector('[data-role="exportScale"]').addEventListener('change', (e) => {
        look.exportScale = Number(e.target.value) || 2;
      });

      /**
       * 按指定倍率重画一遍并取 PNG dataURL。
       * 导出时临时改画布尺寸 → 画 → 读像素 → 还原，保证成图和当前视角完全一致。
       */
      const renderAtScale = (scale, transparent) => {
        const prevW = canvas.width;
        const prevH = canvas.height;
        const cssW = canvas.clientWidth || 800;
        const cssH = canvas.clientHeight || 600;
        canvas.width = Math.round(cssW * scale);
        canvas.height = Math.round(cssH * scale);
        transparentPass = transparent;
        draw();
        const url = canvas.toDataURL('image/png');
        transparentPass = false;
        canvas.width = prevW;
        canvas.height = prevH;
        draw();
        return url;
      };

      /** 在导出图上补一条比例尺（文字用 2D canvas 画，比 WebGL 里糊字清楚）。 */
      const paintScaleBar = (ctx, width, height) => {
        const worldH = camera.ortho ? camera.distance * 0.9 : 2 * camera.distance * Math.tan((20 * Math.PI) / 180);
        const perPx = worldH / height;
        const len = niceLength(width * 0.16 * perPx);
        const px = Math.max(10, Math.round(len / perPx));
        const x = Math.round(width * 0.04);
        const y = Math.round(height * 0.95);
        const barH = Math.max(2, Math.round(height * 0.006));
        const font = Math.max(10, Math.round(height * 0.026));
        ctx.save();
        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        ctx.fillRect(x - 4, y - font * 2.2, px + 8, font * 2.4);
        ctx.fillStyle = '#111';
        ctx.fillRect(x, y - barH, px, barH);
        ctx.font = `${font}px system-ui, sans-serif`;
        ctx.textBaseline = 'alphabetic';
        ctx.fillText(`${len >= 10 ? len.toFixed(0) : len.toFixed(1)} Å`, x, y - barH - font * 0.5);
        ctx.restore();
      };

      /** 导出时的色标（左下角）：和屏幕上的 legend 保持一致。 */
      const paintLegend = (ctx, width, height) => {
        const colored = volumes.find((v) => v.colorRange);
        if (!colored) return;
        const barW = Math.round(width * 0.16);
        const barH = Math.max(6, Math.round(height * 0.012));
        const x = Math.round(width * 0.04);
        const y = Math.round(height * 0.93);
        const font = Math.max(10, Math.round(height * 0.024));
        const gradient = ctx.createLinearGradient(x, 0, x + barW, 0);
        gradient.addColorStop(0, 'rgb(41,89,217)');
        gradient.addColorStop(0.5, 'rgb(219,219,223)');
        gradient.addColorStop(1, 'rgb(209,46,46)');
        ctx.save();
        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        ctx.fillRect(x - 6, y - font * 1.6, barW + 12, barH + font * 2.4);
        ctx.fillStyle = gradient;
        ctx.fillRect(x, y, barW, barH);
        ctx.strokeStyle = 'rgba(0,0,0,0.25)';
        ctx.lineWidth = 1;
        ctx.strokeRect(x, y, barW, barH);
        ctx.fillStyle = '#111';
        ctx.font = `${font}px system-ui, sans-serif`;
        ctx.textBaseline = 'top';
        ctx.fillText(colored.colorRange.lo.toFixed(3), x, y + barH + font * 0.3);
        ctx.textAlign = 'right';
        ctx.fillText(colored.colorRange.hi.toFixed(3), x + barW, y + barH + font * 0.3);
        ctx.restore();
      };

      const exportPng = async () => {
        const scale = look.exportScale || 2;
        const transparent = look.bg === 'transparent';
        const url = renderAtScale(scale, transparent);
        const img = new globalThis.Image();
        await new Promise((resolve, reject) => {
          img.onload = resolve;
          img.onerror = reject;
          img.src = url;
        });
        const out = globalThis.document.createElement('canvas');
        out.width = img.width;
        out.height = img.height;
        const ctx = out.getContext('2d');
        ctx.drawImage(img, 0, 0);
        if (look.scalebar) paintScaleBar(ctx, out.width, out.height);
        paintLegend(ctx, out.width, out.height);
        const a = globalThis.document.createElement('a');
        a.href = out.toDataURL('image/png');
        a.download = `${meta.name ?? 'structure'}-${scale}x.png`;
        a.click();
      };
      container.querySelector('[data-role="shot"]').addEventListener('click', () => { exportPng(); });
      for (const btn of container.querySelectorAll('[data-proj]')) {
        btn.addEventListener('click', () => {
          container.querySelectorAll('[data-proj]').forEach((b) => b.classList.toggle('is-active', b === btn));
          camera.ortho = btn.dataset.proj === 'ortho';
          dirty = true;
        });
      }

      /* ---- 鼠标 / 键盘 ---- */

      let drag = null;
      const onDown = (e) => {
        canvas.setPointerCapture(e.pointerId);
        canvas.classList.add('is-dragging');
        drag = { x: e.clientX, y: e.clientY, button: e.button, startX: e.clientX, startY: e.clientY, moved: false, alt: e.altKey };
      };
      const onUp = (e) => {
        canvas.releasePointerCapture(e.pointerId);
        canvas.classList.remove('is-dragging');
        const wasDrag = drag;
        drag = null;
        // Alt + 点击 = 给最近的原子刷上当前颜色（不移动就不算拖拽）。
        if (wasDrag && !wasDrag.moved && wasDrag.alt) {
          const index = pickAtom(e.clientX, e.clientY);
          if (index !== null) {
            skel.atomColors.set(index, skel.brush);
            if (skel.colorMode !== 'custom') {
              skel.colorMode = 'custom';
              container.querySelector('[data-role="skelColorMode"]').value = 'custom';
              elementBox.hidden = true;
            }
            rebuildSkeleton();
          }
        }
      };
      const onMove = (e) => {
        if (!drag) return;
        const dx = e.clientX - drag.x;
        const dy = e.clientY - drag.y;
        drag.x = e.clientX;
        drag.y = e.clientY;
        if (Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) > 3) drag.moved = true;
        if (drag.button === 2) {
          const eye = eyePosition();
          const forward = normalize([camera.target[0] - eye[0], camera.target[1] - eye[1], camera.target[2] - eye[2]]);
          const right = normalize(cross(forward, [0, 1, 0]));
          const up = cross(right, forward);
          const scale = camera.distance * 0.0016;
          for (let i = 0; i < 3; i += 1) camera.target[i] += (-dx * right[i] + dy * up[i]) * scale;
        } else {
          camera.yaw -= dx * 0.01;
          camera.pitch = clamp(camera.pitch + dy * 0.01, -1.5, 1.5);
        }
        dirty = true;
      };
      const onWheel = (e) => {
        e.preventDefault();
        camera.distance *= Math.exp(e.deltaY * 0.0012);
        dirty = true;
      };
      const onContext = (e) => e.preventDefault();
      const onKey = (e) => {
        if (e.target instanceof globalThis.HTMLInputElement) return;
        if (e.key === 'r' || e.key === 'R') { camera.yaw = HOME.yaw; camera.pitch = HOME.pitch; camera.distance = HOME.distance; dirty = true; }
        if (e.key === ' ') {
          spinning = !spinning;
          spinBtn.classList.toggle('is-active', spinning);
          e.preventDefault();
        }
      };
      const onResize = () => resize();

      canvas.addEventListener('pointerdown', onDown);
      canvas.addEventListener('pointerup', onUp);
      canvas.addEventListener('pointermove', onMove);
      canvas.addEventListener('wheel', onWheel, { passive: false });
      canvas.addEventListener('contextmenu', onContext);
      globalThis.addEventListener('keydown', onKey);
      globalThis.addEventListener('resize', onResize);

      // 挂载那一刻 tab 的布局往往还没算完：clientWidth/clientHeight 可能是 0 或很小，
      // 之后容器变大也不会自动重算，canvas 就永远只占一条。用 ResizeObserver 跟着容器走。
      let observer = null;
      if (typeof globalThis.ResizeObserver === 'function') {
        observer = new globalThis.ResizeObserver(() => resize());
        observer.observe(container);
      }

      // 开局套一次默认风格（论文·浅底）：控件值、配色、等值面透明度一次对齐。
      applyPreset('paper-light');
      // 箭头几何要在 look 定下来之后建（颜色/长度都读 look）。
      rebuildDipole();

      resize();
      draw();
      raf = requestAnimationFrame(loop);
      // 再补一帧：等布局稳定后按真实尺寸重算一次。
      requestAnimationFrame(() => {
        resize();
        draw();
      });

      return () => {
        cancelAnimationFrame(raf);
        observer?.disconnect();
        disposeSkeleton();
        if (dipoleGpu) gl.deleteVertexArray(dipoleGpu.vao);
        canvas.removeEventListener('pointerdown', onDown);
        canvas.removeEventListener('pointerup', onUp);
        canvas.removeEventListener('pointermove', onMove);
        canvas.removeEventListener('wheel', onWheel);
        canvas.removeEventListener('contextmenu', onContext);
        globalThis.removeEventListener('keydown', onKey);
        globalThis.removeEventListener('resize', onResize);
      };
    }

    /* ------------------------------------------------------------ 视图 */

    function makeViewerPage() {
      return function ChemViewer(props) {
        const useTabInfo = props.useTabInfo;
        const info = typeof useTabInfo === 'function' ? useTabInfo() : undefined;
        const address = info?.tab?.contentId ?? props.address ?? props.contentId ?? '';
        const containerRef = react.useRef(null);

        react.useEffect(() => {
          const el = containerRef.current;
          if (!el) return undefined;
          if (!address) {
            // mountViewer 自己建 DOM，这里不预先渲染占位；直接挂一个空容器再报错。
            el.innerHTML = '<div class="chem-view__empty"><div class="chem-view__error">没有拿到资源地址。请从文件树里点一个 .cub。</div></div>';
            return undefined;
          }
          let cleanup = () => {};
          let cancelled = false;
          mountViewer(el, address).then((fn) => {
            if (cancelled) fn();
            else cleanup = fn;
          });
          return () => {
            cancelled = true;
            cleanup();
          };
        }, [address]);

        // 只给容器；canvas / 面板 / 状态都由 mountViewer 建（两条入口共用）。
        return h('div', { className: 'chem-view', ref: containerRef });
      };
    }

    /* ------------------------------------------------------------ 列表页 */

    /**
     * 「结构视图」列表：读 views.json → 列出最近的视图包 → 点一条就地渲染。
     *
     * 这条路**完全不经过资源路由**，所以不会和内置的文本/JSON 预览抢优先级 ——
     * 之前点 meta.json 只弹出 JSON 文本，就是因为内置预览的 builtin 优先级更高。
     */
    async function mountIndex(container) {
      let cleanup = () => {};

      const showList = async () => {
        cleanup();
        cleanup = () => {};
        container.innerHTML = '';

        const root = document.createElement('div');
        root.className = 'chem-view__index';
        container.appendChild(root);

        const head = document.createElement('div');
        head.className = 'chem-view__indexHead';
        head.innerHTML = '<div class="chem-view__title">结构视图</div><div class="chem-view__meta" data-role="count"></div>';
        root.appendChild(head);

        let data;
        try {
          data = await fetchJson(INDEX_PATH);
        } catch (error) {
          const hint = document.createElement('div');
          hint.className = 'chem-view__empty';
          hint.innerHTML = `<div>还没有视图包。<br/><br/>让 agent 跑一次 <code>chem_view</code>（指定 outDir），生成后就会出现在这里。<br/><br/><span class="chem-view__meta">读取 ${escapeHtml(INDEX_PATH)} 失败：${escapeHtml(error.message ?? error)}</span></div>`;
          root.appendChild(hint);
          return;
        }

        const items = Array.isArray(data.items) ? data.items : [];
        head.querySelector('[data-role="count"]').textContent = `${items.length} 个`;
        if (items.length === 0) {
          const hint = document.createElement('div');
          hint.className = 'chem-view__empty';
          hint.innerHTML = '<div>列表是空的。让 agent 跑一次 <code>chem_view</code> 就会出现在这里。</div>';
          root.appendChild(hint);
          return;
        }

        for (const item of items) {
          const row = document.createElement('button');
          row.className = 'chem-view__item';
          row.innerHTML = `<span class="chem-view__itemTitle">${escapeHtml(item.title ?? '未命名')}</span>
            <span class="chem-view__itemMeta">${relativeTime(item.addedAt ?? item.createdAt)} · ${escapeHtml(item.viewDir ?? '')}</span>`;
          row.addEventListener('click', () => { openItem(item); });
          root.appendChild(row);
        }

        // 列表只能在这里看，增删要回对话里说（面板没有写文件权限）。
        const footer = document.createElement('div');
        footer.className = 'chem-view__hint';
        footer.innerHTML =
          '增删/清理：在对话里说「把第 2 条删掉」「把这个包加进列表」，或直接编辑 ' +
          `<code>${escapeHtml(INDEX_PATH)}</code>。`;
        root.appendChild(footer);
      };

      const openItem = async (item) => {
        cleanup();
        cleanup = () => {};
        container.innerHTML = '';

        const stage = document.createElement('div');
        stage.className = 'chem-view__stage';
        container.appendChild(stage);

        const back = document.createElement('button');
        back.className = 'chem-view__back';
        back.textContent = '← 列表';
        back.addEventListener('click', () => { back.remove(); showList(); });
        container.appendChild(back);

        cleanup = await mountViewer(stage, item.metaPath);
      };

      await showList();
      return () => cleanup();
    }

    function makeIndexPage() {
      return function ChemIndex(props) {
        const ref = react.useRef(null);
        react.useEffect(() => {
          const el = ref.current;
          if (!el) return undefined;
          let stop = () => {};
          let cancelled = false;
          mountIndex(el).then((fn) => {
            if (cancelled) fn();
            else stop = fn;
          });
          return () => {
            cancelled = true;
            stop();
          };
        }, []);
        return h('div', { className: 'chem-view', ref });
      };
    }

    /* ------------------------------------------------------------ 注册 */

    function decodePath(address) {
      return decodeAddress(address);
    }

    function viewerTabDefinition() {
      return {
        id: VIEWER_ID,
        kind: VIEWER_KIND,
        // 认所有文件资源，再由 canOpen 收窄到结构文件；这样不会抢内置预览的文档类型。
        patterns: ['dsh-resource://file/**'],
        priority: 'extension',
        canOpen: (address) => {
          const path = decodePath(address).replace(/\\/g, '/');
          // 只抢内置预览不会认的结构文件：.cub 与专用后缀 .cfv。
          // （.json 会被内置文本预览接管，所以不要在这里认 meta.json —— 那是死路。）
          if (/\.cfv$/i.test(path)) return true;
          return /\.cub$/i.test(path);
        },
        title: (address) => {
          const path = decodePath(address).replace(/\\/g, '/');
          return `结构视图 · ${basename(path)}`;
        },
      };
    }

    /** 「结构视图」页签：与资源路由无关，靠头部按钮打开。 */
    function indexTabDefinition() {
      return {
        id: INDEX_ID,
        kind: INDEX_KIND,
        priority: 'extension',
        title: () => '结构视图',
      };
    }

    /** 头部按钮：打开「结构视图」页签（列着最近的视图包）。 */
    function makeHeaderButton(openTab) {
      return function ChemFlowHeaderButton() {
        return h(
          'button',
          {
            className: 'chem-view__headerBtn',
            title: '结构视图（最近的 3D 视图包）',
            onClick: () => {
              try {
                openTab();
              } catch (error) {
                console.warn('[chemflow-viewer] 打开结构视图失败：', error);
              }
            },
          },
          '结构',
        );
      };
    }

    function apply(ctx) {
      ensureStyle();
      const tabs = ctx.sidebarRightTabs;
      if (!tabs || typeof tabs.register !== 'function') {
        // 少了这个服务就注册不了 tab；宁可留一条清楚的日志，也不要静默。
        console.warn('[chemflow-viewer] 没有 sidebarRightTabs 服务，结构面板不会注册');
        return;
      }
      if (!ctx.slots || typeof ctx.slots.register !== 'function') {
        console.warn('[chemflow-viewer] 没有 slots 服务，结构面板不会注册');
        return;
      }

      // 类型要**立即**注册：tab 的打开逻辑不能等 body 挂载。
      ctx.effect(() => tabs.register(viewerTabDefinition()), 'chemflow-viewer: resource tab');
      ctx.effect(() => tabs.register(indexTabDefinition()), 'chemflow-viewer: index tab');

      // 控制台探针：面板不出现时，先在 DevTools 里看这个对象在不在、canOpen 认不认你的路径。
      globalThis.__DSH_CHEMFLOW_VIEWER__ = {
        tabId: VIEWER_ID,
        kind: VIEWER_KIND,
        indexKind: INDEX_KIND,
        indexPath: INDEX_PATH,
        canOpen: (address) => viewerTabDefinition().canOpen(address),
        decodeAddress,
        resolveMetaPath,
        open: () => {
          const sidebar = ctx.get?.('sidebarRight') ?? ctx.sidebarRight;
          if (sidebar && typeof sidebar.openTab === 'function') sidebar.openTab(INDEX_KIND);
        },
      };

      ctx.slots.inject('sidebar.right.pane.tab', () =>
        ctx.slots.register({ name: 'sidebar.right.pane.tab', key: VIEWER_ID }, makeViewerPage()),
      );
      ctx.slots.inject('sidebar.right.pane.tab', () =>
        ctx.slots.register({ name: 'sidebar.right.pane.tab', key: INDEX_ID }, makeIndexPage()),
      );

      // sidebarRight 是**可选**服务：写进 inject 会让插件在缺少它的宿主上停在
      // PENDING（表现就是“没激活”且没有任何报错），所以用探测。
      const sidebar = ctx.get?.('sidebarRight') ?? ctx.sidebarRight;
      if (sidebar && typeof sidebar.openTab === 'function') {
        ctx.slots.inject('conversation.session.header.utilities', () =>
          ctx.slots.register(
            { name: 'conversation.session.header.utilities', id: INDEX_ID, order: 10, label: '结构视图' },
            makeHeaderButton(() => sidebar.openTab(INDEX_KIND)),
          ),
        );
      } else {
        console.warn('[chemflow-viewer] 没有 sidebarRight 服务，头部按钮不会出现（仍可用 __DSH_CHEMFLOW_VIEWER__.open()）');
      }
    }

    exports.apply = apply;
    exports.inject = ['slots', 'sidebarRightTabs'];
    exports.__internals = {
      VIEWER_ID,
      VIEWER_KIND,
      INDEX_ID,
      INDEX_KIND,
      INDEX_PATH,
      decodeAddress,
      resolveMetaPath,
      fileUrl,
      viewerTabDefinition,
      indexTabDefinition,
      relativeTime,
      surfaceNets,
      dequantize,
      mountViewer,
      mountIndex,
      ensureStyle,
      normalizeMeta,
      divergingColor,
      sampleVolume,
    };
    return module.exports;
});
})();
