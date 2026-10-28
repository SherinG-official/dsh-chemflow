# 三个预设任务的 Multiwfn 3.8 实测配方

> 全部在本机 `D:\Program Files\Multiwfn\Multiwfn.exe`（3.8(dev), 2025-Aug-2）上跑通，
> 测试分子是安装目录自带的 `examples\phenanthrene.fch`。
>
> 调用约定：**文件绝对路径作为 argv[1]**，stdin 逐行喂菜单号；
> `Multiwfnpath` 指向一个短路径（< 76 字符）的私有目录，内含 settings.ini 副本。

## 共同坑：退出码 24 / 59 不等于失败

菜单是分层的。**少退一层**时进程会在某个子菜单上读到 EOF：

```
forrtl: severe (24): end-of-file during read, unit -4, file CONIN$
forrtl: severe (59): list-directed I/O syntax error, unit -4, file CONIN$
```

此时**产物往往已经写好了**。排查顺序永远是「先看产物，再看退出码」。
另外注意不同层级的返回键不同：有的菜单是 `0`，有的是 `-1`，主菜单才是 `q`。

---

## A. 分子轨道 cube

入口：主菜单 `200`（Other functions (Part 2)）→ `3` Generate cube file for multiple orbital wavefunctions。

它会依次问：
1. `Input orbital index` —— 支持 `h` / `l` / `h-5` / `l+3`，也支持数字 `47`、`1,3-6`；
2. `Please select a method to set up grid` —— 1 低 / 2 中 / 3 高；
3. **只有数字索引**才会多问一句：
   `1 Output the grid data of these orbitals as separate cube files` /
   `2 ... as a single cube file`（取 1）。

| 写法 | 完整 recipe | 产物 |
|---|---|---|
| 别名 `h` | `200, 3, h, 3, 0, q` | `h.cub`（25,339,851 B） |
| 数字 `47` | `200, 3, 47, 3, 1, 0, q` | `orb000047.cub`（25,339,851 B） |

- 实测耗时：约 1.1 s（phenanthrene，高精度网格 1,767,184 点）。
- 数字索引的文件名是 **6 位零填充**：`orb000047.cub`。
- 退出：导出后停在 PART2 菜单，`0` 回主菜单，`q` 退出 → exit 0。
- 一次只导出一个轨道（多选会提示 *"In this selection mode, you can select only one orbital each time"*）。

---

## B. HOMA 芳香性

入口：主菜单 `25`（Electron delocalization and aromaticity analyses）→ `6`（HOMA / Bird）→ `0`（Start calculation for HOMA!）。

然后逐环输入**按成键顺序排列的环原子序号**：

```
Input indices of the atoms according to bonding relationship in the ring, e.g. 1,5,6,7,8,12
(Input q can return)
```

一次可以输入多个环（算完一个会再问下一环），最后输入 `q` 回到 HOMA 菜单。

完整 recipe（单环）：
```
25, 6, 0, 1,2,3,4,5,6, q, -1, 0, q
```

产物是**纯数值**（没有文件），形如：

```
     Atom pair         Contribution  Bond length(Angstrom)
 1(C )  --  2(C ):      -0.002299        1.380685
 ...
 6(C )  --  1(C ):      -0.016283        1.407471
 HOMA value is    0.854045
```

- 实测：phenanthrene 的 1–6 号环 HOMA = **0.8540**，耗时 ~0.1 s。
- 判据：HOMA → 1 越芳香；> 0.9 强芳香；< 0.5 明显非芳香。
- **FLU / PDI 走不通**：`25 → 9`（FLU）会提示必须先跑模糊分析模块（主菜单 15），
  不是一条 recipe 能解决的，所以工具里只做 HOMA。

---

## C. ESP 表面

入口：主菜单 `12`（Quantitative analysis of molecular surface）。

子菜单（默认值就是我们要的）：
```
-1 Return to main menu
 0 Start analysis now!
 1 Select the way to define surface, current: Electron density, iso: 0.00100
 2 Select mapped function, current: Electrostatic potential (ESP)
 3 Spacing of grid points for generating molecular surface: 0.250000
```
跑完后进入后处理菜单，导出表面网格用的是 **负号**选项：

```
-2 Export the grid data to surf.cub in current folder
```

完整 recipe：
```
12, 0, -2, -1, -1, q
```

- 产物：`surf.cub`（4,876,131 B，45×102×74 = 339,660 点）；无图。
- 实测耗时：约 5 s（phenanthrene）。
- 关键数值（同一个分子，可用于回归）：

| 量 | 值 |
|---|---|
| Overall surface area | 216.25 Å²（772.24 Bohr²） |
| Positive / Negative area | 109.20 / 107.05 Å² |
| Global surface minimum | −0.024941 a.u. |
| Global surface maximum | +0.026345 a.u. |
| Overall average | −0.00089979 a.u.（−0.56463 kcal/mol） |
| σ²_tot | 0.00008881 a.u.²（34.97193 (kcal/mol)²） |
| Balance of charges ν | 0.24192560 |

- 退出：`-1` 两次（后处理 → 表面菜单 → 主菜单）再 `q`，exit 0。少一个 `-1` 会 exit 59。
- **还没有直接出图**：`surf.cub` 是表面网格数据，VMD 里要自己挑等值面阈值。
  想画「ESP 着色表面」，更稳的路线是后处理菜单 `6` 导出 `vtx.pdb`（顶点 + ESP 写在 B-factor），
  在 VMD 里 `mol modcolor 0 0 Beta` 着色 —— 这条留给下一版。

---

## 菜单号速查（3.8，实测）

| 主菜单 | 含义 |
|---|---|
| 5 | spatial region 网格（通用 cube 导出） |
| 12 | 分子表面定量分析（ESP 表面） |
| 18 | 电子激发分析（hole/electron 从这里进） |
| 25 | 离域与芳香性（HOMA 在 6） |
| 200 | Other functions (Part 2)（轨道 cube 在 3） |
