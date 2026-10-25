# YouTube 首次进入视频的字幕初始化修复

日期：2026-10-25。扩展版本保持 **0.2.0**。基于 `268fe6b` 及任务开始时已有的工作区修改。

首次安装后从 YouTube 首页进入视频时，播放器按钮已经出现，但点击无法启动；
弹窗启动后显示字幕获取失败，重试也无效。共同原因是后台把消息发送者的文档 URL
当成了当前视频 URL。站内导航复用文档，刷新才会重建这项身份信息。

## 研究约定

- 目标：定位这三个现象的共同机制，使首次进入、播放器启动、弹窗启动与重试均不依赖刷新。
- 范围：浏览器扩展的消息授权与 YouTube 单页导航。
- 对象：后台、内容脚本、原生播放器和字幕翻译会话之间的初始化链路。
- 验证单元：安装后第一个 YouTube 文档、首页／搜索／频道到视频、视频间切换、直接进入视频、刷新与错误后重试。
- 方法：实验诊断；先在修改前的运行时代码上复现，再用相同测试验证修复。
- 问题：Q1 为什么按钮不可用；Q2 为什么弹窗重试无效；Q3 为什么刷新恢复；Q4 如何修复而不放松视频／会话校验。

预先考虑的原因包括安装时脚本注册过晚、站内导航后文档身份与当前地址不一致、播放器元数据尚未就绪。
按浏览器、初始页面、导航方式、启动入口和修复前后分组比较。

## 主要证据来源

1. 仓库的 `AGENTS.md`、`CONTRIBUTING.md` 和现有字幕会话约定：最小权限、显式启动、原生字幕恢复。
2. [Chrome MessageSender 官方文档](https://developer.chrome.com/docs/extensions/reference/api/runtime#type-MessageSender)
   与 [MDN MessageSender 文档](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/runtime/MessageSender)：
   发送者描述脚本／连接所属文档，`origin` 用于判断来源；文档字段不应替代当前标签页的业务状态。
3. 当前工作区源码、Playwright **1.63.0** 下实际安装的 Chromium／Firefox 扩展，以及真实 YouTube 页面观察。
   `sender.url` 在本次两种浏览器中保留初始 URL 的具体行为，由运行时记录确认，不能只从文档描述推断。

## 证据记录

| 编号 | 观察 | 证据与层级 | 对应问题 |
| --- | --- | --- | --- |
| F1 | 修改前 `contentSender()` 要求 `youtubeVideoId(sender.url)` 有效，所有字幕控制、状态读取和翻译批次都依赖它。 | [后台授权实现](../../extension/lib/subtitles/background.ts)，直接代码检查 | Q1、Q2 |
| F2 | 首页进入视频后，两种浏览器都报告 `sender.url` 为首页，`tabs.get()` 已为视频地址。 | `home-spa` 的 `sender-after-spa.json` 测试附件，真实浏览器观察 | Q1、Q3 |
| F3 | 修改前实际点击首页进入视频后的按钮，两个浏览器均没有译文；扩展页面发出的启动及重试命令也均失败。 | [修复前后对照记录](../research/evidence/youtube-first-navigation-regression.json)，按钮 2 个失败，弹窗／重试 4 个失败 | Q1、Q2 |
| F4 | 修改前重试后的同一失败页面，刷新后即从 `source-error` 变为 `ready` 并得到译文；直接视频／关闭后刷新也通过。 | [刷新恢复对照](../research/evidence/youtube-first-navigation-regression.json)，2 个恢复实验、4 个直接导航对照通过 | Q3 |
| F5 | 修改后，首页、搜索页、频道页、视频间导航、扩展页面启动及错误后重试均在原文档内完成翻译。 | [首次使用浏览器回归](../../extension/e2e/youtube-subtitles-controls.spec.ts)，两浏览器共 26 个通过 | Q1、Q2、Q4 |
| F6 | 不可信扩展、子框架、错误来源，以及已离开视频页的控制请求会被拒绝；旧视频、轨道、会话及代次不能授权翻译。 | [后台导航授权单元测试](../../extension/tests/subtitles-background-navigation.test.ts)，20 个通过 | Q4 |
| F7 | 真实 YouTube 从首页经搜索进入视频也保留首页发送者 URL；修复后能够启用并进入 `realtime`，未获得可用字幕文本。 | [脱敏现场记录](../research/evidence/youtube-first-navigation-live.json)，Chromium 153.0.8010.12、未登录 | Q1、Q4 |

两种浏览器的关键观测相同：

```json
{
  "url": "https://www.youtube.com/",
  "origin": "https://www.youtube.com",
  "frameId": 0,
  "tabUrl": "https://www.youtube.com/watch?v=aaaaaaaaaaa"
}
```

原先的首页导航测试只检查按钮可见；真正点击并检查译文后才暴露问题。
原先名为 `first-load` 的用例还先打开一个视频，再导航到另一文档；现在从安装后的
第一个 YouTube 文档直接验证，不再用预先导航绕过首次使用条件。

## 范围校验

保留文档身份与当前业务地址的区分。对来源的信任依据是扩展 ID、顶层框架及严格的
YouTube origin；当前是否为受支持视频，必须另读 `tabs.get()` 判断。无需增加权限、
延长重试时间、自动刷新页面或改变字幕请求策略。

## 对象校验

问题不限于首次安装：任何从非视频文档出发的 YouTube 站内导航都有相同触发条件。
现有脚本注册能让按钮出现，已有播放器初始化逻辑也能在直接进入视频时工作，
因此它们不能解释本次失败与成功的对照。真实站点观察确认身份机制，但没有证明
未登录环境中的完整字幕下载／翻译成功，不能把模拟字幕的通过结果扩大为这一结论。

## 结论与修复

1. **按钮不可用**：按钮的 `subtitles:setEnabled` 消息被旧的 URL 校验拒绝，甚至没有进入字幕读取阶段。（F1–F3）
2. **弹窗启动和重试失败**：弹窗本身是可信扩展页面，可以建立会话；随后页面脚本的
   `subtitles:state` 等消息仍被旧文档 URL 拒绝。重试只创建新会话，不改变文档身份。（F1–F3）
3. **刷新恢复**：完整导航把初始文档地址变成 `/watch`，旧校验碰巧通过，掩盖了问题。（F2、F4）
4. **统一修复**：`contentSender()` 只校验可信来源；`resolveTab()` 继续验证当前视频页；
   翻译批次继续核对当前视频、轨道、会话及代次。播放器内的偏好修改和打开设置也补上
   当前页校验，避免把旧文档的可信来源误当成仍在播放视频。（F5、F6）

## 验证与剩余限制

已通过 TypeScript、ESLint 和全部 **2,092 个单元测试（56 个文件）**。
新构建的 Chromium／Firefox 共 **204 个字幕相关浏览器用例**全部通过，每种浏览器 102 个。

| 用例组 | Chromium | Firefox |
| --- | ---: | ---: |
| 字幕源桥接 | 32 | 32 |
| 正常字幕会话与页面翻译共存 | 24 | 24 |
| 轨道、元数据、控件替换及过期请求回归 | 25 | 25 |
| 字幕源恢复与实时字幕连续性 | 8 | 8 |
| 首次使用与控件 | 13 | 13 |

其中未修改安装包的测试仍验证无预先授权／无弹窗时控件可见、空闲状态零字幕及翻译请求。
配置翻译服务的用例使用真实扩展隔离环境、后台和 MAIN world；字幕数据及翻译服务由本地固定响应提供。
弹窗路径使用真实扩展页面发送同一生产命令，不伪造 `MessageSender`；弹窗 UI 的重试冷却行为由现有单元测试覆盖。

真实站点测试使用全新未登录配置，视频播放正常、存在两个字幕轨道，扩展启用后进入
`realtime`；观察期间原生字幕文本为空，翻译服务收到零请求。因此真实站点证据支持
文档身份与初始化修复，不代表已经在用户登录状态和截图中的具体视频上验证完整译文。

重跑本次测试：

```bash
cd extension
npm run compile
npm run lint
npm test
npm run build
npm run build:firefox
npx playwright test e2e/youtube-subtitles-controls.spec.ts
npx playwright test e2e/youtube-source.spec.ts e2e/youtube-subtitles.spec.ts e2e/youtube-subtitles-regression.spec.ts e2e/youtube-subtitles-recovery.spec.ts
```

更新本地已安装扩展时需加载新的构建目录；旧目录不会因另一个目录完成构建而自动更新。
本修复不把刷新作为首次使用或重试的恢复步骤。
