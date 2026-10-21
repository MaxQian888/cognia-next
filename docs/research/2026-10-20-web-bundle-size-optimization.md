# Web 前端体积优化研究（2026-10-20）

本轮只研究，未修改产品代码、依赖、构建配置或缓存。新增此文档，是因为现有分析记录的是 2026-10-05 的构建；当前校验器、语言包、插件资源和启动路径已经变化，需要保留新的证据与适用范围。

**判断：Web 首次加载有充分理由继续优化，优先级应放在预缓存策略、全局运行时边界和启动时机。** 不能只看 `out/` 总大小，也不能把 `dynamic()` 的数量当作优化结果。历史有效 Web 构建的首页脚本已经达到 22.01 MiB / 6.14 MiB gzip；当前源码仍存在明显的重依赖路径。但本轮没有新的完整 Web 构建，不能据此声称今天的首页恰好还是这个数字。

## 1. 证据范围与可信度

| 证据                  | 本轮确认结果                                                                                   | 能说明什么                                     |
| --------------------- | ---------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| 历史 Webpack Web 分析 | 2026-10-05 的原始 Analyzer 与报告仍在                                                          | 历史基线，不能当成当前版本测量                 |
| 当前 `out/`           | `cognia-mobile-artifact.json` 的 `platform` 为 `mobile`；首页修改时间为 2026-10-13；无 `sw.js` | 不适合衡量当前 Web 或 PWA                      |
| 当前源码与安装依赖    | Next.js 16.4.0、Webpack 生产命令、Serwist 9.5.13                                               | 当前结构与实际插件行为                         |
| 当前 public 资源盘点  | 文件大小、glob 展开、SHA-256 内容去重                                                          | 当前静态资源与预缓存候选；不是线上传输量       |
| IDE 校验入口独立构建  | esbuild 0.28.2、browser、ESM、minify、ES2018                                                   | 模块本身体积；不是 Next/Webpack 首屏测量       |
| 根运行时静态导入遍历  | 从 `AppRuntime` 可达校验器、词表、多家 SDK、完整图标数据                                       | 定位导入路径；不等于 tree shaking 后保留字节数 |

源码基于共享、存在大量未提交改动的工作区；执行时 HEAD 和关键输入哈希在 [snapshot.json](../../.cache/bundle-analysis/2026-10-20/snapshot.json)。没有创建与修改前后对比的性能实验，没有声称已取得优化收益。

本轮没有运行 `pnpm build:analyze`：主工作区正在被其他会话使用，`next.config.ts:49` 禁止生产自定义 distDir，直接构建会覆盖共享 `.next/`、`out/` 并通过 prebuild 修改多类生成资源。磁盘当时仅余约 16 GiB；历史分析还记录过构建缓存导致 ENOSPC。后续应在隔离 checkout、足够磁盘空间下补基线，而不是覆盖当前产物或清理他人的缓存。未测线上 URL、LCP、长任务、真实下载瀑布和原生端。

## 2. 历史优化确实做过，但没有解决首屏结构

来自 [依赖去重报告](../reports/next-bundle-dependency-dedupe-2026-10-05.md) 和对应原始数据：

| 指标                           | 2026-10-05 去重后的 Web 输出 |
| ------------------------------ | ---------------------------: |
| 所有客户端 JS，包含异步块      |                   187.99 MiB |
| 上述 JS 的逐文件 gzip 合计     |                    55.84 MiB |
| 首页 HTML 引用的现代浏览器 JS  |                    22.01 MiB |
| 上述首页 JS 的逐文件 gzip 合计 |                     6.14 MiB |
| 完整静态导出                   |                   374.30 MiB |

这些首页数字还不含 hydration 后的动态导入、语言包请求和 service worker 下载；gzip 是本地逐文件计算值，不是线上 `Content-Encoding` 实测。原先的 119.54 MiB raw/QA/contact-sheet 素材清理已经落地，本轮 `public/` 中未找到这类候选；Shiki 主版本对齐也已做过，不能重复承诺同一批收益。[历史分析](../reports/next-bundle-analysis-2026-10-05.md)、[本轮 inventory](../../.cache/bundle-analysis/2026-10-20/inventory.json)。

## 3. 第一优先：PWA 安装仍可能把大量可选功能资源下载一遍

当前 `public/` 总计 **164.28 MiB，3,689 文件**。按当前 `next.config.ts:111` 的真实 glob 展开，传给 Serwist 的 public 预缓存候选是 **162.86 MiB，2,434 文件**，尚不含 Webpack 生成的 JS/CSS 和未来 prebuild 更新的资源。

| public 分类             | 当前文件大小合计 |
| ----------------------- | ---------------: |
| `icons/`                |        53.49 MiB |
| `_cognia/` 内置插件资源 |        34.82 MiB |
| `monaco/`               |        24.38 MiB |
| `marketing/`            |        15.93 MiB |
| `ocr/`                  |        11.41 MiB |
| `catalog/`              |         6.28 MiB |

证据：[完整文件清单与 glob](../../.cache/bundle-analysis/2026-10-20/precache-candidates.json)。这不是“首屏一定下载 162.86 MiB”，而是当前 public 候选的未压缩字节数；真实情况取决于 worker 安装成功与否、缓存状态、部署资源和压缩。

**现有 2 MiB 单文件限制不能解决这条 public 收集路径。** 安装版 `node_modules/@serwist/next/dist/index.mjs:195` 直接 glob public 并转成 `additionalPrecacheEntries`，再在 `:211` 传入 `InjectManifest`；`exclude` 处理的是另一条 compilation assets 路径。配置注释 `next.config.ts:95` 也已说明 public 的过滤需要通过 `globPublicPatterns`。本轮候选中仍有 6.71 MiB 的 Monaco TS worker、三个各约 3.76 MiB 的 OCR core 等文件。

建议把 **PWA 预缓存从目录式收集改成最小离线壳清单**：启动页、离线页、当前离线启动必需的资源；编辑器、OCR、营销海报、可选插件、模型目录和非当前需要的图片改为功能首次使用时缓存。普通缓存必须保持文件版本一致；不能随意排除首屏 chunks，导致离线壳无法启动。若“安装后所有高级功能立即离线可用”是必须的产品要求，应显式提供完整离线资源下载，并展示大小和完成状态，不能悄悄取消这个能力。[当前 worker](../../app/sw.ts)、[Web 注册时机](../../components/providers/initializers/pwa-lifecycle-initializer.tsx:40)。

验收要分别记录：安装前后请求、预缓存清单条数/原始字节、首屏到交互期间流量、离线重启、首次使用未缓存功能、跨版本升级；不能只证明改小了 `globPublicPatterns`。

## 4. 第二优先：IDE 校验器已经成为一个新的大模块

当前实现不是以前的“运行时 Ajv + 全量 schema”，而是 CSP 安全的 standalone 校验器。`lib/plugin/ide/manifest-schema.ts:2` 静态导入它，生成选项在 `packages/plugin-sdk/scripts/generate-ide-contract.mjs:116`，包含 `allErrors: true`、`inlineRefs: false`。不能简单回退成运行时编译来压体积或破坏 CSP。

| 测量对象                                          |           JS / 源文件大小 |            gzip level 9 |
| ------------------------------------------------- | ------------------------: | ----------------------: |
| 生成的 `.cjs` 源文件                              | 10,536,499 B（10.05 MiB） |               941,296 B |
| 完整 `manifest-schema.ts` 入口独立 browser bundle |   5,670,415 B（5.41 MiB） | 663,176 B（647.63 KiB） |

独立 bundle 只有两个输入：现有 TypeScript 包装器和生成校验器，未替换实现或放宽校验。[构建元数据](../../.cache/bundle-analysis/2026-10-20/ide-validator.metafile.json)、[尺寸](../../.cache/bundle-analysis/2026-10-20/ide-validator-summary.json)。它不是 Next/Webpack 的最终 chunk，也不是可直接承诺移除的首屏大小。

当前静态路径：

```text
AppRuntime
  → ContextKeysInitializer
  → plugin-store
  → plugin/core/validation
  → plugin/ide/manifest
  → plugin/ide/manifest-schema
  → ide-manifest-validator.generated.cjs
```

除了 store，当前静态图中 `manager`、`marketplace`、`config-api`、`cogpack/manifest`、workflow publication preflight 也导入同一 validation 模块。[导入路径与消费者](../../.cache/bundle-analysis/2026-10-20/graph.json)。`cogpack/manifest.ts:12` 仅需要 id/version predicates，`config-api.ts:15` 只需要配置校验，这些边界应先拆轻。

建议先做一组完整的校验边界实验：把轻量 predicates、config 校验与重型 manifest/IDE 校验分开；保留所有安装、发现、更新、工作流发布和旧格式迁移的完整校验，在已存在异步业务入口上按需加载重型校验。`validation.ts:3449` 已有“声明了 IDE 字段才执行 IDE 校验”的条件，实际问题包括模块加载早于该条件判断。调整同步接口前必须盘点所有调用者，不能只给某一条 import 加 `import()`。

如果插件启动仍会立即执行完整校验，单独切块只会把同样的下载挪到 hydration 后。应和启动激活策略一起测量。进一步按贡献类型生成校验器可以研究，但需保留组合约束、所有错误路径和诊断语义；本轮未试改生成器，不能量化这部分收益。

## 5. 第三优先：把已有 capability 机制用于生产环境

`lib/boot/capabilities.ts:33` 在所有非 development 环境强制返回 `eager`；`:134` 的 eager 初始集合包含所有六种 capability。`DeferredBootInitializers` 虽使用 `dynamic(..., { ssr: false })`，但账户和上层 gate 放行、hydration 完成后，会挂载已被请求的 workflow、integrations、knowledge 等组。[源码](../../components/providers/initializers/deferred-boot-initializers.tsx:51)。

所以 **“HTML 脚本变少”和“用户首次打开需要下载的东西变少”必须分开验收**。官方 lazy-loading 示例也区分“独立 bundle 立即挂载”和“条件成立后才挂载”。[Next.js lazy loading](https://nextjs.org/docs/app/guides/lazy-loading)。

可复用的生产方向是：核心账户/设置/存储/聊天最先准备；导航到功能、用户操作，或已有后台任务确有需要时才请求对应 capability。已有 `BootCapabilityRouteActivator`、`BootProfileStartupProbe` 和 `lib/boot/startup-probe.ts` 可以扩展，不必重新造一个启动系统。

**不能直接把生产 profile 改成 `main` 就结束。** 必须保持已启用的 onStartup 插件、定时任务、连接器消息、memory/twin jobs、goal verification 的后台语义。现有 probe 是起点，仍需核查其他生产初始化、数据迁移与恢复责任是否完整；桌面能力也要继续正常工作。[启动探测](../../lib/boot/startup-probe.ts)、[路由 capability](../../lib/boot/route-capabilities.ts)。

## 6. 随后处理根运行时的非必要数据和功能 SDK

从 `AppRuntime` 的本地静态导入遍历找到以下路径。遍历覆盖 4,891 个文件，但不模拟符号级 tree shaking、第三方包、动态 import、RSC layer 或运行时分支，这个数量不是 bundle 模块数。

| 对象             | 当前证据                                                                                                                                              | 建议与边界                                                                                                                                         |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| AI provider SDK  | `use-claude-chat-controller → build-options → provider-consumption`；后者静态导入 13 家 SDK，`provider-core/core/client` 和 decision SDK 还有其他入口 | 按选中 provider 异步创建；同步接口需要改造并共享加载缓存，所有入口一起核对。保留 BYOK、订阅、兼容协议、流式与取消行为                              |
| 精确 token 词表  | `fallback-estimator.ts:1` 静态导入 cl100k rank，解析到的 CJS 文件 1,090,810 B，gzip 500,951 B                                                         | 在真正需要本地 token 估算前准备，或独立 worker。provider 报告值仍优先；不能直接用粗估替换当前短文本精确计数来制造收益                              |
| 图标全集         | `validation.ts:30 → lucide-catalog.tsx:33`，JSON 839,807 B，gzip 174,852 B                                                                            | 校验用名称/别名元数据与 SVG 节点分开。壳层与 A2UI 仍可能需要渲染全集，所以不能承诺切开后全集一定退出首屏                                           |
| Companion 命令表 | `CompanionBootProvider → transport-companion → command-descriptors`；原始 JSON 933,705 B，gzip 36,626 B                                               | 生成更紧凑的客户端契约表；保留 capability、target、transport、contract version 等实际授权/路由字段。原始体积大但压缩后较小，优先级低于校验器和词表 |
| 模型能力快照     | `reasoning-capability → models-dev-snapshot-lookup`；624,469 B，gzip 56,457 B                                                                         | 元数据与运行时能力最小集分离，避免每次模型能力判断出现网络瀑布                                                                                     |
| PNG 导出         | 当前静态图还能到 `lib/artifacts/export/raster.ts:38 → html2canvas-pro`                                                                                | 图片导出本身是异步，可在实际捕获时加载；保留插件 renderer、离屏 iframe 和截图完整性                                                                |

尺寸均为当前文件测量，不是 Webpack 模块归因或可相加的收益。[inventory](../../.cache/bundle-analysis/2026-10-20/inventory.json)、[graph](../../.cache/bundle-analysis/2026-10-20/graph.json)。

## 7. 总产物继续减重：Shiki、语言包与资源重复

### Shiki

当前 `lib/shiki/highlight-cache.ts:16` 和 `components/ai-elements/code-block.tsx:24` 仍使用 broad `shiki` 入口。官方说明这个入口将所有语言/主题编译为异步 chunks，即使不下载也增加 dist 体积；`shiki/core` 可显式组合语言、主题和 engine。[Shiki bundles](https://shiki.style/guide/bundles)。

建议共享 highlighter/loader，显式维护常用语言与当前受支持主题，长尾仍能按需取得，保留插件 grammar、语言 alias、流式未闭合代码块和双主题。不要为了减 dist 静默取消目前支持的语言。动态拼接的 import 若生成全目录 context，也未必缩小总产物。当前 Markdown 的 math/mermaid/chart 等本来已经有动态边界，不应作为全新优化重复列账。[当前 Markdown 边界](../../components/chat/markdown-renderer.tsx:53)。

### i18n 与帮助语料

当前启动字典已经拆分；`FullMessagesGate` 在允许进入完整界面后按当前 locale 加载整本字典。`i18n/route-messages.ts` 目前仅为 `/status` 提供 scoped catalog。完整英文/中文源文件分别 3,280,476 / 3,201,811 B，gzip 分别 878,389 / 958,332 B。下一步可沿现有 scoped loader 扩展登录回调、配对、公开分享与常用路由，先补齐根 provider 所需 namespaces，再渐进加载功能字典；不要直接剪字典制造 missing message。[messages](../../i18n/messages.ts)、[gate](../../components/providers/full-messages-gate.tsx)、[route messages](../../i18n/route-messages.ts)。

帮助语料当前 3,627,896 B、gzip 1,458,124 B；本轮没有发现从根运行时的纯静态路径。历史出现过 locale/帮助语料重复 chunks，但是否仍重复、是否同时下载，需要新 Analyzer 的 layer/reason 证据，不沿用旧数字。[当前语料入口](../../lib/support-agent/knowledge.ts:1)。

### 内置插件资源重复

对 public `_cognia/` 做 SHA-256 内容比较，重复副本额外占 **10,376,728 B（9.90 MiB）**。典型是同一插件的 hash `.cjs` 与 `resources/dist/index.js`。当前 glob 会把两个 URL 都纳入候选，缓存按 URL 区分，内容相同不表示自动只下载一份。[重复路径](../../.cache/bundle-analysis/2026-10-20/precache-candidates.json)。

先从非必要预缓存中排除，再研究资源 staging 与加载器是否能引用同一个 canonical URL；不能直接删除 `resources/dist/index.js`，因为它可能属于 manifest、nodeRuntime 或包资源契约。[资源生产者](../../scripts/build/build-browser-builtin-plugins.mjs:80)。Monaco 源/暂存目录对比没有发现旧文件残留，当前 24.38 MiB 不能归因于复制脚本没清理旧版本；文件数量差一是版本 stamp。[对比结果](../../.cache/bundle-analysis/2026-10-20/monaco-comparison.json)。

## 8. 实施顺序与验证要求

| 阶段 | 工作                                                                  | 验证                                                                                              |
| ---- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| 0    | 隔离 checkout 上冻结源码、锁文件、平台标记，完成 `pnpm build:analyze` | 保存 Analyzer、生成 worker、HTML 引用、gzip/brotli、构建环境及输入哈希；确认是 Web 产物           |
| 1    | 收窄 PWA 预缓存，首屏与可选资源分开                                   | 冷缓存/暖缓存请求与 Cache Storage，离线启动、功能首次使用、版本升级；保留必要离线能力             |
| 2    | 切开轻量插件状态/元数据与完整 manifest/IDE 校验                       | store、插件发现/安装/更新、config、cogpack、workflow publication、CSP；新 Analyzer 确认根路径切断 |
| 3    | 生产按 capability、route、后台工作激活；减根运行时功能 imports        | 新账户、解锁、已有连接器/定时任务/startup 插件/memory/twin；同时比较 hydration 前后流量           |
| 4    | SDK、tokenizer、字典与图标等逐项处理                                  | 每项单独 before/after，provider 流式/取消、精确计数、locale 切换、图标 alias 和动态插件           |
| 5    | Shiki 显式资源、内置资源去重；必要时独立 Web 发布资源集合             | 长尾语言、双主题、插件 grammar、全部实际资源引用；Web/Tauri/Capacitor 各自验证                    |

首轮至少测 `/`、`/logto/callback`、`/onboarding`、`/share/view`、`/status`，并区分未创建账户、已解锁空工作区、已有后台工作三个数据状态。每条记录 HTML 首批 JS、hydration 后至可交互的 JS、PWA 安装流量、脚本请求数/长任务；单独记录首次打开编辑器、workflow、插件和第一次发送消息的延迟，避免把首次加载成本全部挪到第一次操作。

现有 `scripts/ci/report/bundle.mjs` 已统计总大小，但没有首屏、压缩传输估算、PWA 清单与实际交互预算。可在新基线后扩展这些确定性指标；具体预算要由本项目测量确定，不能将外部通用 KB 数值直接升级为仓库政策。任何“省多少”的结论都要同一冻结快照下的生产 before/after，不累加重叠的模块归因。

## 9. 不建议作为第一步的做法

- 直接换 Turbopack 或大改 `splitChunks`：当前生产使用 Webpack，应先用对应 Analyzer 证明问题；换 bundler 后是另一条待验发布链路。[Next package bundling](https://nextjs.org/docs/app/guides/package-bundling)。
- 继续堆 `optimizePackageImports`：配置已经包含 `radix-ui`、`motion`、`recharts`；静态数据、完整校验器和实际使用的 SDK 不能靠这个配置消失。[当前配置](../../next.config.ts:376)。
- 把用户运行时聊天高亮搬进 Server Component：主应用为 static export，运行时用户内容无法在构建时预渲染，也没有可假设存在的 Next server。[Next static exports](https://nextjs.org/docs/app/guides/static-exports)。
- 只加压缩：部署模板已有 `encode zstd gzip` 和 hash 静态资源 immutable 缓存；线上实际响应头仍需验证。传输压缩不能免除 JS 解压后的解析/执行成本。[Caddyfile](../../deploy/compose/Caddyfile:5)。
- 在现有共享构建里简单编译掉 desktop：Web/Tauri 当前共用 `out/`；这会把桌面功能一起删除。优先运行时按需边界，真正独立 Web 资源集合要明确区分产物、发布与离线要求。[平台约定](../../next.config.ts:21)、[shell seam](../../components/runtime/platform-shell.tsx)。

## 10. 可复现证据与本轮验证

本轮所有测量写入 Git 忽略的 `.cache/bundle-analysis/2026-10-20/`，没有运行项目 prebuild 或清缓存：

```sh
rtk proxy node .cache/bundle-analysis/2026-10-20/measure.cjs
rtk proxy node .cache/bundle-analysis/2026-10-20/graph.cjs
```

- 已完成：public/glob 文件盘点、SHA-256 副本比对、Monaco 目录比对、当前根静态导入链分析、IDE 校验入口独立 browser 构建；脚本成功退出。
- 未完成也不声称通过：完整生产 Web 构建、线上网络/性能测量、Web UI/E2E、Tauri/Capacitor 验收、产品代码修改及其单元测试/typecheck/lint/build。本文档的格式检查单独执行。
- CodeGraph 当前没有本仓库索引，使用当前源码、TypeScript parser 与 literal search 作为导航和取证；没有初始化索引或启动开发服务器。

## Sources

- [Next.js package bundling](https://nextjs.org/docs/app/guides/package-bundling)：区分 Webpack 与 Turbopack 分析工具。
- [Next.js lazy loading](https://nextjs.org/docs/app/guides/lazy-loading)：拆块与条件加载的区别。
- [Next.js static exports](https://nextjs.org/docs/app/guides/static-exports)：静态导出能力边界。
- [Shiki bundles](https://shiki.style/guide/bundles)：全量入口与 fine-grained 资源组合。
- [Ajv standalone validation](https://ajv.js.org/standalone.html)：预编译校验与 CSP 场景；本仓库生成参数以当前脚本为准。
- [Serwist Next configuration](https://serwist.pages.dev/docs/next/configuring)：配置入口；public 收集细节以安装版 `@serwist/next@9.5.13` 的上述实际源码为准。
