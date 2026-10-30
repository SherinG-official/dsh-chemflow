# dsh-chemflow

[![ci](https://github.com/SherinG-official/dsh-chemflow/actions/workflows/ci.yml/badge.svg)](https://github.com/SherinG-official/dsh-chemflow/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

给 DeepSeek Harness 装一条「**ORCA 计算 → Multiwfn 波函数分析 → VMD 出图**」的链路。
数值图（能级图、棒谱、双 Y、ECD）仍然交给 `dsh-origin-api`；这个插件负责**集群提交**、
**波函数分析**、**结构图渲染**。

## 它解决什么问题

不是"把 exe 包一层"。是把两份实测文档里踩过的坑，变成了代码里的闸门：

| 坑 | 代码里怎么处理 |
|---|---|
| 全 TD 喂给 Multiwfn → 积分 0、D=NaN，**不报错** | 开跑前读 ORCA 输出判定 TDA，全 TD 直接拒绝并给出修法 |
| Multiwfn 回写 `settings.ini` 被拒 → `forrtl: severe (47)` | 每次运行复制 settings.ini 到私有目录，`Multiwfnpath` 指过去 |
| `Multiwfnpath` 超过约 80 字符 → 找不到 settings、多吃一行输入、recipe 全乱 | mfhome 固定用 `%TEMP%\cf\<8位hex>` 这种短路径 |
| 菜单 `0` 在部分层级 = 开图形窗口 → 永久挂住 | recipe 校验硬拒中间出现的 `0` |
| 多余空行被当菜单输入 → cube 写成 0 字节，日志仍打印 "Done!" | 空行白名单 + 产物核对（存在 / 大小 / 头部点数自洽） |
| Multiwfn 找的是 `<stem>.molden.out` 而不是 `<stem>.out` | 回传时自动 `cp out molden.out`；本地缺了就明确告诉你怎么补 |
| Windows 版 VMD 只写 BMP（写 .png 会偷偷写成 BMP） | 固定写 `.bmp`，Pillow 转 PNG/TIFF，顺带裁白边 |
| 集群 ORCA 不在 PATH、缺 `LD_LIBRARY_PATH` | 远程脚本里显式 export（ORCA 5.0.3 + OpenMPI 4.1.5） |
| 集群 Slurm 没有 account 关联，`sbatch` 报 Invalid account | 默认 `mode=direct`：nohup 后台 + PID 轮询；Slurm 模板保留 |

## 工具

| 工具 | 作用 |
|---|---|
| `chem_env` | 环境自检：Multiwfn 版本/settings/DLL、VMD、Python+Pillow；`action=ssh` 查集群 |
| `chem_orca` | 集群 ORCA：`submit` 上传并后台启动 → `status` 查状态 → `fetch` 转 molden 并回传 |
| `chem_orca_states` | 解析本地 `.out`：激发态表（λ / f / R / 主导组态）+ TDA 判定 + CSV |
| `chem_hole_electron` | hole/electron 分析：两个 cube + Sr/Sm/D/HDI 判据，可顺手渲染 |
| `chem_orbital` | 分子轨道 cube（h / l / h-1 / 171），可顺手渲染等值面 |
| `chem_aromatic` | HOMA 芳香性（给环原子序号），返回 HOMA 与键长贡献 |
| `chem_esp` | ESP 表面定量（面积 / 正负区 / 极值 / σ² / ν）+ `surf.cub` |
| `chem_render` | VMD 出图：等值面 / 球棍 / 叠加骨架，PNG/TIFF，自动裁边与空图检测 |
| `chem_view` | 生成「结构视图包」（体数据 + 原子/键），供应用内 3D 面板打开 |
| `chem_views` | 管理「结构视图」列表（list / add / remove / prune），不动磁盘文件 |
| `chem_export` | 结构转通用格式：`.xyz` / `.mol`(3D) / `-2d.mol`(2D 结构式) / `.sdf` / `.pdb` / `.svg` |
| `chem_multiwfn` | 逃生口：任意 stdin recipe（菜单号随版本变化时兜底） |

**产物目录必须由用户指定**（`outDir`）。不同课题放不同目录，插件不设全局默认路径。

### 结构导出（`chem_export`）

输入可以是任意结构文件（`.xyz` / ORCA `.out` / `.molden` / `.cub`），也可以是已有视图包的
`meta.json` —— 直接把手上面板里看的那个结构导出来。

| 格式 | 内容 |
|---|---|
| `.xyz` | 3D 坐标，最通用的交换格式 |
| `.mol` | MDL Molfile V2000，**3D** 坐标（可拖进 Avogadro / PyMOL / ChemDraw） |
| `-2d.mol` | 同上但用**生成出来的 2D 坐标**（z=0），适合直接排版 |
| `.sdf` | 与 2D mol 同源，多带一个 `$$$$` 结束符 |
| `.pdb` | ATOM + CONECT，给 Chimera/PyMOL 读小分子 |
| `.svg` | 2D 结构式矢量图（杂原子带隐含氢，如 NH₂；双键画平行线；默认隐氢） |

已知边界（都写在工具返回里，避免误用）：

- **键是按距离推断的连通性**，键级按键长估（单/双/三），**不做芳香性识别**——芳香环会写成单键；
- 2D 坐标是 **PCA 主平面投影 + 弹簧松弛**，平面分子基本正确、多环也能撑开，
  但不是 ChemDraw 级排版（不做环系模板匹配、立体化学标记）；
- 不补氢、不做质子化态判断：原子上有什么就是什么。

> 参考了 [dshchem](https://github.com/cloudbywu/dshchem)（RDKit/ASE 后端）和
> [gaussian-dsh-plugin](https://github.com/yangdw2024/gaussian-dsh-plugin) 的思路，
> 但**不引入 RDKit / Python 依赖**——纯 JS 实现，离线可用，装上就能用。

### 应用内 3D 查看器

`chem_view` 产出一个 `<name>.view/` 目录：

```
<name>.view/
├── meta.json     尺寸 / 原点 / 间距 / 量化范围 / 原子 / 键 / 判据
├── <vol>.bin     Int16 体数据（x 最快），每路一个，可以一个都没有
└── ...
```

**不是只有空穴/电子**。`chem_view` 接受两种输入，自由组合：

| 输入 | 说明 |
|---|---|
| `volumes` | 0~6 路体数据：任意 cube（轨道 h/l、ESP、自旋密度、密度差…）。每项可写成路径，或 `{ file, label, color, iso }` |
| `structure` | 结构文件：`.xyz` / ORCA `.out`（取**最后一块**坐标，即优化后的几何）/ `.molden` / `.cub` |

只给 `structure` 就是"只看优化后的结构"；只给 `volumes` 时原子从第一路 cube 头里取。
旧的 `hole` / `electron` / `xyz` 参数继续可用（等价于 `volumes` + `structure`）。

体数据默认阈值按量级自动选（max ≤ 0.1 取 10%，否则 0.02），配色按顺序取 6 色循环，
都可以在 `volumes` 里显式覆盖。

三档进阶能力（都在 `volumes` 的字段里）：

| 字段 | 作用 |
|---|---|
| `negative: true` | 画**负值瓣**（`field < -iso`）。轨道相位、ESP 正负区都这么做 |
| `colorBy: <下标>` | 用另一路体数据给这一层的等值面**按值着色**（蓝—灰—红 + 色标） |
| `visible: false` | 只当数据源，不画自己的等值面（ESP 的 `totesp.cub` 就是这样） |

**ESP 着色表面**的标准配方（就是文献里那种红蓝图）：

```js
chem_view({
  structure: "job.molden.out",              // 顺带读出偶极矩画箭头
  volumes: [
    { file: "density.cub", iso: 0.001, colorBy: 1, label: "ESP 表面" },  // ρ=0.001 定形状
    { file: "totesp.cub",  visible: false },                              // ESP 只当着色数据
  ],
})
```

得到的是：密度 0.001 等值面 + 顶点按 ESP 上色（色标取 5%~95% 分位并对称化，白点落在 0），
默认隐藏骨架（ESP 图的惯例），色标会画在左下角、导出时也一起画进去。

- **打开方式（推荐）**：聊天区右上角 **「结构」** 按钮 → 右栏「结构视图」列表 → 点一条。
  列表来自 `~/.dsh/dsh-chemflow/views.json`，`chem_view` 每次生成会自动追加。
- 也可以点文件树里的 `.cub`（面板会找同目录的 `<stem>.view/meta.json`）。
  **点 `meta.json` 不行** —— 内置的文本预览优先级更高，会直接把 JSON 显示出来。
- 体数据由 cube **三线性重采样 + Int16 量化**（最长边 ≤ 160 不缩放），量化前按 `20×iso`
  **裁剪**——密度场在核附近能到 27 a.u.，不裁的话 0.001 的等值面会变成梯田。
- 原子/键从 cube 头的原子块直接取，坐标已由 Bohr 换成 Å。
- 等值面在**浏览器里**用 Surface Nets 重算（~100 ms），所以拖阈值滑块不需要回宿主。
- 交互：左键旋转 / 右键平移 / 滚轮缩放 / `r` 重置 / 空格自旋；导出 PNG（1×/2×/4×）。
- **等值面**：每个体数据独立开关、阈值（拖滑块在浏览器里重算网格）、颜色、透明度。
- **骨架**：五种表示 + 八种配色（见下）。
- **偶极矩**：`structure` 给 ORCA `.out` 时自动读 `Total Dipole Moment`，按 0.6 Å/D 画箭头。
- 透视 / 正交可切换。

#### 骨架的样式与配色（照 VMD 的分类来的）

**样式 = 原子球半径与键半径怎么组合**：

| 样式 | 原子 | 键 |
|---|---|---|
| 球棍 ballstick | 元素基线半径 × 粗细 | 0.085 × 粗细 |
| 棍状 licorice | 与键同半径（接点小球） | 0.085 × 1.35 × 粗细 |
| 线 lines | 比键略小 | 0.085 × 0.24 × 粗细（细线框） |
| 球体 vdw | VDW 半径 × 0.9 × 粗细 | 不画 |
| 点 points | 屏幕空间小圆点 | 不画 |

**配色 = 先给每个原子定一个颜色，键再按两端原子各取一半**（C–N 键一半灰一半蓝）：

| 配色 | 取值 |
|---|---|
| 元素 | 查元素表（面板里逐个元素改色，只影响这张图） |
| 单色 | 一个颜色 |
| 按序号 | 原子序号归一化 → 冷→暖五段渐变 |
| 按质量 | 原子量 / 80 → 渐变 |
| 按 X / Y / Z | 坐标归一化 → 渐变（看堆积方向、极化方向好用） |
| 自定义 | 逐原子覆盖：选颜色后 **Alt + 点击原子** 上色；「清除单原子」还原 |

#### 风格预设与外观

一键设定「背景 + 雾化 + 材质 + 骨架样式 + 元素配色」，面板顶部下拉选：

| 预设 | 用途 |
|---|---|
| 论文·浅底 | 白底、低饱和元素色、等值面 0.45 透明，默认值 |
| 论文·深底 | 深蓝渐变 + 雾化 + 棍状，暗色排版 |
| VMD 默认 | 黑底 + VMD 的 Name 配色 + 明显高光，对照 VMD 用 |
| 演示·高对比 | 白底、粗球棍、饱和配色、隐藏氢，投影用 |
| 暗场·发光 | 黑底、强雾化、高光拉满，视觉冲击 |

手动改任一项后预设自动切到「自定义」。可调：

- **背景**：白 / 浅灰 / 深灰 / 黑 / 深蓝渐变 / **透明**（导出时保留 alpha）
- **深度雾化**：VMD 那种近实远虚的效果
- **材质**：环境光 / 漫反射 / 高光 三个滑杆（对应 VMD Material 的 Ambient/Diffuse/Specular）
- **坐标轴**（原点 X/Y/Z 三色线）、**比例尺**（右下角，按视角实时换算成 Å）

#### 导出

`导出`下拉选 1× / 2× / 4×，产出 PNG。导出时会按倍率重画一遍再读像素，所以成图和当前视角完全一致；
比例尺用 2D canvas 叠在成图上（WebGL 里画字会糊）。背景选「透明」时导出是带 alpha 的 PNG。

> 和 VMD 的差距（有意没做）：ribbon/tube/cartoon 只对蛋白有意义；dynamic bonds 需要
> 周期键判定；按电荷上色要等视图包里带上 ORCA 的原子电荷（Mulliken/Loewdin），
> 目前 pack 里没有这个字段。

### 客户端 bundle 的三条硬规则（都是踩出来的）

1. **注册 id 必须等于包名**：`__ModuleLoader__.load({ id: 'dsh-chemflow', … })`。
   写成别的（如 `-viewer` 后缀），脚本会正常执行、factory 也注册上，但宿主按包名激活时
   找不到它，报 `web boot: 1 entry did not activate` 且**日志里没有任何错误**。
2. **顶层不要放 `const`/`let`**：宿主会把这个入口拼接进页面两次，第二次直接
   `SyntaxError: Identifier … has already been declared`，整个应用进崩溃页。
   现在整个 bundle 包在 IIFE 里，注册本身也做了幂等。
3. **可选服务不要写进 `inject`**：缺少某个服务会让插件停在 PENDING（同样表现为
   “没激活”且不报错）。`sidebarRight` 改成用 `ctx.get('sidebarRight')` 探测。

> **cube 轴向的坑（实测）**：Multiwfn 导出的 cube 数据是 **z 最快**，不是标准 Gaussian
> cube 的「x 最快」。按标准读法算质心会整体错位（实测 `complex_tda` 的 hole：
> 标准读法 `(2.82,-0.35,-1.82)` vs Multiwfn 报告 `(-0.14,1.93,0.10)`）；按 z 最快读则
> 逐位一致。`readCube` 按注释行判定来源并统一转成内部约定，可用 `layout` 覆盖。

> 定位：面板负责"看 + 试样式"；**投稿级光追图仍走 VMD**（`chem_render`）。

## 安装

1. 在 profile 的 `package.json` 里加依赖与 bundle：

   ```json
   "dependencies": { "dsh-chemflow": "file:C:/Users/SherinG/Documents/DS work/dsh-chemflow" },
   "dsh": { "profile": { "bundles": [ "...", "dsh-chemflow" ] } }
   ```

2. `node scripts/install-profile.mjs <插件目录> <profile 目录> --sync` 复制并写入配置。

3. **重启前先跑预检**：`node scripts/preflight.mjs`

   它不启动 DSH，把真正会被加载的东西逐层跑一遍：

   | 检查 | 抓什么 |
   |---|---|
   | profile 与源码一致 | 改了源码忘了 sync（重启后跑的还是旧代码） |
   | 29 个 lib 文件语法 | 语法错（宿主插件会整个不加载） |
   | 真 import + apply `lib/index.js` | 工具注册不全、参数拼错 |
   | profile 版 client.js 跑两次 | 拼接两次导致的 SyntaxError / 重复注册 / tab 没挂上 |
   | 列表路径注入、id、inject 名单 | 客户端面板点了不出现 |
   | package.json / cordis.patch.yml / views.json | 装配问题 |

   全绿再重启；红的那条会直接告诉你要改什么。

4. **重启 DSH 桌面端**（新插件不会热加载）。

5. 重启后问一句「检查一下化学计算环境」，应当调起 `chem_env`。

## 配置

在 `<dshHome>/profiles/desktop/cordis.patch.yml` 里按 `id: dsh-chemflow` 覆写：

```yaml
- id: dsh-chemflow
  config:
    multiwfnExe: 'D:\Program Files\Multiwfn\Multiwfn.exe'
    vmdExe: 'D:\Program Files\VMD2\vmd.exe'
    sshHost: '114.214.201.249'
    sshPort: 520
    sshUsername: 'SherinG'
    sshPassword: ''          # 建议改用 sshKeyPath
    sshKeyPath: ''
    sshRemoteRoot: '~/chemflow'
```

> 配置字段是**扁平**的（`sshHost` / `sshPort` …），没有嵌套对象 —— 现有插件的
> Config 都是扁平结构，嵌套对象在配置校验里没验证过，不值得冒险。

> 密码是明文存在本机 profile 里的。想避免的话，把公钥装到集群后只填 `sshKeyPath`。

## 本机与集群的实测环境（2026-10）

| 项 | 值 |
|---|---|
| Multiwfn | `D:\Program Files\Multiwfn\Multiwfn.exe`，3.8(dev) 2025-Aug-2 |
| VMD | `D:\Program Files\VMD2\vmd.exe` |
| Python | DSH 自带 3.12.14（Pillow 12.3.0 / numpy 2.3.5） |
| 集群 | `114.214.201.249:520`，CentOS 8，node01，104 核 / 724 GB / 2 TB 空闲 |
| ORCA | `/opt/software/orca-5.0.3`（`orca`、`orca_2mkl`）；OpenMPI `/opt/software/openmpi-4.1.5` |
| Slurm | 分区 `chem` 可用，但该账号**无 account 关联** → 用 `mode=direct` |

## 开发与自测

不重启 DSH 也能测：`test/harness.mjs` 用宿主桩加载插件，`test/loader.mjs` 把
`@deepseek-ai/dsh-tools` / `schemastery` 映射到本地桩（这两个包由宿主在运行时提供）。

```powershell
cd "C:\Users\SherinG\Documents\DS work\dsh-chemflow"

node --import ./test/register.mjs test/run-tools.mjs env
node --import ./test/register.mjs test/run-tools.mjs states
node --import ./test/register.mjs test/run-tools.mjs gate          # 全 TD 必须被拒
node --import ./test/register.mjs test/run-tools.mjs hole "$env:TEMP\chemflow-tools" 3
node --import ./test/register.mjs test/run-tools.mjs multiwfn "$env:TEMP\chemflow-mf"
```

离线单测（解析器 / 配方校验 / 产物核对）：

```powershell
node --test "test/*.test.mjs"
```

## 边界

- **不跑 Gaussian**：集群上有 g16，但本插件只封 ORCA。
- **不替用户保存/删除课题文件**：产物只写进用户指定的 `outDir`；不自动清理旧 run 目录。
- **不做数值绘图**：能级图/棒谱/双 Y 用 `dsh-origin-api`，它已经有模板图与导出能力。
- **不静默失败**：没产物、产物过小、cube 头对不上，一律返回失败 + 日志末尾。

## 致谢与许可

MIT。ssh2 以 vendored 形式随包分发（同样 MIT），见 `vendor/node_modules/ssh2/LICENSE`。
