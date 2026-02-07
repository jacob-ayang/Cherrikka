# Cherrikka 技术实现说明

## 1. 目标与边界

Cherrikka 的核心目标是：

1. 在 `Cherry Studio` 与 `RikkaHub` 备份之间互转。
2. 保持“目标可导入”与“可回溯”的双层保障。
3. 前端与 CLI 保持内容级一致（忽略随机 ID、时间戳等非语义差异）。

不在本项目范围内：

1. 远程云端任务队列。
2. 账户系统。
3. 实时协同编辑。

## 2. 总体架构

系统分为两套执行面：

1. CLI（Go）：
   - 入口：`cmd/cherrikka/main.go`
   - 主流程：`internal/app/service.go`
2. 前端（TypeScript + Worker）：
   - UI：`frontend/src/ui/*`
   - Worker 协议：`frontend/src/worker/*`
   - 引擎：`frontend/src/engine/*`

两套实现共享同一转换思路：

1. 读取 ZIP。
2. 识别格式。
3. 解析到中间 IR。
4. 将 IR 构建为目标格式。
5. 附加 sidecar（manifest + source.zip）。

## 3. CLI 主流程（基线）

### 3.1 命令接口

CLI 提供四个命令：

1. `inspect`
2. `validate`
3. `convert`
4. `serve`

定义见 `cmd/cherrikka/main.go`。

### 3.2 convert 执行链

`internal/app/service.go` 中的转换流程：

1. 读取输入包并自动识别来源格式。
2. 解析源数据到 IR：
   - Cherry：`internal/cherry/parse.go`
   - Rikka：`internal/rikka/parse.go`
3. 配置归一化与双向映射：
   - `internal/mapping/*`
4. 构建目标备份：
   - Cherry 输出 `data.json + Data/Files`
   - Rikka 输出 `settings.json + rikka_hub.db + upload/`
5. 写入 sidecar：
   - `cherrikka/manifest.json`
   - `cherrikka/raw/source.zip`

## 4. 前端实现

### 4.1 UI 与 Worker 分层

1. UI 只负责交互和展示，不直接做重计算。
2. Worker 负责 `detect/convert`，通过消息协议回传进度。
3. 当前协议定义见 `frontend/src/worker/protocol.ts`。

### 4.2 前端引擎

关键模块：

1. 格式识别与 ZIP 处理：`frontend/src/engine/backup/*`
2. Cherry 解析/构建：`frontend/src/engine/cherry/index.ts`
3. Rikka 解析/构建：`frontend/src/engine/rikka/index.ts`
4. 统一调度：`frontend/src/engine/service.ts`

### 4.3 与 CLI 对齐策略

前端以 CLI 为语义基线，重点对齐：

1. provider/model 映射。
2. 会话与消息落盘规则。
3. sidecar 结构与 warning 语义。
4. JSON 序列化风格（Go 风格键排序和转义）。

## 5. Sidecar 机制

每次转换都会附加：

1. `cherrikka/manifest.json`：转换元信息、idMap、warnings。
2. `cherrikka/raw/source.zip`：原始输入包副本。

用途：

1. 便于回归定位与问题复盘。
2. 支持跨端多次转换时保留原始语义片段。

## 6. 一致性校验

统一脚本：

`scripts/consistency_compare.sh`

典型命令：

```bash
scripts/consistency_compare.sh \
  --mode content \
  --strict \
  --cherry <cherry.zip> \
  --rikka <rikka.zip> \
  --out-dir .compare/latest
```

说明：

1. `--mode content`：比较语义内容，不比较 ZIP 二进制布局。
2. 白名单由 `scripts/parity_profile.json` 管理，仅允许随机字段差异。
3. `--strict`：出现非白名单差异即失败。

## 7. 已知技术要点

1. Go 直接编译到浏览器 wasm 目前不可行（受 SQLite 依赖限制），所以前端采用 TypeScript 镜像实现。
2. 前端禁止引用 legacy 代码：
   - 校验脚本：`frontend/scripts/check_no_legacy_imports.js`
3. 大包转换建议优先 CLI，前端模式受浏览器内存上限影响更明显。

## 8. 调试建议

当“可导入但内容异常”时，建议按顺序排查：

1. `inspect` 查看输入包内会话/助手数量是否符合预期。
2. `validate` 查看是否有 provider/model 引用异常。
3. 对比 CLI 与前端结果：
   - 先看 `manifest.warnings`
   - 再看 `settings.json` 与 `data.json`
4. 最后使用 `scripts/consistency_compare.sh --mode content --strict` 定位差异文件。
