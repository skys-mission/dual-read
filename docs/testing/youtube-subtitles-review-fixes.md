# YouTube 字幕 review 修复验证

日期：2026-10-25。修复基线：`69ec447`。分支：`dev-youtube-bilingual-subtitles`。

本轮修复 review 确认的 6 个 P2 问题，不增加设置项、权限或依赖。播放器仍使用“双语＋箭头”入口，偏好仍为目标语言、字号、位置和设备本地自动开启。唯一新增的文案用于解释为何不能把 YouTube 的自动译文当作原文继续翻译。

## 修复与回归

| 问题 | 修复后的行为 | 对应回归 |
|---|---|---|
| 切轨后刷新被旧 generation 拒绝 | content 实例通过 ping 提供实例 ID；后台保留标签页启停意图，为新实例轮换 sessionId 并重置源代次。apply 也限定目标实例，旧 session 请求继续被拒绝 | `reload-manual`、`reload-auto`：切人工/ASR后刷新恢复；旧 session 的 source 请求拒绝；手动关闭后刷新仍关闭 |
| 原生菜单或快捷键关闭 CC 后继续翻译 | MAIN 租约观察实际 CC 状态，向当前租约的会话发出关闭事件；停止、取消请求并记录手动关闭意图。排除扩展自己的恢复、广告和已替换按钮的事件 | `native-menu-off`、`native-keyboard-off`、`native-off-preparing`、`ad-cc`、`replace-cc` |
| 自动译文被当作原文二次翻译 | DOM 降级从同一 MAIN 快照读取轨道状态和文字。原生自动翻译开启时不提供原文文字、不调用模型，保留原生字幕并提示切回原始语言。切回后自动重新准备；完整原轨可用时正常翻译 | `translated-dom`、`translated-dom-switch`、`translated-full-track` |
| 缺失元数据被判为无字幕 | `hasTracks` 区分未知、确认空列表和非空列表。初始化有界等待；仍未知则显示获取错误，常规状态轮询发现元数据就绪后恢复，不循环抓字幕或请求模型 | `late-metadata`、`missing-metadata`、`empty-metadata` |
| 调整倍速导致 CC 无法恢复 | 设置菜单点击之后比较真实字幕选择，只有字幕轨道或原生自动翻译选择发生变化才放弃恢复责任 | `unrelated-settings`、`caption-selection`，以及自动翻译选择改回后的单元测试 |
| 修改偏好后焦点丢失 | 共享偏好表单提供原位更新；播放器和弹窗保留控件节点，更新值和标签。修改后焦点保持，Esc 关闭面板并返回箭头按钮 | `preference-focus`，以及更新语言标签、自动开关和后续回调值的单元测试 |

review 阶段在修复前的生产构建中已逐项复现：刷新进入 `source-error`；CC 关闭后仍有新增模型请求；西班牙语 DOM 配英语源提示词；元数据恢复后仍 `no-tracks`；倍速调整后关闭扩展仍留下 CC 开启；字号修改后焦点落到 `BODY`，Esc 不关闭面板。

## 恢复契约与测试边界

字幕原文和页面新增的字幕节点始终由 YouTube 页面拥有。扩展只通过自己的样式/属性隐藏原生显示，不重写原生节点或文字。新回归在运行中追加文字、插入新节点，并分别交叉非字幕设置操作、用户切轨和重复关闭，验证节点身份、顺序、文字及原生可见性保持不变。恢复 CC 开关还要求原按钮、视频和字幕选择仍匹配；页面替换的按钮不得被旧租约改写或用来关闭新会话。

单元测试分别覆盖 MutationObserver 已送达及尚未送达的外部修改、扩展自己启停不产生用户关闭事件、广告临时状态、准备阶段用户自行开启 CC、原生自动翻译选择修改后再改回，以及被页面替换的旧按钮。新关闭事件曾在旧按钮仍收到修改时误触发；先由新增测试证实，再加入当前节点身份检查。随后在两种浏览器验证替换后的当前按钮：旧按钮变化不停止会话，当前按钮关闭则必须停止。后者在补充显示阶段的当前 CC 状态检查前两种浏览器均失败，加入检查后使用最终新构建复验。

这些检查针对本功能的 CC 所有权和样式恢复，不将其等同于网页文本 renderer 的所有 DOM 重排/编辑组合。原有字幕与网页翻译共存、播放器替换、原生 CC 初始开启、来源错误和权限相关回归仍保留。

## 执行与证据

环境：macOS，Playwright Chromium / Firefox，分别使用新构建的生产 MV3 bundles。播放器、静音 WebM 和翻译 API 为本地受控 fixtures。字幕集成夹具仅对临时测试副本增加 YouTube host grant 和测试 relay；不作为原始 manifest 的 activeTab 授权实测。

最终新构建共 **143 / 143 项浏览器检查通过**，无失败、跳过或重试后通过。包含新增回归 32 项、原有生产字幕流程 48 项、源桥接 56 项、Chromium 弹窗/设置/axe 5 项和 Firefox 原始生产 addon 加载 2 项。详细统计及源码 SHA-256 见[机器可读记录](youtube-subtitles-review-fixes.json)。

已完成 TypeScript 编译、ESLint、49 个文件中的 **2029 个 Vitest 测试**，以及构建产物检查。新增单元测试 10 个；新增浏览器回归 16 个场景，每个在两个引擎执行。

播放器面板截图为受控源和 mock 译文：[Chromium](../research/evidence/youtube-review-fixes-chromium-focus.png)、[Firefox](../research/evidence/youtube-review-fixes-firefox-focus.png)。两者均验证字号与位置修改后保持焦点，Esc 关闭并归还焦点；截图不代表真实 YouTube 翻译结果。

复现命令（仓库根目录）：

```sh
cd extension
npm run compile
npm run lint
npm test
npm run build
npm run build:firefox
npm run test:youtube-source
npm run test:youtube-subtitles
npx playwright test e2e/popup.spec.ts --project=chromium-ext
npx playwright test e2e/firefox.spec.ts --project=firefox-ext --grep 'firefox extension load'
```

本轮没有发送真实模型请求，也没有新增真实 YouTube 登录态证据。Firefox 真实登录态源验证仍受此前 Google 登录拒绝影响；既有真实服务测试使用受控源的范围不变。DOM 降级的文本与语言身份使用现有 500ms 状态轮询获得一致快照，属于有限实时模式；完整 JSON3 轨道的媒体时钟绘制路径不变。
