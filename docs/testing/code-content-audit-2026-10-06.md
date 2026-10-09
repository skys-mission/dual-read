# 代码块保护专项回归 · 2026-10-06

本次抽样 9 个网站、10 个页面，视口统一为 1920 × 1080。双语与替换模式共 20 次还原检查通过。

## 问题与通用修复

React 首页的高亮示例位于 pre/code 中，但 div/span 行节点以及外层容器仍进入翻译采集，生成了重复代码。此前的 70 页审计未完整识别此遗漏；本专项记录与上一轮构建分开。

- 完整排除 pre、code、kbd、var、samp 的机器文字子树，包括高亮 span、行容器、代码内链接与 Shadow DOM / slot 后代。
- 识别 Highlight.js、Prism、Shiki、CodeMirror、Monaco、Ace、Sandpack 的代码内容根；规则不按域名分支。
- 同步、协作式、增量采集和富文本槽提取使用同一套边界判断。
- 包含代码块的混合容器按文字片段采集，代码保留在原组件中，替换模式不会把整个代码组件一起隐藏。
- 页面把已有正文切换为代码编辑器时，清除已有译文并重新分类。
- 内联代码不送入翻译槽；普通等宽正文、pre-wrap 段落与普通 highlight 文字继续翻译。

实现：extension/lib/collector/code-content.ts；collector/index.ts 调用统一规则。新增单元与 Chrome/Firefox 浏览器用例，覆盖代码、注释、字符串、输出、动态插入、嵌套内联标识符与原节点保留。

## 验证

- TypeScript、ESLint、1241 项单元测试通过。
- 新 Chrome、Firefox 构建，208 项完整浏览器功能用例通过；包含 4 项新增代码保护用例。
- 独立性能检查 5 项通过，3 项延伸套件未启用。
- 实页 10/10 完成，失败翻译单元 0；两种模式还原 20/20 通过。
- 采样包含 136 处代码容器、4182 个原代码文字节点；两种模式均未向代码区域插入译文或改写代码，没有新增隐藏代码块。
- 另在内置浏览器对 React 首页两种模式实测，500 个代码文字节点保持原样；恢复前的页面文本、链接和顺序得到保留。

实页采用生产内容脚本与 CSS，通过原有本机桥接调用 MiMo v2.6 Flash；同一原文使用缓存，比较排版与采集行为。每页覆盖原文首屏、双语首屏、PageDown、替换首屏和原文恢复。原生隐藏标签页按网页自身状态保留；截图按采样时的内容判断。

## 逐页结论

| 网站 / 页面 | 页面地址 | 结论 |
|---|---|---|
| GitHub / 2 | [打开](https://github.com/golang/go) | 普通仓库正文、提交说明和 README 图文仍按原有通用布局呈现。 |
| Apple / 2 | [打开](https://www.apple.com/mac/) | 产品卡片标题、说明、价格和按钮保留上一轮的布局修复，未新增重叠。 |
| Slack Developer / 2 | [打开](https://docs.slack.dev/quickstart/) | CLI 命令及其嵌套高亮节点保持原样，步骤说明继续翻译；网页本身隐藏的示例保留原可见性。 |
| Cloudflare Docs / 2 | [打开](https://developers.cloudflare.com/workers/get-started/guide/) | Workers CLI 示例与机器命令保留，步骤、提示和段落继续翻译。 |
| React / 1 | [打开](https://react.dev/) | 4 个整段代码容器退出翻译采集；示例恢复为单份代码，右侧演示及说明继续翻译。替换模式不再隐藏两个代码块。 |
| React / 2 | [打开](https://react.dev/learn) | 嵌套代码、内联标识符与示例代码保留，章节正文和操作说明继续翻译。 |
| Svelte / 2 | [打开](https://svelte.dev/docs/svelte/overview) | 基准在代码内插入的 5 个译文节点归零，代码字符串、注释与语法标记保留原样。 |
| Next.js / 2 | [打开](https://nextjs.org/docs/app/getting-started/installation) | 滚动视图中代码内的 16 个译文节点归零，安装命令及标识符保留，步骤说明继续翻译。 |
| Vite / 2 | [打开](https://vite.dev/guide/) | 命令与高亮代码保留；非激活语言标签中的代码仍按网页本身隐藏，普通说明段落正常翻译。 |
| Python / 2 | [打开](https://docs.python.org/3/tutorial/introduction.html) | 交互式代码、输出、字符串和嵌套高亮节点保留，教程正文与编号保持正常。 |

修复前 JS SHA-256：`489fa39d3625e9d5cf35f13dd403c20b13af16a673cc52388ce9226994e15ddb`。
修复后 JS SHA-256：`2d8af572d4578940fe95e1dce43df4425f516473d2b6ba31d65f7d7b8110e330`。
修复后 CSS SHA-256：`9ca48e02d9c847da6de93fcbf6cc1ea428e85c861eb6adcd3be049d9b6d8a7a1`。

截图、缓存与私有测试配置位于被 Git 忽略的本机目录。逐页公开指标见同目录 JSON；本记录不含凭据。
