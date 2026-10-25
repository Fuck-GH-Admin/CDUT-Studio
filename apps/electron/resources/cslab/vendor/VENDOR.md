# Vendor 说明

## `antlr4/` — ANTLR 4 Runtime for Python

| 项 | 值 |
|---|---|
| 包名 | `antlr4-python3-runtime` |
| 版本 | **4.11.1**（锁定，不可升级到 4.12+） |
| 来源 | PyPI 官方 sdist：`pip download antlr4-python3-runtime==4.11.1 --no-deps --no-binary :all:` |
| 提取路径 | sdist 中的 `src/antlr4/` → 本目录 `antlr4/` |
| 体积 | 约 100 KB，纯 Python，无 C 扩展 |
| 许可 | BSD 3-Clause，见 [`LICENSE.txt`](./LICENSE.txt)（**随包必须保留**） |

### 为什么内置

SymPy 的 `parse_latex` 依赖 ANTLR 生成的 LaTeX 解析器，而该解析器与 ANTLR runtime
版本强绑定。此前 `formula` profile 要求用户自行 `pip install antlr4-python3-runtime`，
缺失时只能退化为 `sympify` 纯 ASCII 表达式。内置后 SymPy LaTeX 解析开箱即用。

### 版本锁死为 4.11.x 的原因

SymPy 生成的 `.interp` / `SerializedATN` 与 runtime 的序列化格式强耦合。
使用 4.12+ runtime 会在 `parse_latex` 时抛 `SerializedATN` 兼容异常。
**升级 SymPy 时必须同步核对所需的 antlr4 runtime 版本**。

### 导入方式

`cslab-formula-verifier.py` 在入口把 **本目录（`vendor/`）** 加入 `sys.path`：

```python
_VENDOR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'vendor')
if os.path.isdir(_VENDOR) and _VENDOR not in sys.path:
    sys.path.insert(0, _VENDOR)
```

注意插入的是 `vendor` 这一层，让 `import antlr4` 命中 `vendor/antlr4/`。
**切勿把 `antlr4` 的子模块平铺到 vendor 根**，否则 `import antlr4` 失败、
SymPy `parse_latex` 照旧报缺依赖。

### 目录结构

```
vendor/
├── antlr4/                                 # 完整包目录（__init__.py + atn/ dfa/ error/ tree/ xpath/）
├── antlr4_python3_runtime-4.11.1.dist-info/ # ⚠ 必须同时内置，见下
├── LICENSE.txt                             # BSD-3-Clause 上游许可
└── VENDOR.md                               # 本文件
```

### ⚠ 为什么必须内置 `.dist-info`

SymPy 的 `sympy/parsing/latex/_parse_latex_antlr.py` 在 `parse_latex` 入口会做版本断言：

```python
if not version('antlr4-python3-runtime').startswith('4.11'):
    raise ImportError(...)
```

`importlib.metadata.version()` 依赖**已安装包元数据**，只内置源码包会抛
`PackageNotFoundError: No package metadata was found for antlr4-python3-runtime`。

`importlib.metadata` 会沿 `sys.path` 搜索 `*.dist-info` 目录并读取其中 `METADATA` 的
`Name` / `Version` 字段。因此把
`antlr4_python3_runtime-4.11.1.dist-info/{METADATA,top_level.txt,RECORD,INSTALLER}`
放在 `vendor/` 下（与 `antlr4/` 平级），配合 `sys.path.insert(0, vendor)` 即可命中。

**删除该 dist-info 会让整个内置方案静默失效**，务必随包保留。

### 已验证

在纯净系统 Python（未 pip 安装 antlr4）下：

```
sys.path.insert(0, vendor)  →  import antlr4  OK
importlib.metadata.version('antlr4-python3-runtime')  →  '4.11.1'
sympy.parsing.latex.parse_latex(r'\int_0^1 x^2 \,dx')  →  Integral(x**2, (x, 0, 1))
sympy.parsing.latex.parse_latex(r'\frac{1}{2}+\sqrt{x}')  →  sqrt(x) + 1/2
```
