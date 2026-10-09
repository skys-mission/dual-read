# 16:9 页面排版审计 · 2026-10-06

完成 30 个网站、70 个页面，统一使用 1920 × 1080。最终内容脚本 SHA-256：`489fa39d3625e9d5cf35f13dd403c20b13af16a673cc52388ce9226994e15ddb`。阶段基准为 `9954986` 的冻结构建。

> 后续代码块专项回归发现嵌套高亮代码的排除不完整，已在通用采集规则中修复。本报告保留上一轮构建及 70 页采样记录；最新代码保护与 10 页抽样结果见 [代码块专项回归](code-content-audit-2026-10-06.md)。

## 方法与范围

- 大众英文网站 10 个，每站 3 页（含首页）；商业软件文档 10 个，每站 2 页（含文档入口）；独立开源文档 10 个，每站 2 页（含入口）。
- 每页检查原文首屏、双语首屏、PageDown 后内容、替换模式，并在两种模式后验证原文恢复。探针包含开放 Shadow DOM。双语对比左侧为冻结阶段基准；替换视图左侧为最终测试同次访问的原文参考，避免延迟加载造成不同访问之间的误读。
- 实页批测在独立 Chromium 中隔离注入生产内容脚本与生产 CSS，通过本机桥接调用生产提示词、解析器及 MiMo v2.6 Flash。相同原文采用缓存译文，减少模型差异对排版对比的干扰。
- 内置浏览器抽查关键页面；实际 Chrome 扩展及 Firefox 安装/Gecko 内容脚本路径由仓库浏览器用例回归。实页批测没有把内置浏览器注入测试等同于内置浏览器加载扩展。
- 数值裁切候选结合截图判断；保留目录滚动、轮播屏外项目、原文省略和动画。新闻内容、延迟加载及网页自身重排可能随采样时间变化。
- API 密钥、缓存及截图保留于被 Git 忽略的本机目录；本记录仅包含公开页面信息及测试指标。

## 通用实现

- 短图注按块级正文呈现，译文在原图框内独立换行。
- 嵌套替换、父容器先还原以及页面克隆后缺少节点映射的路径，都直接移回隐藏的原文节点，保留 Text 身份、拆分节点和页面新增元素。
- 含 Shadow DOM 或 slot 的容器按独立文字片段采集，替换时保留组件和 slot；替换文字继承原换行规则，避免 min-content 自定义按钮内中文竖排。
- 保留原文单行省略，让译文按正文宽度换行。
- nowrap 的横向 flex 正文与译文共用可收缩文本列，保留前后图标位置。
- 紧凑 flex 链接与正文共用连续文字流包裹，前后图标保留原位置，还原保持原文节点顺序。
- 过滤窄裁切辅助条和屏外图标标签，保留原辅助文字及节点。
- 监听会影响可见性的属性变化，重新发现稍后显示的已有正文；忽略仅有 transform 的动画变化。
- 对实际裁切或固定高度重叠的普通正文容器使用自有 CSS 扩展高度；网格行保留原最低高度并允许增长，保留滚动容器及原文 line clamp。
- 密集标签超出所在列时，只在原链接或控件内调整译文换行。
- 两种模式均记录图文共享行的原始媒体宽度比例，只限制翻译引起的图片扩张；保留动画、位置变更和图片替换。
- 绝对定位的控件页脚明确使用 top:Npx / height:calc(100% - Npx) 时，按正文新增高度同步位置，避免覆盖操作按钮；页面改写定位后释放规则。
- 纯正文的全部文字使用一致的内层样式时，译文沿用实际文字颜色、字号与行距；不抹平多种样式的富文本。

实现位置：`extension/lib/collector/index.ts`、`extension/lib/dom-role.ts`、`extension/lib/renderer/`、`extension/lib/roots/index.ts`、`extension/lib/scheduler/session.ts` 和扩展样式。没有新增域名分支。容器高度、媒体边界使用自有 CSS 规则，恢复不覆写网页自身 style/class；文字与图标保持原节点身份和顺序。

## 验证

- TypeScript、ESLint、1206 项单元测试通过。
- 新 Chrome/Firefox 构建：完整功能回归 204 项与独立性能检查 5 项，共 209 项不同浏览器/性能用例通过，3 项延伸性能套件未启用。包含 16 个双语/替换 × 暂停/观察 × 延迟/已送达变更组合及 5 项性能检查。
- 较早一轮全面回归与实页批测同时运行时，5k 索引记录为 422.1ms，超过 300ms 预算，其余 208 项通过。停止实页批测后，独立性能复测 5 项通过；5k 检查再独立重复 3 次均通过。当时复测未修改代码或放宽阈值；最后的嵌套还原修复使用新构建，功能回归与性能检查分开执行。
- 最终实页 70/70 完成，最终失败翻译单元 0；两种模式恢复 140/140 通过，未覆盖恢复前的网页当前文本、链接或顺序，未残留译文。
- 局部 fixture 覆盖源节点移动、删除、修改、追加和跨容器转移，重复恢复及模式切换；网页自行删除的节点不重新创建，网页自身样式修改保留。

验证命令：

```sh
cd extension
npm run compile
npm run lint
npm test
npm run build
npm run build:firefox
npx playwright test e2e/lab.spec.ts e2e/firefox.spec.ts e2e/translate.spec.ts --project=chromium-ext --project=firefox-ext
npx playwright test e2e/perf.spec.ts --project=chromium-ext
npx playwright test e2e/perf.spec.ts --project=chromium-ext --grep '5k initial index' --repeat-each=3
```

实页证据为本机 `.codex/site-audit/` 下的 manifest、冻结基准、最终截图、每页 report 与交互图库；可移植的逐页指标见同目录文档 `layout-audit-2026-10-06.json`。

## 逐页观察

| 分类 | 网站 / 页面 | 页面地址 | 基准观察及处理 |
|---|---|---|---|
| 大众英文网站 | Wikipedia / 1 | [打开](https://en.wikipedia.org/wiki/Main_Page) | 首页的短图注与图片混合时，原有采集将图注当作紧凑后缀，窄图框会裁切中文。按块级语义分类后，译文在图框内独立换行；左右内容栏、浮动图片和目录保持排列。 |
| 大众英文网站 | Wikipedia / 2 | [打开](https://en.wikipedia.org/wiki/Internet) | Internet 长文含信息框、段落内链接和侧目录。基准正文布局可用；检查双语段落宽度、信息框和恢复后的链接，采用通用回归规则。 |
| 大众英文网站 | Wikipedia / 3 | [打开](https://en.wikipedia.org/wiki/Artificial_intelligence) | Artificial intelligence 长文包含多个标题层级、信息框和富文本段落。基准未见正文挤成竖列；保留正文排版与链接，不增加域名适配。 |
| 大众英文网站 | GitHub / 1 | [打开](https://github.com/) | 营销首页含动画演示、代码画面和深色区域。演示中的裁切属于动画图层；正文和 CTA 使用通用排版，并保留原生动画与代码。 |
| 大众英文网站 | GitHub / 2 | [打开](https://github.com/golang/go) | Go 仓库的最新提交说明采用单行省略。原先中文继承 nowrap 被截断；通用省略正文识别让译文独立换行，同时保留原文省略、文件表列宽和 README 图片。 |
| 大众英文网站 | GitHub / 3 | [打开](https://github.com/features/actions) | Actions 页面包含深色标题区、流程图和多列功能说明。基准主体可用；检查功能卡片的宽度、CTA 点击区域及两种模式恢复，不增加专用规则。 |
| 大众英文网站 | Hacker News / 1 | [打开](https://news.ycombinator.com/) | 首页为紧凑表格列表，标题、域名和操作链接密集。保留表格顺序与编号，译文在原链接内呈现；基准未发现需要站点专用处理的问题。 |
| 大众英文网站 | Hacker News / 2 | [打开](https://news.ycombinator.com/newest) | Newest 同样使用紧凑列表，并存在随时间变化的新闻条目。以布局和当时的原文节点为比较对象，避免把内容更新误当成渲染变化。 |
| 大众英文网站 | Hacker News / 3 | [打开](https://news.ycombinator.com/ask) | Ask 列表较短。检查尾部链接和输入框，翻译保持原链接区域，搜索输入未被改写；无需新增专用规则。 |
| 大众英文网站 | BBC / 1 | [打开](https://www.bbc.com/) | 首页的新闻网格包含图片、标题和摘要，顶部广告保留空白。检查卡片内文本换行和图片位置，基准未见主体跨列；广告空白属于网页本身。 |
| 大众英文网站 | BBC / 2 | [打开](https://www.bbc.com/news) | News 页面含多列新闻摘要。正文保持在各自列内，通用规则覆盖短标题和长摘要；不按新闻域名增加特殊 CSS。 |
| 大众英文网站 | BBC / 3 | [打开](https://www.bbc.com/future) | Future 入口显示 Earth 内容，包含大图及右侧新闻栏。记录实际到达的页面，检查图片说明与相邻摘要；主体基准布局可用。 |
| 大众英文网站 | The Guardian / 1 | [打开](https://www.theguardian.com/international) | 国际版首页为密集新闻卡片。关闭跨域 cookie 对话框后比较正文；导航检测的轻微边框相交需结合字形判断，未因此扩大整条导航。 |
| 大众英文网站 | The Guardian / 2 | [打开](https://www.theguardian.com/world) | World 分类页含多个新闻分组。基准曾被 cookie 对话框遮挡，补拍可见正文；保留列宽、图片和网页自身的广告区域。 |
| 大众英文网站 | The Guardian / 3 | [打开](https://www.theguardian.com/technology) | Technology 分类页同样检查标题、摘要和导航。焦点跳转链接的屏外裁切属于原有辅助功能，保留源节点，避免生成多余可见译文。 |
| 大众英文网站 | Mozilla / 1 | [打开](https://www.mozilla.org/en-US/) | 首页使用大标题与产品列表。基准双语大标题在原区域内换行；继续保留页面字号和行文平衡，不以站点专用字体重写。 |
| 大众英文网站 | Mozilla / 2 | [打开](https://www.mozilla.org/en-US/firefox/new/) | Firefox 页面使用紫色横幅和多列功能卡片。检查 CTA、卡片高度和插图，通用布局回归后主体正常。页面的图片轮播会自行轮换并重排图片节点；还原保持恢复前的实际节点顺序，不撤销轮播自身的操作。 |
| 大众英文网站 | Mozilla / 3 | [打开](https://www.mozilla.org/en-US/about/) | About 页面包含长的大字号宣言和左右分栏。保留原文与译文的字号比例及图片，避免压缩主体字号来减少页面高度。 |
| 大众英文网站 | Apple / 1 | [打开](https://www.apple.com/) | 全站导航包含单像素宽的隐藏 SVG 替代文字，原先会生成不可见的翻译后缀。通用窄裁切辅助文字过滤减少无效翻译，保留 SVG 和原始辅助文字。 |
| 大众英文网站 | Apple / 2 | [打开](https://www.apple.com/mac/) | Mac 页面在基准中将卡片标题、说明和价格固定为原文高度，译文与下一行重叠。通用有界正文保护扩展实际溢出的行，网格像素轨道保留原最低高度并允许增长；绝对定位的轮播页脚若采用 top:Npx / height:calc(100% - Npx)，按内容新增高度同步位置，避免盖住卡片操作按钮。轮播边缘裁切保留原交互，无 Apple 域名规则。 |
| 大众英文网站 | Apple / 3 | [打开](https://www.apple.com/iphone/) | iPhone 页面包含横向产品导航和滚动动画。等待内容出现后复查，CSS 可见性监听覆盖已存在但稍后显示的正文；不改动产品图片和轮播结构。 嵌套按钮的替换还原曾在父容器处理时重建 Text 节点；通用还原改为直接移回原节点，保留按钮文字身份和页面编辑，并加入父容器先还原及克隆组件的回归用例。 |
| 大众英文网站 | Amazon / 1 | [打开](https://www.amazon.com/) | 首页为商品分类网格和轮播。检查短标题及顶部菜单，保持图片和分类卡片排列；屏外轮播项目不能仅凭 DOM 矩形视作损坏。 |
| 大众英文网站 | Amazon / 2 | [打开](https://www.amazon.com/gp/bestsellers/) | 畅销榜的轮播外框由页面固定高度，双语标题会落到框外。通用有界正文规则按实际内容增长高度，保留横向裁切和滚动；辅助图标文字不额外显示。最终剩余裁切候选集中于左右翻页按钮的辅助标签，截图中的箭头和点击区域保留；不依据辅助标签矩形扩大轮播按钮。 |
| 大众英文网站 | Amazon / 3 | [打开](https://www.amazon.com/gp/help/customer/display.html) | 客服首页基准存在横向 flex 正文被译文挤成竖列的情况。两种语言共享可收缩的文本列后恢复正常排版；功能入口、图标与源链接保持。 |
| 大众英文网站 | WordPress / 1 | [打开](https://wordpress.org/) | 首页含大标题、双色内容区和多列产品说明。替代返回地区错误页的 Spotify 样本；英文正文可用，检查大标题与 CTA，通用规则保持各栏宽度。 |
| 大众英文网站 | WordPress / 2 | [打开](https://wordpress.org/about/) | About 页面使用超大标题、自由度列表和左右分栏。基准上游请求曾短暂失败，重跑后完成；最终比较使用成功译文，页面内容与节点恢复均检查。 |
| 大众英文网站 | WordPress / 3 | [打开](https://wordpress.org/news/) | News 页面包含长标题、列表和底部内容卡片。检查中文标题换行及日期位置，保留链接和原有留白；没有需要域名适配的结构问题。 |
| 大众英文网站 | Dropbox / 1 | [打开](https://www.dropbox.com/) | 首页包含左右图文和深色 AI 功能区。基准主体可用，通用规则保留图文列、CTA 的背景和点击区域。 |
| 大众英文网站 | Dropbox / 2 | [打开](https://www.dropbox.com/features) | Features 页面含多个图文卡片。检查两种语言的段落宽度与卡片排列，未发现需要另设域名模块的问题。 首屏插图为自动播放视频，静态截图可能恰逢留白帧；在内置浏览器核对视频与图片未被隐藏，尺寸和源节点保留，文字加载完成后正常显示。 |
| 大众英文网站 | Dropbox / 3 | [打开](https://www.dropbox.com/features/share) | Share 页面包括产品横幅与套餐列表。检查长功能清单与按钮排版，保留套餐列宽和源节点；cookie 浮层不参与正文布局判断。 |
| 商业软件文档 | Microsoft Learn / 1 | [打开](https://learn.microsoft.com/en-us/) | 文档主页为搜索横幅、资源卡片和侧向图文。基准整体可用，检查密集链接、图标及 CTA 在翻译后仍属于原卡片。 |
| 商业软件文档 | Microsoft Learn / 2 | [打开](https://learn.microsoft.com/en-us/azure/architecture/) | Azure Architecture 页面基准双语渲染产生 60px 文档横向溢出。通用 nowrap flex 文本列处理使图标、正文和译文正确共用布局，横向溢出归零。 |
| 商业软件文档 | Adobe Developer / 1 | [打开](https://developer.adobe.com/developer-console/docs/guides/) | Developer Console 文档入口的横幅固定 272px 高，基准译文下端被裁切；正文容器通用扩展使译文完整。另有带 button 类名的普通卡片链接，按实际可用宽度在原链接内换行，避免跨列。CSS 可见性变化也需重新发现导航。 还原审计另发现基准紧凑 flex 链接会将尾部 SVG 移到原文之前；统一为连续文字流并保持包裹位置后，原文、前后图标及其节点顺序均恢复。 |
| 商业软件文档 | Adobe Developer / 2 | [打开](https://developer.adobe.com/developer-console/docs/guides/services/) | Services 文档包含正文、左右目录和嵌入截图。检查侧栏带尾部图标的紧凑链接，使用同一通用连续文字流，验证源节点身份、顺序和链接还原；代码与截图保留。 |
| 商业软件文档 | Salesforce Developers / 1 | [打开](https://developer.salesforce.com/docs) | 文档入口大量使用开放 Shadow DOM，基准部分卡片的源文字被 flex 伴随译文挤成竖列。通用文本流与 Shadow Root 样式覆盖保持正常卡片布局。 替换模式的复核另发现外层容器只读到反馈文字，却会把独立的 Shadow DOM 正文一起隐藏；通用组合边界识别改为片段处理，保留组件、slot 及按钮，替换文字继承原 nowrap，避免按钮中文字竖排。 |
| 商业软件文档 | Salesforce Developers / 2 | [打开](https://developer.salesforce.com/docs/platform/lwc/guide/) | Lightning Web Components 指南同样使用 Shadow DOM。基准文档横向溢出 712px，文本流处理后归零；对正文、侧目录、富文本链接和原文恢复分别验证。 替换模式同样保留文档组件、目录与操作按钮，不将整个组合容器替换为反馈文字；还原保持原节点和页面后续编辑。 |
| 商业软件文档 | Atlassian Developer / 1 | [打开](https://developer.atlassian.com/) | 首页含装饰插图、营销卡片及 cookie 横幅。基准中与正文共享网格高度的 SVG 随双语段落变高而拉宽，文档新增横向溢出。通用媒体保护记录源图与所在列的宽度比例，仅在翻译后图片扩张并伸出视口时使用自有 CSS 限制，双语与替换模式的最终横向溢出均归零；恢复时不覆盖网页自身样式修改。内置浏览器的完整加载版本另有深色图文区：原文颜色和字号设在内层 span。通用一致样式传递让译文保持白色、20px 字号及 30px 行距，改善对比度。 |
| 商业软件文档 | Atlassian Developer / 2 | [打开](https://developer.atlassian.com/platform/forge/) | Forge 指南包含左目录、图文横幅和正文。目录边缘的裁切来自滚动容器；正文使用通用排版，保留滚动区域与图片。 |
| 商业软件文档 | Notion API / 1 | [打开](https://developers.notion.com/) | 文档根入口重定向到 Overview，含三栏目录和富文本段落。保留代码标记与引用链接，检查双语段落、目录及内容宽度；基准主体可用。 |
| 商业软件文档 | Notion API / 2 | [打开](https://developers.notion.com/guides/get-started/quick-start) | 旧 getting-started 地址也重定向到 Overview，因此改为页面中实际链接的 Quickstart。检查操作步骤、代码示例和右侧目录，确保确实覆盖不同页面。 |
| 商业软件文档 | Slack Developer / 1 | [打开](https://docs.slack.dev/) | 文档主页包含 CLI 代码块、示例应用卡片和滚动侧栏。侧栏底部裁切属于其滚动区域；代码示例与正文保持原布局。 |
| 商业软件文档 | Slack Developer / 2 | [打开](https://docs.slack.dev/quickstart/) | Quickstart 页面包含步骤标题、提示框和代码。检查双语步骤说明的换行以及代码不被翻译，未发现需要站点专用规则的问题。 |
| 商业软件文档 | Shopify Developer / 1 | [打开](https://shopify.dev/docs) | 文档主页包含多列开发方向卡片和 CLI 示例。基准部分横向结构在双语渲染中挤窄源内容，通用 flex 文本流改善排列并保留原代码节点。 |
| 商业软件文档 | Shopify Developer / 2 | [打开](https://shopify.dev/docs/apps/build) | Build apps 页面含嵌套目录与图文步骤。检查标题、说明和侧栏，保留截图与源码；目录视口的边缘裁切不扩大成整页内容。 |
| 商业软件文档 | Stripe Docs / 1 | [打开](https://docs.stripe.com/) | 文档入口含导航、产品分组和代码区。主体基准可用；按实际宽度处理密集标签，保留代码、按钮和产品列。 |
| 商业软件文档 | Stripe Docs / 2 | [打开](https://docs.stripe.com/payments/accept-a-payment) | Accept a payment 页面含长正文、提示框与示例。检查步骤内富文本和链接，正文宽度及两种模式恢复可用，不增加支付站点专用 CSS。 |
| 商业软件文档 | Cloudflare Docs / 1 | [打开](https://developers.cloudflare.com/) | 文档主页含侧栏、特色模块和卡片。检查滚动后卡片标题及内联代码，保留原源节点、复制控件与目录。 |
| 商业软件文档 | Cloudflare Docs / 2 | [打开](https://developers.cloudflare.com/workers/get-started/guide/) | Workers 入门指南实际显示 CLI 路线，含命令及多层步骤。保留机器命令，中文说明独立呈现；可见性监听覆盖后续显示的内容。 |
| 商业软件文档 | Auth0 Docs / 1 | [打开](https://auth0.com/docs) | 文档主页包含密集导航、产品入口和资源卡片。基准未见主体跨列，按通用规则回归标题、卡片和控件。 |
| 商业软件文档 | Auth0 Docs / 2 | [打开](https://auth0.com/docs/get-started) | Get started 页面为三栏文档与功能卡片。检查两种语言的段落和导航宽度，保持侧栏滚动、链接与源节点，无需域名适配。 |
| 开源软件文档 | React / 1 | [打开](https://react.dev/) | 首页包含组件演示及代码画面。基准有横向示例结构被译文影响的现象，通用 flex 文本流保持示例与解释文本在合理列宽内；嵌套高亮代码的完整排除在后续专项回归中补齐，详见代码块专项回归报告。 |
| 开源软件文档 | React / 2 | [打开](https://react.dev/learn) | Learn 页面包含左右目录、提示框和 JSX 示例。保留代码与富文本链接，检查双语正文宽度和恢复；无需独立域名模块。 |
| 开源软件文档 | Vue / 1 | [打开](https://vuejs.org/) | 主页使用大字号平衡标题和资源链接。基准双语标题可用，继续继承其排版与配色，避免改写全站字号。 |
| 开源软件文档 | Vue / 2 | [打开](https://vuejs.org/guide/introduction.html) | Introduction 页面包括代码演示、长正文和左右目录。侧栏滚动视口裁切属于原布局；正文、演示和链接在通用规则下回归。 |
| 开源软件文档 | Angular / 1 | [打开](https://angular.dev/) | 首页含图标导航、特色卡片及代码示例。基准主体可用，保留代码、图标和标题比例，观察中文说明的列宽。 |
| 开源软件文档 | Angular / 2 | [打开](https://angular.dev/overview) | Overview 页面含特色卡片和滚动目录。检查卡片内文本与侧栏边缘，保留侧栏滚动，不移除原生裁切策略。 |
| 开源软件文档 | Svelte / 1 | [打开](https://svelte.dev/docs) | 文档入口是带箭头的多个选择项。基准可用，通用规则保留标题与说明层级、原箭头和链接区域。 |
| 开源软件文档 | Svelte / 2 | [打开](https://svelte.dev/docs/svelte/overview) | Overview 页面包含示例、导航和语法索引。检查正文双语换行，代码、语法标记和右侧目录不改写，保留原滚动区域。 |
| 开源软件文档 | Next.js / 1 | [打开](https://nextjs.org/docs) | 文档主页含固定侧目录、介绍段落和列表。保留目录的滚动边界，检查正文和标题，不增加框架专用规则。 |
| 开源软件文档 | Next.js / 2 | [打开](https://nextjs.org/docs/app/getting-started/installation) | Installation 页面包含编号步骤、命令、要求和链接。仅翻译说明文字，保留命令和输入控件，检查两种模式及恢复。 |
| 开源软件文档 | Astro / 1 | [打开](https://docs.astro.build/en/) | 文档主页的横向标题与卡片在基准中出现单词竖向堆叠。通用 nowrap flex 文本流让原文与译文共用文本列，保留图标与卡片排列。 |
| 开源软件文档 | Astro / 2 | [打开](https://docs.astro.build/en/install-and-setup/) | 安装指南按页面实际链接选择，避免与入口重定向到同页。检查提示框、CLI 说明、内联代码及目录，基准主体可用。 |
| 开源软件文档 | Vite / 1 | [打开](https://vite.dev/) | 主页包含深色图文、渐变标题与代码示例。基准主体可用，保留标题平衡、代码和图形；译文继承源页面字号。 |
| 开源软件文档 | Vite / 2 | [打开](https://vite.dev/guide/) | Getting started 页面包含兼容性段落和命令示例。保留代码与侧栏滚动视口，正文换行和链接恢复使用通用回归。 |
| 开源软件文档 | TypeScript / 1 | [打开](https://www.typescriptlang.org/docs/) | 文档入口含密集多列链接。基准结构可用，检查中文后缀、列宽和原链接顺序，保留主题排版。 |
| 开源软件文档 | TypeScript / 2 | [打开](https://www.typescriptlang.org/docs/handbook/intro.html) | Handbook 页面包含长段落与固定目录。检查章节层级、列表和代码，侧栏边缘裁切保留其滚动策略；不设域名规则。 |
| 开源软件文档 | Python / 1 | [打开](https://docs.python.org/3/) | Sphinx 文档入口为侧栏和多列链接索引。检查窄栏下的双语文字和源链接顺序，基准主体可用。 |
| 开源软件文档 | Python / 2 | [打开](https://docs.python.org/3/tutorial/introduction.html) | 教程页面包含编号标题、段落、列表与 Python 命令示例。保留代码及章节编号，检查正文宽度、段落分隔和原文恢复。 |
| 开源软件文档 | Rust / 1 | [打开](https://doc.rust-lang.org/) | 文档入口包含多层标题和工具链接。基准单列正文可用，保留段落与富文本引用，不增加专用主题规则。 |
| 开源软件文档 | Rust / 2 | [打开](https://doc.rust-lang.org/book/ch01-00-getting-started.html) | The Book 章节使用可滚动目录与前后页箭头。多个裁切候选来自目录视口，保留其滚动；正文与译文宽度正常，源节点和链接恢复均检查。 |

## 样本调整

- Stack Overflow 返回 HTTP 403 挑战页，改用 Hacker News 的首页、Newest 和 Ask。
- Spotify 的两个营销入口返回地区错误页，改用 WordPress 的首页、About 和 News。
- Notion 旧 getting-started 路由重定向到与首页相同的 Overview；按实际页面链接改用 API Quickstart。Astro 安装页面也使用实际页面链接，避免入口重定向造成重复。
- Adobe 等待延迟加载的页面内容显示后补拍基准与最终记录；Guardian 的跨域 cookie 对话框通过页面提供的拒绝选项关闭后补拍。BBC Earth 的最终截图曾被临时调查弹窗遮挡，已重新采样并补拍无弹窗的正文视图。
