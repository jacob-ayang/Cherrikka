# Cherrikka 前端二期对齐说明（Convert 优先）

## 1. 目标
本轮目标固定为：
1. 保持纯前端本地转换（无 `/api/*`）。
2. 以 CLI 为语义基线，优先保证 `convert` 可用性。
3. 建立内容级一致性对比能力，持续收敛前后端差异。

## 2. 当前前端能力
当前页面只保留转换主流程：
1. 上传源 ZIP（点击/拖拽）。
2. 选择源格式（`auto/cherry/rikka`）。
3. 自动推导目标格式（只读显示）。
4. 运行 `convert`。
5. 下载结果，查看 progress / warnings / errors。

Worker 协议固定为：
1. `detect(inputFile: File)`
2. `convert(req: ConvertRequest)`
3. `progress` 事件：`{ stage, progress, message, level }`

## 3. 本轮已落地的 CLI 对齐点
1. Go 风格 JSON 序列化：
   - 递归键排序
   - HTML 字符转义（`< > &`）
2. `settings` 关键修复：
   - OpenAI base URL 自动补 `/v1`
   - cherry provider 类型映射到 rikka（`openai/claude/google`）
   - `maxTokens` 空值不再写 `0`
   - assistant 同名冲突自动重命名
3. 文件映射修复：
   - `Cherry -> Rikka` 优先复用文件名路径（`upload/<basename>`）
   - `Rikka -> Cherry` 使用与 CLI 一致的文件 ID 选择策略
4. sidecar 保持：
   - `cherrikka/manifest.json`
   - `cherrikka/raw/source.zip`
5. 兼容脚本修复：
   - 新增 `frontend/scripts/convert_with_engine.ts`
   - 使 `scripts/consistency_compare.sh` 可直接驱动前端引擎
6. no-legacy 护栏：
   - `frontend/scripts/check_no_legacy_imports.js`
   - `npm run check:legacy`

## 4. 一致性校验口径
使用脚本：
1. `scripts/consistency_compare.sh --mode content --strict ...`

配置文件：
1. `scripts/parity_profile.json`

当前结果状态：
1. 双向转换后文件集合已对齐（`cli_only=0`，`fe_only=0`）。
2. 仍有内容差异聚焦在：
   - `settings.json`（字段保留策略差异）
   - `data.json`（块级字段与格式细节差异）
   - `manifest.json`（warning 集合差异）

## 5. 现阶段已知边界
1. 前端与 CLI 目前已做到“主流程可用 + 文件结构一致”，但还未达到 `--strict` 下零差异。
2. 现存差异主要来自“字段保留程度”和“默认字段注入差异”，不是 ZIP 打包层面的随机差异。
3. 这类差异会继续以 CLI 输出为标准逐步收敛。

## 6. 推荐回归命令
1. `go test ./...`
2. `cd frontend && npm test -- --run`
3. `cd frontend && npm run build`
4. `scripts/consistency_compare.sh --mode content --cherry <cherry.zip> --rikka <rikka.zip> --out-dir .compare/latest`

## 7. 故障排查
如果导入后仍出现 provider 空回或会话异常，按顺序检查：
1. `reports/*/content-hash-diff.tsv` 是否含 `settings.json`。
2. `reports/*/normalized/*` 中 `settings.json` 的：
   - `providers[].baseUrl`
   - `providers[].enabled`
   - `chatModelId` 与 `assistants[].chatModelId`
3. `manifest.warnings` 是否出现：
   - `provider-invalid-disabled:*`
   - `assistant-model-fallback:*`
