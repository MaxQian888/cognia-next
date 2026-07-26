---
title: "0092 — 官网工作区与三站拓扑"
description: "为官网新建独立的 web/ 静态导出工作区，与 fumadocs 文档站分离，配套构建期证据管道、可重跑的产品截图矩阵，以及英文优先的双语路由。"
---

# ADR 0092 — 官网工作区与三站拓扑

- **状态：** 已接受
- **日期：** 2026-07-26
- **依赖：** ADR-0059（Cloudflare Pages 上的静态文档导出）
- **设计依据：** `docs/research/cognia-official-website-v2-design-spec-2026-07-26.md`
- **计划记录：** `docs/plans/2026-07-26-official-website-v2.md`

## 背景

仓库有产品外壳、有文档站，但从来没有官网。V2 官网方案要求的东西，现有的两个界面都承载不了：

- 一套自有视觉系统（`paper` / `ink` / `graphite` 的「阅读层 vs 执行舞台」、Geist、细规则线），
  它刻意**不是**产品的 token 集，也**不是** fumadocs 主题；
- 面向开源开发者受众的英文优先定位，首页必须由站点根路径直接提供以服务搜索；
- 每一条对外承诺都绑定可核验来源——license、release、支持的操作系统、provider registry、
  权限行为——不允许出现手工维护的数字。

现有文档站有三个属性使它不适合承载官网：

1. **locale 根路径已被占用。** `docs/lib/i18n.ts` 设定 `defaultLanguage: "zh"` 且
   `hideLocale: "never"`，`docs/public/_redirects` 把 `/` 送到 `/zh/`，`app/[lang]/page.tsx`
   再重定向到 `/docs`。而官网首页需要 `/` 直接返回内容，不是跳两次。
2. **主题是全局的。** `docs/app/global.css` 在 app 层级 import 了 `fumadocs-ui/css/preset.css`。
   同一个 app 里的营销路由会继承第二套互相竞争的基线。
3. **构建很重。** MDX collections、Orama 索引与 Mermaid 都在文档的关键路径上，官网迭代不该为它们买单。

产品 app 完全不是候选：它的 `out/` 导出会被 Tauri 与 Capacitor 消费，加进去的任何东西都会随桌面端和
移动端二进制一起分发。

## 决策

### 1. 三个站点，三个工作区

| 站点     | 工作区    | 产物         | 托管                        |
| -------- | --------- | ------------ | --------------------------- |
| 产品 app | `/`       | `out/`       | Tauri 桌面端 + Capacitor    |
| 文档     | `docs/`   | `docs/out/`  | Cloudflare Pages            |
| 官网     | `web/`    | `web/out/`   | Cloudflare Pages（新项目）  |

`web/` 是一个 Next.js 16 `output: "export"` 工作区，拥有自己的 `package.json`、`tsconfig.json`、
PostCSS 与 Tailwind v4 配置。它**零跨包引用**——不碰产品的 `components/ui/`、`lib/`，也不碰共享的
`i18n/messages` bundle。营销界面是与产品组件零重叠的静态展示代码，引用它们只会把 Zustand / Dexie /
Tauri 的依赖图拖进一份宣传册。

### 2. 域名分工，注入而非硬编码

官网占 apex 域名（`www` 重定向到 apex），文档站移到 `docs.` 子域。两个 origin 都不写进源码：官网从
`NEXT_PUBLIC_WEB_SITE_URL` 解析绝对 URL（canonical、hreflang、OpenGraph、sitemap），回退到
Cloudflare 的 `CF_PAGES_URL`，再回退到开发 origin——与 `docs/lib/site.ts` 已有的解析阶梯一致。
跨站链接（导航里的 `Docs`）读 `NEXT_PUBLIC_DOCS_SITE_URL`。

### 3. 用 `@web/*`，绝不用 `@/`

根 Jest 配置把 `^@/(.*)$` 映射到 `<rootDir>/$1`——仓库根——而工作区的 `tsconfig.json` 把 `@/*`
映射到它自己的目录。根 Jest 会收走 `docs/**` 与 `web/**` 的测试文件（两者都不在
`testPathIgnorePatterns` 里），于是两套映射直接冲突。文档站至今没爆炸，只是因为它的测试恰好都用相对
导入——那是运气，不是设计。

因此 `web/` 使用 `@web/*` 前缀，在 `web/tsconfig.json` 和根 Jest 的 `moduleNameMapper`
（`^@web/(.*)$` → `<rootDir>/web/$1`）中各映射一次。根 `tsconfig.json` 把 `web` 加入 `exclude`，
避免产品 typecheck 用产品的 `paths` 去编译它。

### 4. 英文优先的双语路由

`/` 直接提供英文内容——不重定向——`/zh/…` 提供中文，两者 `hreflang` 互指。`/en/*` 301 到 `/`，
使默认语言只有一个规范形式。由于静态导出没有 middleware，所有 locale 路径都在构建期生成，
`/en/*` 规则由 `web/public/_redirects` 在 Pages 上承担。

### 5. 文案是类型化内容，不是 ICU bundle

官网文案位于 `web/content/`，形式是一个 `SiteCopy` 接口加 `en`、`zh` 两份实现。理由：

- 营销文案是结构化的（bullet 数组、一张运行策略表、三列 footer），`next-intl` 只能用 `t.raw()`
  表达且丢掉全部类型；
- 任一语言缺项或多项都会让 `pnpm typecheck` 失败，这比 `lint:i18n` 是更强的 parity 门禁——后者只扫
  根级 `components/ app/ hooks/`，永远看不见 `web/`；
- 产品的 `i18n/messages/*.json` 会被打进 Tauri 与 Capacitor 产物，营销文案不能住在那里。

这满足了仓库 i18n 规则的本意——`.tsx` 里零硬编码用户可见文案——只是换了一个更契合内容形态的机制。

### 6. 证据在构建期解析

静态导出没有请求期运行时，因此每一条动态承诺都在构建期物化，并打上读取时间戳：

| 承诺                     | 管道                                                        |
| ------------------------ | ----------------------------------------------------------- |
| 最新发布、支持的操作系统 | GitHub Releases API → 静态 release manifest                  |
| 变更日志（未发布）       | `.changeset/*.md` + 每个文件的首次提交时间 → 分组时间线      |
| 变更日志（已发布）       | 已发布的 release notes，它携带同一份聚合文本                 |
| stars、contributors      | GitHub API → 带 `as of <date>` 标注渲染的统计文件            |

每日定时重建保持新鲜。不做客户端 GitHub 调用：未认证 API 是 60 次/小时/IP，而且为了一个按周变化的
数字向第三方泄漏访客 IP 并不划算。

### 7. 降级到真相，绝不降级成死链

仓库目前**零个已发布 release**——`release.yml` 由 `v*` tag 触发，从未运行过。因此下载界面按 release
manifest 的真实状态渲染：无 release 时提供 `Build from source` 与 `Watch releases`；一旦有 release，
同一个组件解析为 `Download for macOS / Windows / Linux`。同一条规则治理变更日志（在 `CHANGELOG.md`
带上真实版本之前走 `.changeset` 时间线）和 footer——Roadmap 与 Community 在真实存在之前完全不出现。

### 8. 产品视觉：真实截图加 DOM 复刻

大幅产品视觉是真实截图，由一个可重跑的 Playwright 脚本驱动应用、针对**专门构建的演示种子工作区**
拍摄——绝不用作者的真实工作数据，那会把仓库名、会话内容与 provider 配置公开出去。截图矩阵是
*章节 × {浅色, 暗色} × {en, zh}*，产物提交在 `web/public/product/` 下；脚本不进 CI，因为一次
Playwright 全量跑对站点构建来说太重也太脆。

分步交互元素——signature task rail、stepper、permission checkpoint——用 DOM 复刻而非截图，因为方案
要求它们可翻译、可键盘操作，并在 `prefers-reduced-motion` 下坍缩为静态 stepper。位图一样都做不到。

#### 修订，2026-07-26 —— 兜底是结构复刻，不是空框

实际出货时截图矩阵是空的：它需要一个尚不存在的产品侧种子接缝
（`window.__cogniaSeedDemoWorkspace`），因此 `product-shots.json` 里没有任何一格。原先的规则让
`ProductStage` 渲染出一个只装着一句 alt 文案的框，实际效果是**每一页最大的视觉都是空白**——首屏那块
接近全宽的产品舞台就是一个约一屏高的空盒子。

因此优先级顺序现在被显式写下来，其中第二条是新增的：

1. 真实截图，只要该章节的矩阵里**明暗两套都在**；
2. 否则用**同一界面的 DOM 结构复刻，并永久标注为复刻**。

这是对「大幅产品视觉必须是真实截图」的一次有意收窄。§8 真正要禁止的是把手工搭的稿子当成应用的照片，
这一点被直接处理掉了，而不是靠留白：`AppFrame` 的 `label` 是必填 prop，所以任何复刻都不可能在标题栏
里没有标记就渲染出来；`ProductStage` 还会在图注里再打印一次「不是截图」的说明。一旦真实截图存在，它
依然优先。

两条不那么显然但必须写明的后果：

- **复刻整体被 `aria-hidden`，外面只包一个 `role="img"` 和该章节的 alt 文案。** 被画出来的 rail 项与
  tab 条是控件的图像；把它们朗读出来等于给读屏用户提供了十几个并不存在的可操作项。截图给辅助技术的是
  它的 alt 文案，那么截图的替身就给同样的东西。signature demo 的步骤产物是刻意相反的——真实内容、留在
  可访问性树里、经过翻译——这正是上一段一开始就让它们走 DOM 的理由。
- **演示身份放在 `web/content/demo-task.ts`**，与截图脚本的 `DEMO` 一致，并由一个测试把两者钉在一起。
  同一章节的复刻与将来的截图必须描述同一条任务，否则站点会对同一次发布讲出两个故事。

这些都不削弱把截图跑起来的价值。那仍然是目标；这里定义的只是在那之前页面该怎么办，而不是发一块空舞台。

### 9. 全站唯一 signature task

每一页推进同一条任务——*「Review this release, fix the failing check, and prepare the launch
notes」*——在演示项目中真实发生。没有任何页面替换成另一个场景。use-case 页是唯一的刻意例外：它们叙述
可复现的端到端剧本，其中 development 页使用 dogfooding（用 Cognia 开发 Cognia），并显式分层标注。

### 10. 暗色由石墨舞台反推

方案只定义了浅色值。暗色模式复用**同一套语义 token 名**，把 `ink` 提升为页面基底、`graphite` 为面板，
`action` / `approval` 保持色相但相对暗色基底提亮到 WCAG AA。不存在第二套品牌配色，且「浅色阅读 /
深色执行」的对比在两种模式内部都得以保留。

### 11. 门禁覆盖

- `scripts/gates/check-colocated-tests.mjs` 的 `TS_ROOTS` 增加 `web/components/`、`web/lib/`、
  `web/hooks/`——与它在产品树上门禁的三个根一致。`web/app/` 沿用产品 `app/` 的先例（写测试但不入门禁）；
  `web/content/` 是数据，其 parity 已由 `tsc` 证明。
- `.changeset/config.json` 把 `web` 加入 `ignore`：官网不属于 `cognia-next` 应用版本，发布它也不是
  桌面端用户会感知的变更。
- `eslint.config.mjs` 忽略 `web/.next/**`、`web/out/**` 与 `web/next-env.d.ts`。flat config 不读
  `.gitignore`，不加这三条 `pnpm lint` 会去走压缩后的导出产物——与 `docs/out/**` 已被列入的理由相同。
- `deploy.yml` 增加 `web` target 与 `CF_WEB_PAGES_PROJECT` / `WEB_SITE_URL` 变量。每日证据重建是一个
  独立的 `refresh-website.yml` 去**调用** `deploy.yml`：定时运行时 `inputs` 为空，而现有每个 job 都
  依据 `inputs.target` 做门禁，直接在原文件加 `schedule` 等于要改写那些部署 Workers 与 Fly 应用的
  job 的判断表达式。

## 后果

**正面。** 官网可以在不重建 MDX collections、不触碰已被文档化的 docs URL 的前提下迭代。它的视觉系统
不受 fumadocs 基线污染。每一个对外数字都有管道和时间戳，而不是维护者的记忆。`@web/*` 别名顺带关掉了
一个潜伏的模块解析冲突——文档工作区距离踩中它只差一次重构。

**负面。** 两个 Cloudflare Pages 项目、两套导航/footer 实现需要靠约定而非共享代码保持同步。跨站链接
是外链。截图矩阵是四套，因此一次让视觉失效的产品 UI 改动等于四套重拍。

**风险。** 演示种子工作区必须与出货产品保持一致，否则截图会变成一个慢动作的谎言；缓解手段是那个可重跑
的截图脚本，而不是种子数据本身。每日重建是唯一阻止证据管道过期的东西，因此它的失败必须可见。

## 已否决的替代方案

- **把营销路由放进 `docs/`。** 需要重做文档站的 locale 根路径、把 fumadocs preset 从全局 import 降级为
  路由级，并把官网的发布节奏绑死在文档构建上。
- **用一个 Worker 把两个 Pages 项目拼成单域名。** 用一层必须维护、预览和调缓存的路由层，换一个单一
  origin。
- **把营销页放进产品 app。** 等于把宣传册代码打进 Tauri 与 Capacitor 产物。
- **复用产品的暗色 token。** 那是为密集 UI 调的零色度中性色；方案的舞台刻意偏冷调，而中性色在大留白
  页面上会发脏。
