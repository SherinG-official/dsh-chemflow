import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { register } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

// 宿主才有的包（@deepseek-ai/dsh-tools、schemastery）用测试 loader 映射到桩。
register(new URL('./loader.mjs', import.meta.url))

/**
 * `chem_views` —— 列表管理。用临时 dataDir，不碰用户真实列表。
 */
const dir = mkdtempSync(path.join(tmpdir(), 'chemflow-views-'))
process.on('exit', () => rmSync(dir, { recursive: true, force: true }))

const { createHarness } = await import('./harness.mjs')
const harness = await createHarness({ config: { dataDir: dir } })

const packDir = path.join(dir, 'demo.view')
mkdirSync(packDir, { recursive: true })
const metaPath = path.join(packDir, 'meta.json')
writeFileSync(metaPath, JSON.stringify({ title: '演示包', atoms: [], volumes: [] }), 'utf8')

test('add：加一条并出现在 list 里', async () => {
  const added = await harness.call('chem_views', { action: 'add', metaPath })
  assert.match(added.message, /已加入列表/)
  const list = await harness.call('chem_views', { action: 'list' })
  assert.match(list.message, /演示包/)
  assert.match(list.message, /✓/)
})

test('add：给 .view 目录也认', async () => {
  const result = await harness.call('chem_views', { action: 'add', metaPath: packDir })
  assert.match(result.message, /已加入列表/)
})

test('remove：按序号删', async () => {
  const result = await harness.call('chem_views', { action: 'remove', index: 1 })
  assert.match(result.message, /已从列表移除/)
  const list = await harness.call('chem_views', { action: 'list' })
  assert.doesNotMatch(list.message, /演示包/)
})

test('remove：按标题子串删', async () => {
  await harness.call('chem_views', { action: 'add', metaPath })
  const result = await harness.call('chem_views', { action: 'remove', match: '演示' })
  assert.match(result.message, /已从列表移除/)
})

test('prune：清掉文件已不存在的条目', async () => {
  await harness.call('chem_views', { action: 'add', metaPath })
  rmSync(packDir, { recursive: true, force: true })
  const result = await harness.call('chem_views', { action: 'prune' })
  assert.match(result.message, /移除 1 条/)
})

test('add：文件不存在时报错而不是静默', async () => {
  const result = await harness.call('chem_views', { action: 'add', metaPath: path.join(dir, 'nope.view', 'meta.json') })
  assert.match(result.message, /找不到/)
})
