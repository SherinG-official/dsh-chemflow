/**
 * 工具的公共输出契约。
 *
 * 所有工具返回 `{ ok, message }`：`render` 只把 `message` 交给模型。
 * 失败也走**正常返回值**而不是抛异常 —— 「文件不存在」「TDA 没开」「超时」都属于
 * 「工具没办成事」，不该把整轮对话打断，也不该让模型以为是自己的参数写错了。
 *
 * 图片不内联：返回里给路径，模型用 read_image 自己看。这样少一条附件服务依赖，
 * 也避免「图其实没生成、但卡片里显示了一张旧图」这类误判。
 *
 * @module dsh-chemflow/tools/shared
 */

/**
 * @param {(args: any, value: any) => string} [compose]
 */
export function textOutput(compose) {
  return {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ok: { type: 'boolean', required: true },
        message: { type: 'string', required: true },
      },
    },
    render(args, value) {
      const text = compose ? compose(args, value) : value.message
      return [{ type: 'text', text: text === '' ? (value.ok ? '完成。' : '操作未完成。') : text }]
    },
  }
}

/** @param {string} message */
export function ok(message) {
  return { ok: true, message }
}

/** @param {string} message */
export function fail(message) {
  return { ok: false, message }
}

/**
 * 异常 → 可读失败信息（不把堆栈甩给模型）。
 *
 * @param {unknown} error
 */
export function failFrom(error) {
  const detail = error instanceof Error ? error.message : String(error)
  return fail(`操作失败：${detail}`)
}

/**
 * 列对齐成纯文本表格。
 *
 * @param {Array<Array<string|number>>} rows 第一行是表头
 */
export function formatTable(rows) {
  if (rows.length === 0) return ''
  const widths = []
  for (const row of rows) {
    row.forEach((cell, index) => {
      widths[index] = Math.max(widths[index] ?? 0, String(cell).length)
    })
  }
  return rows.map((row) => row.map((cell, index) => String(cell).padEnd(widths[index])).join('  ').trimEnd()).join('\n')
}

/**
 * 把字节数变成人读的大小。
 *
 * @param {number} bytes
 */
export function humanBytes(bytes) {
  if (!Number.isFinite(bytes)) return '?'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}
