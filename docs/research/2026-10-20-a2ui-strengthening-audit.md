# Cognia A2UI 现有实现加强审计

日期：2026-10-20，Asia/Shanghai。

初始审计阶段范围：研究、源码审计、隔离行为探针和现有定向测试。本轮没有修改产品代码、依赖、配置或用户数据，没有提交代码。

## 后续逐项修复记录

### 2026-10-20：第 1 项，CORE-01 AI 编辑数据丢失

状态：已完成本地修复及定向验证；未提交、未部署。以上“研究范围”描述原始审计阶段，此记录描述后续修复。

- 修改 `components/a2ui/workspace/a2ui-toolbar.tsx`：移除编辑完成后的 `updateDataModel(surfaceId, result.dataModel, false)`，保留已通过 `onDispatch` 应用到 store 的真实数据操作。capture 仅含本 turn 的部分数据，不是完整快照；组件补丁仍按原路径应用。
- 修改同目录 `a2ui-toolbar.test.tsx`：使用真实 A2UI store，新增组件编辑保值、嵌套 merge 保留 sibling、显式 `merge:false` 替换三个行为用例。先确认前两项在旧代码失败，第三项通过，再实施修复。
- 修改 `lib/a2ui/ai-generate.ts`：仅修正调用方说明，明确编辑结果中的部分数据不能覆盖实时模型；未改变生成 API 或创建/整页再生成逻辑。
- Chromium 隔离页面使用真实 toolbar、store、A2UI TextField 和 UI primitives，模型与持久化用 fixture：旧代码编辑标题后得到 `{}`；修复后用户填写的 name/email/draft 均保留；嵌套 patch 保留 email/draft；显式替换只保留新模型。未调用真实模型，也未运行整站或 Tauri 验收。
- 定向 Jest：43 passed、1 skipped。被排除的是既有 share-link 测试，它将 `createShareLink(options, undefined)` 与单参数调用匹配；已使用 HEAD 原始 toolbar 和原始测试复现同一失败，未改断言或分享实现。完整两套测试的结果为 43 passed、1 failed。
- 改动文件 ESLint、Prettier、`pnpm lint:i18n`、`pnpm i18n:sort:check` 通过；test-gap/i18n 审查无新问题。全仓 `pnpm lint` 被未修改的 role-model memoization（2 errors）及 agent editor dependency（1 warning）阻塞；`pnpm typecheck` 报告 14 个未修改路径中的错误，未报告此次修改文件。两项全仓门禁均不能称为通过。

第 1 项完成时只修 CORE-01；capture 合并/root 分叉、MCP ready、组件状态和其他审计问题仍按原清单逐项处理。

### 2026-10-20：第 2–17 项，本地修复进展

以下均未提交、未部署；验证使用真实 reducer/组件，传输、模型和外部设施按测试需要替换。

| 修复项            | 内容与文件                                                                                                            | 验证                                                           |
| ----------------- | --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| 2 / CORE-02       | `stores/a2ui/a2ui-store.ts`：有效根组件到达即 ready，loading 独立；legacy ready 幂等                                  | store + surface 92 tests passed                                |
| 3 / CORE-03       | `lib/claude/run-and-capture.ts`：复用真实 deepMerge，保留显式替换                                                     | 新增嵌套/替换回归先失败后通过                                  |
| 4 / CORE-04       | `lib/a2ui/component-tree.ts`：store/capture 共用初始 root 选择与后续保留规则                                          | capture/tree/store 204 tests passed                            |
| 5 / CORE-05       | parser 增加完整 dispatch 校验，ACP/IPC/store 共用；connector action 按声明 enum/字段检查                              | parser/bridges/store 181 tests passed                          |
| 6 / CORE-06 部分  | `lib/a2ui/prompts.ts`：纠正 Alert/Table/List/Chart 错误字段                                                           | prompts/generate-prompts 13 tests passed；完整描述生成仍待完成 |
| 7 / CORE-07       | catalog 执行已注册 JSON Schema；store 批量预检后再写入                                                                | catalog/store 92 tests passed                                  |
| 8 / S02 部分      | renderer 正确传递 disabled=false；ToggleGroup 整体禁用并阻止回写                                                      | renderer/toggle-group 26 tests passed                          |
| 9 / S02,S03       | Combobox 接上 Popup/Portal、items/filter、disabled、标签与翻译                                                        | Combobox 5 tests passed                                        |
| 10 / S04          | Collapsible 外部 open 更新与绑定回写                                                                                  | 相关套件通过，见第12项                                         |
| 11 / S04,S07 部分 | Sheet/Drawer open 回写，补默认无障碍标题                                                                              | 相关套件通过，见第12项                                         |
| 12 / S04          | Tabs activeTab 外部更新与绑定回写                                                                                     | Tabs/Collapsible/Sheet/Drawer 13 tests passed                  |
| 13 / S10          | 日期按本地日历格式写入；ISO instant 转本地 datetime-local，包括 min/max，拒绝无效日期显示                             | UTC/Asia-Shanghai/America-New-York 各21 tests passed           |
| 14 / S08          | Toast 稳定 surface/component ID，卸载清理，action identity 不重发                                                     | Toast 4 tests passed                                           |
| 15 / S09          | Table 读取/跟随 selectedRows，分页全选保留其他页并发出 action                                                         | Table 9 tests passed                                           |
| 16 / S01          | FormGroup 从真实 surface model 校验/提交；补提交入口和错误反馈，保持 fieldset 避免嵌套 form；pattern 支持 JSON string | FormGroup 18 tests passed                                      |
| 17 / S04          | Pagination 点击回写 currentPage 绑定并保留 action/disabled guard                                                      | Pagination 3 tests passed                                      |

说明：这些是逐项修复中的定向测试结果。最终联合回归、浏览器验收与质量门禁还需完成；不能将此表解释为整个审计清单已完成。正式官方协议互操作和 v1.0 候选功能仍是独立工作线，尚未实现。

### 2026-10-20：第 18–28 项与最终联合验收

| 修复项          | 内容与文件                                                                                                                               | 验证                                                                                                    |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| 18 / S06        | Button 渲染 icon/iconPosition，复用现有 resolveIcon                                                                                      | Button/Dialog 16 tests passed                                                                           |
| 19 / S06,S07    | Dialog closable=false 隐藏关闭按钮并阻止 Escape/outside dismiss；默认文案国际化                                                          | 同上                                                                                                    |
| 20 / S05        | InputGroup 增加 prefix/suffix addon；TextField/TextArea 使用组内 control，输入框成为 group 直接子节点                                    | InputGroup/fields 定向验证通过，纳入最终联合测试                                                        |
| 21 / S07        | 复用 child-renderer 增加 A2UITrigger，Button 接收原生 trigger props/ref，6 个 overlay/navigation wrapper 接入；Tooltip 复用全局 provider | 原生 overlay 键盘、hover、焦点恢复与 action 测试通过；审查发现的隐藏触发器、多 child Tooltip 回归已修复 |
| 22 / S06        | 七种 Chart 统一点击回传真实 row/index，修正 Bar 的 series index 错用                                                                     | 7 种均通过真实 Recharts 浏览器事件验收                                                                  |
| 23 / S06        | Tabs/Sidebar 渲染已声明图标                                                                                                              | 与 OTP 共14 tests passed                                                                                |
| 24 / S07        | InputOTP label/id 关联；禁用解析与回写 guard                                                                                             | 同上                                                                                                    |
| 25 / 契约重复   | `types/a2ui/schema.ts` 合并两源声明与扩展 union；`types/artifact/a2ui.ts` 保留兼容 re-export                                             | TypeScript 未报告本轮改动文件错误；最终全仓仍有1个范围外测试错误                                        |
| 26 / CORE-06    | 标准 prompt 从现有 factory + enum 元数据生成68个起始示例；custom catalog 附 description/schema；MCP 两端说明改为 legacy upsert           | prompt/schema 32 Jest tests + sidecar 13 node tests passed                                              |
| 27 / 部分失败   | Toolbar 流式补丁应用后失败时保留当前草稿并明确提示部分结果；未开始修改时仍显示 unavailable                                               | 新回归先失败后通过；最终 toolbar 含分享用例全部通过                                                     |
| 28 / 浏览器发现 | Scatter 缺少 Y 轴 dataKey 导致只显示图例；为每个系列映射数值轴且不改原数据                                                               | 新回归先失败后通过；浏览器显示2个散点，B点点击回传原始 row/index                                        |

最终联合回归：`pnpm test --runInBand components/a2ui lib/a2ui stores/a2ui lib/claude/run-and-capture.test.ts`：**160 suites passed / 2162 tests passed，无跳过**。同时修正了已有分享测试的可选第二参数断言，仍严格核对 payload，没有修改分享生产逻辑。

浏览器验收使用 Chromium、真实 store/context/A2UI adapters/vendored primitives/Recharts。模型、持久化和 catalog 宿主边界用 fixture；catalog 另由静态审查实际打包并在浏览器能力环境验证 schema。已验证：公开 create/components/data 序列 ready=true；Combobox 搜索选择回写；ToggleGroup 禁用；Tabs 外部更新；Collapsible 展开；Sheet open 回写、Escape 关闭与焦点返回；Popover Enter 打开与 Escape 关闭；InputGroup control/addons；FormGroup required 错误、填写及包含当前模型的 submit action；上海日期/时间往返；七种图表 B 行点击回传 index=1。部分 Calendar/datetime/Recharts 操作由浏览器 DOM 事件执行，不能称为所有操作均经过实体鼠标/键盘输入；截图使用简化 fixture 样式，不是整站视觉验收。

配套证据位于本任务 visualization 目录：`a2ui-full-browser.cjs`、`a2ui-full-browser-final.png`、`a2ui-full-browser-verification.md`。日期单元测试另在 UTC/Asia-Shanghai/America-New-York 分别通过21项。未运行 coverage、完整生产 build、真实模型、真实外部 MCP/A2A 对端或 Tauri 验收。

质量检查：改动文件 ESLint、Prettier、diff whitespace、`i18n:build:check`、`lint:i18n`、`i18n:sort:check` 通过；`sidecar:typecheck` 单独通过。test-gap/i18n/wiring/PII/static-export 审查已执行，审查发现的本轮回归已补修。最终全仓 `lint` 通过；此前范围外 lint 问题在共享树更新后已消失，未计入本轮修复。最终全仓 `typecheck` 仍有未修改的 `permission-api.test.ts:531` 一处错误（`true` 与 permission union 不兼容）；全仓 `lint:static-export` 仍由未修改的 `lib/browser/extension-engine.ts:450` Node 导入阻塞，不能称为全仓门禁全绿。

范围界限：本轮完成现有缺陷修复批次。起始示例不是所有可选 props 的完整 schema；完整标准组件 contract/编辑器元数据生成仍有后续建设空间。官方 v0.9.1 互操作、Basic Catalog 完整行为与 v1.0 Candidate 仍是下述独立新增能力，尚未实现。ACP sniffer 的校验已修正，但它原本没有 runtime consumer；此次没有接入新的 ACP transport，不能声称真实 ACP 路径已验收。无提交、推送或部署。

## 结论与决策建议

建议继续加强现有实现，将工作拆成 **现有行为修复、组件契约统一、官方 v0.9.1 互操作、按场景补齐组件、v1.0 候选版实验** 五条有顺序的工作线。

现状不能用“68 个组件已经注册”判定适配完整。此次发现的主要问题是：已注册组件的受控状态和禁用行为不完整、模型没有获得完整组件契约、消息入口校验不同、捕获快照与真实 store 的语义分叉，以及 AI 编辑和 MCP 生命周期中的数据/可见性问题。先修这些，收益高于替换 renderer 或继续扩展组件数量。

官方版本也已变化：**v0.9.1 是当前生产规范，v1.0 是 Candidate**。Cognia 自定义格式既不等同于官方 v0.9，也不会通过改版本号自动获得新版兼容。官方 Basic Catalog、Cognia 扩展 catalog、shadcn primitives 是三种不同的目录，必须分别审计。

## 证据与配套报告

- Cognia 源码基线：`07eb0d44b5567f815bbdf70bcb7693f518a9a38d`。共享工作树有其他并发修改；本次保留这些修改，结论描述检查时的源码，不代表线上已部署行为。
- 官方 A2UI 固定于 [`ba4c47baba5663037217f107d5bcc51f6d35c536`](https://github.com/a2ui-project/a2ui/commit/ba4c47baba5663037217f107d5bcc51f6d35c536)。完整版本、schema 差异和 24 次 Ajv 判定见 [官方协议校对](2026-10-20-a2ui-official-version-delta.md)。
- 本地 shadcn primitives、68 个 A2UI 类型和行为问题的完整对应表见 [shadcn 适配审计](2026-10-20-a2ui-shadcn-adaptation-audit.md)。
- 核心入口、快照、编辑和生命周期探针结果见 [机器可读结果](2026-10-20-a2ui-core-runtime-probes.json)。探针执行真实入口代码和从源码提取的 reducer/accumulator，替换了持久化、历史记录和传输等外部设施；不冒充完整浏览器或真实模型验收。
- 此前的 OpenUI 比较见 [替换评估](2026-10-20-cognia-a2ui-openui-comparison.md)。本报告依据后续研究，将当前工作方向明确为加强现有实现。

## 1. 官方版本需要校正哪些认识

| 项目                    | 当前准确结论                                                                               | Cognia 应对                                    |
| ----------------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------- |
| v0.9                    | Previous Stable                                                                            | 保留来源兼容；不再作为“最新规范”               |
| v0.9.1                  | Current production，规范 closed                                                            | 正式互操作首选基线；固定 schema commit/hash    |
| v1.0                    | Candidate，原 v0.10 draft                                                                  | 独立开关和测试集，不修改 legacy 语义           |
| SDK/MCP bridge 软件版本 | 与协议版本独立                                                                             | `A2UI_BRIDGE_VERSION = 0.9.0` 不能当作兼容声明 |
| v0.9 → v0.9.1           | 主要统一 MIME 为 `application/a2ui+json`、放宽活动 surface 唯一性；schema 接受 v0.9/v0.9.1 | 变化不大，现有互操作缺口早于这次更新           |
| v1.0                    | 新 `@path/@call` directive、数据删除语义、混合 catalog、双向函数 RPC 等                    | 不是小幅字段更名，需独立适配和执行边界         |

来源：[官方状态](https://a2ui.org/)、[v0.9.1 evolution guide](https://github.com/a2ui-project/a2ui/blob/ba4c47baba5663037217f107d5bcc51f6d35c536/specification/v0_9_1/docs/evolution_guide.md)、[v1.0 evolution guide](https://github.com/a2ui-project/a2ui/blob/ba4c47baba5663037217f107d5bcc51f6d35c536/specification/v1_0/docs/evolution_guide.md)。

特别注意：官方首页对 v1.0 的简短摘要已经落后于固定提交的规范/schema。首页仍提及 `actionResponse`、`theme → surfaceProperties`，而实际 schema 使用 `callRendererFunction/rendererFunctionResponse` 和 `callAgentFunction/agentFunctionResponse`，并移除 theme，没有声明 surfaceProperties。实现必须固定具体 schema，不能根据首页摘要设计字段。[v1.0 agent-to-renderer schema](https://github.com/a2ui-project/a2ui/blob/ba4c47baba5663037217f107d5bcc51f6d35c536/specification/v1_0/json/agent_to_renderer.json)

官方 Basic Catalog 两版都有 18 个组件和 14 个函数。当前 Cognia 的 Checkbox、Select、Dialog、Button 等即使名称近似，仍与官方 CheckBox、ChoicePicker、Modal、Button 的 props/children/action 结构不同。增加 envelope 解析只是第一步，不能单独宣称 Basic Catalog 完整兼容。[官方 Basic Catalog](https://github.com/a2ui-project/a2ui/blob/ba4c47baba5663037217f107d5bcc51f6d35c536/catalogs/basic/v1/catalog.json)

## 2. 初始审计发现的核心缺口（当前修复状态见上）

以下 P1/P2 表示后续修复优先级。探针是在隔离设施中复现的源码行为；真实 UI/模型/外部 agent 流程仍须在修复验收时运行。

| 编号 / 优先级 | 触发与实际结果                                                                                                                                                             | 源码证据                                                                                                                                                         | 修复方向与验收                                                                                                                                          |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CORE-01 / P1  | AI 只修改组件、不更新数据时，capture 从空模型开始并返回 `{}`；toolbar 以 `merge:false` 用它覆盖完整旧模型。探针中的 `name/draft` 全部消失                                  | `lib/claude/run-and-capture.ts:224`；`components/a2ui/workspace/a2ui-toolbar.tsx:145-154`；`lib/a2ui/ai-generate.ts:288-317`                                     | edit 返回明确 patch 或基于旧 surface 的完整结果；不得将未知/未更新数据解释为清空。真实编辑已填写表单，改变标题后所有值必须保留                          |
| CORE-02 / P1  | standalone MCP 的 create → components → data 序列已包含有效 root，但 `ready` 仍为 false；surface 组件据此显示 preparing。五个 MCP tools 没有 ready 操作                    | `stores/a2ui/a2ui-store.ts:493-520,582-625`；`components/a2ui/a2ui-surface.tsx:123`；`lib/a2ui/mcp-tool-schemas.ts:60`；`sidecar/src/tools/a2ui/tool-defs.ts:37` | 将“root 可呈现”与“transport turn 完成”分开；保留 legacy ready 输入兼容。外部 MCP agent 只使用公开工具即可显示 surface；分批 child/data 到达时可渐进显示 |
| CORE-03 / P1  | 同一嵌套数据更新，在 store 深合并保留 email，在 capture 浅合并丢失 email。编辑收尾、IM 投影可能与正在显示的内容不同                                                        | `lib/claude/run-and-capture.ts:261`；`stores/a2ui/a2ui-store.ts:929-949`；`lib/a2ui/data-model.ts:318`                                                           | 复用同一 operation/reducer 语义；先保持 legacy deep-merge，再另行实现官方 path replacement/delete，不能混成一种 merge                                   |
| CORE-04 / P2  | 首批先出现 label 后出现命名 root app 时，store 选择 app，capture 选择 label；后续 child-only patch 也会改变 capture 的命名 root                                            | `lib/claude/run-and-capture.ts:239-245`；`stores/a2ui/a2ui-store.ts:595-609`                                                                                     | 统一 root 解析与保留规则。无字面 root、child-first、连续 patch、save/replay/IM 提取的 root 必须一致                                                     |
| CORE-05 / P1  | ACP 会转发缺少 surfaceId 的 create；IPC 会转发 components 为字符串的 update；共同 parser 会拒绝同样输入                                                                    | `lib/a2ui/acp-bridge.ts:35-46`；`lib/a2ui/ipc.ts:49-55`；`lib/a2ui/parser.ts:46-67,87-175`                                                                       | 所有不可信输入通过同一版本检测、字段校验、catalog 校验和归一化边界；store 接收可信内部 operation。无效数据不突变状态，并有明确错误回馈                  |
| CORE-06 / P2  | 标准 prompt 仅词法提及 68 个类型中的 20 个，48 个名称未出现；mention 也不代表完整 API 文档。自定义 catalog prompt 主要补充类型名；MCP component schema 只要求 id/component | `lib/a2ui/prompts.ts`；`lib/a2ui/agent-catalog-prompt.ts:16-29`；`lib/a2ui/mcp-tool-schemas.ts:28-37`                                                            | 从实际组件契约生成按任务/agent 裁剪的模型描述和校验 schema，不能一边增加 wrapper 一边依赖模型猜字段。词法统计不表示模型绝对不能使用未提及类型           |
| CORE-07 / P2  | catalog 接口允许 schema，但 validateComponent 仅检查 id、type、是否注册，没有执行组件级 schema                                                                             | `lib/a2ui/catalog.ts:473-502`                                                                                                                                    | 合并组件 contract、运行时校验、编辑器字段/引用元数据和模型描述的来源；对插件扩展保持注册边界，避免新增另一套平行 registry                               |

CORE-02 的范围是直接 bridge dispatch 路径。简化 JSON parser、模板、插件等路径会合成 `surfaceReady`，不能把它扩大为“所有 A2UI 均无法显示”。CORE-05 证明入口校验不一致，不代表本轮完成了跨用户攻击或安全漏洞利用验证。

CORE-06 还有比“没有列出名字”更直接的契约错误：标准 prompt 教模型使用 `Alert.description`、`Table.rows`、`Chart.type/options`，实际 renderer 读取 `message`、`data`、`chartType/xKey/yKeys`。这些内容应在第一批修复，而不必等待完成 schema 收敛。来源：`lib/a2ui/prompts.ts:92,105-107` 和对应 Alert/Table/Chart renderer；详见组件审计 S06。

另一个需要纳入批次 B 的源码事实：`types/a2ui/schema.ts` 与 `types/artifact/a2ui.ts` 是两个实质重复的类型定义源，并非简单 re-export。TypeScript AST 盘点分别有 91、126 个 interface/type declarations；前者独有 4 个 connector/dispatch 定义，后者独有 39 个扩展组件/模板定义，共享的 `A2UIComponentType` 和 `A2UIComponent` unions 也不同。应先盘点消费者，再收敛公共定义和兼容导出；不能直接删除任一文件或把两套不同 union 当成同一份完整契约。

额外需在实施时确认：AI streaming patch 若已作用于画布而 turn 随后失败，应当回滚、保留草稿还是明确标记部分结果；当前“失败后保持原内容”的文案/测试不能代替真实部分失败验收。surface owner/session 与全局 ID 的关系也需要明确，但本轮不将其直接定性为已证实的权限漏洞。

## 3. shadcn 适配的完整性要分五层

1. **已有 primitive 是否有产品需要的 A2UI 表达。** 独立 wrapper、组合复用和宿主内部 helper 必须分别记录。
2. **props 与 children 契约是否完整。** 不是透传全部 React props，而是把模型可用的受控能力、引用关系和限制定义清楚。
3. **绑定和动作是否真实闭环。** 读取 dataModel、用户修改、回写路径、外部更新、disabled、validation、submit 都要有实际行为证据。
4. **编辑/生成/持久化是否一致。** renderer 能显示，不等于模型知道如何生成，也不等于属性面板能编辑或旧 surface 能恢复。
5. **底层 API 与版本是否匹配。** 本地 Combobox 来自 Base UI，Tabs/Sheet/ToggleGroup 等来自 Radix。不能把所有组件都按旧版 Radix 模式拼接。

此次已复现的例子包括：Combobox 缺少本地 primitive 的 Popup/Content 组合且 disabled 不生效；ToggleGroup disabled 后仍可写数据；Sheet 的 open path 无法通过 trigger 正确回写；Tabs 外部 activeTab 更新后仍选择旧页；Collapsible 的 open path 更新不驱动展开。FormGroup 也存在创建 form hook 但没有将提交/字段注册连接到 children 的源码缺口。完整证据、范围和断言见配套审计。

本地清单为 **71 个顶层生产 UI `.tsx` 文件、68 个 A2UI catalog/renderer 类型、68 个插入 factory cases**。71 个文件分为 44 个直接复用、7 个能力候选、2 个组合、1 个组合缺口、2 个替代实现、4 个宿主 helper 和 11 个图标 helper。7 个能力候选是 `alert-dialog`、`command`、`contribution-graph`、`kbd`、`menubar`、`navigation-menu`、`resizable`，是否新增要按实际需求决定。`field` 是当前组合缺口；`chart` 和 `native-select` 不宜简单计为产品能力完全缺失。

日期处理也应提前修复：Asia/Shanghai 下 date-only 选中 `2026-10-20`，当前 `toISOString().split('T')[0]` 会生成 `2026-10-19`；datetime-local 12:00 写成 ISO 后再按字符串切片恢复会显示 04:00。这里是源码加确定性 Date 运算探针，不是完整 Calendar 点击验收。详细字段、时区和测试范围见组件审计 S10。

当前 shadcn 官方目录也已增加 Code Block、Trace 等条目，但这些条目不应自动成为 A2UI 暴露清单。部分能力已有 Markdown、RichOutput 或 AI Elements 实现；新增独立节点必须有真实使用场景，并说明与现有组件的关系。[当前官方目录](https://ui.shadcn.com/docs/components)、[当前 Base UI Combobox 组合](https://ui.shadcn.com/docs/components/base/combobox)

## 4. 建议保留的架构与新增边界

```text
legacy JSON / MCP / ACP ─ legacy validator ───────┐
official v0.9.1 ─ schema + catalog normalizer ───┼─ shared operations ─ surface/store/editor
official v1.0 ─ candidate gate + adapter ────────┘                  └─ IM/plugin/workflow
                                                   component contracts
                                                schema / prompt / editor metadata
```

这不是另建一个 UI 引擎。优先扩展 `lib/a2ui/catalog.ts` 及现有定义/属性/引用模块，抽取真正共享的 operation 语义，让 renderer、capture、IM 和持久化复用。旧格式继续按 legacy 解释；协议版本、catalog 版本和存储格式版本分别记录。

官方入口必须保留自己的语义：`updateDataModel` 的 path 节点替换、scalar/array、删除、相对绑定和函数不能降格成 `data + merge`。v0.9.1 的 literal null 与 v1.0 的 null-delete 不能共用无版本逻辑。未知 catalog 在官方入口应明确拒绝或协商，不能静默落到 Cognia 默认组件。

组件 contract 应明确模型参数、默认值、约束、动态值支持、子引用 slots、事件/回写、可访问性和宿主权限。JSON import 校验较严格的安全/引用规则可以复用，但 streaming 中尚未到达的 child 与最终导入文件缺失引用不同，不能机械套用完整 tree 校验。

## 5. 分批实施建议与验收

| 批次                | 工作内容                                                                                                 | 必须验证的行为                                                                                                                                               |
| ------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A：先修现有功能     | CORE-01/02/03/05；错误 prompt 字段；受控状态、disabled、FormGroup、Combobox、日期时区；失败时的数据保护  | 已填写表单编辑保值；standalone MCP root 可见；capture/store 数据和 root 一致；所有入口拒绝非法消息；UI 真实输入、打开关闭、键盘和提交；日期/时刻在多时区往返 |
| B：统一组件契约     | 68 个类型的 props/binding/action/slots 元数据；校验、模型说明、编辑器来源收敛；纠正 replace/upsert 文案  | 每个对外类型均有有效/无效 fixture；模型能获取真实支持列表；编辑器往返不丢字段；插件 catalog 保持可扩展                                                       |
| C：正式 v0.9.1 入口 | 固定官方 schema；envelope 和 catalog 协商；数据操作、动作回程、通用 checks/functions/accessibility       | 官方 fixture 到真实 renderer/action 回程；未知 catalog 明确错误；18 个 Basic 条目的支持范围真实可测；legacy 不回归                                           |
| D：按场景补组件     | 从本地 inventory 中选择独立日期范围、确认对话框、原生选择等有价值缺项；将 helpers/组合节点与独立能力区分 | 一项能力从 model → parser → renderer → editor → save/replay → action 全链路完成，不只增加 registry 名称                                                      |
| E：v1.0 实验        | `@path/@call`、mixed catalogs、inline create、ValidationResult；双向 RPC 单独推进                        | 版本隔离；关联 ID、取消/超时、真实用户激活、允许调用方、工具权限及 PII 出站边界完整，不以候选功能破坏稳定数据语义                                            |

批次 C 中，官方 wire + Cognia catalog 和官方 Basic Catalog 是两个可区分的承诺。可以先声明受支持的 Cognia catalog；只有 Basic 的 props、动态函数、动作和行为均通过验收，才声明 Basic 完整支持。A2A 特定 metadata/header 仅在实际接入 A2A 时实施，不需要为协议升级替换现有 MCP transport。

批次 D 不以覆盖所有上游 primitives 为目标。导航 shell、Direction、布局 helper、可调整编辑面板等可以属于宿主内部；多选/日期范围/确认交互等则可能是有产品价值的模型节点。具体完整分母和优先级见 inventory。

## 6. 原始研究阶段的验证与未完成部分

本轮核心测试通过：

```text
pnpm test --runInBand --runTestsByPath
  lib/a2ui/ai-generate.test.ts
  lib/a2ui/ipc.test.ts
  lib/a2ui/acp-bridge.test.ts
  lib/a2ui/data-model.test.ts
  lib/a2ui/agent-catalog-prompt.test.ts
  lib/a2ui/generate-prompts.test.ts
  stores/a2ui/a2ui-store.test.ts
  lib/claude/run-and-capture.test.ts

Test Suites: 8 passed, 8 total
Tests:       306 passed, 306 total
```

此外，组件审计的 **7 个现有套件、199 项测试通过**，并通过 **7 条真实 primitives 的隔离 DOM 观察**复现相关行为缺口；日期问题使用确定性时区运算另行检查。官方 schema 执行了 **24 次判定**，结果符合报告矩阵。核心探针保留了结果 JSON；没有为了让测试变绿修改任何断言或实现。现有测试通过与新增探针复现缺口同时成立，说明当前测试对相关跨层契约覆盖不足。

未完成且未声称完成：产品修复、正式协议互操作实现、全量组件验收、真实模型生成、完整浏览器/Tauri 流程、真实外部 MCP/A2A 对端、全量测试/typecheck/lint/build/export、coverage。后续代码实施按每批影响运行真实检查；本轮研究不需要用全仓 build 代替已复现的行为证据。
