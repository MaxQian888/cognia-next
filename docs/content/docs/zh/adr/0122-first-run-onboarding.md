---
title: ADR-0122 — 首次运行引导
description: "把首次运行的模态对话框换成一条以「一次真实、肉眼可验证的产出」收尾的全屏流程；记录用户为何中途离开而不只是记录他离开过；用同一条步骤序列服务四种运行语境。"
---

# ADR-0122 — 首次运行引导

**状态**：已接受（2026-08-15）

## 背景

首次运行原本是 `components/shell/onboarding-dialog.tsx` 里一个 597 行的 `AlertDialog`：登录方式 → 选人格 → 六张只读轮播卡。它有三个结构性问题，没有一个是打磨层面的。

**没有首次成功。** 流程终结于一张轮播图和一个空聊天框。用户走完设置时，被**告知**了六个子系统，却一个都没看到。而且轮播是静态的——不管这台机器上 OCR、Computer Use、连接器、数字分身有没有配置，都按同一顺序吹一遍。于是唯一在描述这个产品的那一屏，恰恰是与产品实际状态最脱节的一屏。

**状态只有一个时间戳。** `AppSettings.onboardingDismissedAt` 在每条退出路径上都会写入——跳过、OAuth 成功、选完人格、看完 tour、按 Esc、点击外部——于是「走完了」「第一步就跑了」「误触 Esc」是同一个值。没有续跑，没有部分恢复，事后也说不出比「你曾经关掉过某个东西」更具体的话。

**最强的资产完全不可见。** `lib/agent-migration/probe.ts` 早就能探测已安装的 `claude-code`、`codex`、`opencode`，ADR-0107 也早就能整套导入它们的命令、设置和历史会话。这些全部埋在「设置 → 数据」之后，而首次运行的用户没有任何理由打开那里。`BUILTIN_EXECUTABLE_PRESET_IDS` 里的十四个可执行 runtime 同理。

Multica（`github.com/multica-ai/multica`）解决第一个问题的方式是让流程终结于一个真实完成的 issue：在服务端置备第一个 agent、写好开场白、再由一个内置 skill 驱动首次对话。它有两个承重假设无法照搬。Cognia 是**没有服务端的静态导出**——「服务端拥有 agent 身份，所以客户端无法伪造」在这里没有对应物，也没有 middleware 可以守卫路由。Cognia 也**没有分析后端**，这让 Multica 引导问卷里归因的那一半直接归零。而且 Cognia 没有 workspace 这个对象，它的工作区命名步骤在这里无处映射。

## 决策

一条位于 `/onboarding` 的全屏流程，以一次真实、肉眼可验证的产出收尾。

### 步骤序列

`lib/onboarding/steps.ts` 里的 `ONBOARDING_STEPS` 是「什么步骤出现在什么端」的唯一真相。每一项声明自己适用的语境；其中两步还会在运行时进一步过滤。

```
welcome  →  scan  →  [provider]  →  first-run
                     ↑ 已有可用的模型访问时整步消失
```

| 语境 | welcome | scan | provider | first-run |
| --- | --- | --- | --- | --- |
| Tauri 桌面 | ✅ | ✅ 探测本机 | 条件出现 | 三张卡 |
| 浏览器 | ✅ | ⛔ 无本地 runtime | ✅ | 仅网页卡 |
| 移动 standalone | ✅ + 模式分叉 | ⛔ | ✅ BYOK | OCR + 网页 |
| 移动 paired | ✅ + 模式分叉 | 配对 | ⛔ 借用桌面凭证 | 仅网页卡 |

四种语境被 `lib/onboarding/shell.ts` 归结为一个 `OnboardingShell` 值。真正重要的区分不是「桌面还是手机」，而是**算力在哪**：配对的手机没有本地 runtime 可扫，所以它是独立的一种语境，而不是笼统的「移动端」。

### 扫描步

原样复用 `probeVendors()`，而不是另造一个探测器——「这台机器上装没装 claude-code」在本仓库里已经有一个诚实的答案，有两个就一定会漂移。配置文件存在的 vendor 被报告为已登录，因为这些 CLI 把写配置作为登录的一部分。这是证据而非证明（吊销的 token 会留下文件），所以它所抑制掉的 provider 步，仍然可以从残留提示条回到。

迁移**内嵌执行**，直接调用 `buildMigrationPreview` → `applyMigration`。把用户中途弹去设置页，会让返回路径变得不确定。

阶段判定用两个计时器，不是一个。Multica 最初只用了一个并且不得不修（代码里标了 MUL-5119）：daemon 还在探测时页面已经翻到「没找到 runtime」，用户就跳过了一个再等一秒就会成功的步骤。Cognia 的探测链路**更长**——文件系统探测、可执行文件解析、版本查询——所以同样的假阴性只会更容易发生。软超时给出 5 秒的常规预算，但在确实有工作在飞行中时被抑制；硬超时 20 秒为这种抑制封顶，让卡死的探测仍能收敛。

### 终点步

三张固定卡，每张都满足四条约束：不需要额外授权、除模型调用外可离线、结果肉眼可验证、30 秒内完成。它们展示的是 Cognia 相对普通聊天应用真正多出来的东西——文件系统、OCR、网页阅读。

能力未确认的卡是**隐藏，而不是置灰**。置灰的卡仍然在宣传用户做不到的事，那正是旧 tour 的失败方式外加一层视觉噪音。`starterCardsWithFallback` 保证这一步永远不为空。

用户选哪张卡**本身就是**个性化信号，因此没有问卷。Multica 那份问卷有一半是为了喂养 Cognia 并不存在的归因分析，而且行为信号本来就强于自陈信号。点击一张卡会开一个会话、通过 `queuePendingChatPrompt` 排入它的固定提示词、并把用户送进那个对话——于是首次产出走的是生产环境的发送路径，而不是一条特设通道。

内置 skill `cognia-onboarding` 负责塑造这次对话：不要重复问候、最多问一个问题、这一轮就做完、不要创建任何别的东西。

### 没有服务端时如何防伪造

Multica 把 skill 的身份放在服务端。没有服务端时，替代方案是结构性的，并由 `lib/onboarding/skill.test.ts` 钉死：行 id 由 codegen 出的目录**推导**而非声明；它位于保留命名空间 `skill_builtin_`，只有那份目录会向其中播种；启动期播种会用目录内容覆写该行当前的内容——所以一次直接写入撑不过一次重启。

### 状态

两个**顶层** `AppSettings` 字段，而不是一个嵌套对象。`SETTINGS_SYNC` 对每个顶层 key 只分类一次，嵌套会悄悄地把同一种分类强加给两半。

| 字段 | 分类 | 理由 |
| --- | --- | --- |
| `onboardingProgress` | `device-local` | 手机的引导实质上就是配对流程。同步会让桌面端的完成把一台尚未配对的手机标记为已引导——同时处于「已完成」和「不可用」。 |
| `onboardingProfile` | `shared` | 描述的是这个人，不是这台设备。换设备不该重问。 |

`onboardingProgress.path` 记录一次设置**为何**结束（`completed` / `provider_skipped` / `runtime_skipped` / `task_failed` / `legacy_dismissed`），这正是残留的「完成设置」提示条能说清楚缺了什么、而不是笼统催促的前提。

### 路由守卫

静态导出意味着没有 middleware，所以 `OnboardingGate` 在客户端判定。它位于 `RecoveryBootGate` 之下——应用坏了这件事优先级高于用户是不是新人——并位于各端外壳之上，这样首次运行的设备不会在流程背后先画出聊天工作区。

难点全在「就绪」二字。读取尚未水合的 settings 会让老用户看起来像全新安装；在 Dexie 回答之前读会话数会让有对话的老用户看起来像首次运行。判定被 latch 住：`settings.load()` 会在遗留迁移之后重写这一行，而实时重算会把用户从他已经开始的流程里拽出来。唯一实时读取的是「已结算」（`skippedAt` / `completedAt`）：流程在导航回首页之前才写入它，如果启动时的 "enter" 判定在这次写入之后仍然生效，用户会被立刻弹回 `/onboarding`——所有退出路径都变成空操作。结算是单向、由用户触发的，因此按它放行只会释放用户，永远不会把人拽出流程。

### 存量用户

`migrateLegacyOnboarding` 把旧时间戳投影为 `path: "legacy_dismissed"`，并预先关闭提示条。旧字段的真实意图不可恢复，所以我们不猜：没有人会被重新弹窗，而「设置 → 发现」提供显式的重跑入口。没有这个入口，把某人标记为 `legacy_dismissed` 就等于替他做了决定却不给回头路。

### tour

保留，但移出关键路径——放在「设置 → 发现」，可选。它现在是一份固定的 A2UI `InteractiveGuide` 负载，而不是自制轮播，这让 `components/a2ui/display/a2ui-interactive-guide.tsx` 有了第一个产品作者（它此前已注册进渲染器，却无人使用）。负载是常量而非模型轮次：最需要知道「这东西能干什么」的人，恰恰是跳过了 provider 步、手上一个模型都没有的人。它不发射任何 A2UI 动作——那些动作是派发给 agent 运行时的，而一个无人生成的界面背后没有 agent——所以六个设置深链作为宿主导航渲染在它旁边。

## 影响

- 删除 `components/shell/onboarding-dialog.tsx` 与休眠的 `components/chat/welcome/welcome-a2ui-demo.tsx`，以及两份已经漂移的、决定何时弹出对话框的 `useEffect` 拷贝。
- `app/(mobile-onboard)/welcome` 与 `components/mobile/welcome/` 被吸收进 welcome 步。配对流程本身不变；`/pair` 保留，两个 boot provider 以及 `SURFACE_CONTRACTS` 中原本写 `/welcome` 的地方改为 `/onboarding`。
- i18n 从 `desktop.onboarding.*` 搬到顶层 `onboarding.*`——一条服务四种语境的序列不该顶着 `desktop.` 前缀。
- `lib/db/sessions.ts` 新增 `countSessions()`，让门在启动时只问那一个问题，而不必把所有会话都取出来。
- provider 步原样复用生产环境的 `AddAccountDialog`，与它所替换的对话框一致——凭证界面仍然只有一处。

## 备选方案

**保留模态框，只是放大。** 否决：尺寸从来不是问题。对话框的 Esc / 点击外部依然意味着「永久消失」，而正是这个语义催生了单时间戳的状态模型。

**v1 只做桌面。** 最初的建议，被推翻：状态模型无论如何都要按四种语境设计，之后再补三端等于把同一段序列逻辑再过一遍。代价落在吸收那两条移动端路由上，这也是配对流程本身被完整保留的原因。

**把配对桌面的能力上报给手机。** 暂时否决。companion 握手里的 `capabilities` 是授权范围（`host.admin`、`agent.worker`、`process.spawn`），不是功能开关，所以这需要新建一条 Rust 汇总 → 握手 → TS 缓存的链路。那是本次改动唯一会涉及跨语言的新基础设施，把它绑在流程的关键路径上并不划算——配对的手机拿到那张无依赖的卡。

**加一个问卷步骤。** 否决：它一半的价值来自这里并不存在的归因分析，而用户选的那张卡本来就比自陈的角色更有信息量。
