/**
 * 测试用 ESM loader：把宿主才有的两个裸包名映射到本地桩。
 *
 * 为什么需要：`@deepseek-ai/dsh-tools` 与 `@deepseek-ai/schemastery` 由 DSH 宿主在运行时
 * 提供，插件目录里没有、也不该有（有的话会反过来遮蔽宿主真正的那份）。所以做离线测试
 * 只能靠 loader 重定向，而不是往 node_modules 里塞假的。
 */

export async function resolve(specifier, context, next) {
  if (specifier === '@deepseek-ai/dsh-tools') {
    return { url: new URL('./stub-tools.mjs', import.meta.url).href, shortCircuit: true }
  }
  if (specifier === '@deepseek-ai/schemastery') {
    return { url: new URL('./stub-schemastery.mjs', import.meta.url).href, shortCircuit: true }
  }
  return next(specifier, context)
}
