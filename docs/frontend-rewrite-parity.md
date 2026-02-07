# Cherrikka 前端重写与 CLI 业务对齐说明

## 1. 目标
本次前端重写的目标是：

1. 保持纯前端本地执行，不依赖 Go `/api/*`。
2. 让前端 `inspect / validate / convert` 与 CLI 语义一致。
3. 对齐关键兼容逻辑：`managed_files` 缺失、`.keep` 空目录占位、MCP/工具块降级、同名助手冲突。
4. 支持 Vercel 从仓库根目录直接构建部署。

## 2. 新前端架构
重写后前端目录：

1. `frontend/src/engine/`
2. `frontend/src/worker/`
3. `frontend/src/ui/`
4. `frontend/src/vendor/sql.ts`

数据流：

1. `ui` 负责文件输入、参数选择、进度显示、结果展示和下载。
2. `worker` 负责 RPC 分发与任务执行（`inspect/validate/convert`）。
3. `engine` 负责 ZIP 读写、格式识别、IR 构建、映射、目标构建与 sidecar。
4. `vendor/sql.ts` 负责浏览器内加载 `sql.js` wasm。

## 3. Worker 公共协议
`frontend/src/worker/protocol.ts` 定义固定命令：

1. `inspect`
2. `validate`
3. `convert`

以及统一的进度事件：

1. `stage`
2. `progress`
3. `message`

## 4. CLI 语义镜像清单
前端已对齐以下业务规则：

1. 输出 sidecar：
   - `cherrikka/manifest.json`
   - `cherrikka/raw/source.zip`
2. `manifest` 字段：
   - `schemaVersion/sourceApp/sourceFormat/sourceSha256/targetApp/targetFormat/idMap/redaction/createdAt/warnings`
3. 配置映射：
   - canonical settings 归一化与回写顺序保持一致。
4. 文件策略：
   - 文件字节、元数据、引用重写、`missing/orphan` 标记保持一致。
5. 脱敏策略：
   - 默认保留密钥，勾选 `redact secrets` 后脱敏。
6. JSON 序列化策略：
   - 前端统一使用 Go 风格序列化（键排序、紧凑编码、HTML escape），对齐 CLI `encoding/json` 行为。

## 5. 兼容与降级策略
### 5.1 `managed_files` 表缺失（Rikka）
对齐 CLI 行为：

1. 校验阶段：
   - 不崩溃。
   - 产生 warning：`managed_files table missing; skipping managed file index`。
   - `message_node` 中 `file://` 改为直接检查 `upload/<filename>` 物理 payload。
2. 解析阶段：
   - 不查询不存在的 `managed_files` 表。
   - 继续合并 `upload/` 文件为 IR 文件，标记 `orphan=true`。

### 5.2 Cherry 空附件目录
构建 Cherry 目标包时，在没有附件文件时写入：

1. `Data/Files/.keep`

避免导入器因空目录丢失导致结构识别异常。

### 5.3 MCP/工具消息
在 Cherry -> Rikka 映射中，对高风险工具结构进行文本化降级，避免目标端读取崩溃。

### 5.4 助手同名冲突
助手名称冲突时自动重命名并记录 warning，避免导入后冲突覆盖。

### 5.5 Provider 可用性与隔离策略
1. Provider/Model 对齐：
   - 前端与 CLI 都会把 `Rikka Model` 结构重建为 Cherry 可运行模型结构（`id/provider/name/group`）。
   - 无可用模型的 provider 不强删，保留但禁用，并输出 `provider-invalid-disabled:*`。
2. 世界书/注入/记忆：
   - 不做跨端隐式注入，不改写为运行时 prompt。
   - 统一隔离到 `interop.rikka.unsupported` / `interop.cherry.unsupported`，并输出 `unsupported-isolated:*`。
3. sidecar 回灌：
   - 若输入包含 sidecar 且本次目标格式等于 sidecar 原始格式，前端与 CLI 都执行一层回灌（`depth=1`）。
   - 警告前缀：`sidecar-rehydrate:*`。

## 6. 黑白像素 TUI 设计
`frontend/src/ui/theme.css` 采用黑白灰像素终端风：

1. 黑底白字灰辅色。
2. 像素字体（本地打包 `@fontsource/silkscreen`，无 CDN）。
3. 1px 方角边框、终端风按钮、进度条、日志窗格。
4. 结果区支持 JSON 折叠和复制。

## 7. Vercel 部署口径
### 7.1 构建入口
使用仓库根目录 `vercel.json`：

1. `installCommand`: `cd frontend && npm install`
2. `buildCommand`: `cd frontend && npm run build`
3. `outputDirectory`: `frontend/dist`

### 7.2 单一配置原则
已移除 `frontend/vercel.json`，避免与根配置冲突。

## 8. 验证清单
建议发布前至少执行：

1. `go test ./...`
2. `cd frontend && npm test -- --run`
3. `cd frontend && npm run build`
4. `cd frontend && npm run test:e2e`
5. `scripts/consistency_compare.sh --mode content --strict --cherry <cherry.zip> --rikka <rikka.zip>`

回归样本需覆盖：

1. Cherry -> Rikka
2. Rikka -> Cherry
3. `managed_files` 缺失的 Rikka 备份
4. sidecar hash 一致性

### 8.1 内容级一致性口径
默认以 `content` 模式校验，随机字段通过 `scripts/parity_profile.json` 白名单剔除。当前白名单包含：

1. `cherrikka/manifest.json.createdAt`
2. `data.json`：
   - `time`
   - `indexedDB.message_blocks[].id`
   - `indexedDB.message_blocks[].createdAt`
   - `indexedDB.message_blocks[].toolId`
   - `indexedDB.topics[].messages[].createdAt`
   - `indexedDB.topics[].messages[].blocks[]`
3. `rikka_hub.db`：
   - `ConversationEntity.create_at/update_at`
   - `managed_files.created_at/updated_at`
   - `message_node.id`
   - `message_node.messages[*].id`

### 8.2 故障排查
当 `--mode content --strict` 失败时，优先检查：

1. `reports/*/file-list.diff`：是否有结构缺失。
2. `reports/*/content-hash-diff.tsv`：哪些文件在归一化后仍不一致。
3. `reports/*/normalized/`：直接查看归一化后的 JSON/SQLite 快照差异。

## 9. 已知边界
1. 浏览器内存上限仍会影响超大 ZIP（已通过 Worker 与流式 ZIP 降低主线程阻塞）。
2. 无法语义等价字段采用 `opaque + warnings` 保护可回转能力。
3. E2E 需要 Playwright 浏览器与系统库；本地可执行 `npx playwright install` 安装浏览器。
4. CLI 与前端转换后的 ZIP **不保证二进制 MD5 一致**：
   - CLI 与前端使用不同 SQLite 实现生成 `rikka_hub.db`，二进制页布局可不同。
   - `manifest.createdAt` 等运行时字段天然随执行时刻变化。
   - 对齐校验以 `content` 模式一致性为准，而非原始字节一致。
