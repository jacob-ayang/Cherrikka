# Cherrikka 使用说明（中文）

<img src="frontend/public/favicon.svg" alt="Cherrikka Icon" width="72" />

Cherrikka 用来在 **Cherry Studio** 和 **RikkaHub** 备份之间互转。  
你可以用两种方式：

1. `CLI`（命令行）
2. `前端页面`（浏览器本地转换）

---

## CLI 用法

### 1) 准备

在仓库根目录执行：

```bash
go build -o cherrikka ./cmd/cherrikka
```

也可以不编译，直接用：

```bash
go run ./cmd/cherrikka <命令>
```

### 2) 常用命令

#### 查看备份格式

```bash
./cherrikka inspect --input <backup.zip>
```

#### 校验备份结构

```bash
./cherrikka validate --input <backup.zip>
```

#### 转换备份（最常用）

```bash
./cherrikka convert \
  --input <src.zip> \
  --output <dst.zip> \
  --from auto|cherry|rikka \
  --to cherry|rikka \
  [--template <template.zip>] \
  [--redact-secrets]
```

参数说明：
1. `--from`：源格式。通常用 `auto`。
2. `--to`：目标格式，必须是 `cherry` 或 `rikka`。
3. `--template`：可选，提供目标平台模板包（更稳）。
4. `--redact-secrets`：可选，脱敏密钥后再输出。

### 3) 直接可用示例

#### Cherry -> Rikka

```bash
./cherrikka convert \
  --input cherry-backup.zip \
  --output rikka-backup.zip \
  --from auto \
  --to rikka
```

#### Rikka -> Cherry

```bash
./cherrikka convert \
  --input rikka-backup.zip \
  --output cherry-backup.zip \
  --from auto \
  --to cherry
```

---

## 前端用法（纯本地）

前端在浏览器里本地执行转换，不依赖后端 API。

### 1) 启动页面

```bash
cd frontend
npm install
npm run dev
```

打开终端输出的地址（默认一般是 `http://localhost:5173`）。

### 2) 页面操作步骤

1. 上传备份 ZIP（支持拖拽）。
2. 选择源格式：`auto / cherry / rikka`。
3. 目标格式会自动显示为相反格式。
4. 点击 `Convert`。
5. 等待进度完成后点击下载。

### 3) 前端构建（部署前）

```bash
cd frontend
npm run build
```

构建产物在：

```text
frontend/dist
```

---

## 小提示

1. 建议先保留原始备份，再做转换测试。
2. 如果某个包导入异常，优先用 `validate` 看错误/警告信息。
3. 大文件转换建议在内存充足的环境下进行。
