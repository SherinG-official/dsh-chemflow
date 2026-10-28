/**
 * 最小宿主桩：模拟 ctx.tools / ctx.systemPrompt，加载插件并暴露 call()。
 *
 * 这样就能在**不重启 DSH** 的情况下，按真实工具定义跑通每一条路径。
 */

/**
 * @param {{ config?: Record<string, any> }} [options]
 */
export async function createHarness(options = {}) {
  const tools = new Map()
  const sections = []

  const ctx = {
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
      get(name) {
        return tools.get(name)
      },
    },
    systemPrompt: {
      section(section) {
        sections.push(section)
      },
    },
  }

  const plugin = await import('../lib/index.js')
  plugin.apply(ctx, { prompt: false, ...(options.config ?? {}) })

  return {
    ctx,
    tools,
    sections,
    names: [...tools.keys()],
    /** 调一个工具，返回 { ok, message } */
    async call(name, args = {}) {
      const tool = tools.get(name)
      if (!tool) throw new Error(`没有注册这个工具：${name}`)
      const started = Date.now()
      const value = await tool.execute(args, { signal: undefined })
      return { ...value, ms: Date.now() - started }
    },
  }
}
