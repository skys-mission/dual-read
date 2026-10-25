# YouTube 双语字幕现成实现调研

日期：2026-10-24。研究方式：读取三个项目的固定提交源码、README 和 LICENSE，并查阅 Read Frog、沉浸式翻译、Language Reactor 的官方交互说明；未运行这些扩展或验证真实 YouTube 播放效果。最终产品取舍以[设计文档](../design/youtube-bilingual-subtitles.md)为准。

## 研究约定

- 目标：为 Dual Read 选择值得借鉴的字幕机制与交互，重点是设置简单、播放器内入口轻量。
- 范围 / 对象 / 研究单元：桌面 YouTube 双语字幕 / Dual Read 新功能 / 三个开源扩展的获取、解析、调度、显示及清理代码。
- 类型：探索性源码比较；已有字幕接入基础研究，当前需要识别成熟设计与适用边界。
- Q1：现成实现怎样获取字幕，如何处理 JSON3 / ASR？
- Q2：怎样同步、预译、缓存、处理过期结果和 SPA？
- Q3：怎样植入 UI，默认配置是否降低使用负担？
- Q4：哪些设计适合本项目，哪些不应直接迁入？
- 完成标准：每个项目都有实现证据；明确 README 宣称、代码事实、设计推论和未实测部分；给出可采纳的原则。

## 来源与版本

排名：作者维护的原始实现及许可证优先；README 用来核对产品宣称。代码可以证明“如何实现”，不能证明所有视频上的成功率或用户体验优劣。

| 项目 | 固定提交 | 提交日期（UTC） | 许可事实 |
|---|---|---|---|
| Read Frog | `23523841690ff640cd55be973495f4deec17bac6` | 2026-10-23 | LICENSE 为 GNU GPL v3；GitHub API 标识 `GPL-3.0`；README 另称 GPLv3 / 商业双许可。[LICENSE][R-license]、[README][R-readme-license] |
| BilingualTube | `01ee5cc8c7d6ac3b72beed4ac0a44fed8f6b2a8d` | 2026-08-26 | LICENSE 为 GNU GPL v3；GitHub API 标识 `GPL-3.0`。[LICENSE][B-license] |
| yt-dual-subs | `5657c8a18ca30c84b5d4662bca58e3e9214ffdff` | 2026-09-11 | LICENSE 为 MIT；GitHub API 标识 `MIT`。[LICENSE][D-license] |

以上只记录仓库文件和平台元数据，不作许可证适用或兼容性法律结论。本轮没有复制这些项目的实现到 Dual Read。

## 证据台账

### Read Frog

| 编号 | 代码事实 / 宣称 | 固定来源 | 回答 |
|---|---|---|---|
| R1 | MAIN world 脚本在 `document_start` 注入，覆盖 YouTube 与 youtube-nocookie、各 frame。 | [入口][R-entry] | Q1 |
| R2 | XHR hook 在 load 后缓存带 `v` 与 `pot` 的 timedtext URL；桥接从当前播放器取轨道并核对 expectedVideoId。 | [观察器][R-observer]、[播放器桥][R-bridge] | Q1 |
| R3 | 优先快取；必要时开 CC 等待 token/真实请求，再用轨道 baseUrl 及页面参数构建请求；轨道身份包含 videoId、语言、kind、vssId。 | [fetcher][R-fetch]、[回退][R-fetch-fallback]、[URL][R-url] | Q1 |
| R4 | 格式检测区分标准、scrolling-ASR、karaoke、stylized karaoke、animated；ASR parser 使用跨事件缓冲、词级 offset、追加分隔事件及长度边界。 | [检测][R-format]、[ASR parser][R-asr] | Q1/Q2 |
| R5 | 默认每批 5 段、向前 30 秒；预取窗口随倍速扩大，倍率封顶 4。 | [常量][R-constants]、[倍速窗口][R-lookahead] | Q2 |
| R6 | 翻译协调器用 runId 和 cue 身份丢弃停止/改写后的结果；只翻译播放点附近尚未处理片段。 | [协调器][R-coordinator] | Q2 |
| R7 | 显示监听原生 video 的 timeupdate 与 seeking，按 currentTime 选择 cue。 | [调度器][R-scheduler] | Q2 |
| R8 | 缓存身份包含文本、provider、源/目标语言；LLM 路径还纳入实际提示词等内容，后台读取并保存翻译缓存。 | [hash][R-hash]、[后台缓存][R-cache] | Q2 |
| R9 | 按钮打开设置面板并显示 ON/OFF；主面板包含翻译开关、下载、侧栏等入口；按钮由独立 Shadow host 承载。 | [按钮][R-button]、[主菜单][R-menu]、[挂载][R-button-mount] | Q3 |
| R10 | 字幕功能默认 enabled，但 YouTube autoStart 为 false；默认双语、译文在上，AI 分句默认关闭。 | [默认配置][R-defaults]、[样式常量][R-style] | Q3 |
| R11 | YouTube 会话按播放器模式管理；销毁清理监听器、调度器和 UI，移除隐藏原生字幕的样式；显示恢复与 CC 开关状态是不同动作。 | [会话][R-session]、[销毁][R-destroy]、[原生显示][R-native] | Q2/Q4 |

### BilingualTube

| 编号 | 代码事实 / 宣称 | 固定来源 | 回答 |
|---|---|---|---|
| B1 | MAIN world 在 document_start 用 Vista 拦截 fetch/XHR，直接解析 timedtext 响应；含 tlang 时去掉该参数重取原文，避免二次翻译。 | [入口与拦截][B-entry] | Q1 |
| B2 | JSON3 转词级时间片；按人工/ASR、语言和标点情况分流，英语及日语部分路径调用本地标点恢复模型。 | [规范化与分流][B-parse]、[调用路径][B-punct] | Q1/Q2 |
| B3 | 预译接下来最多 10 个未翻译 cue，后台先查 IndexedDB；cache key 为 engine + targetLang + text，最多 10000 条、30 天。 | [预译][B-lookahead]、[缓存][B-cache] | Q2 |
| B4 | 同步依赖播放器私有 onVideoProgress；store.reset 会 abort 旧会话，返回时检查 signal。 | [播放监听][B-clock]、[结果检查][B-result]、[store][B-store] | Q2 |
| B5 | 在播放器下挂两行 DOM，以 textContent 更新；从原生字幕采样字体/颜色并响应尺寸变化；是否显示跟随原生 CC 按钮状态。 | [显示][B-overlay]、[样式镜像][B-mirror]、[CSS][B-css] | Q3 |
| B6 | 常用设置为目标语言、显示模式、引擎；默认 en / Google / bilingual；扩展工具栏动作打开设置页。 | [设置表单][B-options]、[默认值][B-defaults]、[工具栏][B-action] | Q3 |
| B7 | 入口未使用 setupSubtitleInterception/setupSubtitleUI 的 cleanup 返回值，页面更新监听调用被注释；“每次新字幕请求都等于新视频”的 reset 也是其当前简化。 | [入口][B-lifecycle]、[拦截 reset][B-entry] | Q2/Q4 |
| B8 | README 宣称优先官方翻译；本次读到的主路径会去掉 tlang 重取原文并调用所选 provider，不能据 README 推导其当前拥有独立官方译轨优先算法。 | [README][B-readme]、[实际路径][B-entry]、[后台][B-background] | Q1/Q4 |

### yt-dual-subs

| 编号 | 代码事实 / 宣称 | 固定来源 | 回答 |
|---|---|---|---|
| D1 | MAIN script 使用 XHR、fetch 及 Resource Timing 观察真实字幕 URL，具备重复注入 guard；请求保留参数并设置 JSON3/tlang。 | [注入声明][D-manifest]、[捕获][D-capture]、[guard][D-guard]、[URL 与 parser][D-parse] | Q1 |
| D2 | parser 保留事件顺序及最后一个词的时间；译轨数量不一致时存在时间近邻匹配路径，因此 README 的“完美逐条对齐”不是可直接采纳的保证。 | [parser][D-parse]、[近邻回退][D-align]、[README][D-readme] | Q1/Q2 |
| D3 | cue 模式每 120ms 读取 video.currentTime，使用二分查找；提前取未来 cue 或句组；回复以 videoId/nonce 检查过期。 | [循环][D-clock]、[媒体时间][D-time]、[预取][D-prefetch]、[回复校验][D-response] | Q2 |
| D4 | 后台区分急需/预取队列；付费 provider 可合批，重度退避时丢弃预取；缓存 namespace 包含 provider/model/baseURL 等。 | [队列参数][D-queue]、[退避][D-shed]、[缓存][D-cache] | Q2 |
| D5 | 轨道失败后读取原生字幕 DOM，200ms 轮询，持续空白降至1秒；回包检查文本与请求 token。 | [DOM 降级][D-fallback] | Q1/Q2 |
| D6 | 控制栏一个图标主体切换，箭头开菜单，含键盘和 ARIA；只在自身开启过 CC 时尝试关闭恢复。 | [按钮][D-button]、[CC][D-cc] | Q3 |
| D7 | 默认开启、zh-CN、auto引擎、原文在上、默认点击穿透；弹窗有预览和引擎选择，也有间距控制。 | [默认值][D-defaults]、[弹窗][D-popup]、[间距][D-popup-style] | Q3 |
| D8 | 导航清空当前轨道、过期请求状态并停止显示循环，通知后台丢弃播放队列；事件之外还有500ms URL轮询。 | [导航][D-navigation]、[后台丢队列][D-drop] | Q2/Q4 |

### 官方产品说明与本项目设置

| 编号 | 文档事实 / 观察 | 来源与证据边界 | 回答 |
|---|---|---|---|
| U1 | Read Frog 提供独立字幕 provider、prompt、速率、批次和样式设置；官方提示 AI 分句增加成本与延迟，有时使时间不够准确。 | [官方字幕文档](https://www.readfrog.app/en/docs/video-subtitles)，维护者说明，未独立运行验证 | Q2/Q3 |
| U2 | Read Frog 的官方截图将翻译按钮放在播放器控制条中，与原生 CC/设置按钮并列。 | [官方截图](https://www.readfrog.app/assets/translate-button-Dfo_uwkb.png)，已在浏览器查看，不等同于实测最新版扩展 | Q3 |
| U3 | 沉浸式翻译的使用文档提供自动开启双语字幕；FAQ 提示可使用原生字幕样式选项。 | [使用说明](https://immersivetranslate.com/docs/usage/#youtube-bilingual-subtitles)、[FAQ](https://immersivetranslate.com/docs/faq/#video-translation-related)，产品文档 | Q3 |
| U4 | 沉浸式翻译维护者说明默认尽量复用播放器已取得的原文字幕，再交给选定翻译服务；YouTube 机翻字幕 429 时尝试一次原文恢复。 | [429 说明](https://immersivetranslate.com/docs/youtube-subtitle-429/)，维护者对内部行为的说明，未查其私有实现 | Q1/Q4 |
| U5 | Language Reactor 官方帮助展示功能开关、词典、逐句自动暂停和多组快捷键，目标是语言学习。 | [官方帮助](https://www.languagereactor.com/help/basic)，2026-10-24 浏览器渲染读取；普通抓取仅返回 JavaScript 壳；未安装扩展 | Q3/Q4 |
| L1 | Dual Read 现有 280px 弹窗包含目标语言、页面模式、站点规则；已有全局翻译服务和目标语言。 | [popup](../../extension/entrypoints/popup/index.html)、[popup 样式](../../extension/entrypoints/popup/style.css)、[options](../../extension/entrypoints/options/index.html)，本地源码 | Q3/Q4 |
| L2 | 当前 popup 的语言保存操作修改全局 targetLang/mode。新增字幕语言选择若要独立，不能直接复用这个写入动作。 | [popup/main.ts](../../extension/entrypoints/popup/main.ts) 第 192–197 行，本地源码 | Q4 |
| P1 | Chrome activeTab 同源导航仍有效，跨源导航撤销；storage.session 可在浏览器会话内存放标签页临时偏好，默认不暴露给 content script。 | [Chrome activeTab](https://developer.chrome.com/docs/extensions/develop/concepts/activeTab)、[MDN storage.session](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/storage/session)，API 参考；Firefox具体行为仍需本项目验收 | Q4 |

## 范围过滤

- 保留获取与生命周期设计，不把“开源已有实现”推导为网页接口长期稳定，也不报告抓取成功率或字幕同步精度。
- 不把源码注释中的实测经验、README 性能/健壮性形容词当作本轮独立验证。
- R4/B2/D2 展示了三种不同规范化策略，不能视为一份完整 JSON3 标准；应使用自己采集的样本检验边界。
- 排除朗读、章节摘要、词卡、商业账户、皮肤和字幕导出作为首版必备功能；这些不解决当前“双语字幕、配置简单”的核心需求。

## 对象过滤

- 三个项目的主要获取入口都依赖提前注入。Dual Read 的按需注入需要额外设计“中途启用”：读取当前播放器数据、扫描仍存在的资源记录、必要时受控触发新的字幕请求，而非只等下一次请求（R1–R3、B1、D1）。
- R11 的恢复原生字幕显示不能等同于恢复最初 CC 状态；D6 的 ownership 标记值得借鉴，但仍要覆盖用户中途手动改 CC 的情形。
- B4 的私有播放器事件不作为本项目唯一播放时钟；沿用 HTMLVideoElement.currentTime 更容易独立测试。
- B7 是静态代码中看到的生命周期覆盖不足，不声称已经在浏览器复现泄漏或串片。
- D2 的近邻匹配说明双轨不能一律按数组索引配对；本项目以自己翻译的稳定 cue id 对齐更可控。
- 两个体量较大的项目包含大量非核心能力。借鉴职责边界和状态规则，不搬入整套功能或依赖。
- U1/U5 的学习与高级定制能力有明确产品用途，但本次目标是简约观看；不把竞品选项数量当成本项目需求清单。U4 是维护者说明，不能写成对其闭源实现的独立源码验证。

## 结论与可采纳设计

1. **架构主要参考 Read Frog。**字幕源、规范化、预译、显示与会话清理分别负责；用“当前视频 + 当前轨道 + 会话代次 + cue 身份”挡住晚到结果。R2–R8、R11 支持这些职责划分。
2. **播放器入口参考 yt-dual-subs。**主按钮直接开关，旁边的小菜单承载次要操作；按键、tooltip、ARIA 与 YouTube 控制栏保持一致。D6 支持该交互；不需要把全部高级设置塞进播放器。
3. **减少设置参考 BilingualTube 的取舍。**用户首先需要顺畅开启和正确目标语言；翻译服务沿用 Dual Read 现有设置。B5–B6 表明少量选项也可组成完整字幕层；本项目可以进一步省去首版显示模式选择，固定双语，不开放逐行字体、颜色、描边、背景、间距等独立参数。
4. **首版以有限预译改善等待感。**R5、B3、D3–D4 均使用有边界的前瞻策略。Dual Read 可先用保守时间窗口加条数/字符上限，在慢接口或限流时优先当前字幕，拖动后重新排优先级；具体数值应由自身测试决定。
5. **失效应优雅降级，关闭应完整恢复。**D5 的 DOM 方案有明确能力折损；需要向用户区分“字幕读取失败”和“没有字幕”。D6/R11 提供恢复思路，但本项目应明确原生 CC 和自有样式各自的所有权。
6. **缓存必须体现翻译配置和上下文。**R8/D4 的 namespace 思路适合本项目；B3 的简单 key 不适合直接用于多模型、可改 prompt 或上下文相关字幕翻译。

## 给主设计的 UI 建议

以下是结合上述证据的设计建议，不是三个项目共同遵循的事实：

- 首次在 YouTube 从 Dual Read 弹窗选择“翻译字幕”；按需授权/注入完成后，播放器才出现一个双语字幕按钮。
- 播放器按钮负责开/关；小菜单放“译成… / 字幕大小 / 位置”，尺寸做小、标准、大三档；双语顺序固定，首版不加模式切换。
- “在 YouTube 自动开启”作为用户主动选择的站点偏好；全局翻译服务继续在现有设置页管理。
- 画面默认原文在上、译文在下；同一字幕盒、留出控制栏空间，默认点击穿透。此顺序是本产品选择，R10 与 D7 本就采用不同默认值。
- 初次加载用短暂状态文字；译文未到先保留当前原文，过期译文不追赶插入。错误只给简短原因和重试入口。
- 不在常用界面暴露 token、抓取模式、预取秒数、并发数、批大小和解析器类型。

## 待验证与验收方向

- 中途启用、CC 已开/未开、字幕请求早已完成、视频切换、播放器重建与反复启停，均不能重复创建 UI 或累积监听器。
- 用户手动改 CC、语言或字幕轨后，扩展不得用旧会话强制覆盖；退出只撤回自身仍拥有的改动。
- 真实 JSON3 样本分别覆盖人工、ASR追加/重叠、不同语言/音轨、空事件与短时 cue；原文不得因规范化丢词。
- 跳转、暂停、倍速、广告与全屏验证当前 cue；异步回包、断网、429及设置更换验证过期结果和缓存隔离。
- Chromium/Firefox 都使用新构建验收。三个仓库的支持声明不替代 Dual Read 的浏览器测试。
- 本轮未运行任何源项目测试或真实视频实验；未测量延迟、成本、成功率或维护工时。

## 固定源码索引

[R-license]: https://github.com/mengxi-ream/read-frog/blob/23523841690ff640cd55be973495f4deec17bac6/LICENSE#L1-L6
[R-readme-license]: https://github.com/mengxi-ream/read-frog/blob/23523841690ff640cd55be973495f4deec17bac6/README.md#L261-L267
[R-entry]: https://github.com/mengxi-ream/read-frog/blob/23523841690ff640cd55be973495f4deec17bac6/src/entrypoints/interceptor.content/index.ts#L1-L12
[R-observer]: https://github.com/mengxi-ream/read-frog/blob/23523841690ff640cd55be973495f4deec17bac6/src/entrypoints/interceptor.content/timedtext-observer.ts#L1-L64
[R-bridge]: https://github.com/mengxi-ream/read-frog/blob/23523841690ff640cd55be973495f4deec17bac6/src/entrypoints/interceptor.content/inject-player-api.ts#L149-L190
[R-fetch]: https://github.com/mengxi-ream/read-frog/blob/23523841690ff640cd55be973495f4deec17bac6/src/utils/subtitles/fetchers/youtube/index.ts#L195-L263
[R-fetch-fallback]: https://github.com/mengxi-ream/read-frog/blob/23523841690ff640cd55be973495f4deec17bac6/src/utils/subtitles/fetchers/youtube/index.ts#L305-L349
[R-url]: https://github.com/mengxi-ream/read-frog/blob/23523841690ff640cd55be973495f4deec17bac6/src/utils/subtitles/fetchers/youtube/url-builder.ts#L15-L48
[R-format]: https://github.com/mengxi-ream/read-frog/blob/23523841690ff640cd55be973495f4deec17bac6/src/utils/subtitles/fetchers/youtube/format-detector.ts#L109-L157
[R-asr]: https://github.com/mengxi-ream/read-frog/blob/23523841690ff640cd55be973495f4deec17bac6/src/utils/subtitles/fetchers/youtube/parser/scrolling-asr-parser.ts#L35-L138
[R-constants]: https://github.com/mengxi-ream/read-frog/blob/23523841690ff640cd55be973495f4deec17bac6/src/utils/constants/subtitles.ts#L14-L18
[R-lookahead]: https://github.com/mengxi-ream/read-frog/blob/23523841690ff640cd55be973495f4deec17bac6/src/utils/subtitles/lookahead.ts#L1-L6
[R-coordinator]: https://github.com/mengxi-ream/read-frog/blob/23523841690ff640cd55be973495f4deec17bac6/src/entrypoints/subtitles.content/translation-coordinator.ts#L191-L242
[R-scheduler]: https://github.com/mengxi-ream/read-frog/blob/23523841690ff640cd55be973495f4deec17bac6/src/entrypoints/subtitles.content/subtitles-scheduler.ts#L200-L245
[R-hash]: https://github.com/mengxi-ream/read-frog/blob/23523841690ff640cd55be973495f4deec17bac6/src/utils/subtitles/processor/translator.ts#L113-L155
[R-cache]: https://github.com/mengxi-ream/read-frog/blob/23523841690ff640cd55be973495f4deec17bac6/src/entrypoints/background/subtitles-translation.ts#L38-L88
[R-button]: https://github.com/mengxi-ream/read-frog/blob/23523841690ff640cd55be973495f4deec17bac6/src/entrypoints/subtitles.content/ui/subtitles-translate-button.tsx#L13-L52
[R-menu]: https://github.com/mengxi-ream/read-frog/blob/23523841690ff640cd55be973495f4deec17bac6/src/entrypoints/subtitles.content/ui/subtitles-settings-panel/views/main-menu.tsx#L10-L30
[R-button-mount]: https://github.com/mengxi-ream/read-frog/blob/23523841690ff640cd55be973495f4deec17bac6/src/entrypoints/subtitles.content/renderer/render-translate-button.tsx#L45-L84
[R-defaults]: https://github.com/mengxi-ream/read-frog/blob/23523841690ff640cd55be973495f4deec17bac6/src/utils/constants/config.ts#L289-L315
[R-style]: https://github.com/mengxi-ream/read-frog/blob/23523841690ff640cd55be973495f4deec17bac6/src/utils/constants/subtitles.ts#L111-L129
[R-session]: https://github.com/mengxi-ream/read-frog/blob/23523841690ff640cd55be973495f4deec17bac6/src/entrypoints/subtitles.content/init-youtube-subtitles.ts#L57-L108
[R-destroy]: https://github.com/mengxi-ream/read-frog/blob/23523841690ff640cd55be973495f4deec17bac6/src/entrypoints/subtitles.content/universal-adapter.ts#L185-L222
[R-native]: https://github.com/mengxi-ream/read-frog/blob/23523841690ff640cd55be973495f4deec17bac6/src/entrypoints/subtitles.content/universal-adapter.ts#L818-L846
[B-license]: https://github.com/rxliuli/bilingualtube/blob/01ee5cc8c7d6ac3b72beed4ac0a44fed8f6b2a8d/LICENSE#L1-L6
[B-entry]: https://github.com/rxliuli/bilingualtube/blob/01ee5cc8c7d6ac3b72beed4ac0a44fed8f6b2a8d/entrypoints/content/index.ts#L29-L114
[B-parse]: https://github.com/rxliuli/bilingualtube/blob/01ee5cc8c7d6ac3b72beed4ac0a44fed8f6b2a8d/lib/subtitles/subtitle-utils.ts#L8-L156
[B-punct]: https://github.com/rxliuli/bilingualtube/blob/01ee5cc8c7d6ac3b72beed4ac0a44fed8f6b2a8d/entrypoints/content/index.ts#L130-L175
[B-lookahead]: https://github.com/rxliuli/bilingualtube/blob/01ee5cc8c7d6ac3b72beed4ac0a44fed8f6b2a8d/lib/subtitles/cues-utils.ts#L1-L35
[B-cache]: https://github.com/rxliuli/bilingualtube/blob/01ee5cc8c7d6ac3b72beed4ac0a44fed8f6b2a8d/lib/cache.ts#L3-L96
[B-clock]: https://github.com/rxliuli/bilingualtube/blob/01ee5cc8c7d6ac3b72beed4ac0a44fed8f6b2a8d/entrypoints/content/index.ts#L409-L431
[B-result]: https://github.com/rxliuli/bilingualtube/blob/01ee5cc8c7d6ac3b72beed4ac0a44fed8f6b2a8d/entrypoints/content/index.ts#L367-L396
[B-store]: https://github.com/rxliuli/bilingualtube/blob/01ee5cc8c7d6ac3b72beed4ac0a44fed8f6b2a8d/lib/store.ts#L39-L48
[B-overlay]: https://github.com/rxliuli/bilingualtube/blob/01ee5cc8c7d6ac3b72beed4ac0a44fed8f6b2a8d/entrypoints/content/index.ts#L270-L317
[B-mirror]: https://github.com/rxliuli/bilingualtube/blob/01ee5cc8c7d6ac3b72beed4ac0a44fed8f6b2a8d/entrypoints/content/subtitleStyleMirror.ts#L30-L105
[B-css]: https://github.com/rxliuli/bilingualtube/blob/01ee5cc8c7d6ac3b72beed4ac0a44fed8f6b2a8d/entrypoints/content/global.css#L1-L48
[B-options]: https://github.com/rxliuli/bilingualtube/blob/01ee5cc8c7d6ac3b72beed4ac0a44fed8f6b2a8d/entrypoints/options/components/OptionsForm.tsx#L97-L145
[B-defaults]: https://github.com/rxliuli/bilingualtube/blob/01ee5cc8c7d6ac3b72beed4ac0a44fed8f6b2a8d/lib/settings.ts#L24-L32
[B-action]: https://github.com/rxliuli/bilingualtube/blob/01ee5cc8c7d6ac3b72beed4ac0a44fed8f6b2a8d/entrypoints/background.ts#L139-L141
[B-lifecycle]: https://github.com/rxliuli/bilingualtube/blob/01ee5cc8c7d6ac3b72beed4ac0a44fed8f6b2a8d/entrypoints/content/index.ts#L34-L49
[B-readme]: https://github.com/rxliuli/bilingualtube/blob/01ee5cc8c7d6ac3b72beed4ac0a44fed8f6b2a8d/README.md#L3-L10
[B-background]: https://github.com/rxliuli/bilingualtube/blob/01ee5cc8c7d6ac3b72beed4ac0a44fed8f6b2a8d/entrypoints/background.ts#L16-L86
[D-license]: https://github.com/Gythiro/yt-dual-subs/blob/5657c8a18ca30c84b5d4662bca58e3e9214ffdff/LICENSE#L1-L13
[D-capture]: https://github.com/Gythiro/yt-dual-subs/blob/5657c8a18ca30c84b5d4662bca58e3e9214ffdff/inject.js#L1218-L1273
[D-parse]: https://github.com/Gythiro/yt-dual-subs/blob/5657c8a18ca30c84b5d4662bca58e3e9214ffdff/inject.js#L182-L227
[D-align]: https://github.com/Gythiro/yt-dual-subs/blob/5657c8a18ca30c84b5d4662bca58e3e9214ffdff/content.js#L4169-L4182
[D-readme]: https://github.com/Gythiro/yt-dual-subs/blob/5657c8a18ca30c84b5d4662bca58e3e9214ffdff/README.md#L125-L134
[D-clock]: https://github.com/Gythiro/yt-dual-subs/blob/5657c8a18ca30c84b5d4662bca58e3e9214ffdff/content.js#L2041-L2088
[D-prefetch]: https://github.com/Gythiro/yt-dual-subs/blob/5657c8a18ca30c84b5d4662bca58e3e9214ffdff/content.js#L4144-L4167
[D-response]: https://github.com/Gythiro/yt-dual-subs/blob/5657c8a18ca30c84b5d4662bca58e3e9214ffdff/content.js#L4393-L4397
[D-queue]: https://github.com/Gythiro/yt-dual-subs/blob/5657c8a18ca30c84b5d4662bca58e3e9214ffdff/background.js#L368-L395
[D-shed]: https://github.com/Gythiro/yt-dual-subs/blob/5657c8a18ca30c84b5d4662bca58e3e9214ffdff/background.js#L553-L585
[D-cache]: https://github.com/Gythiro/yt-dual-subs/blob/5657c8a18ca30c84b5d4662bca58e3e9214ffdff/background.js#L280-L315
[D-fallback]: https://github.com/Gythiro/yt-dual-subs/blob/5657c8a18ca30c84b5d4662bca58e3e9214ffdff/content.js#L4522-L4608
[D-button]: https://github.com/Gythiro/yt-dual-subs/blob/5657c8a18ca30c84b5d4662bca58e3e9214ffdff/content.js#L1885-L1963
[D-cc]: https://github.com/Gythiro/yt-dual-subs/blob/5657c8a18ca30c84b5d4662bca58e3e9214ffdff/content.js#L1988-L2034
[D-defaults]: https://github.com/Gythiro/yt-dual-subs/blob/5657c8a18ca30c84b5d4662bca58e3e9214ffdff/content.js#L59-L116
[D-popup]: https://github.com/Gythiro/yt-dual-subs/blob/5657c8a18ca30c84b5d4662bca58e3e9214ffdff/popup.html#L56-L139
[D-navigation]: https://github.com/Gythiro/yt-dual-subs/blob/5657c8a18ca30c84b5d4662bca58e3e9214ffdff/content.js#L5418-L5537
[D-drop]: https://github.com/Gythiro/yt-dual-subs/blob/5657c8a18ca30c84b5d4662bca58e3e9214ffdff/background.js#L537-L550
[D-guard]: https://github.com/Gythiro/yt-dual-subs/blob/5657c8a18ca30c84b5d4662bca58e3e9214ffdff/inject.js#L1-L12
[D-time]: https://github.com/Gythiro/yt-dual-subs/blob/5657c8a18ca30c84b5d4662bca58e3e9214ffdff/content.js#L3939-L3951
[D-popup-style]: https://github.com/Gythiro/yt-dual-subs/blob/5657c8a18ca30c84b5d4662bca58e3e9214ffdff/popup.html#L265-L268
[D-manifest]: https://github.com/Gythiro/yt-dual-subs/blob/5657c8a18ca30c84b5d4662bca58e3e9214ffdff/manifest.json#L47-L71
