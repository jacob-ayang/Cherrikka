# Cherrikka 使用指南

<img src="frontend/public/favicon.svg" alt="Cherrikka Icon" width="80" />

Cherrikka 用于在 `Cherry Studio` 与 `RikkaHub` 备份 ZIP 间互转。  
提供两种使用方式：

1. `CLI`：适合批量、自动化、可脚本化场景。
2. `Web 前端`：纯浏览器本地转换，适合手动操作。

## CLI 用法

### 环境准备

1. 安装 Go `1.23+`。
2. 在仓库根目录构建：

```bash
go build -o cherrikka ./cmd/cherrikka
```

你也可以直接运行，不先构建：

```bash
go run ./cmd/cherrikka <命令>
```

### 常用命令

1. 识别备份格式：

```bash
./cherrikka inspect --input <backup.zip>
```

2. 校验备份结构：

```bash
./cherrikka validate --input <backup.zip>
```

3. 执行转换：

```bash
./cherrikka convert \
  --input <src.zip> \
  --output <dst.zip> \
  --from auto|cherry|rikka \
  --to cherry|rikka \
  [--template <target-template.zip>] \
  [--redact-secrets]
```

参数说明：
1. `--from`：源格式，推荐默认 `auto`。
2. `--to`：目标格式，`cherry` 或 `rikka`。
3. `--template`：可选，提供目标端模板包用于更稳回填。
4. `--redact-secrets`：可选，脱敏密钥后再输出。

### 一步示例

1. Cherry 转 Rikka：

```bash
./cherrikka convert \
  --input cherry-backup.zip \
  --output cherry-to-rikka.zip \
  --from auto \
  --to rikka
```

2. Rikka 转 Cherry：

```bash
./cherrikka convert \
  --input rikka-backup.zip \
  --output rikka-to-cherry.zip \
  --from auto \
  --to cherry
```

## 前端用法（纯本地）

前端在浏览器本地执行，不依赖 Go API 服务。

### 本地启动

```bash
cd frontend
npm install
npm run dev
```

默认访问 `http://localhost:5173`（以终端输出为准）。

### 页面操作

1. 上传备份 ZIP（支持拖拽）。
2. 选择源格式 `auto/cherry/rikka`。
3. 页面自动推导目标格式（反向）。
4. 点击 `Convert`。
5. 完成后下载结果 ZIP，并查看 warnings/errors。

### 生产构建

```bash
cd frontend
npm run build
```

构建输出目录：`frontend/dist`。

## 常见问题

1. 导入后会话数量不对：先用 `inspect`/`validate` 确认输入包中是否真的包含该会话。
2. 模型可见但空回复：优先检查 provider 的 `baseUrl` 与模型选择映射。
3. 转换包较大：建议优先使用 CLI，或在前端场景下关闭其他高内存应用。

## 相关文档

1. 前端对齐进展：`docs/frontend-rewrite-parity.md`
2. 技术实现说明：`docs/technical-implementation.md`
