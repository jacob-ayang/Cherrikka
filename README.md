<div align="center">
  <img src="frontend/public/favicon.svg" alt="Cherrikka Logo" width="92" />
  <h1>Cherrikka</h1>
  <p><strong>Cherry Studio ↔ RikkaHub 备份互转（CLI + 纯前端）</strong></p>
  <p>
    <a href="https://uwp.de5.net"><strong>在线试用：uwp.de5.net</strong></a>
  </p>
  <p>
    <a href="https://vercel.com/new/clone?repository-url=https://github.com/jacob-ayang/Cherrikka&project-name=cherrikka&repository-name=Cherrikka">
      <img src="https://vercel.com/button" alt="Deploy with Vercel" />
    </a>
  </p>
</div>

<div align="center">
  <img src="image.png" alt="Cherrikka 前端页面截图" width="920" />
  <p><sub>纯前端本地转换页面（浏览器内执行，不上传你的备份内容）</sub></p>
</div>

## 这是什么

Cherrikka 用于在 `Cherry Studio` 与 `RikkaHub` 的备份 ZIP 之间进行互转。  
你可以用它做：

1. 单包互转：`Cherry -> Rikka` / `Rikka -> Cherry`
2. 多包整合：一次上传多个备份（可混合 Cherry/Rikka），合并后导出单一目标格式
3. 双端通用：网页端（纯前端）和 CLI 都支持转换

---

## 前端使用（推荐）

### 1) 直接在线用

访问：<https://uwp.de5.net>

流程：

1. 上传一个或多个备份 ZIP
2. 选择源格式（建议 `自动识别`）
3. 选择目标格式（`Cherry` 或 `Rikka`）
4. 可选：配置主次策略、脱敏密钥
5. 点击 `Convert` 下载结果

### 2) 本地运行前端

```bash
cd frontend
npm install
npm run dev
```

默认地址：`http://localhost:5173`

### 3) 前端构建

```bash
cd frontend
npm run build
```

构建产物：`frontend/dist`

---

## CLI 使用

### 1) 编译

```bash
go build -o cherrikka ./cmd/cherrikka
```

### 2) 常用命令

格式识别：

```bash
./cherrikka inspect --input <backup.zip>
```

结构校验：

```bash
./cherrikka validate --input <backup.zip>
```

单输入转换：

```bash
./cherrikka convert \
  --input <src.zip> \
  --output <dst.zip> \
  --from auto \
  --to rikka
```

多输入整合转换（新）：

```bash
./cherrikka convert \
  --input <a.zip> \
  --input <b.zip> \
  --output <merged.zip> \
  --from auto \
  --to cherry \
  --config-precedence latest
```

### 3) `convert` 参数说明

| 参数 | 说明 |
| --- | --- |
| `--input` | 输入备份 ZIP，可重复传入（1..N） |
| `--output` | 输出 ZIP 路径 |
| `--from` | 源格式：`auto \| cherry \| rikka`（多输入时仅支持 `auto`） |
| `--to` | 目标格式：`cherry \| rikka` |
| `--template` | 可选模板包 |
| `--redact-secrets` | 脱敏密钥 |
| `--config-precedence` | 多输入配置主次：`latest \| first \| target \| source` |
| `--config-source-index` | 当 `config-precedence=source` 时指定来源序号（1-based） |

---

## 产物与兼容说明

输出包默认包含 sidecar：

1. `cherrikka/manifest.json`
2. `cherrikka/raw/source.zip`
3. 多输入时额外包含 `cherrikka/raw/source-1.zip ... source-n.zip`

这用于后续追溯与回转，不影响目标应用导入。

---

## 自部署

你可以 Fork 本仓库后部署到：

1. Vercel
2. Netlify
3. Cloudflare Pages
4. GitHub Pages（静态介绍页）

---

## 相关文档

1. 前端对齐进展：`docs/frontend-rewrite-parity.md`
2. 技术实现说明：`docs/technical-implementation.md`
