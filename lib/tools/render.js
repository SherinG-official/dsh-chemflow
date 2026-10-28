/**
 * `chem_render` —— VMD 出图（等值面 / 球棍）。
 *
 * 参数是声明式的：给文件、阈值、颜色、视角，脚本由插件生成。
 * Windows 版 VMD 只能写 BMP，转换与裁边由 Pillow 完成，返回里带自检数据
 * （尺寸、非白像素占比），模型据此判断是不是空图。
 *
 * @module dsh-chemflow/tools/render
 */

import { existsSync } from 'node:fs'

import { defineTool } from '@deepseek-ai/dsh-tools'

import { runRender } from '../tasks/render.js'
import { fail, humanBytes, ok, textOutput } from './shared.js'

/**
 * @param {any} ctx
 * @param {{ config: Record<string, any> }} deps
 */
export function registerRenderTool(ctx, deps) {
  const { config } = deps

  ctx.tools.register(
    defineTool({
      name: 'chem_render',
      description:
        '用 VMD 渲染论文图：cube（等值面）或 xyz（球棍），可叠加骨架、可指定颜色/视角/尺寸，' +
        '输出 PNG 或 TIFF（自动裁白边）。Windows 版 VMD 只写 BMP，转换由插件内部完成。' +
        '返回里带尺寸与非白像素占比用于判断空图；交付前请用 read_image 看一眼。',
      parameters: {
        files: {
          type: 'array',
          items: { type: 'string' },
          description: '要渲染的文件，1~2 个（如 [hole.cub, electron.cub]，或 [s0.xyz]）。.cub 当体数据，.xyz 当分子。',
          required: true,
        },
        outDir: { type: 'string', description: '产物目录（**由用户指定**，按课题分开）。', required: true },
        style: {
          type: 'string',
          enum: ['isosurface', 'licorice', 'both'],
          description:
            '第一个文件的画法：isosurface=只画等值面；licorice=只画球棍；both=等值面+骨架（最长用）。' +
            '其余文件固定按等值面画。默认 both。',
        },
        iso: { type: 'number', description: '等值面阈值，默认 0.003。数值越小面越胖。' },
        scale: { type: 'number', description: '缩放，默认 1.8。' },
        rotateX: { type: 'number', description: '绕 x 轴旋转角度（度），默认 -12。' },
        rotateY: { type: 'number', description: '绕 y 轴旋转角度（度），默认 8。' },
        width: { type: 'number', description: '画布宽（像素），默认 1600。' },
        height: { type: 'number', description: '画布高（像素），默认 1200。' },
        format: { type: 'string', enum: ['png', 'tiff'], description: '输出格式，默认 png；投稿要 TIFF 时选 tiff。' },
        trim: { type: 'boolean', description: '是否裁掉白边，默认 true。' },
        colorIds: {
          type: 'array',
          items: { type: 'number' },
          description: '各文件用的 ColorID（默认 [21, 31]，已在插件里重定义成红/蓝）。',
        },
      },
      output: textOutput((_args, value) => value.message),
      timeoutMs: 600_000,
      isConcurrencySafe: () => true,
      async execute(args) {
        const files = Array.isArray(args.files) ? args.files : [args.files]
        const missing = files.filter((file) => !existsSync(file))
        if (missing.length > 0) return fail(`这些文件不存在：\n${missing.map((m) => `  ${m}`).join('\n')}`)

        const style = args.style ?? 'both'
        const colorIds = Array.isArray(args.colorIds) && args.colorIds.length > 0 ? args.colorIds : [21, 31]
        const molecules = files.map((file, index) => ({
          file,
          style: index === 0 ? style : 'isosurface',
          iso: args.iso ?? 0.003,
          colorId: colorIds[index] ?? 21,
          material: 'Transparent',
        }))

        const result = await runRender({
          config,
          outDir: args.outDir,
          molecules,
          scale: args.scale ?? 1.8,
          rotate: [
            ['x', args.rotateX ?? -12],
            ['y', args.rotateY ?? 8],
          ],
          size: [args.width ?? 1600, args.height ?? 1200],
          format: args.format ?? 'png',
          trim: args.trim !== false,
        })

        if (!result.ok) {
          const parts = [`✗ 渲染未完成：${result.reason ?? result.issues?.join('；')}`]
          if (result.log) parts.push('', 'VMD 日志末尾：', result.log)
          if (result.runDir) parts.push('', `运行目录：${result.runDir}`)
          return fail(parts.join('\n'))
        }

        return ok(
          [
            `✓ 已渲染：${result.figure.path}（${humanBytes(result.figure.bytes)}）`,
            `尺寸 ${result.size?.[0]}×${result.size?.[1]}，非白像素 ${result.nonWhitePercent}%`,
            `脚本：${result.script}`,
            `run.json：${result.manifestPath}`,
            '',
            '下一步：用 read_image 亲眼看一遍 —— 视角是否把分子切掉、两个等值面是否糊在一起、阈值是否合适，' +
              '这些只有看图能判断。不满意就调 iso / rotateX / rotateY 再渲染一次。',
          ].join('\n'),
        )
      },
    }),
  )
}
