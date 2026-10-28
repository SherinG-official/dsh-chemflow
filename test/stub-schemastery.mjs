/**
 * `@deepseek-ai/schemastery` 的测试桩。
 *
 * 只为了能 import lib/index.js（它会构造 Config 对象），不校验任何东西。
 * 每个方法都返回同一个链式对象，`.default()/.description()` 之类的调用不会炸。
 */
function chain() {
  const node = {
    default: () => node,
    description: () => node,
    optional: () => node,
    required: () => node,
  }
  return node
}

const z = {
  object: () => chain(),
  string: () => chain(),
  number: () => chain(),
  boolean: () => chain(),
  array: () => chain(),
  union: () => chain(),
}

export default z
