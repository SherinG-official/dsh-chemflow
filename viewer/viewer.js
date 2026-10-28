/*
 * 结构查看器（独立版）：WebGL2 + 浏览器端 Surface Nets。
 *
 * 先在独立页面调通，之后搬进 DSH 客户端面板（只换数据加载那一段）。
 * 不引 three.js：客户端插件用 __ModuleLoader__ 加载，没有 import map，
 * 第三方库要么内联几百 KB，要么得加构建管线。
 *
 * 数据：/data/meta.json + /data/<volume>.bin（Int16，x 最快，与内部约定一致）。
 */

import { surfaceNets } from '/lib/view/surface.js';

/* ---------------------------------------------------------------- 数学 */

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
    out[0] = 2 / (right - left);
    out[5] = 2 / (top - bottom);
    out[10] = -2 / (far - near);
    out[12] = -(right + left) / (right - left);
    out[13] = -(top + bottom) / (top - bottom);
    out[14] = -(far + near) / (far - near);
    out[15] = 1;
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

const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
function normalize(v) {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/* ---------------------------------------------------------------- 着色器 */

const MESH_VS = `
attribute vec3 aPos; attribute vec3 aNormal;
uniform mat4 uMVP; uniform mat4 uModelView;
varying vec3 vNormal; varying vec3 vView;
void main() {
  vec4 mv = uModelView * vec4(aPos, 1.0);
  vView = mv.xyz;
  vNormal = mat3(uModelView) * aNormal;
  gl_Position = uMVP * vec4(aPos, 1.0);
}`;

const MESH_FS = `
precision mediump float;
uniform vec3 uColor; uniform float uAlpha;
varying vec3 vNormal; varying vec3 vView;
void main() {
  vec3 n = normalize(vNormal);
  vec3 v = normalize(-vView);
  float diff = max(dot(n, normalize(vec3(0.35, 0.5, 0.8))), 0.0);
  float back = max(dot(-n, normalize(vec3(0.35, 0.5, 0.8))), 0.0);
  float rim = pow(1.0 - abs(dot(n, v)), 2.2);
  vec3 c = uColor * (0.35 + 0.65 * max(diff, back * 0.35)) + vec3(rim * 0.18);
  gl_FragColor = vec4(c, uAlpha);
}`;

const POINT_VS = `
attribute vec3 aPos; attribute float aRadius; attribute vec3 aColor;
uniform mat4 uMVP; uniform mat4 uModelView;
uniform float uProjScale; uniform float uOrthoPix; uniform float uOrtho;
varying vec3 vColor;
void main() {
  vec4 mv = uModelView * vec4(aPos, 1.0);
  vColor = aColor;
  float size = uOrtho > 0.5 ? aRadius * uOrthoPix : aRadius * uProjScale / max(0.001, -mv.z);
  gl_PointSize = clamp(size, 1.0, 320.0);
  gl_Position = uMVP * vec4(aPos, 1.0);
}`;

const POINT_FS = `
precision mediump float;
varying vec3 vColor;
uniform vec3 uLight;
void main() {
  vec2 d = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(d, d);
  if (r2 > 1.0) discard;
  vec3 n = vec3(d.x, -d.y, sqrt(max(0.0, 1.0 - r2)));
  float diff = max(dot(n, normalize(uLight)), 0.0);
  float spec = pow(max(dot(n, normalize(uLight + vec3(0.0, 0.0, 1.0))), 0.0), 24.0);
  vec3 c = vColor * (0.45 + 0.55 * diff) + vec3(spec * 0.35);
  gl_FragColor = vec4(c, 1.0);
}`;

/* ---------------------------------------------------------------- 元素 */

const ELEMENT_COLORS = {
  H: [0.93, 0.93, 0.93], C: [0.28, 0.28, 0.30], N: [0.25, 0.35, 0.85],
  O: [0.85, 0.25, 0.25], F: [0.35, 0.75, 0.45], S: [0.85, 0.75, 0.25],
  P: [0.95, 0.55, 0.2], Cl: [0.35, 0.75, 0.35], Br: [0.6, 0.35, 0.2], I: [0.5, 0.3, 0.7],
};
const ELEMENT_RADIUS = { H: 0.30, C: 0.36, N: 0.36, O: 0.35, F: 0.33, S: 0.42, P: 0.42, Cl: 0.40, Br: 0.44, I: 0.48 };

function dequantize(int16, min, max) {
  const span = max - min;
  const out = new Float32Array(int16.length);
  if (span === 0) return out;
  const scale = span / 65535;
  for (let i = 0; i < int16.length; i += 1) out[i] = (int16[i] + 32768) * scale + min;
  return out;
}

/* ---------------------------------------------------------------- 骨架 */

function buildSkeleton(meta) {
  const atoms = meta.atoms ?? [];
  const bonds = meta.bonds ?? [];
  const positions = [];
  const normals = [];
  const indices = [];

  const push = (p, n) => {
    positions.push(p[0], p[1], p[2]);
    normals.push(n[0], n[1], n[2]);
  };

  for (const [i, j] of bonds) {
    const a = atoms[i];
    const b = atoms[j];
    if (!a || !b) continue;
    const dir = [b.x - a.x, b.y - a.y, b.z - a.z];
    const len = Math.hypot(...dir) || 1;
    const n = [dir[0] / len, dir[1] / len, dir[2] / len];
    const up = Math.abs(n[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    const u = normalize(cross(n, up));
    const v = normalize(cross(n, u));
    const r = 0.09;
    const seg = 6;
    const base = positions.length / 3;
    for (let k = 0; k < seg; k += 1) {
      const ang = (k / seg) * Math.PI * 2;
      const off = [
        (u[0] * Math.cos(ang) + v[0] * Math.sin(ang)) * r,
        (u[1] * Math.cos(ang) + v[1] * Math.sin(ang)) * r,
        (u[2] * Math.cos(ang) + v[2] * Math.sin(ang)) * r,
      ];
      const nrm = normalize(off);
      push([a.x + off[0], a.y + off[1], a.z + off[2]], nrm);
      push([b.x + off[0], b.y + off[1], b.z + off[2]], nrm);
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

  const pointData = [];
  for (const atom of atoms) {
    if (!atom) continue;
    const c = ELEMENT_COLORS[atom.element] ?? [0.6, 0.6, 0.6];
    const r = ELEMENT_RADIUS[atom.element] ?? 0.35;
    pointData.push(atom.x, atom.y, atom.z, r, c[0], c[1], c[2], atom.element === 'H' ? 1 : 0);
  }

  return {
    bondMesh: { positions: new Float32Array(positions), normals: new Float32Array(normals), indices: new Uint32Array(indices) },
    atomPoints: new Float32Array(pointData),
  };
}

/* ---------------------------------------------------------------- WebGL 工具 */

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
  return shader;
}

function program(gl, vsSource, fsSource, attribs = []) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vsSource));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fsSource));
  // 属性位置必须显式绑定，否则链接器分配的位置和下面写死的 0/1/2 对不上。
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

/* ---------------------------------------------------------------- 颜色 */

function toHex(rgb) {
  const h = (v) => Math.round(clamp(v, 0, 1) * 255).toString(16).padStart(2, '0');
  return `#${h(rgb[0])}${h(rgb[1])}${h(rgb[2])}`;
}
function fromHex(hex) {
  const v = parseInt(hex.replace('#', ''), 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

/* ---------------------------------------------------------------- 主程序 */

async function main() {
  const loading = document.getElementById('loading');
  const canvas = document.getElementById('gl');
  const panel = document.getElementById('panel');

  let meta;
  try {
    meta = await (await fetch('/data/meta.json')).json();
  } catch (error) {
    loading.innerHTML = `<div class="error">读不到 /data/meta.json：${error.message}</div>`;
    return;
  }

  document.getElementById('title').textContent = meta.title ?? meta.name ?? '结构视图';
  const m = meta.metrics ?? {};
  const metricLine = [
    m.integralHole != null ? `Integral ${Number(m.integralHole).toFixed(3)}` : '',
    m.sr != null ? `Sr ${Number(m.sr).toFixed(3)}` : '',
    m.dIndex != null ? `D ${Number(m.dIndex).toFixed(2)} Å` : '',
  ].filter(Boolean).join(' · ');
  document.getElementById('meta').textContent =
    `${meta.atoms.length} 原子 · ${meta.bonds.length} 键${metricLine ? ` · ${metricLine}` : ''}`;

  const gl = canvas.getContext('webgl2', { antialias: true, alpha: false, preserveDrawingBuffer: true });
  if (!gl) {
    loading.innerHTML = '<div class="error">这个环境不支持 WebGL2</div>';
    return;
  }

  const meshProgram = program(gl, MESH_VS, MESH_FS, ['aPos', 'aNormal']);
  const pointProgram = program(gl, POINT_VS, POINT_FS, ['aPos', 'aRadius', 'aColor']);

  const volumes = [];
  for (const spec of meta.volumes) {
    const buf = await (await fetch(`/data/${spec.file}`)).arrayBuffer();
    volumes.push({
      spec,
      field: dequantize(new Int16Array(buf), spec.min, spec.max),
      visible: true,
      iso: spec.iso ?? 0.003,
      color: spec.color ?? [0.85, 0.25, 0.25],
      alpha: 0.5,
    });
  }

  const skeleton = buildSkeleton(meta);

  const box = { min: [1e9, 1e9, 1e9], max: [-1e9, -1e9, -1e9] };
  for (const atom of meta.atoms) {
    box.min[0] = Math.min(box.min[0], atom.x); box.max[0] = Math.max(box.max[0], atom.x);
    box.min[1] = Math.min(box.min[1], atom.y); box.max[1] = Math.max(box.max[1], atom.y);
    box.min[2] = Math.min(box.min[2], atom.z); box.max[2] = Math.max(box.max[2], atom.z);
  }
  const center = [(box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2, (box.min[2] + box.max[2]) / 2];
  const radius = Math.max(box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]) * 0.75 + 1;
  const HOME = { yaw: -0.35, pitch: 0.35, distance: radius * 2.3 };

  const camera = { yaw: HOME.yaw, pitch: HOME.pitch, distance: HOME.distance, target: center.slice(), ortho: false, background: [1, 1, 1] };
  const view = new Float32Array(16);
  const proj = new Float32Array(16);
  const mvp = new Float32Array(16);
  const modelView = new Float32Array(16);
  let spinning = false;
  let dirty = true;

  const meshOf = (v) => surfaceNets(v.field, v.spec.dims, v.iso, v.spec.origin, v.spec.spacing);

  // 初次网格化
  for (const v of volumes) {
    const t0 = performance.now();
    v.mesh = meshOf(v);
    v.meshMs = performance.now() - t0;
  }

  /* ---- UI ---- */

  const volumeBox = document.getElementById('volumes');
  for (const v of volumes) {
    const wrap = document.createElement('div');
    wrap.className = 'group';
    wrap.innerHTML = `
      <div class="row"><label><input type="checkbox" checked data-role="show" /> ${escapeHtml(v.spec.label)}</label>
        <input type="color" data-role="color" value="${toHex(v.color)}" /></div>
      <input type="range" data-role="iso" min="0.0002" max="${(v.spec.max * 0.35).toFixed(4)}" step="0.0001" value="${v.iso}" />
      <div class="row"><span class="value" data-role="isoLabel">${v.iso.toFixed(4)}</span>
        <span class="value" data-role="triLabel">${v.mesh.triangles.toLocaleString()} 面</span></div>
      <input type="range" data-role="alpha" min="0.05" max="1" step="0.01" value="${v.alpha}" />`;
    volumeBox.appendChild(wrap);

    wrap.querySelector('[data-role="show"]').addEventListener('change', (e) => { v.visible = e.target.checked; dirty = true; });
    wrap.querySelector('[data-role="color"]').addEventListener('input', (e) => { v.color = fromHex(e.target.value); dirty = true; });
    wrap.querySelector('[data-role="alpha"]').addEventListener('input', (e) => { v.alpha = Number(e.target.value); dirty = true; });

    const iso = wrap.querySelector('[data-role="iso"]');
    let timer = null;
    iso.addEventListener('input', (e) => {
      v.iso = Number(e.target.value);
      wrap.querySelector('[data-role="isoLabel"]').textContent = v.iso.toFixed(4);
      clearTimeout(timer);
      timer = setTimeout(() => {
        const t0 = performance.now();
        v.mesh = meshOf(v);
        v.gpu = createMesh(gl, v.mesh);
        wrap.querySelector('[data-role="triLabel"]').textContent = `${v.mesh.triangles.toLocaleString()} 面`;
        console.debug(`[viewer] remesh ${(performance.now() - t0).toFixed(0)} ms`);
        dirty = true;
      }, 40);
    });
  }

  document.getElementById('skeleton').addEventListener('change', () => { dirty = true; });

  for (const btn of document.querySelectorAll('[data-bg]')) {
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-bg]').forEach((b) => b.classList.toggle('active', b === btn));
      camera.background = fromHex(btn.dataset.bg);
      dirty = true;
    });
  }
  for (const btn of document.querySelectorAll('[data-proj]')) {
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-proj]').forEach((b) => b.classList.toggle('active', b === btn));
      camera.ortho = btn.dataset.proj === 'ortho';
      dirty = true;
    });
  }

  document.getElementById('reset').addEventListener('click', () => {
    camera.yaw = HOME.yaw; camera.pitch = HOME.pitch; camera.distance = HOME.distance; dirty = true;
  });
  const spinBtn = document.getElementById('spin');
  spinBtn.addEventListener('click', () => {
    spinning = !spinning;
    spinBtn.classList.toggle('active', spinning);
    if (spinning) requestAnimationFrame(tick);
  });
  document.getElementById('shot').addEventListener('click', () => exportPng(2));

  /* ---- 交互 ---- */

  let drag = null;
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    canvas.classList.add('dragging');
    drag = { x: e.clientX, y: e.clientY, button: e.button };
  });
  canvas.addEventListener('pointerup', (e) => {
    canvas.releasePointerCapture(e.pointerId);
    canvas.classList.remove('dragging');
    drag = null;
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    drag.x = e.clientX; drag.y = e.clientY;
    if (drag.button === 2) {
      pan(dx, dy);
    } else {
      camera.yaw -= dx * 0.01;
      camera.pitch = clamp(camera.pitch + dy * 0.01, -1.5, 1.5);
    }
    dirty = true;
  });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    camera.distance *= Math.exp(e.deltaY * 0.0012);
    dirty = true;
  }, { passive: false });

  window.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement) return;
    if (e.key === 'r' || e.key === 'R') { camera.yaw = HOME.yaw; camera.pitch = HOME.pitch; camera.distance = HOME.distance; dirty = true; }
    if (e.key === 'w' || e.key === 'W') { camera.background = [1, 1, 1]; dirty = true; }
    if (e.key === 'b' || e.key === 'B') { camera.background = [0.06, 0.07, 0.09]; dirty = true; }
    if (e.key === ' ') {
      spinning = !spinning;
      spinBtn.classList.toggle('active', spinning);
      if (spinning) requestAnimationFrame(tick);
      e.preventDefault();
    }
    if (e.key === '+' || e.key === '=') nudgeIso(1.15);
    if (e.key === '-') nudgeIso(1 / 1.15);
  });

  function nudgeIso(factor) {
    for (const v of volumes) {
      v.iso = Math.max(0.0002, v.iso * factor);
      v.mesh = meshOf(v);
      v.gpu = createMesh(gl, v.mesh);
    }
    dirty = true;
  }

  function pan(dx, dy) {
    const eye = eyePosition();
    const forward = normalize([camera.target[0] - eye[0], camera.target[1] - eye[1], camera.target[2] - eye[2]]);
    const right = normalize(cross(forward, [0, 1, 0]));
    const up = cross(right, forward);
    const scale = camera.distance * 0.0016;
    for (let i = 0; i < 3; i += 1) camera.target[i] += (-dx * right[i] + dy * up[i]) * scale;
  }

  function eyePosition() {
    const cp = Math.cos(camera.pitch);
    return [
      camera.target[0] + camera.distance * cp * Math.sin(camera.yaw),
      camera.target[1] + camera.distance * Math.sin(camera.pitch),
      camera.target[2] + camera.distance * cp * Math.cos(camera.yaw),
    ];
  }

  /* ---- 绘制 ---- */

  const bond = createMesh(gl, skeleton.bondMesh);
  const atomBuf = createPoints(gl, skeleton.atomPoints);
  for (const v of volumes) v.gpu = createMesh(gl, v.mesh);

  function resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.floor(canvas.clientWidth * dpr);
    canvas.height = Math.floor(canvas.clientHeight * dpr);
    dirty = true;
  }
  window.addEventListener('resize', resize);
  resize();

  function draw() {
    const w = canvas.width;
    const h = canvas.height;
    gl.viewport(0, 0, w, h);
    gl.clearColor(camera.background[0], camera.background[1], camera.background[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);

    const eye = eyePosition();
    mat4.lookAt(view, eye, camera.target, [0, 1, 0]);
    const aspect = w / Math.max(1, h);
    if (camera.ortho) {
      const halfH = camera.distance * 0.45;
      mat4.ortho(proj, -halfH * aspect, halfH * aspect, -halfH, halfH, 0.1, camera.distance * 8);
    } else {
      mat4.perspective(proj, (40 * Math.PI) / 180, aspect, 0.1, camera.distance * 8);
    }
    mat4.multiply(mvp, proj, view);
    mat4.multiply(modelView, view, IDENTITY);

    if (document.getElementById('skeleton').checked) {
      gl.useProgram(meshProgram.program);
      gl.uniformMatrix4fv(meshProgram.u.uMVP, false, mvp);
      gl.uniformMatrix4fv(meshProgram.u.uModelView, false, modelView);
      gl.uniform3f(meshProgram.u.uColor, 0.62, 0.64, 0.68);
      gl.uniform1f(meshProgram.u.uAlpha, 1);
      gl.disable(gl.BLEND);
      gl.depthMask(true);
      gl.bindVertexArray(bond.vao);
      gl.drawElements(gl.TRIANGLES, bond.count, gl.UNSIGNED_INT, 0);

      gl.useProgram(pointProgram.program);
      gl.uniformMatrix4fv(pointProgram.u.uMVP, false, mvp);
      gl.uniformMatrix4fv(pointProgram.u.uModelView, false, modelView);
      gl.uniform1f(pointProgram.u.uProjScale, (h * proj[5]) / 2);
      gl.uniform1f(pointProgram.u.uOrthoPix, h / (camera.distance * 0.9));
      gl.uniform1f(pointProgram.u.uOrtho, camera.ortho ? 1 : 0);
      gl.uniform3f(pointProgram.u.uLight, 0.35, 0.5, 0.8);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.depthMask(true);
      gl.bindVertexArray(atomBuf.vao);
      gl.drawArrays(gl.POINTS, 0, atomBuf.count);
    }

    // 透明面：按离相机远近排序，远的先画
    const ordered = volumes
      .filter((v) => v.visible && v.mesh.triangles > 0)
      .map((v) => ({ v, d: distanceTo(volumeCentroid(v), eye) }))
      .sort((a, b) => b.d - a.d);

    gl.useProgram(meshProgram.program);
    gl.uniformMatrix4fv(meshProgram.u.uMVP, false, mvp);
    gl.uniformMatrix4fv(meshProgram.u.uModelView, false, modelView);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
    gl.disable(gl.CULL_FACE);
    for (const item of ordered) {
      gl.uniform3f(meshProgram.u.uColor, item.v.color[0], item.v.color[1], item.v.color[2]);
      gl.uniform1f(meshProgram.u.uAlpha, item.v.alpha);
      gl.bindVertexArray(item.v.gpu.vao);
      gl.drawElements(gl.TRIANGLES, item.v.gpu.count, gl.UNSIGNED_INT, 0);
    }
    gl.depthMask(true);
    gl.enable(gl.CULL_FACE);
  }

  function volumeCentroid(v) {
    const [nx, ny, nz] = v.spec.dims;
    const [ox, oy, oz] = v.spec.origin;
    const [dx, dy, dz] = v.spec.spacing;
    return [ox + (nx / 2) * dx, oy + (ny / 2) * dy, oz + (nz / 2) * dz];
  }
  function distanceTo(p, eye) {
    return Math.hypot(p[0] - eye[0], p[1] - eye[1], p[2] - eye[2]);
  }

  function tick() {
    if (!spinning) return;
    camera.yaw += 0.006;
    dirty = true;
    if (dirty) { draw(); dirty = false; }
    requestAnimationFrame(tick);
  }

  function loop() {
    if (dirty) { draw(); dirty = false; }
    requestAnimationFrame(loop);
  }

  function exportPng(scale) {
    const cw = canvas.width;
    const ch = canvas.height;
    canvas.width = Math.floor(canvas.clientWidth * scale);
    canvas.height = Math.floor(canvas.clientHeight * scale);
    draw();
    const url = canvas.toDataURL('image/png');
    canvas.width = cw;
    canvas.height = ch;
    draw();
    const a = document.createElement('a');
    a.href = url;
    a.download = `${meta.name ?? 'structure'}.png`;
    a.click();
  }

  window.__CHEM_VIEW__ = { meta, volumes, camera, draw, exportPng };

  loading.hidden = true;
  panel.hidden = false;
  draw();
  requestAnimationFrame(loop);
  console.debug('[viewer] ready', volumes.map((v) => `${v.spec.name}:${v.mesh.triangles}t/${v.meshMs.toFixed(0)}ms`).join(' '));

  if (new URLSearchParams(location.search).has('autoshot')) {
    setTimeout(async () => {
      try {
        draw();
        await fetch('/shot', { method: 'POST', body: canvas.toDataURL('image/png') });
      } catch (error) {
        console.error('[viewer] autoshot failed', error);
      }
    }, 600);
  }
}

main().catch((error) => {
  document.getElementById('loading').innerHTML = `<div class="error">${escapeHtml(error.stack ?? error.message)}</div>`;
  console.error(error);
});
