/**
 * 工具级测试（不重启 DSH，用宿主桩直接调工具）。
 *
 *   node --import ./test/register.mjs test/run-tools.mjs env
 *   node --import ./test/register.mjs test/run-tools.mjs states
 *   node --import ./test/register.mjs test/run-tools.mjs gate
 *   node --import ./test/register.mjs test/run-tools.mjs hole <outDir> [state]
 *   node --import ./test/register.mjs test/run-tools.mjs multiwfn <outDir>
 */

import path from 'node:path'

import { createHarness } from './harness.mjs'

const scenario = process.argv[2] ?? 'env'
const WORK = 'C:\\Users\\SherinG\\Documents\\USTC project\\PCTC\\calc\\multiwfn'
const TDA_INPUT = path.join(WORK, 'complex_tda.molden.input')
const TDA_OUT = path.join(WORK, 'complex_tda.molden.out')
const FULL_TD_OUT = path.join(WORK, 'complex_tddft2.out')

const h = await createHarness({
  config: {
    sshHost: '114.214.201.249',
    sshPort: 520,
    sshUsername: 'SherinG',
    sshPassword: process.env.PW ?? '',
  },
})

if (scenario === 'env') {
  console.log('注册的工具：', h.names.join('、'))
  const r = await h.call('chem_env', { action: 'local' })
  console.log(`--- chem_env (${r.ms} ms, ok=${r.ok}) ---\n${r.message}`)
}

if (scenario === 'ssh') {
  const r = await h.call('chem_env', { action: 'ssh' })
  console.log(`--- chem_env ssh (${r.ms} ms, ok=${r.ok}) ---\n${r.message}`)
}

if (scenario === 'states') {
  const r = await h.call('chem_orca_states', { file: TDA_OUT, maxStates: 5 })
  console.log(`--- TDA 输出 (${r.ms} ms, ok=${r.ok}) ---\n${r.message}`)
  const bad = await h.call('chem_orca_states', { file: FULL_TD_OUT, maxStates: 3 })
  console.log(`\n--- 全 TD 输出 (ok=${bad.ok}) ---\n${bad.message}`)
}

if (scenario === 'gate') {
  const r = await h.call('chem_hole_electron', {
    file: TDA_INPUT,
    state: 3,
    outFile: FULL_TD_OUT,
    outDir: path.join(process.env.TEMP, 'chemflow-gate'),
  })
  console.log(`--- 全 TD 闸门 (ok=${r.ok}) ---\n${r.message}`)
}

if (scenario === 'hole') {
  const outDir = process.argv[3] ?? path.join(process.env.TEMP, 'chemflow-tools')
  const state = Number(process.argv[4] ?? 3)
  const r = await h.call('chem_hole_electron', { file: TDA_INPUT, state, outDir, render: true })
  console.log(`--- chem_hole_electron (${r.ms} ms, ok=${r.ok}) ---\n${r.message}`)
}

if (scenario === 'multiwfn') {
  const outDir = process.argv[3] ?? path.join(process.env.TEMP, 'chemflow-mf')
  const r = await h.call('chem_multiwfn', {
    file: 'D:\\Program Files\\Multiwfn\\examples\\phenanthrene.fch',
    recipe: 'q',
    outDir,
  })
  console.log(`--- chem_multiwfn (${r.ms} ms, ok=${r.ok}) ---\n${r.message}`)
}

if (scenario === 'orbital') {
  const outDir = process.argv[3] ?? path.join(process.env.TEMP, 'chemflow-orb')
  const r = await h.call('chem_orbital', {
    file: 'D:\\Program Files\\Multiwfn\\examples\\phenanthrene.fch',
    orbital: 'h',
    outDir,
    render: true,
  })
  console.log(`--- chem_orbital (${r.ms} ms, ok=${r.ok}) ---\n${r.message}`)
}

if (scenario === 'aromatic') {
  const outDir = process.argv[3] ?? path.join(process.env.TEMP, 'chemflow-aro')
  const r = await h.call('chem_aromatic', {
    file: 'D:\\Program Files\\Multiwfn\\examples\\phenanthrene.fch',
    rings: ['1,2,3,4,5,6'],
    outDir,
  })
  console.log(`--- chem_aromatic (${r.ms} ms, ok=${r.ok}) ---\n${r.message}`)
}

if (scenario === 'esp') {
  const outDir = process.argv[3] ?? path.join(process.env.TEMP, 'chemflow-esp')
  const r = await h.call('chem_esp', {
    file: 'D:\\Program Files\\Multiwfn\\examples\\phenanthrene.fch',
    outDir,
  })
  console.log(`--- chem_esp (${r.ms} ms, ok=${r.ok}) ---\n${r.message}`)
}

if (scenario === 'view') {
  const outDir = process.argv[3] ?? path.join(process.cwd(), 'run', 'view-test')
  const r = await h.call('chem_view', {
    hole: path.join(WORK, 'hole.cub'),
    electron: path.join(WORK, 'electron.cub'),
    outDir,
    name: 'complex_tda-s3',
    title: 'complex_tda · 第 3 激发态',
  })
  console.log(`--- chem_view (${r.ms} ms, ok=${r.ok}) ---\n${r.message}`)
}
