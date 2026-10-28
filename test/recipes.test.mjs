import assert from 'node:assert/strict'
import test from 'node:test'

import { holeElectronRecipe, recipeToText, validateRecipe } from '../lib/recipes.js'

test('holeElectronRecipe 的形状与实测一致(Multiwfn 3.8)', () => {
  const recipe = holeElectronRecipe({ state: 3, grid: 'high' })
  assert.deepEqual(recipe, ['18', '1', '', '3', '1', '3', '10', '1', '11', '1', '0', '0', '0', 'q'])
  assert.equal(recipeToText(recipe).endsWith('\n'), true)
})

test('网格档位映射：low/medium/high → 1/2/3', () => {
  assert.equal(holeElectronRecipe({ state: 1, grid: 'low' })[5], '1')
  assert.equal(holeElectronRecipe({ state: 1, grid: 'medium' })[5], '2')
  assert.equal(holeElectronRecipe({ state: 1, grid: 'high' })[5], '3')
})

test('未知网格 / 非法态号直接抛', () => {
  assert.throws(() => holeElectronRecipe({ state: 1, grid: 'ultra' }), /未知网格/)
  assert.throws(() => holeElectronRecipe({ state: 0 }), /正整数/)
})

test('validateRecipe 拦住中间出现的 0（会开图形窗口挂死）', () => {
  const bad = ['18', '0', '1', 'q']
  const result = validateRecipe(bad, { allowEmptyAt: [], allowZeroTail: 3 })
  assert.equal(result.ok, false)
  assert.match(result.reason, /显示分子结构/)
})

test('validateRecipe 拦住多余空行（会写出 0 字节 cube）', () => {
  const bad = ['18', '', '1', '', '3', 'q']
  const result = validateRecipe(bad, { allowEmptyAt: [2], allowZeroTail: 3 })
  assert.equal(result.ok, false)
  assert.match(result.reason, /空行/)
})

test('validateRecipe 允许规定的空行与结尾逐层返回', () => {
  const good = holeElectronRecipe({ state: 3 })
  assert.equal(validateRecipe(good, { allowEmptyAt: [2], allowZeroTail: 3 }).ok, true)
})

test('validateRecipe 要求以 q 结尾', () => {
  const result = validateRecipe(['18', '1'], { allowEmptyAt: [] })
  assert.equal(result.ok, false)
  assert.match(result.reason, /q 结尾/)
})
