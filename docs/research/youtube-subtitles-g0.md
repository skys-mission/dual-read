# YouTube 字幕源 G0 验证

日期：2026-10-24–2026-10-25（Asia/Shanghai）。分支：`dev-youtube-bilingual-subtitles`。

**当前结论：已取得真实完整轨道，按需获取方案可行，可以继续首版实现。** 2026-10-25 在用户自行登录的内置 Chromium 浏览器中，同一份探针成功读取人工 / ASR 字幕，验证了 CC 关闭后的启用和恢复、播放中途重放、真实 SPA 后身份切换。真实扩展跨世界通信另在 Chromium / Firefox 中验证，并增加这次取得的脱敏真实样本回放。

这是[设计文档](../design/youtube-bilingual-subtitles.md)规定的实施关卡。**可行性通过不等于完整产品验收：Firefox 登录态线上、正式工具栏 activeTab 激活和首版翻译 UI 仍待验证。** 未登录独立配置的空响应保留为环境兼容性风险，不归因为没有字幕，也不把登录设成产品的强制前提。G0 本身不新增面向用户的设置或播放器控件。

## 1. 已实现的验证代码

- [`youtube-adapter.ts`](../../extension/lib/subtitles/youtube-adapter.ts)：独立、可序列化的 `probeYouTubeSource`。仅支持桌面 watch 主 frame，校验 URL、当前播放器响应与 `getVideoData` 的视频 ID；校验选中轨道并区分人工 / ASR。
- [`browser.mjs`](../../extension/tools/youtube-source-probe/browser.mjs)：为每次测试构建并加载一次性 MV3 诊断扩展，走真实 `ISOLATED → background → scripting.executeScript(MAIN) → background → ISOLATED`。Chromium 和 Firefox 都没有使用 `chrome.*` shim。
- [`run.mjs`](../../extension/tools/youtube-source-probe/run.mjs)：真实站点 canary。用独立临时配置启动浏览器；检查人工 / ASR、CC 初始开关、中途按需读取，以及实际 watch 链接触发的 SPA 导航。关闭浏览器后删除临时配置。
- [`youtube-source.spec.ts`](../../extension/e2e/youtube-source.spec.ts)：在两个真实浏览器中用受控页面 / 网络响应验证源获取及恢复合同。已加入 Playwright 两个项目的 `testMatch`。

诊断扩展只授予测试所需的 YouTube host 权限；它的静态 relay 等待测试命令，随后才调用探针。这个权限用于分离验证浏览器通信能力，**不等于已经验证产品工具栏点击的 `activeTab` 授权流程**。正式扩展 manifest、自动注入和设置 schema 均未改动。探针目前没有导入正式 background / popup，因此普通扩展构建不会向用户暴露未通过关卡的功能。

G0 采用 `scripting.executeScript` 的结构化结果直接返回源数据，不需要先引入生产用页面消息总线。测试里的 `window.postMessage` 仅用于自动化控制诊断扩展。后续持续会话仍需单独实现身份、取消、权限及生命周期校验。

## 2. 获取与清理合同

1. 优先观察当前轨道的真实 XHR / fetch 响应；fetch 使用 clone，保留播放器自己的响应消费路径。
2. Resource Timing 只提供候选 URL。找不到非空响应时最多做一次有界请求，保留当前页面产生的签名 / token 参数，仅选择 JSON3 格式；不生成 token，也不转交代理抓取。
3. 必要时开启一次原生 CC。探针结束时，只有仍拥有这次改动、视频 / 轨道 / 控件身份未变化，才恢复原始 CC 开关。
4. 原生 CC 点击、实际属性变化、轨道切换、SPA 或播放器替换会影响恢复资格。相同 `aria-pressed` 值的重复渲染不算用户操作。观察器不会改写字幕节点或恢复已被页面替换的按钮。
5. 结束时移除监听器并取消自己的请求。仅当全局 fetch / XHR 仍是自己的 wrapper 时才恢复，保留其他脚本后来安装的 wrapper。
6. 只有非空、带有效时间信息的 JSON3 字幕事件才能标为 `ready`。HTTP 200 / 空正文、坏格式和缺少轨道 metadata 都是获取不可用；只有明确空轨道数组才标为 `no-tracks`。视频或轨道变化丢弃旧事件。

探针默认 6 秒，参数限制为 300 ms–10 秒；真实 canary 每次使用 4 秒。响应体限制为 4 MiB，事件数量与分段数量有上限。它保留 JSON3 的时间、追加 / 窗口标记和词级 offset，**尚未实现 ASR 规范化、稳定 cue ID 或翻译对齐**。

## 3. 真实 YouTube 证据

主样本为 YouTube Developers 的 [`M7lc1UVf-VE`](https://www.youtube.com/watch?v=M7lc1UVf-VE)，同时提供英文人工字幕和自动字幕。SPA 样本从当时页面实际存在的 watch 链接选择，最终视频 ID 记录在证据中；不会用 `history.pushState` 冒充真实 YouTube 导航。

登录态正向记录见 [2026-10-25 脱敏 JSON](./evidence/youtube-g0-authenticated-2026-10-25.json)。运行的是仓库适配器编译后的自包含函数，经 CUA CDP 在当前页 MAIN 环境执行；没有安装正式扩展，不能将它计为正式 activeTab 测试。响应观察通过 Network 域核对，记录不包含 cookie、签名 URL、账号标识或原始字幕正文，没有导出用户会话到独立测试浏览器。

| 登录态场景 | 结果 | 响应 / 时码 | 状态恢复 |
|---|---|---|---|
| 原生 ASR 响应独立观察 | 成功 | 429,168 bytes；1,144 events，572 个文本事件，3,497 个词级 offset | 原生 CC 保持开启 |
| 播放中途，ASR 已开启 | `ready`，`a.en` | 页面上下文重放同一轨道，完整 JSON3 | 保持开启 |
| 播放中途，人工已开启 | `ready`，`.en` | 65,976 bytes；466 个文本事件 | 保持开启 |
| 人工 CC 初始关闭 | `ready`，`.en` | 捕获原生请求；466 个文本事件 | `false → true → false`，269 ms |
| ASR CC 初始关闭 | `ready`，`a.en` | 捕获原生请求；572 个文本事件 | `false → true → false`，318 ms |
| 点击真实站内链接至 `M6mYodf0dJM` | `ready`，`a.en` | 306,251 bytes；505 个文本事件；同一 document | 使用新视频身份 |
| SPA 后请求上一个 videoId | 拒绝旧身份 | 无字幕事件返回 | 不改 CC |

本次验证结束后返回主测试视频，仍保持静音。[播放器截图](./evidence/youtube-authenticated-asr-muted.png)只保留播放器区域。此前未登录内置浏览器也曾显示原生人工 / ASR 字幕，见[当时截图](./evidence/youtube-native-asr-muted.png)；当时尚未保存非空网络正文。因此只能确定当前登录会话工作，不能确定“未登录”是空响应的根因。

首版接入后另以最终的 CC 租约 + 适配器函数复验初始 CC 关闭：先安装请求监听，再由租约开启 CC，527ms 从原生请求取得 466 条人工字幕，释放租约后恢复关闭。测试后恢复用户先前的 CC 开启，保持静音暂停。[最终顺序结果](./evidence/youtube-final-lease-live.json)与[截图](./evidence/youtube-final-live-muted.png)只保存安全摘要和播放器区域。生产规范化函数对完整人工/ASR 轨道的[逐词计数核对](./evidence/youtube-full-track-normalization.json)也通过，未存完整原文。

保留的[2026-10-24 独立配置报告](./evidence/youtube-g0-2026-10-24.json)是负向记录：Chromium 153.0.8010.12 与 Firefox 155.0 未登录配置中出现 HTTP 200 / 空正文及超时。**该早期驱动的 ASR 设置未生效，`actualKind` 仍是 manual，不能算 ASR 已覆盖；SPA 遇到广告也不能算源测试通过。** 当前驱动改为原生菜单选择，检查实际轨道类型；不能用改过的驱动描述旧报告的测试条件。

已观察到的限制：

- 播放器能返回正确视频与轨道 metadata、视频能够播放，不代表字幕正文已取得。
- 原生字幕请求和页面内重放都可能返回 200 / 0 bytes。该结果不能归因为“视频没有字幕”。
- 新增[人工](./evidence/youtube-manual-redacted.json)和[ASR](./evidence/youtube-asr-redacted.json)真实脱敏样本：各取前 60 个事件，替换所有词，保留时间、窗口、追加、词级 offset、标点和重复关系；未保存替换词典。它们与原本人工编写的合成边界样例分别标识。
- 当前登录环境为内置 Chromium 浏览器；Firefox 的真实登录会话尚未验证。不能从单一可用会话推出所有用户、地区或登录状态均可用。
- 一次探索性的 60 秒 seek 在两种浏览器中均未在 20 秒内恢复就绪；这不作为源获取失败的根因，也不计为 seek 功能已验证。最终中途注入用例使用已经自然播放的视频，时间见记录。真实 seek / 倍速 / 同步精度留给后续功能验收。

源码调研之外，yt-dlp 的维护者也讨论过“字幕响应为空”和“没有字幕”需要区分的情况；它只能作为错误分类的背景，不能解释本次网络环境的根因：[yt-dlp #13443](https://github.com/yt-dlp/yt-dlp/issues/13443)。

## 4. 本地浏览器覆盖

每种浏览器分别覆盖：

- XHR / fetch，初始 CC 关闭后的启用与恢复，已开启 CC 的中途 URL 重放，原始响应仍可被页面消费。
- 人工字幕、ASR 的窗口 / 追加 / 词级时间字段、重复文本；原生 `vss_id`、人工字幕 `kind: ''` 和 CC 关闭时隐藏选择信息的情况。
- SPA 后新视频身份、途中换视频 / 换轨 / 替换播放器，旧结果不返回；URL 与播放器身份不符时不请求。
- CC 点击、同一微任务里的关→开属性变化、相同属性重复写入、按钮被页面替换；不覆盖页面后来安装的 fetch / XHR wrapper。
- 空正文、缺少 metadata、明确无轨道、坏格式 / 无效时码、非 YouTube 请求 URL。
- 正在直播 / 广告阶段不开始获取；直播回放不会仅因 `isLiveContent` 被排除。
- 严格页面 CSP 下的真实 MAIN 注入、隔离环境无法直接调用页面播放器 API、返回数据不含签名 URL。

本地受控验证与真实源 canary 分开计数。它证明适配器在明确输入下的行为，不证明 YouTube 当前一定返回相同格式，也不证明首版字幕显示、翻译性能或登录兼容性。

## 5. 重跑与恢复实施

从仓库根目录进入 `extension/`：

```bash
npm run test:youtube-source
npm run probe:youtube -- --browser=both --headed
```

也可选择 `--browser=chromium` 或 `--browser=firefox`。默认无界面；真实源诊断建议加 `--headed`。不需要翻译密钥，不发送模型请求，不读取用户浏览器配置，也不伪装 UA 或生成访问凭据。

真实 canary 输出在 `extension/test-results/youtube-source/`，属于忽略的本地结果；Playwright 可清理该目录。报告会在每个场景后重新创建目录并保存累积结果。需要长期保留时，先审查脱敏内容再复制到 `docs/research/evidence/`。

退出码：`0` 表示本次全部要求的源场景满足检查；`2` 表示工具正常运行但字幕源关卡没有通过；`1` 表示导航、播放器准备或测试通信未完成。即便返回 `0`，仍需检查未覆盖的登录 / `activeTab` / 发布场景，不能据此直接标记整个产品已验收。

后续已接入现有 provider、严格 cue 解析、有限预译和单一启停控件，详见[首版验收记录](../testing/youtube-subtitles-v1.md)。设置沿用现有连接及默认目标语言，低频选项保持四项。完整轨道失败但原生 DOM 正常时显示“实时”状态；空响应不强制登录、不伪报无字幕。两种浏览器的真实工具栏入口已另行验证，Firefox 登录态实网仍为发布前补测项。
