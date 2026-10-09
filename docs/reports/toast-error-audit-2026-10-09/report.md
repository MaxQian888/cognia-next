# Cognia toast 报错审计 — 2026-10-09

当前主要问题是**后续动作覆盖率低，技术错误 / 批量结果常直接进入短暂 toast**。已解析的固定中文文案大多并不长；多条错误拼接和不受 UI 控制的 runtime message 更值得先处理。

本次只新增审计文件，没有修改业务代码。

## 范围与统计口径

- HEAD: `514a46bf76cb8e7764b4576cee1f998874648327`；分析的是当前 working tree，包括已有未提交改动，不能把 HEAD 单独视为此次源码快照。
- 扫描 app、components、hooks、lib、stores、packages、plugins、services、web 的 10965 个 JS / TS 源文件，文件来源为 Git 清单与 rg 清单的并集。排除测试、stories、mock、fixture、构建输出和 node_modules。
- 用 TypeScript AST 提取调用，区分直接 error / warning、toast[severity]、条件函数别名、custom、插件 host showToast 和通知 / 诊断桥接。Rust 文本搜索命中为注释里的 toast.error，实际 UI 报错通过前端和事件桥接归入此范围；未把 Rust 的所有 Result::Err 都当成 toast。
- 统计是**源码调用点**，不是不同故障种类、真实触发次数或保证活跃的调用链；同一故障可能经过多个调用点，遗留分支也在清单中。
- en / zh-CN 生成词典已通过与 split source 的 freshness 对比。中文预览解析 ICU，避免把 plural 的语法分支误当成用户实际看到的长段文字。动态翻译键按候选范围记录，不能把候选范围所有 key 当成实际错误文案。
- 对所有调用做静态标记，对下文代表案例、按钮目标、系统样式与通知桥接做人工源码核对。没有逐一触发 1,364 个故障或进行浏览器 / 真实设备验证。

| 指标                              | 数量 | 含义                                                                            |
| --------------------------------- | ---: | ------------------------------------------------------------------------------- |
| 直接 toast.error 调用点           | 1364 | 分布在 510 个文件                                                               |
| 直接 toast.warning 调用点         |   79 | 单独收录，避免混入 error 分母                                                   |
| error 调用中显式声明 action       |   11 | 约 0.8%；包含条件提供的按钮，不保证每次有按钮                                   |
| error 调用中存在 description      |  115 | 包含条件展开的 description；分层并不意味着内容短                                |
| runtime detail 候选               |  716 | 含 runtime error / reason / message、字符串化或列表拼接；不等于全部实际为长文本 |
| 直接出现 .message 的 error 调用   |  472 | 可见代码确实读取 message；上游仍可能做过规范化                                  |
| 无法直接解析标题翻译的 error 调用 |  355 | 原始 message、辅助函数、传入翻译器或动态变量；保留源码供人工确认                |

静态分类互斥汇总：含 action **11**，无按钮的 runtime detail 候选 **712**，无上述特征的文字引导候选 **205**，短消息 / 动态待确认 **436**。后三项都是筛查标签，不是人工逐条定级；文字引导关键词与动态翻译候选可能出现误判。所有记录保留源码、翻译键和独立特征，可以重新判定。

A2UI 的 opts、插件通用 toastFn、统一通知 runtime 的 fn 和其它动态桥接另列；不能从“11 个显式 action”推断全应用只存在 11 种有按钮的报错。

## 有明确后续动作的调用点

下面前 11 项覆盖直接 error 调用中所有显式 action 声明，第 12 项是插件 severity 动态分发。

| 场景                             | 已有引导                                            | 动作与限制                                                                  | 源码                                                                                                                                                            |
| -------------------------------- | --------------------------------------------------- | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 下载文件不能直接打开             | 解释原因，并给出替代操作                            | “在文件夹中显示”调用 reveal；失败继续报告                                   | [components/browser/browser-downloads-panel.tsx](/Users/bytedance/Project/cognia-next/components/browser/browser-downloads-panel.tsx:168)                       |
| 发送给 @Agent / Squad 路由不可用 | 标题、原因、修复入口分开                            | 按缺少成员或 Agent 故障打开 squads / agents 设置                            | [components/chat/composer.tsx](/Users/bytedance/Project/cognia-next/components/chat/composer.tsx:4111)                                                          |
| 提示词润色缺少模型               | 明确提示配置模型                                    | 提供 onOpenProviderSettings 时显示设置按钮；另一分支仅文字                  | [components/chat/composer/enhance-button.tsx](/Users/bytedance/Project/cognia-next/components/chat/composer/enhance-button.tsx:93)                              |
| 原生录音权限被拒绝               | 指出要开启麦克风权限                                | 打开系统应用设置；同文件其他权限失败分支并不都有按钮                        | [components/chat/composer/voice-controls.tsx](/Users/bytedance/Project/cognia-next/components/chat/composer/voice-controls.tsx:156)                             |
| 移动端通知权限被拒绝             | 说明在哪里授权、授权后再打开开关                    | 打开系统应用设置                                                            | [components/mobile/me/notification-preferences-section.tsx](/Users/bytedance/Project/cognia-next/components/mobile/me/notification-preferences-section.tsx:121) |
| 插件启用失败事件                 | 业务标题 + 已知错误本地化 + 去重 + 详情             | 跳转到具体插件；未知错误仍原样显示                                          | [components/plugins/plugin-enable-failure-toaster.tsx](/Users/bytedance/Project/cognia-next/components/plugins/plugin-enable-failure-toaster.tsx:57)            |
| 插件启用 / 停用失败              | 同一故障 id 去重、提供详情入口                      | viewDetails 跳转插件页面；description 仍可能很长                            | [hooks/plugins/use-plugin-enable-action.ts](/Users/bytedance/Project/cognia-next/hooks/plugins/use-plugin-enable-action.ts:79)                                  |
| 插件卸载失败                     | 点名插件、提供详情                                  | 跳转对应插件详情；未识别错误仍可透传                                        | [hooks/plugins/use-plugin-uninstall.ts](/Users/bytedance/Project/cognia-next/hooks/plugins/use-plugin-uninstall.ts:132)                                         |
| 全局工作流运行失败               | 复用进度 toast id，标题短，带实际运行链接           | actionFor 带 workflowId 和 runId 跳转                                       | [components/workflow/runs/workflow-run-toaster.tsx](/Users/bytedance/Project/cognia-next/components/workflow/runs/workflow-run-toaster.tsx:66)                  |
| 手动运行任务失败                 | 失败标题 + 运行查看动作；抑制已有任务通知的重复报告 | onOpenRun 存在才有按钮；execution.error 仍完整进 description                | [hooks/scheduler/use-scheduler-item-actions.ts](/Users/bytedance/Project/cognia-next/hooks/scheduler/use-scheduler-item-actions.ts:244)                         |
| SSH 凭据 / 配置问题              | 按原因提示补密码或编辑主机                          | 只有传入 action 的错误分支有按钮；Host key 变化走确认对话框、信任后自动重试 | [hooks/terminal/use-ssh-connect.tsx](/Users/bytedance/Project/cognia-next/hooks/terminal/use-ssh-connect.tsx:123)                                               |
| 插件通用错误 / 警告分发          | 生命周期标题、2 秒去重、详情动作                    | toastFn 动态选择 severity，不计入 1,364 个直接 error 调用                   | [components/plugins/plugin-error-toaster.tsx](/Users/bytedance/Project/cognia-next/components/plugins/plugin-error-toaster.tsx:57)                              |

这些按钮多为“进入修复 / 查看详情”，不是 toast 内直接重试。插件错误、SSH 与计划任务虽然有动作，description 依然可能承载技术全文，因此“有动作”和“文案层次好”要分别判断。

## 只有文字引导，但下一步相对清楚

| 场景                        | 已有引导                                           | 改善空间 / 当前上下文                                    | 源码                                                                                                                                                      |
| --------------------------- | -------------------------------------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Lark OAuth 缺少回调地址     | “请先设置回调地址…设置 → 平台连接 → 概览…启动隧道” | 有明确路径，但需要自己导航                               | [components/settings/connections/forms/lark-config.tsx](/Users/bytedance/Project/cognia-next/components/settings/connections/forms/lark-config.tsx:326)   |
| Slack OAuth 缺少公网入口    | 要求启动隧道或配置公网源                           | 知道做什么；没有直接进入隧道 / 公网入口的按钮            | [components/settings/connections/forms/slack-config.tsx](/Users/bytedance/Project/cognia-next/components/settings/connections/forms/slack-config.tsx:256) |
| 导入会话绑定的 Agent 未连接 | 提示重新连接或选择另一 Agent                       | 文字清楚；没有直接打开选择器，result.detail 可追加长文本 | [components/chat/imported-origin-chip.tsx](/Users/bytedance/Project/cognia-next/components/chat/imported-origin-chip.tsx:193)                             |
| 记忆批量操作部分失败        | 给出成功 / 失败数，并保留失败项选中供重试          | 当前页面可继续操作；无需为这种短反馈强塞按钮             | [components/memory/memory-console.tsx](/Users/bytedance/Project/cognia-next/components/memory/memory-console.tsx:356)                                     |
| 旧 SSH 标签页无法重连       | 提示从“+”菜单重新打开已保存主机                    | 路径明确；可进一步加“选择主机”动作                       | [components/terminal/terminal-dock.tsx](/Users/bytedance/Project/cognia-next/components/terminal/terminal-dock.tsx:434)                                   |
| 自动提示词被隐私门禁拦截    | 提示新建普通对话，只提供明确希望发送的内容         | 说明了安全的下一步；无新建对话按钮                       | [components/chat/chat-view.tsx](/Users/bytedance/Project/cognia-next/components/chat/chat-view.tsx:625)                                                   |

“复制失败”“名称不能为空”这类当前页面就能理解和修正的短反馈不必都增加按钮。应优先补充跨页面配置、系统权限、运行诊断的动作。

## 已确认的文本堆积，以及容易膨胀的路径

前三项优先处理：前两项明确把多项结果拼成一条 toast；第三项是后台通知实际走的通知中心分发路径。其它项按内容数量或上游错误长度决定实际展示长度，不能称为每次都很长。

| 场景                           | 当前表现                                                                                       | 建议后续动作 / 承载位置                                                | 源码                                                                                                                                                                                    |
| ------------------------------ | ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MCP 批量导入失败               | 把每个 name: error 用换行拼成一条 error toast；随后仍发 success 汇总并关闭对话框               | 高优先级：toast 只报失败数量；保留结果面板，列每项错误并允许重试失败项 | [components/settings/mcp/mcp-transfer-dialog.tsx](/Users/bytedance/Project/cognia-next/components/settings/mcp/mcp-transfer-dialog.tsx:98)                                              |
| Router Fusion 覆盖配置校验失败 | 把全部 issues.map(issueText).join(" ") 塞入 saveRefused；无按钮                                | 高优先级：将每个校验问题挂到对应字段；toast 只说未保存                 | [components/settings/provider/routing/router-fusion-action-catalog.tsx](/Users/bytedance/Project/cognia-next/components/settings/provider/routing/router-fusion-action-catalog.tsx:146) |
| 后台计划任务失败通知           | centerNotify 只传 title/body/sourceRef，没有 actions / href；error body 拼完整 execution.error | 高优先级：任务 / 运行详情动作 + 简短错误摘要；技术全文保留在持久详情   | [lib/scheduler/notification-integration.ts](/Users/bytedance/Project/cognia-next/lib/scheduler/notification-integration.ts:115)                                                         |
| 删除作为多个变体基础的智能体   | 把所有 variantNames.join(", ") 插入标题；其它分支直接 err.message                              | 列表可膨胀：toast 报依赖数量，详情列出变体并提供解除关联入口           | [components/settings/characters-section.tsx](/Users/bytedance/Project/cognia-next/components/settings/characters-section.tsx:464)                                                       |
| 批量 slash command 失败        | 所有失败命令名 join(", ") 插入同一标题，无动作                                                 | 显示失败数量；命令清单留在当前对话 / 执行结果                          | [components/chat/composer.tsx](/Users/bytedance/Project/cognia-next/components/chat/composer.tsx:2176)                                                                                  |
| 连接器缺少凭据字段             | 所有 missing 字段 join(", ")；字段名列表与修复位置没有关联                                     | 把错误贴到缺少的字段上，并定位 / 聚焦首个字段                          | [components/settings/connections/forms/plugin-connector-config.tsx](/Users/bytedance/Project/cognia-next/components/settings/connections/forms/plugin-connector-config.tsx:105)         |
| Twin cron 表达式无效           | 把所有 invalidExpressions 用分号拼入 toast                                                     | 每个 cron 输入显示自身问题；toast 给保存 / 同步状态                    | [components/twin/twin-cron-card.tsx](/Users/bytedance/Project/cognia-next/components/twin/twin-cron-card.tsx:81)                                                                        |
| 编辑器工作流运行失败           | runFailed + result.error.message 放进标题；同文件多条直接 err.message                          | 运行详情 / 节点内错误承载技术文本；toast 给查看运行入口                | [components/workflow/editor/canvas.tsx](/Users/bytedance/Project/cognia-next/components/workflow/editor/canvas.tsx:522)                                                                 |
| 运行列表启动工作流失败         | runFailed + execution.result.error.message，没有详情动作                                       | 在已有运行记录处呈现错误，并给跳到运行的入口                           | [components/workflow/runs/run-list.tsx](/Users/bytedance/Project/cognia-next/components/workflow/runs/run-list.tsx:180)                                                                 |
| 外部 Agent 连接失败            | 标题短，但 description 原样接 (error as Error).message；没有动作                               | 按诊断原因提供连接配置 / 认证 / 日志动作；长文本进入详情               | [components/settings/agent/external-agent-settings.tsx](/Users/bytedance/Project/cognia-next/components/settings/agent/external-agent-settings.tsx:368)                                 |
| MCP 测试失败                   | 把 name 与完整 result.error 合进翻译标题                                                       | 标题保持业务摘要；当前测试区域给诊断详情与重试                         | [components/settings/mcp/mcp-server-detail.tsx](/Users/bytedance/Project/cognia-next/components/settings/mcp/mcp-server-detail.tsx:126)                                                 |
| 项目文件保存失败               | saveFailed 直接插入 String(error)；同文件多个位置复用此模式                                    | 保留文件与未保存状态；toast 提供重试或定位文件，细节留在编辑器         | [components/editor/project/project-editor-workbench.tsx](/Users/bytedance/Project/cognia-next/components/editor/project/project-editor-workbench.tsx:749)                               |
| 统一诊断通知映射               | diag.message 无摘要直接成为 body；runtime 又把整个 rec.body 作为 description                   | 保留现有持久化、去重和真实动作；toast 摘要与全文展示分开               | [lib/diagnostics/notification-mapping.ts](/Users/bytedance/Project/cognia-next/lib/diagnostics/notification-mapping.ts:96)                                                              |
| 插件错误文案转换               | 已知模式变成中文；未知模式直接返回 classified.message                                          | 不能只因“有查看详情”就判文案也完善：未知技术错误仍要限于摘要           | [hooks/plugins/use-plugin-error-message.ts](/Users/bytedance/Project/cognia-next/hooks/plugins/use-plugin-error-message.ts:114)                                                         |

## 短但没有足够引导的报错

- [components/share/my-shares-panel.tsx](/Users/bytedance/Project/cognia-next/components/share/my-shares-panel.tsx:57)：统计 / 续期失败只给 statsError / renewError。文案简短，但 toast 未带重试动作。
- [app/a2ui/page.tsx](/Users/bytedance/Project/cognia-next/app/a2ui/page.tsx:364)：多条 generationFailed / deleteFailed / importFailed。已告诉操作失败；下一步主要依赖当前页面原有控件。
- [components/workflow/library/workflow-create-dialog.tsx](/Users/bytedance/Project/cognia-next/components/workflow/library/workflow-create-dialog.tsx:67)：正常 Error 分支原样 message；兜底 t("create") 是操作词，更应独立核对错误语义。
- [components/inbox/adapter-health-badge.tsx](/Users/bytedance/Project/cognia-next/components/inbox/adapter-health-badge.tsx:67)：重连不可用时仅提示“运行时未注册该适配器”，没有连接配置入口。

此类问题与长文本不同：需要补“为什么 / 怎样继续”，不是单纯压缩字数。完整对应清单见 inventory.csv 的 short-or-unresolved 分类。

## 通知系统和样式目前能做什么

- [lib/notifications/runtime.ts](/Users/bytedance/Project/cognia-next/lib/notifications/runtime.ts:191)：普通通知把 title 与完整 body 映射为 toast；只有 rec.actions[0] 能变成 toast 按钮。href / sourceRef 自身不会自动产生此按钮。
- [lib/notifications/functional-toast/registry.ts](/Users/bytedance/Project/cognia-next/lib/notifications/functional-toast/registry.ts:17)：功能卡片目前只匹配 pet-scheduled-due + task 的特定提醒；不能把它算作通用错误 toast 已有的诊断卡片。
- [components/error/diagnostic-notifier.tsx](/Users/bytedance/Project/cognia-next/components/error/diagnostic-notifier.tsx:43) 与 [lib/diagnostics/notification-commands.ts](/Users/bytedance/Project/cognia-next/lib/diagnostics/notification-commands.ts:95)：已有可执行的设置、日志、重载、导出日志、复制安装命令、重启 sidecar、复制报告、提交问题等动作。映射时丢弃无执行器的动作，避免空按钮；未接入诊断管线的直接 toast.error 不会自动获得这些能力。
- [lib/diagnostics/surface-router.ts](/Users/bytedance/Project/cognia-next/lib/diagnostics/surface-router.ts:102)：已有 watched inline、级联归并、持久 badge / center 等分面策略；直接 Sonner 调用不会自动经过它。DiagnosticNotifier 在 [components/runtime/app-runtime.tsx](/Users/bytedance/Project/cognia-next/components/runtime/app-runtime.tsx:427) 挂载。
- [components/a2ui/display/a2ui-toast.tsx](/Users/bytedance/Project/cognia-next/components/a2ui/display/a2ui-toast.tsx:33)：actionLabel + action 可以动态构造 opts.action；静态 call 的 toast.error(message, opts) 应标为需要追踪选项，不能武断归为无按钮。
- [lib/plugin/core/context.ts](/Users/bytedance/Project/cognia-next/lib/plugin/core/context.ts:735)：插件 host showToast 的 message 直接进入 Sonner，接口只给 message/type，没有该调用形状下的 action。与可以带 action 的 notifications plugin bridge 是两条不同入口。
- [app/globals.css](/Users/bytedance/Project/cognia-next/app/globals.css:5145)：已给 toast 加 40dvh 的最大高度，内容区 max-height 与 overflow-y:auto，长 token 自动换行。这解决撑屏和溢出，不会把技术全文转成简短业务摘要，也不会补后续动作。

## 按目录排序的全量分布

计数仅包含直接 error；runtime 列为候选特征，可与 action 重叠。settings 的错误调用最多，且这些直接调用没有显式 action 声明。

| 目录                                 | error 调用 | runtime detail 候选 | 显式 action |
| ------------------------------------ | ---------: | ------------------: | ----------: |
| components/settings                  |        496 |                 281 |           0 |
| components/chat                      |        136 |                  36 |           3 |
| components/mobile                    |         81 |                  44 |           1 |
| components/workflow                  |         55 |                  32 |           1 |
| components/agent                     |         51 |                  28 |           0 |
| components/browser                   |         45 |                   7 |           1 |
| components/plugins                   |         40 |                  33 |           1 |
| components/skills                    |         29 |                  23 |           0 |
| components/a2ui                      |         24 |                   1 |           0 |
| components/issues                    |         24 |                  16 |           0 |
| hooks/chat                           |         19 |                   6 |           0 |
| components/inbox                     |         18 |                   9 |           0 |
| app/scheduler                        |         15 |                   7 |           0 |
| components/desktop                   |         12 |                   8 |           0 |
| components/editor                    |         12 |                  11 |           0 |
| app/me                               |         11 |                   6 |           0 |
| components/logging                   |         11 |                   3 |           0 |
| components/workspace                 |         11 |                  11 |           0 |
| hooks/git                            |         11 |                   2 |           0 |
| components/servers                   |         10 |                   7 |           0 |
| components/account                   |          9 |                   9 |           0 |
| components/scheduler                 |          9 |                   6 |           0 |
| components/shell                     |          9 |                   6 |           0 |
| components/terminal                  |          9 |                   5 |           0 |
| components/twin                      |          9 |                   7 |           0 |
| hooks/bots                           |          9 |                   2 |           0 |
| hooks/global-search                  |          9 |                   7 |           0 |
| app/a2ui                             |          8 |                   0 |           0 |
| components/discover                  |          8 |                   8 |           0 |
| components/memory                    |          8 |                   1 |           0 |
| hooks/devices                        |          8 |                   8 |           0 |
| components/context-workbench         |          7 |                   3 |           0 |
| components/connectors                |          6 |                   2 |           0 |
| components/data                      |          6 |                   4 |           0 |
| components/onboarding                |          6 |                   4 |           0 |
| components/project-coordinator       |          6 |                   5 |           0 |
| hooks/skills                         |          6 |                   3 |           0 |
| components/artifacts                 |          5 |                   0 |           0 |
| components/pet                       |          5 |                   2 |           0 |
| components/providers                 |          5 |                   3 |           0 |
| components/router-fusion             |          5 |                   5 |           0 |
| components/templates                 |          5 |                   4 |           0 |
| components/devices                   |          4 |                   2 |           0 |
| components/goal                      |          4 |                   4 |           0 |
| components/labels                    |          4 |                   3 |           0 |
| components/performance               |          4 |                   4 |           0 |
| components/squads                    |          4 |                   1 |           0 |
| hooks/companion                      |          4 |                   4 |           0 |
| hooks/plugins                        |          4 |                   3 |           2 |
| components/error                     |          3 |                   0 |           0 |
| components/observability             |          3 |                   1 |           0 |
| components/share                     |          3 |                   0 |           0 |
| components/source-control            |          3 |                   1 |           0 |
| hooks/browser                        |          3 |                   2 |           0 |
| hooks/data                           |          3 |                   3 |           0 |
| hooks/files-library                  |          3 |                   0 |           0 |
| hooks/project-coordinator            |          3 |                   2 |           0 |
| hooks/use-biometric-policy-update.ts |          3 |                   1 |           0 |
| lib/skills                           |          3 |                   3 |           0 |
| app/page.tsx                         |          2 |                   0 |           0 |
| app/share-target                     |          2 |                   0 |           0 |
| components/app-shell-mobile.tsx      |          2 |                   1 |           0 |
| components/canvas                    |          2 |                   0 |           0 |
| components/capture                   |          2 |                   2 |           0 |
| components/files-library             |          2 |                   0 |           0 |
| components/sites                     |          2 |                   1 |           0 |
| components/thread-handoff            |          2 |                   0 |           0 |
| hooks/codeserver                     |          2 |                   1 |           0 |
| hooks/files                          |          2 |                   2 |           0 |
| hooks/scheduler                      |          2 |                   1 |           1 |
| hooks/terminal                       |          2 |                   2 |           1 |
| hooks/workspace                      |          2 |                   1 |           0 |
| app/servers                          |          1 |                   1 |           0 |
| app/workflows                        |          1 |                   1 |           0 |
| components/agent-runs                |          1 |                   0 |           0 |
| components/connectivity              |          1 |                   0 |           0 |
| components/support                   |          1 |                   0 |           0 |
| hooks/sites                          |          1 |                   1 |           0 |
| hooks/squads                         |          1 |                   1 |           0 |
| hooks/use-camera-recovery.ts         |          1 |                   0 |           0 |
| lib/files                            |          1 |                   1 |           0 |
| lib/plugin                           |          1 |                   1 |           0 |
| lib/scheduler                        |          1 |                   0 |           0 |
| lib/tts                              |          1 |                   0 |           0 |

## 推荐处理顺序

1. MCP 批量导入、Router Fusion 多字段校验、后台 Scheduler 失败通知：先消除整批错误 / 技术全文进入短暂 toast 的明确路径，并提供持久详情或字段定位。
2. Agent / MCP / OAuth / 系统权限：能明确推导修复位置的报错，补一个真正定位到配置或详情的动作；沿用已有诊断动作与通知中心能力。
3. 工作流与项目文件：业务摘要放 toast，具体节点 / 文件错误留在原上下文，带查看 / 重试入口。
4. 其余低风险短反馈按具体用户路径判断，避免给每个“复制失败”机械加按钮。

建议规范：**短业务标题 + 最多一句可执行指导 + 一个具体动作**。多条问题、堆栈、HTTP / provider 技术正文、失败列表保留在可持续查看的详情或当前字段，toast 提供摘要和入口。这里是审计建议，未实施改动。

## 附件与核对

- [inventory.csv](./inventory.csv)：直接 error / warning / custom 和其它可能报错的动态 Sonner 调用，含完整 source 表达式、翻译、action 与 detail 特征。
- [error-calls.md](./error-calls.md)：逐调用点的可浏览索引，按目录归组。
- [inventory.json](./inventory.json)：全部 Sonner 调用及通知 / 诊断 / 插件 host 桥接；不把不同分发层简单相加成故障总数。
- [bridges.md](./bridges.md)：桥接与动态通知调用逐项源码清单；含非错误调用以便完整追溯，需按 levelExpression / source 判断。
- [source-hashes.json](./source-hashes.json)：审计读取的相关源码和词典 hash。
- [scan.cjs](./scan.cjs)：可重跑静态提取（在仓库根运行 rtk proxy node docs/reports/toast-error-audit-2026-10-09/scan.cjs）。

已检查：AST 清单完整性与代表源码行、11 个显式 action 及其动作实现、普通通知与诊断执行器、全局 toast 样式、i18n split freshness。只读源码审计，不声称 UI / E2E / 真实错误复现已通过。

验证结果：[verification.json](./verification.json) 记录 1453 个 toast 调用源码位置匹配、2309 个相关源码 / 词典 hash 无漂移、互斥分类总数等于 1364；i18n freshness en / zh-CN 均通过。
