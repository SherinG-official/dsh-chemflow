import assert from 'node:assert/strict'
import test from 'node:test'

/**
 * 客户端**兼容性**测试：视图包格式是演进的（volumes 早先叫 hole/electron，
 * dipole / colorBy / visible 都是后加的），面板必须能吃下老包、半残包、手写包，
 * 而不是白屏。
 *
 * 这里只测不依赖 WebGL 的部分：meta 归一化 + 色标。
 */
let internals
globalThis.window = {
  __ModuleLoader__: {
    load({ factory }) {
      internals = factory((name) => {
        if (name === 'react') return { createElement: () => null, useRef: () => ({}), useEffect: () => {} }
        throw new Error(`unexpected require: ${name}`)
      }).__internals
    },
  },
}
await import('../lib/client.js')

test('老包（只有 atoms/bonds，没有 volumes 字段）不抛错', () => {
  const meta = internals.normalizeMeta({
    name: 'legacy',
    atoms: [{ element: 'C', x: 0, y: 0, z: 0 }],
    bonds: [],
  })
  assert.deepEqual(meta.volumes, [])
  assert.equal(meta.atoms.length, 1)
  assert.deepEqual(meta.metrics, {})
  assert.equal(meta.dipole, undefined)
})

test('空对象 / null / 非对象都收敛成空包', () => {
  for (const input of [{}, null, undefined, 42, 'x', []]) {
    const meta = internals.normalizeMeta(input)
    assert.deepEqual(meta.atoms, [])
    assert.deepEqual(meta.bonds, [])
    assert.deepEqual(meta.volumes, [])
    assert.deepEqual(meta.metrics, {})
  }
})

test('坏条目被过滤掉，而不是让渲染层崩', () => {
  const meta = internals.normalizeMeta({
    atoms: [{ element: 'C', x: 0, y: 0, z: 0 }, { element: 'H' }, null],
    bonds: [[0, 1], [0], ['a', 'b'], null],
    volumes: [
      { file: 'ok.bin', dims: [4, 4, 4], origin: [0, 0, 0], spacing: [1, 1, 1] },
      { file: 'no-dims.bin' },
      { dims: [4, 4, 4], origin: [0, 0, 0], spacing: [1, 1, 1] },
      null,
    ],
  })
  assert.equal(meta.atoms.length, 1)
  assert.equal(meta.bonds.length, 1)
  assert.equal(meta.volumes.length, 1)
  assert.equal(meta.volumes[0].file, 'ok.bin')
  // 缺的数值字段要补成安全默认值，否则滑块 min/max 是 NaN
  assert.equal(meta.volumes[0].label, '体数据')
  assert.equal(meta.volumes[0].iso, 0.02)
  assert.equal(meta.volumes[0].min, 0)
  assert.equal(meta.volumes[0].max, 1)
})

test('偶极矩字段缺失或坏掉时不画箭头', () => {
  assert.equal(internals.normalizeMeta({ dipole: null }).dipole, undefined)
  assert.equal(internals.normalizeMeta({ dipole: { vector: [1, 0] } }).dipole, undefined)
  assert.equal(internals.normalizeMeta({ dipole: { vector: [1, 0, 0] } }).dipole, undefined)
  assert.equal(
    internals.normalizeMeta({ dipole: { vector: [1, 'x', 0], origin: [0, 0, 0] } }).dipole,
    undefined,
  )

  const ok = internals.normalizeMeta({
    dipole: { origin: [0, 0, 0], vector: [1, 0, 0], magnitude: 2.5 },
  })
  assert.equal(ok.dipole.magnitude, 2.5)
})

test('未知字段原样保留（向前兼容未来的 pack 字段）', () => {
  const meta = internals.normalizeMeta({ futureField: { a: 1 } })
  assert.deepEqual(meta.futureField, { a: 1 })
})

test('色标在 0/0.5/1 三点行为稳定，越界被钳住', () => {
  const low = internals.divergingColor(0)
  const mid = internals.divergingColor(0.5)
  const high = internals.divergingColor(1)
  assert.ok(low[2] > low[0], '低端应偏蓝')
  assert.ok(high[0] > high[2], '高端应偏红')
  assert.ok(Math.abs(mid[0] - mid[2]) < 0.05, '中点是中性灰')
  assert.deepEqual(internals.divergingColor(-5), low)
  assert.deepEqual(internals.divergingColor(5), high)
})

test('体数据采样越界时钳到边界，不返回 null/NaN', () => {
  // 2x2x2 的线性场：f = x
  const field = new Float32Array([0, 1, 0, 1, 0, 1, 0, 1])
  const volume = {
    spec: { dims: [2, 2, 2], origin: [0, 0, 0], spacing: [1, 1, 1] },
    field,
  }
  assert.equal(internals.sampleVolume(volume, 0, 0, 0), 0)
  assert.equal(internals.sampleVolume(volume, 1, 0, 0), 1)
  const outside = internals.sampleVolume(volume, 99, 99, 99)
  assert.ok(Number.isFinite(outside))
  assert.equal(outside, 1)
})
