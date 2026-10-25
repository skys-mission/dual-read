# YouTube 双语字幕首版验收

日期：2026-10-25。分支：`dev-youtube-bilingual-subtitles`。本页记录开发构建；未发布到商店。

## 结果与使用方式

G0 已取得真实人工/ASR 的完整 JSON3 时码，随后完成字幕首版。配置过翻译服务后，在桌面版 YouTube `/watch` 页面打开扩展，点击“字幕 → 开启双语字幕”。原文在上、译文在下；播放器新增“双语 ▾”。网页翻译保持独立。

默认目标语言跟随现有设置，字幕可以单独指定语言。低频选项仅语言、字号、位置、自动开启。自动开启默认关闭，仅在用户确认后申请 `https://www.youtube.com/*`。播放器的自动开启项直达已有设置页的字幕区域，实际权限申请在扩展页面里由用户触发。

## 实现边界

- `youtube-adapter.ts` 经 MAIN world 读取当前视频/选中轨道，有限观察原生 fetch/XHR 或复用当前页面的合法字幕 URL。签名 URL、Cookie 和完整播放器响应不进入翻译请求。
- `youtube-lease.ts` 持有原生 CC 开关的有限所有权。先准备租约、安装请求监听，再由租约开启 CC，避免漏掉首次原生请求。关闭、重注入、导航时恢复；用户改过轨道、开关或替换节点后不覆盖用户选择。现有页面监听器可在撤销新脚本执行权限后释放所有权。
- JSON3 规范化保留时间、窗口替换、追加和重复句。翻译严格按 ID/revision 对齐，只重试缺失/格式错误的条目一次；不会把未解析输出广播给多条字幕。
- 最多两批并行，每批最多五个 cue、8,000 字符，总预取窗口不超过 60 秒/24 个 cue。seek、导航、换轨取消旧请求；广告阶段隐藏字幕；错误停止自动请求，保留原生字幕和手动重试入口。
- 完整轨道不可用但原生字幕可读时，以明确的“实时字幕”状态翻译当前可见文字。源不可用、确实无轨道与模型错误分别呈现。
- 字幕缓存独立命名空间，共用既有 TTL、LRU 和清空机制；隐身只在内存缓存。自动开启偏好仅设备本地保存，设置同步和导入均不能开启它。
- 关闭自动默认会结束由自动启动创建的会话并移除未来启动脚本；用户手动开启的会话保持原意图。手动关闭的标签页不会被自动默认重新打开。
- 自有 UI 与原生 CC 容器从网页采集链路排除。播放器中的文本通过 `textContent` 写入 Shadow DOM。
- 首版支持桌面观看页已有字幕，不支持正在直播、Shorts、移动站、iframe 嵌入、音频转录或画中画字幕。字幕源语言跟随 YouTube 原生设置。

## 证据分层

| 层级 | 环境 | 能证明什么 |
|---|---|---|
| 真实字幕源 | 用户登录后的内置 Chromium，原生 CC，真实视频/SPA | 人工 466 个文本事件、ASR 572 个文本事件；第二个视频 505 个 ASR 文本事件。见 [G0](../research/youtube-subtitles-g0.md) |
| G0 桥接合同 | Chromium / Firefox 的真实临时 MV3 扩展，受控 YouTube 页面 | MAIN/isolated/background、请求观察、身份与所有权，含真实脱敏样本 |
| 首版功能 | 新构建的真实 MV3 内容脚本/后台/provider，测试专用授权与控制 relay | 时间轴、取消、缓存、错误、恢复与页面翻译共存；没有 `chrome.*` shim |
| 工具栏和权限 | 原始生产 manifest 的隔离有界面配置，仅在后台初始化本地 mock API | 用户手势 `activeTab`、真实 popup、原生权限提示、设备偏好和播放器 UI |
| 真实翻译服务 | Firefox 155.0 生产 MV3 扩展 + 受控人工/ASR 源 + 真实 MiMo | 实际跨源服务请求、严格解析、双语显示、缓存和恢复；不覆盖登录态 YouTube 在线源 |

最终生产租约/适配器顺序还在用户登录的真实页面上复验：初始 CC 关闭，准备租约后仍关闭，安装监听后开启；**527ms** 从原生请求取得 **65,976 字节 / 466 条人工字幕**，释放后 CC 恢复关闭。随后把用户页面恢复为测试前的 CC 开启，保留静音、暂停。[结果](../research/evidence/youtube-final-lease-live.json) / [播放器截图](../research/evidence/youtube-final-live-muted.png)。此复验在 MAIN world 调用生产函数，未在用户会话中安装测试扩展或发送模型请求。

自动化功能套件的测试 relay 与 YouTube 预授权只存在临时副本中。手工工具栏测试副本没有这些授权或静态内容脚本；仅将测试 API/语言填入 storage。API 使用 loopback mock，未消耗用户模型额度。Firefox 的临时安装不能代替商店正式安装时的同意流程。

### 真实翻译服务补测

2026-10-25 使用用户已有配置的 MiMo `mimo-v2.6-flash`，通过生产 `translateSubtitleItems`、provider 和严格 ID 解析器发送五条自编英文测试字幕，目标语言为简体中文。一次 HTTP 200 返回全部五个 ID/revision，无格式重试；网络请求耗时 **3,753ms**，用量 **297 prompt + 120 completion = 417 tokens**。译文保留了 640 像素、原始宽高比、字幕自动显示、暂停和播放同步等含义。完整受控样本及计数见[脱敏记录](../research/evidence/youtube-provider-canary-2026-10-25.json)。

随后在 Firefox 155.0 的真实 MV3 生产后台/内容脚本中补测同一服务。播放器与时码源为明确标注的受控页面：五条自编人工字幕、五条含窗口/追加事件的 ASR 样本；视频为无音轨本地 WebM。模型请求没有 mock 或路由替换，走实际 HTTPS 服务。诊断副本只增加 YouTube 和配置 API origin 的授权，密钥经一次性 loopback 通道写入扩展 session storage，没有打包或记录到报告。

| 真实服务场景 | 观察结果 |
|---|---|
| 人工样本 5 条 | 全部正确对齐并显示；首条译文在启用后约 3,474ms 被观察到；API 请求 3,030ms |
| 切换 ASR 样本 5 条 | 追加事件合并后原文完整，译文逐条显示；切轨后首条约 12,952ms；API 请求 11,326ms |
| 关闭、重新开启与 seek | 原生 CC 初始关闭被恢复；缓存重开约 85ms 显示首条，重开和 seek 共新增 0 次模型请求 |
| 用户切轨后关闭 | 保留用户选择的 ASR / CC 开启；原生字幕节点身份和可见性恢复，自有字幕文本清空 |
| 服务用量 | 两次 HTTP 200，共 695 prompt + 260 completion = 955 tokens；加上独立 canary，总计三次请求 / 1,372 tokens |

请求耗时包括读取响应正文；UI 耗时从启用/切轨到测试首次观察到非空译文，包含测试轮询开销。所有数值均为这次单样本观测，不是性能保证。ASR 请求较慢说明真实服务延迟存在波动；本次没有评估长视频连续播放就绪率或每分钟费用。样本译文保留了追加字幕、切换语言取消旧请求、恢复原生字幕等含义，没有把相邻译文串给其他原文。

证据：[Firefox 真实服务记录](../research/evidence/youtube-firefox-real-provider-2026-10-25.json)、[人工字幕截图](../research/evidence/firefox-real-provider-manual.png)、[ASR 截图](../research/evidence/firefox-real-provider-asr.png)。截图播放器内明确标注了受控源，不能作为真实 YouTube 登录态全链路截图。

### Firefox 登录态阻塞

用户尝试在独立 Firefox 测试配置中登录后，Google 显示“此浏览器或应用可能不安全”，未完成登录。Google 的[官方说明](https://support.google.com/accounts/answer/7675428?hl=en)列出受软件自动化控制的浏览器等可能原因；当前是 Playwright Nightly 配置，但不能据此排除其他原因。没有绕过登录检查、修改 UA 或移植其他浏览器的 Cookie。

返回真实测试视频后，未登录源请求仍为 HTTP 200 / 0 字节，扩展进入 `source-error`，模型请求数为零；同一运行中原生播放器随后也显示播放错误。关闭扩展后状态回到 `off`。测试浏览器通过 `media.volume_scale=0` 保持输出静音；播放器错误重建媒体时曾读到媒体元素的默认音量属性，此时媒体暂停且未就绪，后续驱动已在 loadstart/emptied 等事件上补充静音保护。详见[脱敏失败记录](../research/evidence/youtube-firefox-live-unavailable-2026-10-25.json)。临时浏览器及测试配置已关闭清理。

Firefox 登录态源验证仍保留为待验证。后续适合在用户能正常登录的普通 Firefox 配置里通过临时加载扩展验证；本次受控源 + 真实服务结果不能替代该关卡。

## 浏览器测试

两个引擎都覆盖：人工字幕、初始 CC 开/关、ASR 换轨、SPA、慢响应 seek、401、429、坏 JSON、空源的实时降级、确实无字幕、同语言零请求、外观设置不重译、剧场/全屏、广告、0.5/1/2 倍速、网页翻译共存、原生 CC 关闭、重复注入、准备中取消、播放器替换、模型 HTML 作为纯文本、窄屏键盘、短视口菜单、跨源清理、媒体时钟、自动默认与手动意图的优先级，以及只接受原生请求 URL 的源场景。

| 检查 | 结果 |
|---|---|
| TypeScript / ESLint / `git diff --check` | 通过 |
| Vitest | 48 个文件，2,019 项通过 |
| Chromium / Firefox 生产构建 | 均通过；无新增安装时网站权限或静态内容脚本 |
| G0 源合同 | 每引擎 28 项，共 56 项通过 |
| 首版功能最终独立运行 | 每引擎 24 项，共 48 项通过，无跳过、重试或失败 |
| 既有 UI / 加载回归 | Chromium popup/options 5 项通过（含 axe）；Firefox 真实 addon 加载 2 项通过 |

相关浏览器检查合计 **111 项通过**，分套件执行。另将本轮取得的完整真实字幕在内存中交给生产规范化函数：人工 466 个 cue / 3,797 个词、ASR 572 个 cue / 4,073 个词，规范化前后词序完全一致、时间区间有序且有效。只保存[计数结果](../research/evidence/youtube-full-track-normalization.json)，未保存完整原文。

媒体时钟用真实静音 WebM、视频已缓冲和本地 mock 测量。Chromium 的 seek 原文更新为 **17.2ms**、播放跨 cue 边界偏差 **16.1ms**；Firefox 分别为 **11.0ms / 18.9ms**。这是单次本地测试的观测值，测量原文 cue 绘制，不包含模型网络耗时，不能作为跨设备性能保证。测试记录见[机器可读摘要](youtube-subtitles-v1.json)。

单元覆盖还包括真实脱敏人工/ASR 样本逐词保留、重复文本与空隙、重叠窗口、严格 ID/部分重试、缓存隔离与清空、隐身不落盘、设置迁移和本地权限偏好、权限申请保留原始点击调用栈、撤销权限后的 CC 所有权释放。

手工检查结果：

- Chromium、Firefox 均从原生扩展工具栏取得 `activeTab`，在没有持久 YouTube 授权时一键开启并显示双语。
- Chromium 拒绝自动权限时保持关闭、当前手动字幕继续；设置页允许后，新标签页自动开始翻译。
- Firefox 的可选授权提示、允许后的重新加载自动启动、手动关闭后的 SPA 保持关闭均通过。原生权限管理页撤销 YouTube 权限后，扩展自动开关恢复为关闭。
- Chromium 在一个由自动启动建立的活跃会话中撤回站点访问后，字幕停止，原生 CC 从开启恢复到最初的关闭；未再点击扩展工具栏取得新授权。
- 两个引擎检查了实际 popup 与播放器选项。Chromium 在 200% 浏览器缩放下，菜单限制在可见区域并可内部滚动，键盘能到达第四项；播放器可直达已展开的字幕设置。

截图：[Chromium 弹窗](../research/evidence/youtube-subtitles-chromium-popup.png)、[播放器](../research/evidence/youtube-subtitles-chromium-player.png)、[选项](../research/evidence/youtube-subtitles-chromium-options.png)、[200% 缩放](../research/evidence/youtube-subtitles-chromium-zoom200.png)、[撤回访问](../research/evidence/youtube-subtitles-chromium-revoked.png)；[Firefox 弹窗](../research/evidence/youtube-subtitles-firefox-popup.png)、[播放器](../research/evidence/youtube-subtitles-firefox-player.png)、[自动启动](../research/evidence/youtube-subtitles-firefox-auto.png)、[撤销权限](../research/evidence/youtube-subtitles-firefox-revoked.png)。这些是本地受控播放器和 mock 译文，不能冒充真实 YouTube 全链路翻译截图。

## 重跑

在 `extension/` 中，先完成构建，再串行运行浏览器套件；构建会替换 output，Playwright 会清理 test-results，不要同时运行两个使用这些目录的任务。

```bash
npm run compile
npm run lint
npm test
npm run build
npm run build:firefox
npm run test:youtube-source
npm run test:youtube-subtitles
npx playwright test e2e/popup.spec.ts
npx playwright test e2e/firefox.spec.ts --grep 'firefox extension load'
```

真实服务补测按需执行，会使用忽略的 `dev-settings.json` 中的服务并消耗模型额度，不纳入 CI。运行方式和诊断权限边界见[工具说明](../../extension/tools/youtube-live-validation/README.md)：

```bash
node tools/youtube-live-validation/provider.mjs
node tools/youtube-live-validation/run.mjs --controlled-source
node tools/youtube-live-validation/run.mjs
```

`subtitle-clock.webm` 是本地生成的 120 秒、640×360、10fps、VP8 纯色静音测试视频，无外部素材、无音轨。媒体路由支持 206 Range；字幕用人工 fixture，避免用墙上时钟伪装视频时钟。示例生成命令：

```bash
ffmpeg -f lavfi -i color=c=0x24304b:s=640x360:r=10 -t 120 -an -c:v libvpx -b:v 80k subtitle-clock.webm
```

## 发布前保留项

- Firefox 真实登录会话的在线源 canary 被 Google 登录拒绝阻塞。独立未登录配置仍返回 200/空正文，不能推断“必须登录”；内置未登录浏览器此前也出现过可用原生字幕。
- 真实模型独立 canary、Firefox 受控人工/ASR 源的实际服务翻译显示、缓存与恢复已通过；Firefox 真实 YouTube 字幕的翻译显示、每分钟成本和长视频就绪率仍待补测。浏览器自动化套件继续使用可控 mock 验证代码和请求边界。
- 多音轨、全部 JSON3 变体、真实广告切换、平台实验 UI 与系统高对比/屏幕阅读器的全面验收仍需补充。200% 手工缩放检查针对 Chromium；Firefox 有窄屏/短视口/键盘自动化覆盖。
- 文档中的 150ms/250ms 仅是本地媒体时钟测试目标，不是在线模型响应 SLA。商店发布、签名和安装同意流程未执行。

本轮没有 Go 服务端变更。实现为独立编写，没有复制参考项目的源码，也未新增运行时依赖或安装时全站权限。
