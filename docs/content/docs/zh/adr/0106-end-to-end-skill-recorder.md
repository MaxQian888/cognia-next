---
title: ADR-0106 — 端到端技能录制器
description: "预检、限定范围捕获、仅追加的本机产物、结构化复核、可预览的生成、以禁用态保存并做受控试运行。"
---

# ADR-0106 — 端到端技能录制器

**状态**：已接受（2026-08-01）

## 背景

`cognia-skill-recorder` 此前只是一个演示。`/record-skill` 打开一个插件弹窗，只有「开始」和「停止并生成」两个按钮；后者直接把轨迹发给模型，并保存为**已启用**的技能。没有预检、没有范围、没有暂停、没有复核、没有恢复、没有出处、也没有试运行。原生侧把一切放在内存里，`record_cancel` 会删除捕获目录，`record_stop` 在读取观测结果之前就 abort 了 drain 任务——静默丢掉最后一段按键，而 `record_start` 完全绕过 `dispatcher::run_gated`：它会弹出同意窗，却从不面对白名单、等级策略与审计环。

录制器会看到用户所做的一切。因此这是唯一一个「合理默认值」不足以作为答案的子系统：捕获什么、什么离开本机、之后又打开了什么，都必须是用户做出并且看得见的决定。

本决策扩展 [ADR-0020](/docs/zh/adr/0020-computer-use-completeness)（自动化闸门与紧急停止），并复用 [ADR-0003](/docs/zh/adr/0003-employee-digital-twin) 的 PII 闸门。

## 决策

### 流程

一台权威状态机——`setup → preflight → recording ↔ paused → stopping → review → generating → draft → saving → saved`，外加从任意阶段都合法的 `interrupted`。四个入口（技能工具栏、命令面板、`/record-skill`、可配置的 `skills.record` 快捷键，默认 `Ctrl+Alt+R`，仅桌面）都向同一个全局 store 派发 `OPEN`。非空闲阶段的 `OPEN` 只抬起 Sheet 而不改变阶段：这就是「重新接入而非重复开启」，由 reducer 保证，而不是靠 UI 自律。

Sheet 挂载在应用根部而非技能面板——四个入口中有三个可在任意路由触发。捕获过程中关闭面板只是隐藏；录制进行时的主界面是 420×56 的悬浮控制条。控制条被排除在录屏之外（`set_content_protected`，在 NSPanel 转换之后与每次显示时重新断言，Windows 上还有 `GetWindowDisplayAffinity` 后置检查与 `WDA_MONITOR` 回退），并且**在构造上不可关闭**：其 capability 文件不含 `core:window:allow-close` 与 `allow-hide`，permission 文件不含 `record_start` 及整个产物读取面。两处遗漏都由 `include_str!` 测试钉死。

### 准入先于一切

`admission_check` 是纯函数且顺序固定：紧急停止 → 自动化已禁用 → 平台不支持 → 插件未安装 → 插件已禁用 → 授权缺失 → 已在录制 → 存储。它在闸门调用**之前**执行，因此拒绝永远不会先弹出同意窗。随后 `record_start` 经由 `run_gated`，`process_name` 与 `window_title` 由所选范围推导；`Call::forces_per_call()` 使 `Whitelist` 等级无法自动放行一个全局输入钩子。`ConsentPrompt::is_one_shot()` 阻止会话授权形成：对录制器而言，「不再询问」不是一件能事先有意义地授予的事。

### 捕获有范围，产物仅追加

`CaptureScope` 为 `Window | Application | Desktop`，以三个并列选项呈现，而不是藏进高级设置。由于 `Window` 与 `Application` 带有身份字段，这个选择是「种类**加目标**」：`record_list_capture_targets` 枚举实时窗口列表（排除 Cognia 自身窗口，聚焦窗口排在最前），`scopeForSelection` 再据所选目标构造范围。选了种类却没有目标时返回 `null`，无法开始录制——既不会被悄悄放宽为整个桌面，预检重试同样不会。`ScopeBinding::decide` 是纯函数；由于操作系统会回收窗口 id，每次捕获都按 `(pid, app_name)` 重新校验窗口身份。**按键序列没有光标位置，因此按焦点 pid 而非鼠标定范围**——否则当被限定的窗口正好位于指针之下时，在密码管理器里输入的内容就会被捕获。范围外的动作生成一个没有元素、没有截图的步骤，渲染端只显示聚合计数。

产物位于 `<data_dir>/cognia/recordings/<recordingId>/`：不可变的 `manifest.json`、仅追加的 `journal.jsonl`、以及 `assets/<assetId>.png`。**撤销是墓碑，永不截断**；`replay` 是纯折叠，末行撕裂被丢弃而非致命。`AssetId`/`RecordingId` 只解析规范 UUID，这是路径穿越的第一道防线，其后还有规范化前缀的再次断言。配额（单次 60 分钟 / 500 步 / 250 MiB，全局 2 GiB，整数 80% 预警）在写入截图**之前**校验。

### 敏感输入失败即关闭

`SecureState` 为 `Plain | Secure | Unknown`，且 `Unknown` 在所有调用点都按 `Secure` 处理。状态在按键序列开始时以及每次按键时采样，任一次采样为安全态就使整段成为 `Sensitive`——它不携带值、**不携带长度、也不携带形状**。命令修饰键（ctrl/alt/meta，刻意不含 shift）会把一段输入变成 `cmd+c` 这样的结构化组合键，而不是被转写的文本。本地 OCR 是限定在范围内、裁剪到 480×160 的区域，且只允许 `apple-vision` / `windows-media-ocr`；云端后端永远无法被选中，其结果落在 `ocr_hint`，不会与用户输入混淆。

### 复核是必经步骤，生成可预览

每个步骤只带 asset id 而非字节；截图按需读取，经 64 条的缓存。编辑与捕获分开存储并在其上重放，这正是让已保存的源版本不可变的原因。变量建议一律以未确认状态出现，并在回答之前阻断生成——录制器分不清搜索词和菜单名，猜错的结果要么是写死了某个人数据的技能，要么是把固定值替换成了占位符。闸门位于 reducer（只要还有未确认项就拒绝 `GENERATE_REQUESTED`），而非 UI，因为未确认的变量并非惰性：信封会对它回退到录制到的原文，提前生成会把用户输入的内容既发给模型、又写进技能。手写模板路径走的是同一个事件，因此受同样的约束。

`buildGenerationEnvelope` 返回的就是实际发送的字符串，返回前已过 PII 闸门，预览渲染的也是同样这两段；有测试钉死其逐字节一致。**截图从不发送给生成模型。** 模型提出的 `allowedTools` 会与真实目录求交并交由用户确认；目录为空时一律报告为未知，而不是默默保留。未配置模型时的回退是依据复核后时间线写成的**完整**技能，而非留空模板。重新生成产出候选稿，按小节合并——绝不覆盖。

### 以禁用态保存、先试一次、再启用

技能在单个 Dexie 事务（`skills`、`skillResources`、`skillRecordings`）中写入，`status: "disabled"`。试运行会话带两个字段，因为单靠其一并不构成试运行：`trialSkillId` 才是真正加载技能的那一个——`resolveSendOptions` 读取它并**按 id 绕过启用状态过滤**载入该行，因为刚录制的技能仍刻意处于 `disabled`；`disabledSkillIds` 则是**其余所有**已启用技能，使输入框标签与会话徽标同发送路径对「哪些是惰性的」保持一致。两者合起来，结果无法用别的东西解释。启用是一个独立且显式的动作。

### 构造上只留在本机

一张新增表 `skillRecordings: "&id, skillId, status, updatedAt, [skillId+createdAt]"`（Dexie v141），保存编辑、计数与出处——从不保存捕获本身。它不在 `SyncableTable`、不在伴侣同步处理器集合、不在 `readDexieDelta`（未知表会抛错）、不在 `ClearableTable`、也不在备份负载中。该遗漏由测试断言，而非默认成立。日志与遥测只允许包含阶段、时长、计数、大小、平台、范围类型与稳定错误码——绝不包含文本、截图、坐标、窗口标题、文档名、提示词或模型回复。

### 紧急停止

`kill_switch::engage` 取代了三处彼此发散的调用点（设置、全局快捷键、托盘）：接通闸门 → 落盘 → 清除会话授权 → 释放虚拟显示器 → `recorder.interrupt_blocking(KillSwitch)` → 发出唯一一次事件。该中断保留日志，因此停止不是数据丢失事件；横幅会这样说明，并且在紧急停止或权限被撤销后不提供重试。

## 验证

`cognia-automation` 594 个 Rust 测试，外加 `recorder_window` 的 capability 钉死测试；其中承重的包括：末行撕裂的日志重放、asset id 拒绝路径穿越、按焦点 pid 而非光标定范围、拒绝被回收的窗口 id、`Unknown` 按安全处理、敏感内容不含长度、暂停会刷出缓冲的按键序列、中断保留日志，以及准入检查中紧急停止优先。TypeScript 侧的同址测试覆盖状态机的合法与非法迁移、信封逐字节一致、原子保存的事务范围、试运行的技能隔离，以及每一个录制器界面。Windows 代码路径已实现并做了单元测试，但**未**在真实 Windows 设备上验证；相应的核对清单已交给用户。
