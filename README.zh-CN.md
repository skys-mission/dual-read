# Dual Read — 网页双语翻译与 YouTube 双语字幕

[English](README.md) | **简体中文**

Dual Read 是一款支持 **Chrome、Edge 和 Firefox 的开源浏览器翻译插件**。通过你配置的 OpenAI 兼容 API（如 DeepSeek、OpenAI 或本地 Ollama），翻译网页和 YouTube 字幕，同时保留原文对照阅读。

可以单独使用插件，也可以接入可选的自托管 Go 缓存代理，减少重复 API 请求。**使用前需要配置翻译服务**；第三方 API 可能按用量收费。

[![GitHub Release](https://img.shields.io/github/v/release/skys-mission/dual-read?logo=github&label=Release)](https://github.com/skys-mission/dual-read/releases/latest)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![CI](https://github.com/skys-mission/dual-read/actions/workflows/ci.yml/badge.svg)](https://github.com/skys-mission/dual-read/actions/workflows/ci.yml)
[![Zero telemetry](https://img.shields.io/badge/Telemetry-none-success)](PRIVACY.md)

## 浏览器商店

**0.2.0 已上架 Edge 和 Firefox 插件商店，并已发布至 [GitHub Releases](https://github.com/skys-mission/dual-read/releases/tag/v0.2.0)。** 此版本新增 YouTube 双语字幕，并改进网页排版、原文恢复和缓存处理。完整变更见 [CHANGELOG.md](CHANGELOG.md)。

| 浏览器 | 安装 Dual Read | 要求与方式 |
|---|---|---|
| Microsoft Edge | [从 Edge 加载项商店安装](https://microsoftedge.microsoft.com/addons/detail/hpkdnnlmodeggabfieondnamlmamibik) | 商店安装，支持自动更新 |
| Firefox | [从 Firefox 附加组件商店安装](https://addons.mozilla.org/zh-CN/firefox/addon/dual-read-translator/) | 桌面版 Firefox **140+**，支持自动更新 |
| Chrome | [下载 0.2.0 ZIP](https://github.com/skys-mission/dual-read/releases/download/v0.2.0/dual-read-extension-0.2.0-chrome.zip) | 手动安装，详见[加载浏览器插件](#加载浏览器插件) |

[快速开始](#快速开始) · [特性](#特性) · [支持的 API](#支持的-api) · [常见问题](#常见问题) · [可选服务端](#可选服务端) · [开发](#开发)

## 快速开始

1. **安装插件。** Edge 和 Firefox 用户从对应商店安装；Chrome 用户下载 ZIP，按[手动安装步骤](#加载浏览器插件)加载。
2. **配置翻译服务。** 打开插件设置（Options），选择「**直连 API**」，填写 API 地址、API Key 和模型，并选择目标语言。保存设置，按提示授权访问 API 地址，再点击「**测试连接**」。无 Key 的本地端点或自建代理请参照[支持的 API](#支持的-api)。
3. **开始翻译。** 点击插件图标，选择「**翻译页面**」，或按 `Alt+T`。翻译 YouTube 字幕时，打开带字幕的桌面视频观看页，点击原生 **CC** 旁的双语按钮。

插件弹窗中的「**网页**」和「**字幕**」页签分别控制网页翻译与字幕翻译。YouTube 字幕翻译默认关闭。

## 为什么选择 Dual Read？

- **阅读外文文章、技术文档和研究页面**，同时查看原文与译文。
- **结合 YouTube 字幕学习语言**，对照原始字幕与翻译。
- **自主选择翻译服务与模型**，通过 OpenAI 兼容 API 连接云端服务或本地 Ollama。
- **复用翻译结果**，插件内置本地缓存，需要服务端缓存时再接入可选代理。
- **可审查源码、自主控制数据去向**，采用 Apache 2.0 许可证，默认零遥测，无需使用项目方运营的翻译后端。

## 特性

### 网页双语翻译

- 保留原文与译文双语对照，也可切换为直接替换模式。
- 优先翻译可见区域，浏览时继续处理动态新增内容。
- `Alt+T` 翻译或恢复原文，`Alt+M` 切换显示模式。
- 选中文字后从右键菜单触发划词翻译，在浮层中查看结果。
- 按站点设置自动翻译或永不翻译规则。
- 复用本地缓存，失败时自动重试；持续失败的译文可点击重试。

### YouTube 双语字幕

支持翻译**桌面 YouTube 视频观看页**已有的人工字幕或自动生成字幕。通过原生 **CC** 旁的双语按钮或插件弹窗的「**字幕**」页签开启，复用已配置的 API 和目标语言。

可在设置中调整字幕语言、字号和位置。自动开启字幕翻译是当前设备的可选设置，**默认关闭**。仅显示待机按钮时，不读取字幕，也不发送翻译请求。

暂不支持直播、Shorts、移动站、嵌入播放器和画中画字幕。Dual Read 不录制音频，也不从语音生成字幕。完整字幕轨道不可用时，可能降级为翻译当前可见的原生字幕；可用性与延迟取决于 YouTube 和所配置的翻译服务。

### 语言与设置

| 设置 | 可用选项 |
|---|---|
| 界面语言 | 英语、简体中文、繁体中文、俄语、西班牙语、法语 |
| 翻译目标语言 | 简体中文、英语、俄语、西班牙语、法语 |
| 连接设置 | API 地址、模型、API Key，以及仅保存在本地的自定义 HTTP 请求头 |
| 设置迁移 | 支持导入与导出；API Key 和自定义请求头默认排除，需显式选择才会导出 |

## 支持的 API

网页翻译和字幕翻译均使用 **OpenAI 兼容的 Chat Completions API**。根据所用服务选择连接方式：

| 翻译服务 | 设置中的连接方式 | API Key |
|---|---|---|
| DeepSeek、OpenAI 或其他兼容服务 | **直连 API** | 必填 |
| 无需 Key 的本地端点，例如 Ollama | **Dual Read 代理**，填写本地端点的 API 地址和模型 | 端点无需鉴权时可留空 |
| 自建 `dual-read-server` | **Dual Read 代理** | 服务端开启鉴权后必填 |

填写服务商提供的 API 基础地址，而非完整请求地址：插件会自动追加 `/chat/completions`。例如，默认 DeepSeek 地址为 `https://api.deepseek.com`。模型需选择所用服务中实际可用的模型。远程端点必须使用 **HTTPS**；HTTP 仅支持环回地址（`localhost`、`127.0.0.1` 或 `::1`）。

翻译质量、速度与费用取决于所选模型、服务商和网络。接口兼容不代表不同模型的表现完全一致。

## 常见问题

### 必须部署服务端吗？

不需要。插件可以直接连接你配置的 API。[可选服务端](#可选服务端)提供缓存、相同请求合并和访问控制，网页翻译与 YouTube 字幕翻译均不依赖它。

### Dual Read 免费吗？

源码以 [Apache 2.0 许可证](LICENSE)开放。Dual Read 不附带翻译服务或 API 额度；第三方服务可能收取 API 费用，本地模型则使用你自己的硬件。缓存实际节省的费用取决于命中情况和服务商定价。

### 可以使用本地 Ollama 模型吗？

可以，通过 Ollama 的 OpenAI 兼容端点连接。在设置中填写其 API 地址和已安装的模型；端点无需 Key 时，选择「**Dual Read 代理**」即可留空 API Key，这种方式无需运行 `dual-read-server`。仅启用本地缓存不会把远程 API 变为本地模型。

### 网页、字幕和 API Key 会发送到哪里？

页面、选区及启用翻译后的字幕文本会发送到**你配置的 API 端点**；如果使用自建代理，它可以继续转发到所配置的上游。项目维护者不接收你的浏览内容或 API Key，Dual Read 默认零遥测。API Key 和自定义请求头保存在本地，用于向所配置端点发送请求；部分非敏感偏好可通过浏览器账户同步。详见[隐私政策](PRIVACY.md)。

### 为什么需要站点访问权限？

手动网页翻译使用你主动操作的当前标签页权限；连接远程 API 或开启某站点的自动翻译时，会请求对应来源的访问权限。YouTube 访问权限用于显示待机按钮，并在你开启翻译后读取已有字幕。浏览器可能在安装或升级时要求接受这项权限。详见[权限与数据说明](PRIVACY.md#what-the-extension-can-access)。

### 从 0.1.x 升级后需要做什么？

如浏览器提示，请接受 YouTube 站点访问，然后刷新已打开的 YouTube 页面。手动安装的插件需先从实际安装目录重新加载。字幕翻译仍需单独开启。完整说明见 [0.2.0 变更与升级提示](CHANGELOG.md)。

## 可选服务端

`dual-read-server` 是可自托管的 Go 缓存代理，支持本地 BigCache 或共享 Valkey 缓存、相同并发请求合并、API Key 和模型别名，管理界面可查看缓存与请求情况。

从源码运行时，使用 [`server/go.mod`](server/go.mod) 指定的 Go 工具链，并从仓库根目录执行：

```bash
cd server
export OPENAI_API_KEY=sk-your-key
go run ./cmd/dual-read-server
```

默认上游为 DeepSeek，监听 `http://127.0.0.1:8080`，开启本地缓存，管理界面位于 `/admin`。插件中选择「**Dual Read 代理**」，API 地址填写 `http://127.0.0.1:8080/v1`；服务端未开启鉴权时，客户端 Key 可留空。

[已发布的二进制](https://github.com/skys-mission/dual-read/releases)无需安装 Go。安装与配置见[服务端指南](server/README.md)，容器、Valkey 和生产部署见[部署文档](server/docs/DEPLOY.md)。在环回地址以外开放服务前，请阅读[安全指南](SECURITY.md)。

## 加载浏览器插件

Edge 和 Firefox 的日常安装与自动更新请使用[浏览器商店](#浏览器商店)。以下步骤适用于 Chrome 或手动测试安装。

从 [0.2.0 Release](https://github.com/skys-mission/dual-read/releases/tag/v0.2.0) 下载对应 ZIP 和 `SHA256SUMS`，按[下载校验指南](docs/RELEASE.md#verify-a-download)验证：

- **Chrome / Edge：**使用 `dual-read-extension-0.2.0-chrome.zip`，解压后打开 `chrome://extensions` 或 `edge://extensions`，开启「**开发者模式**」，选择「**加载已解压的扩展程序**」，定位到包含 `manifest.json` 的目录。
- **Firefox 140+：**GitHub 安装包 `dual-read-extension-0.2.0-firefox.zip` **未经 Mozilla 签名**。解压后打开 `about:debugging#/runtime/this-firefox`，点击「**临时载入附加组件**」，选择 `manifest.json`。临时安装在重启 Firefox 后失效；正常安装与自动更新需使用商店签名版本。详见 Mozilla 的[临时安装说明](https://extensionworkshop.com/documentation/develop/temporary-installation-in-firefox/)。

## 开发

插件使用 TypeScript 和 WXT，可选服务端使用 Go。构建插件需要 Node.js **22.12+** 的 22.x，或受支持的 24.x / 26+。从仓库根目录执行：

```bash
npm --prefix extension ci
make build-extension
```

按[手动安装步骤](#加载浏览器插件)，在 Chrome/Edge 加载 `extension/output/chrome-mv3`，或在 Firefox 临时加载 `extension/output/firefox-mv3/manifest.json`。

热更新开发、测试与 DOM 恢复约定见 [CONTRIBUTING.md](CONTRIBUTING.md)，常用命令见 [Makefile](Makefile)。CI 根据改动范围运行 TypeScript 检查、lint、单元测试、浏览器构建与 E2E、Go 竞态与覆盖率检查，以及商店元数据一致性检查；纯文档改动跳过无关构建与测试。

## 文档导航

| 文档 | 内容 |
|---|---|
| [English](README.md) | 英文安装与使用指南 |
| [隐私政策](PRIVACY.md) | 数据去向、存储方式与浏览器权限 |
| [安全指南](SECURITY.md) | 漏洞报告与服务端加固 |
| [变更记录](CHANGELOG.md) | 版本变更与升级提示 |
| [服务端指南](server/README.md) | 安装、配置、缓存与鉴权 |
| [部署文档](server/docs/DEPLOY.md) | 容器、Valkey、TLS 与生产部署 |
| [贡献指南](CONTRIBUTING.md) | 开发环境、测试与 PR 要求 |
| [发布与校验](docs/RELEASE.md) | 发布流程、校验和与证明 |
| [性能实验](docs/PERF_LAB.md) | 性能预算与验证 |
| [Firefox E2E](docs/FIREFOX_E2E.md) | Firefox 浏览器测试配置 |

## 参与贡献

欢迎[报告 Bug](https://github.com/skys-mission/dual-read/issues/new?template=bug_report.yml)或[提出功能建议](https://github.com/skys-mission/dual-read/issues/new?template=feature_request.yml)。提交代码或文档前，请阅读[贡献指南](CONTRIBUTING.md)并遵守[行为准则](CODE_OF_CONDUCT.md)。PR 标题使用 Conventional Commits 格式，例如 `docs: clarify installation`。

## License

[Apache License 2.0](LICENSE)。
