import assert from 'node:assert/strict'
import test from 'node:test'

import { classifyExcitation, parseMultiwfnLog } from '../lib/parse/multiwfn.js'
import { parseOrcaOut, statesToCsv } from '../lib/parse/orca.js'

const MULTIWFN_LOG = `
 Loading configuration coefficients of excited state   3...
 Sum of square of excitation coefficients:  0.465935
 Number of points in X,Y,Z is  149  128   93   Total:     1773696
 Integral of hole:        0.931875
 Integral of electron:    0.931871
 Integral of transition density:    0.000021
 Sm index (integral of Sm function):   0.47538 a.u.
 Sr index (integral of Sr function):   0.68623 a.u.
 Centroid of hole in X/Y/Z:       -0.141880    1.926005    0.104470 Angstrom
 Centroid of electron in X/Y/Z:   -1.009746    1.294064   -0.071568 Angstrom
 D_x:   0.868  D_y:   0.632  D_z:   0.176    D index:   1.088 Angstrom
 H_x:  2.928  H_y:  1.740  H_z:  1.584  H_CT:  2.558  H index:  3.797 Angstrom
 t index: -1.470 Angstrom
 Hole delocalization index (HDI):       5.71
 Electron delocalization index (EDI):       5.19
 Done!
 Done!
`

test('parseMultiwfnLog 抽出 hole/electron 指标', () => {
  const { metrics, issues, ok } = parseMultiwfnLog(MULTIWFN_LOG)
  assert.equal(ok, true)
  assert.deepEqual(issues, [])
  assert.equal(metrics.state, 3)
  assert.equal(metrics.gridPoints, 1773696)
  assert.equal(metrics.integralHole, 0.931875)
  assert.equal(metrics.integralElectron, 0.931871)
  assert.equal(metrics.sr, 0.68623)
  assert.equal(metrics.sm, 0.47538)
  assert.equal(metrics.dIndex, 1.088)
  assert.equal(metrics.hdi, 5.71)
  assert.equal(metrics.edi, 5.19)
  assert.deepEqual(metrics.centroidHole, [-0.14188, 1.926005, 0.10447])
})

test('parseMultiwfnLog 认得出「积分 0 = 全 TD 硬凑」并报警', () => {
  const { issues, ok } = parseMultiwfnLog(' Integral of hole:        0.000000\n Integral of electron:    0.000000\n')
  assert.equal(ok, false)
  assert.ok(issues.some((i) => i.includes('全 TD')))
})

test('classifyExcitation 按 D / Sr 给判据', () => {
  assert.equal(classifyExcitation({ dIndex: 1.09, sr: 0.69 }).kind, 'LE')
  assert.equal(classifyExcitation({ dIndex: 4.39, sr: 0.1 }).kind, 'CT')
  assert.equal(classifyExcitation({ dIndex: 2.5, sr: 0.4 }).kind, 'mixed')
})

const ORCA_TDA = `
Program Version 5.0.3 -  RELEASE  -
TD-DFT/TDA EXCITED STATES (SINGLETS)
STATE  1:  E=   0.134524 au      3.661 eV    29524.6 cm**-1 <S**2> =   0.000000
   171a -> 172a  :     0.385865 (c= -0.62118043)
   171a -> 173a  :     0.597018 (c=  0.77266908)

  ABSORPTION SPECTRUM VIA TRANSITION ELECTRIC DIPOLE MOMENTS
  -------------------------------------------------------------
  State   Energy    Wavelength  fosc         T2        TX        TY        TZ
          (cm-1)      (nm)                 (au**2)    (au)      (au)      (au)
  -------------------------------------------------------------
     1   29524.6    338.7   0.007074309   0.07888  -0.20342  -0.18319  -0.06279

  -------------------------------------------------------------------
                               CD SPECTRUM
  -------------------------------------------------------------------
  State  Energy     Wavelength     R         MX        MY        MZ
         (cm-1)       (nm)     (1e40*cgs)   (au)      (au)      (au)
  -------------------------------------------------------------------
     1   29524.6    338.7      4.00981  -0.00560  -0.06478   0.07166

****ORCA TERMINATED NORMALLY****
`

test('parseOrcaOut 认出 TDA 并解析组态与谱表', () => {
  const parsed = parseOrcaOut(ORCA_TDA)
  assert.equal(parsed.version, '5.0.3')
  assert.equal(parsed.tda, true)
  assert.equal(parsed.fullTd, false)
  assert.equal(parsed.terminated, true)
  assert.equal(parsed.states.length, 1)

  const state = parsed.states[0]
  assert.equal(state.index, 1)
  assert.equal(state.eV, 3.661)
  assert.equal(state.configs.length, 2)
  assert.equal(state.nm, 338.7)
  assert.equal(state.fosc, 0.007074309)
  assert.equal(state.r, 4.00981)
  // 主导组态按权重排序：171→173 (0.597) 应该排第一
  assert.equal(state.dominant[0].from, '171a')
  assert.equal(state.dominant[0].to, '173a')
})

test('parseOrcaOut 把全 TD 标出来（这是不能接 Multiwfn 的关键判定）', () => {
  const parsed = parseOrcaOut('TD-DFT EXCITED STATES (SINGLETS)\nTERMINATED NORMALLY\n')
  assert.equal(parsed.tda, false)
  assert.equal(parsed.fullTd, true)
  assert.ok(parsed.issues.some((i) => i.includes('全 TD')))
})

test('statesToCsv 输出 Origin 能直接读的表头与行', () => {
  const csv = statesToCsv(parseOrcaOut(ORCA_TDA))
  const lines = csv.trim().split('\n')
  assert.ok(lines[0].startsWith('State,E(eV),Wavelength(nm),fosc'))
  assert.equal(lines.length, 2)
  assert.ok(lines[1].startsWith('1,3.6610,338.7,0.007074'))
})
