# Cherrikka

Cherrikka 用于 Cherry Studio 与 RikkaHub 备份互转，支持 CLI 与纯前端本地转换。

## 核心能力
1. `inspect`：识别备份格式并输出摘要。
2. `validate`：结构与引用一致性校验（含 warning/error 分级）。
3. `convert`：Cherry ↔ Rikka 双向转换，附带 sidecar 保真信息。
4. `serve`：提供 Go Web 服务入口（可选）。

## 配置域策略（V1.1）
1. Provider/Model 以“可用优先”映射：缺少可用模型的 provider 会保留但标记禁用，并输出 `provider-invalid-disabled:*` warning。
2. Rikka 世界书/注入与记忆等不可等价字段不会强行注入到 Cherry 提示词，统一进入 `opaque + warnings`（`unsupported-isolated:*`）。
3. sidecar 回灌：若输入包已含 `cherrikka/raw/source.zip` 且目标格式回到原格式，会自动回灌原生独有配置（`sidecar-rehydrate:*`）。
4. `inspect/validate` 的 `configSummary` 额外提供：
   - `isolatedConfigItems`
   - `rehydrationAvailable`

## CLI 用法
1. `cherrikka inspect --input <backup.zip>`
2. `cherrikka validate --input <backup.zip>`
3. `cherrikka convert --input <src.zip> --output <dst.zip> --from auto|cherry|rikka --to cherry|rikka [--template <target-template.zip>] [--redact-secrets]`
4. `cherrikka serve --listen 127.0.0.1:7788`

## 纯前端（默认推荐）
前端位于 `frontend/`，转换在浏览器 Worker 内执行，不调用 `/api/*`。

1. `cd frontend`
2. `npm install`
3. `npm run dev`
4. 打开终端输出的本地地址（默认 `http://localhost:5173`）

## 前端测试
1. `cd frontend && npm test -- --run`
2. `cd frontend && npm run build`
3. `cd frontend && npm run test:e2e`（需先安装 Playwright 浏览器与系统依赖）

## CLI 与前端一致性对比脚本
使用 `scripts/consistency_compare.sh` 一键完成：
1. 用同一组输入分别跑 CLI 和前端引擎转换（双向）。
2. 解压产物并比较内部文件列表与内容差异。
3. 默认 `content` 模式会按 `scripts/parity_profile.json` 去除随机字段后再比较。
4. 输出详细报告到指定目录。

常用参数：
1. `--mode raw|content`（默认 `content`）
2. `--profile <path>`（内容模式使用的随机字段白名单）
3. `--strict`（只要有差异即返回非 0）

示例：
1. `scripts/consistency_compare.sh --cherry cherry-studio.202602071921.zip --rikka rikkahub_backup_20260207_184206.zip --mode content --strict --out-dir .compare/run-20260207`
2. 查看摘要：`.compare/run-20260207/reports/c2r/summary.txt` 与 `.compare/run-20260207/reports/r2c/summary.txt`

## Vercel 部署
使用仓库根目录 `vercel.json` 部署，构建输出 `frontend/dist`。

1. 在 Vercel 导入本仓库。
2. 确认 `Root Directory` 为仓库根目录。
3. 直接 Deploy。

若出现 404：

1. 确认项目使用的是根目录 `vercel.json`。
2. 重新触发部署并检查 Build Log 是否执行 `cd frontend && npm run build`。

## GitHub Pages 部署
仓库内置 `.github/workflows/deploy-pages.yml`，推送 `main` 自动发布 `frontend/dist`。

1. 打开仓库 `Settings -> Pages`。
2. `Source` 选择 `GitHub Actions`。
3. 推送到 `main` 或手动触发 workflow。

## 详细文档
1. 前端重写与 CLI 对齐说明：`docs/frontend-rewrite-parity.md`
2. 说明：CLI 与前端转换产物不保证 ZIP 二进制 MD5 完全一致（SQLite 引擎与时间戳字段差异），请以 `inspect/validate` 结果一致性作为对齐标准。
