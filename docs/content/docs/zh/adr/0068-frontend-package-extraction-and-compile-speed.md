---
title: "ADR-0068 — 前端包拆分、编译提速与结构优化计划"
description: "主应用是一个平坦编译单元（单一TSCONFIG程序，单一Next.js图）中包含~873k LOC非测试TypeScript。这ADR记录了研究结论——前端已经高度优化（pixi 单文件别名、runtime-AMD Monaco、所有重库动态导入、自我调优的 Jest），所以剩下的优势是结构性的：冗余的内置 tsc、未缓存的 CI 类型检查、`lib/` 几乎完全没有包边界，以及少数属于组织（而非逻辑）的“神文件”。它提出了一组排名化的零重构编译速度优势（去掉冗余的构建时 tsc、缓存 tsbuildinfo、推迟重度布局初始化器）、一个叶优先`@cognia/*`提取阶梯，镜像既有的源包模式（从 `@cognia/redact` 开始，到750 consumer `@cognia/agent-config-types`编译边界），以及利用树中已有的模式对域对称的 forms/executor god-file 工作流程分解。"
---

# ADR-0068 — 前端包拆分、编译提速与结构优化计划

**状态**：提议（2026-07-13）**作者**：Max Qian + Claude Opus 4.8 **构建内容**：现有`packages/*`源包模式（14个零构建`@cognia/*`包，通过`tsconfig.json` `paths` + `jest.config.ts` `moduleNameMapper`作为原始TS消耗）、已用于`DesktopOnlyInitializers` / `MobileOnlyInitializers`的`next/dynamic(ssr:false)`初始化模式、`stores/agent/agent-team-store/slices/`已使用的Zustand切片模式，以及已在`components/workflow/editor/inspector/forms/`下开始的域文件拆分（`eval-forms.tsx`，`github-forms.tsx`，......）。这是前端对应的**ADR-0067**（`src-tauri` crate分解和构建速度）;同样的“把重图隔离在边界后面，这样编辑就不会再重新编译所有东西”的论点也适用于TS程序。

## 背景

主应用的TypeScript（浏览器/Tauri/Capacitor壳共享的所有内容）是一个扁平的编译单元。这是前端开发速度和CI成本的主要结构性拖累，数字明确无误：

| 度规 | 价值 | 后果 |
| --- | --- | --- |
| 非测试源（`app+components+lib+hooks+stores+types`） | **873,255 LOC** | 一个`tsconfig`程序，一个Next.js模块图 |
| 测试文件（共址） | **4,283** | 全部汇聚成同一个根`tsconfig` `include: **/*.ts(x)` |
| TS项目参考文献 / `composite` | **0** | 整个 ~9k 文件程序将类型校验作为一个整体 |
| 静态路由（`page.tsx`） | **92**（0动态`[param]`，0 `generateStaticParams`） | 干净的静电扇出——对`output:"export"` |
| `dynamic()` + `React.lazy` boundaries in `app`/`components` | **16 + 8** | 虽然很少，但重度自由派已经在其中（见下文） |
| `optimizePackageImports` | `["radix-ui","motion","recharts"]` | 近乎最优;剩下的桶不符合条件（下文） |
| `next build`类型检查 | 全 `tsc` ~9k 文件，** 非 * `ignoreBuildErrors` | 即使CI有另一份`typecheck`工作，他仍然坚持 |
| 内部封装 | **14** 低于`packages/*`（13个零构建源包，1个TSP） | 提取模板经过验证且价格便宜 |

有两个事实贯穿整个项目：

- **前端已经优化良好。** pixi.js被锯齿化为预先捆绑的单一文件（`next.config.ts:72-73,181,196`），Monaco通过运行时 AMD加载器加载，因此从不进入捆绑包（`lib/canvas/monaco-loader.ts`），而且所有`three`/`mermaid`/`pdfjs-dist`/`@huggingface/transformers`/`xterm`/`docx`/`jspdf`/`xlsx`/`mammoth`都是`import()`-split。Jest已经拆分`node`/`jsdom`项目，并由免费RAM自调Worker覆盖。除了冗余的构建时间 TSC，项目的其余部分是结构性质的，已经没有低强度的“翻旗子”后果胜利了**。剩下的项目是结构性质的。
- **当孤立至关重要时，团队已经会伸手去`packages/*`。** `provider-types`，`provider-core`，`rag`，`document`，`vector`，`primitives`，`time`，......正是因为它们像叶子一样，不受框架限制，并且跨壳共享，才被从`lib/*`中提取出来。这种模式被理解并欢迎;它只是没有被推到下一层候选人。

### 为什么这块巨石碑可以安全（且便宜）地剥开

有三个结构性事实（测量而非假设）使开采风险异常低：

**1.提取模板是一个三文件、零构建移动。** 14个包中有13个没有构建步骤：`package.json`点`main`/`types`在`./src/index.ts`，`exports`映射显示`"cognia-source"`条件+`"default"`，均为原始`.ts`。分辨率精确布线在三个地方——`tsconfig.json` `paths`（`:25-53`）、`jest.config.ts` `moduleNameMapper`（`:130-144`）和`pnpm-workspace.yaml`。因此添加一个包是有成本的：创建`packages/xyz/{package.json,tsconfig.json,src/}` →添加一个`paths`别名→添加一行`moduleNameMapper`→重写导入网站。`next.config.ts`从未提及`@cognia`（Next是从`tsconfig`原生解决了别名），所以那里没什么可触碰的。只有`provider-types`（叶子最多的）也`tsup`-builds `dist/`，并且仅仅证明它能独立编译。

**2.跨壳耦合已经存在——_want_ `@/`边界的深度。** 独立CLI（`cli/src`，存在于主TS程序中以便可重用应用逻辑）通过`@/…`别名导入应用内部文件：**`@/lib/claude` 188×**、`@/lib/db` 32×、`@/lib/ai` 28×、`@/lib/plugin` 24×、`@/lib/workflow` 13×。这些不是偶然——它们是稳定依赖，如今没有包边界，因此每次应用端对`lib/claude/*`的编辑都会使CLI的类型图失效。

**3.最大的“神档案”是组织债务，而非逻辑债务。** 两个最大罪魁祸首共用工具包/登记册，纯粹是规模问题，_already在同一条directory_中出现分裂模式：

| 档案 | LOC | 自然 | 现有模式可复制 |
| --- | --- | --- | --- |
| `components/workflow/editor/inspector/forms/index.tsx` | 7,816（113个`*Config`部件） | **组织型**——所有人都使用共享的`./shared/`工具包（`Field`、`readString`、`patchParam`、`ExpressionField`、`CronBuilder`）;禁止复制粘贴 | 兄弟`eval-forms.tsx`、`github-forms.tsx`、`git-ocr-forms.tsx`已经是域名分割的 |
| `lib/workflow/nodes/built-ins.ts` | 4,773人（117 处理器） | **混合** — 43次导入，跨越~40个无关`lib/`域 | 镜像表单域分割 + 薄注册表 |
| `lib/claude/build-options.ts` → `resolveSendOptions` | 2,350行单一功能（`:897-3247`） | **混合** — 汇聚编排器 | 文件已经有相位解析接缝（`resolveMemberConfig`，`teamHasKnowledgeTwins`） |
| `hooks/chat/use-claude-chat.ts` | 2,816 | 配器 | 已提取的邻居（`steer-runtime`、`stream-coalescing`、`use-artifact-detection`） |
| `stores/artifact/artifact-store.ts` / `stores/settings/settings-store.ts` | 1,933（102次行动）/ 1,540 | 没有切割 | `stores/agent/agent-team-store/slices/` 是仓库片中的先例 |

测量到的`lib/`子系统尺寸还揭示了开采边界的形状——几片干净的叶子被一个巨大的Dexie/twin-coupled核心包围，这些核心绝对不能**移动**：

| 可提取（叶状） | 耦合核心（留在应用内） |
| --- | --- |
| `packages/redact/src/index.ts`（0 `@/`导入）、`lib/search`（24 次，3 次可注入泄漏）、`lib/logging`（26 + `types/logging`叶）、`lib/claude/types.ts`（仅类型集线器）、`lib/tts`（25 个，4 文件原生桥接） | `lib/db`（119，_is_ Dexie模式）、`lib/workflow`（150）、`lib/plugin`（265）、`lib/connectors`（184）、`lib/scheduler`（43）、`lib/goal`/`lib/radar`/`lib/memory`/`lib/a2ui`/`lib/slash-commands`/`lib/ocr`（Dexie/twin胶） |

## 决策

采用**三轨前端程序**——（T1）零重构编译速度获胜，（T2）叶优先`@cognia/*`提取阶梯，（T3）神文件的域对称分解——以分阶段、并发安全的顺序执行，标志翻转先获胜，并提取一个叶包作为可复用模板。没有运行时行为改变;发射`out/`必须保持字节兼容，以兼容 Tauri 和 Capacitor shell。

### 轨道1 — 编译速度指标（按 ROI 排名）

| # | 拉杆 | 变化 | 影响 | 努力 | 风险 |
| --- | --- | --- | --- | --- | --- |
| **C1** | 去掉多余的内置TSC | `typescript.ignoreBuildErrors: true` `next.config.ts`（`:129-131`年）。`next build`目前对大约9k文件进行全面检查，但`quality.yml`已经把`pnpm typecheck`作为独立作业运行，而且CI从未缓存`*.tsbuildinfo`（git忽略），→构建中的检查是**每次构建都做一次冷满tsc**。SWC仍然会编译;`out/`字节完全相同。 | **-30–50%的工作CI `build`**;大型本地`pnpm build`胜利 | **该死** | M — 类型门禁必须在其他地方持续执行（即：优质工作+本地`pnpm typecheck`） |
| **C2** | 缓存`*.tsbuildinfo`在CI | 在`quality.yml`中添加`actions/cache` `tsconfig.tsbuildinfo`，基于lockfile + 源哈希，带有仅lockfile `restore-keys` 回退（形状与`test.yml:246-253`相同）。`incremental:true`已经在本地工作;CI就是从不恢复。 | **-40–70%CI小PRs的类型检查** | S | 低级——buildinfo是咨询;stale/missing →全额支票 |
| **C3** | 延迟重布局初始化器 | 将网端`null`-rendering初始化器（`WorkflowRuntimeProvider`、`GatewayProvider` + `RoutingRuntimeInitializer`、`ConnectorBusProvider`、`SchedulerInitializer`、`AgentTeamRuntimeInitializer`）收集到一个`next/dynamic(ssr:false)`捆中，复制已验证的`desktop-only-initializers.tsx`模式。从每个路由的同步首次绘制编译中移除`lib/workflow`/网关路由/连接器子系统图。 | **-15–30% 显影冷启动**，降低`pnpm dev` RAM | M | M — 保留子挂载顺序（`app/layout.tsx:216-221` 带有排序注释）;组件渲染`null` `ssr:false`导出安全 |
| **C4** | mtime-skip 预构建 sidecar TSC | `scripts/build/build-webclone-sidecar.mjs:70-71`和`build-vscode-ext-host-sidecar.mjs`每`prebuild`都无条件地`npm run build`（tsc）运行。像 `copy-monaco-assets.mjs` 一样加个`newest(src) > dist`跳过。 | 当sidecar号不变时，每 `pnpm build` 10–30 先令 / `tauri build` | S | 低——dist永远不会进入渲染包 |

**明确评估并_not_采纳**（有证据支持，以防止再次诉讼）：

- **给`optimizePackageImports`添加`@xyflow/react`** — 无操作。它的`exports`映射只暴露了一个`.`桶（没有子路径），因此Next无法重写导入。`optimizePackageImports`列表已经接近最优（`radix-ui`通过元桶在34个文件中使用，而4个子路径用户;`lucide-react`/`date-fns`在Next内置默认列表中）。
- **定制`splitChunks`** — 应用路由器默认分块已经会按路由拆分动态重库。自定义配置会冒着Tauri/Capacitor消耗的调优`out/`的风险。唯一真正的重复（**shiki**泄露到聊天共享块+`@streamdown/code`第二个副本）是bundle大小的问题，而不是编译速度的问题;仅在测量的丛回归中处理。
- **重新启用`turbopackFileSystemCacheForDev`** — 上游被单一作者腐败竞赛阻断（vercel/next.js#90691）;接下来只暴露on/off，没有安全的部分启用。保持关闭（`next.config.ts:155`）;请继续关注上游修正。
- **TS `packages/*`项目引用（大致）**——单体`app`/`components`/`lib`程序主导了~9k文件，因此引用只购买了一小块片，实际成本（复合文件需要`declaration`个发射+`moduleResolution`约束+15条参考线路）。它支付的_one_是`lib/claude/types.ts`边界（2号轨道，E5）。

### 轨道2 — `@cognia/*`层取材梯（叶片优先）

每个梯级都使用零构建源码包模板。阶级顺序是**耦合优先**：先在平凡叶节点上证明流，在中等规模运行时包上建立`{ fetch, getSecret, model }`依赖-注入约定，最后完成宽代码修改边界。

| # | 包装 | 搬迁 | 断开联结 | 努力 | 回报 |
| --- | --- | --- | --- | --- | --- |
| **E1** | `@cognia/redact` | `packages/redact/src/index.ts`（纯正则表达PII清除器） | **无** — 0 `@/`导入。兄弟`redaction-key.ts`（密钥环）有两个消费者，要么留在应用端，要么注入`KeyProvider` | **该死** | 81个站点共享的安全关键门禁（双站、目标站、连接器自动模式、Agent-Team、计划门禁）;可独立审计;sidecar可以采用真正的刷子 |
| **E2** | `@cognia/web-search` | 全部`lib/search`（24个文件，11个 提供商 适配器） | 3个可注射泄漏：`useSettingsStore` → `SearchConfig`参数;`standalone-answer.ts:19-25` model/fetch → `{ model, fetch }`手柄 | M | 框架无关;今天只限应用。CLI没有网页搜索功能;有个包可以让它在多个壳层间重复使用，并且在对等 DEP 后面隐藏了 11 个第三方适配器 |
| **E3** | `@cognia/tts` | `lib/tts`（25个文件）+ `types/media`叶子 | 原生桥接器限制在4个文件（`keyring`、`proxy-fetch`、`providers/edge`、`providers/openai-realtime`）→注入`{ fetch, getSecret }` | M | 手机通缉（Capacitor）+ sidecar;分离第三方TTS 提供商 |
| **E4** | `@cognia/logging` | `lib/logging`核 + `types/logging`（近纯叶） | 平台传输隔离在5个bootstrap/transport文件→作为应用注册插件保存（已经可插拔） | M | **344个导入站点**（第二宽的枢纽）。CLI 自有 11 文件的日志→真实收敛目标;编译隔离集线器可以减少增量重建的扇出 |
| **E5** | `@cognia/agent-config-types` | `lib/claude/types.ts`（`AppSettings` / `SendOptions` hub）——**not** `build-options.ts`（运行时胶水，贴在应用侧） | 仅有类型;抽取4种类型兄弟（`lib/search/types`——脱离E2;`types/pet`;`types/lsp/config`;`types/system/compression`） →作为对等离职者共同搬迁或重新导出 | **L**（代码mod） | **750个导入站点——仓库中最大的编译边界。** 编辑应用运行时代码停止使750个类型使用者失效;CLI的188 `@/lib/claude`伸缩，成为稳定的封装边缘。这是唯一值得TS项目参考优势的案例 |

**一般规则（`provider-types`先例）:** 任何叶子测试失败的Dexie/twin-coupled子系统（`goal`、`radar`、`memory`、`scheduler`、`a2ui`、`slash-commands`、`ocr`）都**不可**整体提取——其唯一干净的第一步是提取其已经纯净的`types/*`兄弟系统（已验证：`types/goal`、`types/radar`、`types/memory`在`lib`中有0–1次回溯引用）。

### 轨道3 — 神文件分解（域对称）

| # | 目标 | 分裂 |
| --- | --- | --- |
| **S1** | `forms/index.tsx`（7,816）+ 71 KB `index.test.tsx` | 按域提取（`goal-forms`、`scheduler-forms`、`team-forms`、`plan-forms`、`terminal-forms`、`connector-forms`、`ai-forms`、`mobile-forms`）;把`index.tsx`转成再出口桶，这样5个消费者都能保持稳定。分组测试同步进行。**L，机械故障。** |
| **第二季** | `lib/workflow/nodes/built-ins.ts`（4,773） | 镜像S1的域边界（`goal-nodes`、`scheduler-nodes`等）+一个薄的注册表。自然地与S1搭配。**L.** |
| **第三季** | `build-options.ts::resolveSendOptions`（2,350行 fn） | 提取纯相位解析剂（`resolveA2uiCapabilities`、`resolveComputerUseTools`、`resolveTwinRuntime`、`resolveGoalContext`、`resolveBriefMode`）;保留一个~200线编排器。在现有测试套件后面。**M–L.** |
| **S4** | `use-claude-chat.ts`（2,816） | 继续邻居模式：`use-chat-send`、`use-chat-events`、`use-chat-session-lifecycle`。**L.** |
| **S5** | `artifact-store.ts`（102次行动）+ `settings-store.ts` | 采用现有的`agent-team-store/slices/`模式。**M.** |
| **第六季** | `characters-section.tsx`（2,351,8个组件） | 分成`character-editor`、`character-row`、`character-packs`、`computer-use-sub-settings`。**M.** |
| **第七季** | 目录卫生 | 合并`lib/file`↔`lib/files`，`lib/theme`↔`lib/themes`;向前`lib/data-hooks/` → `hooks/data/`;记录`stores/plugins`↔`stores/plugin-runtime`边界。**每人都喜欢。** |
| **第8季** | 测试回填 | `chat/message-parts/mcp-renderers/*` （8） + `chat/renderers/*` （7） 中缺失的15个测试——它们渲染了不可信模型输出（潜在漏洞接口最高）。**M.** |

**别管（大但连贯）:** `lib/claude/types.ts`（纯类型——但_becomes_ E5，移动而非分裂），`lib/plugin/core/manager.ts`（单一经过充分测试的生命周期类别）。

## 迁徙计划

每个步骤都是独立提交，受 `pnpm test:changed`（或有作用域的`npx jest <paths>`——参见 `gotcha_rtk_test_masks_jest_exit_2026-07-13`）、`pnpm typecheck` 和 `pnpm lint:i18n` 限制。Order在并发WIP（仅配置优先，宽代码mod最后）时接口冲突最小化。

1. **C1 + C2 + C4批次** — 仅接触`next.config.ts` + `.github/workflows/*` + 两个`scripts/build/*.mjs`。几乎没有应用代码;冲突最低接口。立即CI/build加速。
2. **Extract `@cognia/redact` （E1）** — 模板PR：证明 create-package →别名→映射器 的 mapper →重写导入流程在零耦合叶节点上端到端运行，并加固了安全关键的 门禁。
3. **S1 + S2 神档分割** — `forms/index.tsx` + `built-ins.ts` 按对称域边界分割（一起做;边界相同）。机械结构，高结构回报，没有运行时变化。
4. **S5 商店切片** — 采用现有的切片模式进行`artifact-store`/`settings-store`。
5. **C3初始化推迟** — 开发速度胜利;安装顺序需要小心，机械工作稳定后。
6. **E2 `@cognia/web-search` + E3 `@cognia/tts`** — 独立的M提取，建立`{ fetch, getSecret, model }` DI约定。
7. **S3 + S4** — `resolveSendOptions`相位解析器和`use-claude-chat`子hook，位于测试套件后方。
8. **E4 `@cognia/logging`（344个站点）→ E5 `@cognia/agent-config-types`（750个站点）**——宽广的代码模组边界，最后，在DI约定和提取模板经过实战测试后。E5还引入了唯一值得TS的项目参考优势。
9. **S7 + S8** — 目录卫生和测试回填，机会主义地与上述内容并行。

## 后果

- **Dev/CI内环：** 删除冗余的构建时间 tsc（C1）并缓存CI类型检查（C2）直接切断了运行次数最多的两个门禁;推迟布局初始化器（C3）会缩减每条路由的首次绘制编译图。
- **编译隔离：** 每个 `@cognia/*` 边界都会阻止应用端编辑使该包的消费者失效。仅E5就为750个类型用户（以及CLI的188个输入端）隔绝了应用运行时流失。
- **跨壳重用：** `redact`、`web-search`、`tts` `logging` CLI、sidecar 和移动 shell 可被消耗，而非仅应用或逐壳重新实现。
- **结构清晰度：** forms/executor神文件获得了他们已经半拥有的领域层次;商店采用了已建模代码库的切片;这两个工作流文件沿着_same_边界分开，保持表单↔执行器对等性明显。
- **无输出变化：** 每个度量都保留`output:"export"` — C1/C4仅在非可视化工作运行_whether/when_改变，C3 组件在服务器上渲染`null`，且`@cognia/*`包是源解析的（相同的发射图）。

## 风险

- **并发树危害。** 工作树承载大量来自其他会话的未提交工作，轨道2/3重写shared/high-fan-in文件（`tsconfig.json`、`jest.config.ts`、`forms/index.tsx`、`lib/claude/types.ts`）。先按顺序操作仅配置步骤，每次提交做一个包/一个神文件;当文件携带混合WIP时，使用hunk滤波器拆分技术。参见`concurrent-tree-safety`和`gotcha_split_concurrent_features_hunk_filter_2026-07-12`。
- **E5 代码模组爆炸半径（750 个站点）。** 在 E2 移除`lib/search/types`兄弟耦合后，以脚本化的寻替方式进行完整 `pnpm typecheck` 门禁。先落地E1–E4，以证明模板和DI约定。
- **覆盖范围门禁。** 任何移入`packages/*`的文件必须加入`collectCoverageFrom`+`scripts/test/coverage-thresholds.json`中的阈值组（现有包已包含自由时代的底层），否则≥90%门禁将默默失去执行力。
- **i18n 对等性.** God-file split（S1， S6）移动面向用户的字符串;运行`pnpm lint:i18n`，并按照工作规则保持`en.json`/`zh-CN.json`在对等性中。
- **玩笑，ESM shims。** 拉取ESM-only deps 的新包必须扩展`transformIgnorePatterns`允许列表 / `moduleNameMapper` （`jest.config.ts:247-250`），与 `@cognia/document` 处理其对等程序相同。

## 非目标

- 没有运行时行为变化，没有依赖升级，没有`output:"export"`、路由设置或Tauri/Capacitor消耗的捆绑包布局也没有变化。
- 不提取Dexie/twin-coupled核心（`lib/db`、`lib/workflow`、`lib/plugin`、`lib/connectors`、`lib/scheduler`、`lib/goal`等）——这些设计上是集成胶;只有纯`types/*`叶符合条件，并以机会主义方式追踪。
- 不会分解`build-options.ts`成一个包裹（它会留在应用端运行时胶水）;唯一的`lib/claude/types.ts`是E5叶。
- 没有广泛的TS `composite`/project-reference迁移超过单一E5边界。

## 考虑的替代方案

- **只有1号轨道的旗帜会被翻转。**真实但有界限;保留873k-LOC单程序失效和神文件的完整。第一轨是_as well_采用的，不是_instead_。
- **`transpilePackages` / 一个次级包边界代替源包。** 更重且冗余——仓库已经通过`tsconfig` `paths`本能`@cognia/*`解析;源包给出编译边界，且没有任何构建步骤。
- **仅通过内部`//region`标记或嵌套的`#[path]`-style桶分割神文件。** 不会改变编译器看到的模块边界;没有增量隔离的好处。需要真实文件（Track 3）。
- **广泛的`composite`项目参考迁移。** 已拒绝 E5之外：app/components/lib大部分数据留在一个无法廉价拆分的程序中，因此cost/benefit较差（参见轨道1非采纳列表）。

## 附录 — 测量数据（2026-07-13）

- LOC / 文件计数、路由计数、懒惰边界计数、`optimizePackageImports`适应度、per-`lib/`-subsystem大小和跨壳耦合计数通过`app/ components/ lib/ hooks/ stores/ types/`和`cli/src/`的`find`/`wc`/`grep`捕获，以及`next.config.ts`、`tsconfig.json` + `tsconfig.build.json`、`package.json`、`jest.config.ts`、`app/layout.tsx`和`scripts/build/*.mjs`链的读取。
- 重现头条数字：
  - 资料来源LOC：`find app components lib hooks stores types -type f \( -name '*.ts' -o -name '*.tsx' \) ! -name '*.test.*' ! -name '*.stories.*' -print0 | xargs -0 cat | wc -l`
  - 懒惰的界限：`grep -rl "dynamic(" app components | wc -l` / `grep -rl "lazy(" app components | wc -l`
  - 项目参考资料：`grep -rc '"references"' tsconfig*.json` → 0
  - CLI联结：`grep -rho "@/lib/[a-z-]*" cli/src | sort | uniq -c | sort -rn`
  - 包装构建模式：`for p in packages/*/; do [ -f "$p/tsup.config.ts" ] && echo "$p tsup"; done` →唯一的`provider-types`

## 关键文件

- 编译速度目标：`next.config.ts:129-131`（C1）、`.github/workflows/quality.yml`（C2）、`app/layout.tsx:210-249` + `components/providers/initializers/desktop-only-initializers.tsx`（C3模式）、`scripts/build/build-webclone-sidecar.mjs:70-71` + `build-vscode-ext-host-sidecar.mjs`（C4）
- 提取模板：`packages/primitives/{package.json,tsconfig.json}`（零构建）、`packages/provider-types/tsup.config.ts`（唯一的构建步骤）;`tsconfig.json:25-53`、`jest.config.ts:130-144`、`jest.config.ts:259-289`（覆盖块状布线）
- 萃取候选物：`packages/redact/src/index.ts`（E1）、`lib/search/standalone-answer.ts:19-25`（E2注射点）、`lib/tts/`（E3）、`lib/logging/` + `types/logging`（E4）、`lib/claude/types.ts`（E5）、`cli/src`（E5稳定的188× `@/lib/claude`消费者）
- 神档：`components/workflow/editor/inspector/forms/index.tsx`（第一季）、`lib/workflow/nodes/built-ins.ts`（第二季）、`lib/claude/build-options.ts:897-3247`（第三季）、`hooks/chat/use-claude-chat.ts`（第四季）、`stores/artifact/artifact-store.ts` + `stores/agent/agent-team-store/slices/`（第五季目标+先例）
