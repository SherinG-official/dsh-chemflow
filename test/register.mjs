/**
 * 注册 loader（Node 20+ 的 module.register）。
 *
 * 用法：node --import ./test/register.mjs scripts/xxx.mjs
 */

import { register } from 'node:module'

register('./loader.mjs', import.meta.url)
