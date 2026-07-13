# Dual Read

[![CI](https://github.com/skys-mission/dual-read/actions/workflows/ci.yml/badge.svg)](https://github.com/skys-mission/dual-read/actions/workflows/ci.yml)
[![Nightly](https://github.com/skys-mission/dual-read/actions/workflows/nightly.yml/badge.svg)](https://github.com/skys-mission/dual-read/actions/workflows/nightly.yml)
[![Release](https://github.com/skys-mission/dual-read/actions/workflows/release.yml/badge.svg)](https://github.com/skys-mission/dual-read/actions/workflows/release.yml)
[![GitHub Release](https://img.shields.io/github/v/release/skys-mission/dual-read?logo=github&label=Release)](https://github.com/skys-mission/dual-read/releases/latest)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Go](https://img.shields.io/badge/Go-1.25+-00ADD8?logo=go&logoColor=white)](server/go.mod)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)](extension/tsconfig.json)
[![Manifest V3](https://img.shields.io/badge/Manifest-V3-4285F4?logo=googlechrome&logoColor=white)](extension/wxt.config.ts)
[![Zero telemetry](https://img.shields.io/badge/Telemetry-none-success)](PRIVACY.md)

[English](README.md) | **中文**

开源、自托管的**网页双语阅读**工具：浏览器插件 + 可选 Go 缓存代理（`dual-read-server`）。支持 Chrome、Edge、Firefox，通过任意 OpenAI 兼容 API（DeepSeek、OpenAI、Ollama 等）实现 AI 驱动的双语对照翻译，无厂商锁定。

插件通过任意 OpenAI 兼容 API 翻译网页；服务端提供本地 / Valkey 缓存，未命中时才转发上游 LLM，重复内容最多可降低 90% 延迟与费用。

**隐私一句话：** Dual Read **默认零遥测**；页面文字只发往**你配置的** LLM / 自建服务端；项目方不收集浏览内容或 API Key。详见 [PRIVACY.md](PRIVACY.md)。

---

## 目录

- [为什么选择 Dual Read？](#为什么选择-dual-read)
- [特性](#特性)
- [快速开始](#快速开始)
- [服务端配置](#服务端配置toml)
- [Make 命令](#make-命令)
- [验证](#验证)
- [文档导航](#文档导航)
- [参与贡献](#参与贡献)
- [Star 趋势](#star-趋势)
- [License](#license)

---

## 为什么选择 Dual Read？

| | Dual Read | 沉浸式翻译 | Readwise Reader |
|---|---|---|---|
| 开源 | Apache 2.0 | 部分 | 否 |
| 自托管缓存代理 | 支持 | 否 | 否 |
| LLM 提供商 | 任意 OpenAI 兼容 | 有限 | 仅内置 |
| 遥测 | 零 | 有 | 有 |
| Manifest V3 | 是 | 是 | N/A |
| 成本控制 | 缓存 + singleflight | 无 | 订阅制 |

- **阅读外文文档、论文、新闻**，双语对照一目了然
- **语言学习**，保留原文对照翻译，边读边学
- **降低 LLM 费用**，缓存代理让重复段落命中缓存而非 API
- **隐私自主**，阅读数据不离开你的基础设施

---

## 文档导航

| 文档 | 说明 |
|------|------|
| [PRIVACY.md](PRIVACY.md) | 隐私政策（数据去向、权限说明） |
| [SECURITY.md](SECURITY.md) | 安全漏洞报告与加固要求 |
| [CONTRIBUTING.md](CONTRIBUTING.md) | 贡献指南（构建 / 测试 / PR） |
| [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) | 行为准则 |
| [CHANGELOG.md](CHANGELOG.md) | 变更记录 |
| [server/README.md](server/README.md) | 服务端配置 |
| [server/docs/DEPLOY.md](server/docs/DEPLOY.md) | 容器与生产部署 |
| [docs/store/](docs/store/) | Chrome / Firefox 商店上架清单与文案 |
| [docs/RELEASE.md](docs/RELEASE.md) | Tag 发布、校验与 attestation |
| [docs/PERF_LAB.md](docs/PERF_LAB.md) | 性能预算 lab |
| [docs/FIREFOX_E2E.md](docs/FIREFOX_E2E.md) | Firefox E2E（Gecko harness 说明） |

---

## 特性

### 浏览器插件（Chrome / Edge / Firefox，Manifest V3）

- **双语对照** 或 **直接替换**，Options 默认 + Popup 临时切换
- **按需注入**：点击翻译时注入 content script，兼容更多站点
- **视口懒翻译**：IntersectionObserver 仅翻译进入视口（含预取一屏）的内容，滚动时按需补齐，省 token
- **增量翻译**：MutationObserver 持续监听动态内容，只索引新增节点
- **失败自动重试**：指数退避（1s/4s/16s，3 次），仍失败则译文区显示可点击「↻」手动重试
- **本地翻译缓存**：内存 + `chrome.storage.local` LRU 两级缓存，重复内容零请求
- **浮层选词翻译**：Shadow DOM 隔离的悬浮结果（替代弹窗），支持右键菜单触发
- **键盘快捷键**：`Alt+T` 翻译 / 还原页面，`Alt+M` 切换双语 / 替换模式（快捷键可在浏览器设置中自定义）
- **站点规则**：在设置中逐站配置模式、目标语言、自动翻译或永不翻译；自动翻译会明确请求该站权限
- **批量请求**：可配置并发数与每批片段数，连续失败时自适应缩小批量
- **自定义 HTTP 请求头**：仅保存在当前设备；API Key 的 `Authorization` 优先
- **设置导入 / 导出**：API Key 与请求头默认排除，需显式确认后才导出
- **界面语言**：英语、简体中文、繁體中文、俄语、西班牙语、法语
- **目标语言**：简体中文、English、Русский、Español、Français

### 服务端（可选）

- 转发 OpenAI 兼容上游（默认 DeepSeek）
- **singleflight**：相同请求并发只打一次上游
- **BigCache** 本地 / **Valkey** 共享 / 双层 / 全关
- **服务端 API Key** 分配 + 按 Key 覆盖上游凭据
- **模型映射**：客户端 `flash` → 上游真实模型 id
- **Admin 监控页**：`/admin` 查看命中率、延迟、最近请求
- **Admin 设置页**：`/admin` → 设置，保存到 `data/runtime.json`（不改 TOML）
- 响应头 `X-Cache: HIT|MISS`、`X-Dual-Read-Model`

---

## 项目结构

```text
dual-read/
├── extension/                 # 浏览器插件源码（TypeScript + WXT）
│   ├── entrypoints/           # background / dual-read(按需注入) / popup / options
│   ├── lib/                   # 分层：collector·renderer·scheduler·provider·cache·settings·i18n
│   ├── public/                # _locales、图标、注入用样式 dual-read.css
│   ├── tests/                 # vitest 单测
│   └── wxt.config.ts          # 自动生成 Chrome/Firefox MV3 manifest
├── server/                    # Go 服务端 (dual-read-server)
│   ├── cmd/dual-read-server/
│   ├── internal/{admin,auth,cache,config,handler,metrics,models,server,upstream}/
│   ├── config.example.toml
│   ├── README.md
│   └── Dockerfile
├── scripts/                   # 构建 / 开发脚本
└── Makefile
```

---

## 快速开始

### 方案 A：直连 API（不跑服务端）

1. 准备任意 OpenAI 兼容端点与 API Key（例如 DeepSeek）。
2. 加载插件（见下文「加载浏览器插件」）。
3. 打开 Options，填写：

| 设置 | 默认值（可改） |
|------|----------------|
| API base URL | `https://api.deepseek.com` |
| API key | 必填 |
| Model | `deepseek-v4-flash` |

### 方案 B：本地服务端 + 插件（推荐，可缓存）

#### 1. 启动 dual-read-server（最少一步）

需要 Go 1.22+：

```bash
cd server
export OPENAI_API_KEY=sk-your-key
go run ./cmd/dual-read-server
```

无需配置文件。默认：

| 项 | 默认 |
|----|------|
| 监听 | `http://127.0.0.1:8080` |
| 上游 | `https://api.deepseek.com` |
| 本地缓存 | 开 |
| 鉴权 | 关（本机开放） |
| 监控页 | [http://127.0.0.1:8080/admin](http://127.0.0.1:8080/admin) |

常用接口：

- `POST /v1/chat/completions`
- `GET  /health`
- `GET  /admin`（监控）
- `GET  /v1/models`

可选 TOML（鉴权、模型映射、Valkey 等）：

```bash
cp config.example.toml config.toml
# 编辑后
go run ./cmd/dual-read-server -config config.toml
```

安装到 PATH：

```bash
# 从远程安装（发布后）
go install github.com/skys-mission/dual-read/server/cmd/dual-read-server@latest

# 或本地 clone
cd server
go install ./cmd/dual-read-server

dual-read-server   # 需 OPENAI_API_KEY
```

Docker：

```bash
cd server
docker build -t dual-read-server .
docker run --rm -p 8080:8080 --read-only --tmpfs /tmp:size=64m \
  -v dual-read-data:/app/data \
  -e OPENAI_API_KEY=sk-your-key \
  -e DUAL_READ_ADMIN_TOKEN="$(openssl rand -hex 16)" \
  -e DUAL_READ_ALLOW_INSECURE_PUBLIC=true \
  dual-read-server
```

Compose / Valkey / TLS 见 [`server/docs/DEPLOY.md`](server/docs/DEPLOY.md)。公网 / `0.0.0.0` 务必开启 `auth.enabled` 并设置 `admin.token`（可用 `DUAL_READ_ALLOW_INSECURE_PUBLIC=true` 仅作本地演示）。
#### 2. 加载浏览器插件

插件基于 **TypeScript + [WXT](https://wxt.dev)**，首次需要 `cd extension && npm install`（Node ≥ 18）。

**日常开发（HMR 热更新）：**

```bash
make dev-extension          # 等价于 cd extension && npm run dev
```

在 Chrome / Edge：`chrome://extensions` → **Load unpacked** → 选择 **`extension/output/chrome-mv3`**。
Firefox：`npm run dev:firefox`，加载 `extension/output/firefox-mv3`。

可选：复制 `extension/dev-settings.json.example` → 本地 JSON，填入 Key 后在扩展 Options 页导入。
**不要**把含密钥的文件放到 `extension/public/`——该目录会进入生产 zip。

**打包 / 发布：**

```bash
make build-extension        # 类型检查 + 构建 + 打包 chrome/firefox
```

产物：

- `extension/output/chrome-mv3/` · `extension/output/firefox-mv3/`（unpacked）
- `extension/output/*.zip`（并复制到 `dist/`，用于商店上架 / 侧载）

内容脚本以 WXT **unlisted script**（`dual-read.js`）形式产出，点击翻译时通过 `chrome.scripting.executeScript` **按需注入**，不会自动注入所有页面。

#### 3. 配置插件（走服务端时）

| 设置 | 使用服务端 | 直连上游 |
|------|------------|----------|
| API base URL | `http://127.0.0.1:8080/v1` | `https://api.deepseek.com` 等 |
| API key | 本地默认可留空；若开启 `auth.enabled` 则填服务端 Key | 必填 |
| Model | 可用映射别名，如 `flash`，或上游真实 id | 与上游一致 |

首次访问非 localhost 站点时，浏览器可能要求授权 `optional_host_permissions`，按提示允许即可。

#### 4. 使用

- 插件图标 → **翻译页面** / **恢复原文**
- Popup 切换目标语言与模式（双语对照 / 直接替换）
- 选中文字 → 右键 → **翻译选中文本**
- Options 可调并发、每批片段数、自定义请求头，并支持导入 / 导出 JSON

---

## 服务端配置（TOML）

详见 [`server/README.md`](server/README.md) 与 [`server/config.example.toml`](server/config.example.toml)。

```toml
[server]
host = "127.0.0.1"
port = 8080

[upstream]
base_url = "https://api.deepseek.com"
# api_key 也可只靠环境变量 OPENAI_API_KEY

[auth]
enabled = false
# [[auth.keys]]
# name = "alice"
# key = "sk-server-alice"
# models = { flash = "deepseek-v4-flash" }

[models]
default = "deepseek-v4-flash"
[models.map]
flash = "deepseek-v4-flash"

[admin]
enabled = true
path = "/admin"
token = ""   # 公网请设置

[cache.local]
enabled = true
ttl = "10m"
max_mb = 256

[cache.valkey]
enabled = false
addr = "127.0.0.1:6379"
ttl = "24h"

[log]
level = "info"
```

### 环境变量（覆盖配置）

| 变量 | 说明 |
|------|------|
| `OPENAI_API_KEY` | 上游 API Key（必填，除非每个 auth key 自带 `upstream_api_key`） |
| `OPENAI_BASE_URL` | 上游地址，默认 `https://api.deepseek.com` |
| `DUAL_READ_HOST` | 监听地址（Docker 用 `0.0.0.0`） |
| `DUAL_READ_PORT` | 监听端口 |
| `DUAL_READ_CACHE_LOCAL` / `DUAL_READ_CACHE_VALKEY` | `true` / `false` |
| `DUAL_READ_VALKEY_ADDR` / `DUAL_READ_VALKEY_PASSWORD` | Valkey |
| `DUAL_READ_LOG_LEVEL` | 如 `info` / `debug` |
| `DUAL_READ_ADMIN_TOKEN` | Admin 页口令 |
| `DUAL_READ_AUTH_ENABLED` | 强制开关服务端鉴权 |
| `DUAL_READ_ALLOW_INSECURE_PUBLIC` | 允许在公网（`0.0.0.0`/`::`）绑定时缺少鉴权或 admin token 启动；默认 `false`，此时会**拒绝启动**以防配额被刷 |
| `DUAL_READ_ALLOW_PRIVATE_UPSTREAM` | 允许上游 `base_url` 指向私网 / 链路本地地址（如局域网自建 LLM）；默认 `false`，仅放行环回地址以防 SSRF |

### 缓存与鉴权要点

- 缓存键覆盖会影响生成的字段（model、messages、temperature、top_p、max_tokens、seed、tools 等）+ 透传头指纹 + 鉴权身份
- `stream: true` 会被拒绝（服务端按整包 JSON 缓存，不兼容流式）
- Valkey 启动 ping 失败会 **Error 日志** 并降级为无共享缓存，服务继续
- 开启 `auth.enabled` 后，插件 / 客户端必须带 `Authorization: Bearer <服务端 Key>`

---

## Make 命令

```bash
make dev-extension          # 插件开发(Chrome)：WXT dev/HMR，自动打开或 Load unpacked output/chrome-mv3
make dev-extension-firefox  # 插件开发(Firefox)：WXT dev/HMR，自动打开或 output/firefox-mv3
make build            # 服务端多平台二进制 + 插件打包 → dist/
make build-server     # 仅服务端 → dist/server/
make docker-build     # 构建 dual-read-server 容器镜像
make docker-smoke     # 容器冒烟：non-root + read-only + /livez
make build-extension  # 仅插件：类型检查 + 构建 + zip（chrome/firefox）
make test             # 服务端 go test + 插件 tsc/vitest
make test-server      # 仅服务端 go test ./...
make test-extension   # 仅插件 compile + lint + vitest
make test-e2e         # 插件 E2E：真实 Chromium/Firefox 加载构建产物跑 Playwright
make test-e2e-perf    # 性能预算 lab（Chromium + mock API）
make check-golangci   # 服务端 golangci-lint v2
make check-npm-audit  # 插件运行时 npm audit 门禁
make sbom             # 生成 CycloneDX / Go modules SBOM → dist/sbom/
make check-store      # 商店文案 / 隐私 / 权限一致性检查
make check-release    # 发布门禁：VERSION/CHANGELOG/package.json（例：VERSION=0.1.0）
make package-amo-sources  # Firefox AMO sources zip → dist/store/
make assemble-release # 汇总 dist/release/ + SHA256SUMS（需先构建产物）
make release-dry-run  # 无 tag 发布干跑：构建 + 校验 SHA256SUMS（不发布）
make run-server       # 运行服务端（需 OPENAI_API_KEY）
make install-server   # go install 到 $GOBIN
make clean            # 删除 dist/ 与 extension/output/
```

---

## 验证

```bash
# 存活 / 就绪 / 诊断
curl -s http://127.0.0.1:8080/livez
curl -s http://127.0.0.1:8080/readyz
curl -s http://127.0.0.1:8080/health

# 监控页
open http://127.0.0.1:8080/admin

# 翻译（首次 MISS，重复 HIT）
curl -s -D - http://127.0.0.1:8080/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"flash","messages":[{"role":"user","content":"hello"}],"temperature":0.3}' \
  | grep -iE 'x-cache|x-dual-read'

# Valkey 键（启用 valkey 后）
redis-cli keys 'dual_read:*'
```

---

## 参与贡献

欢迎贡献！请先阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。

- 报告 Bug：[Issues](https://github.com/skys-mission/dual-read/issues/new?template=bug_report.yml)
- 功能建议：[Feature Request](https://github.com/skys-mission/dual-read/issues/new?template=feature_request.yml)
- PR 标题需遵循 [Conventional Commits](https://www.conventionalcommits.org/)（`feat:`、`fix:`、`docs:` 等）

---

## Star 趋势

[![Star History Chart](https://api.star-history.com/svg?repos=skys-mission/dual-read&type=Date)](https://star-history.com/#skys-mission/dual-read&Date)

---

## License

[Apache License 2.0](LICENSE)

参与贡献即表示同意遵守 [行为准则](CODE_OF_CONDUCT.md)，并按 [贡献指南](CONTRIBUTING.md) 提交变更。
