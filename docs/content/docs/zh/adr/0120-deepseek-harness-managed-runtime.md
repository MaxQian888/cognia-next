---
title: ADR-0120 — DeepSeek Harness 托管运行时
description: "以外部智能体形式接入 DeepSeek Harness，跨两种传输层；因上游既未发布可执行文件也未发布 host 平面，组合由 Cognia 自己拥有。"
---

# ADR-0120 — DeepSeek Harness 托管运行时

**状态**：已接受（2026-08-14）

## 背景

DeepSeek Harness（下称 DSH）是 DeepSeek 开源的 agent harness，基于 Cordis 构建。先前调研（`docs/research/deepseek-harness-lessons-2026-08-13.md`）的结论是：Cognia 应当**借鉴** DSH，而非迁移到 DSH。该结论依然成立，本 ADR 不推翻它。这里处理的是一个更窄的问题——像 Cognia 已经运行 Claude Code、Codex、Pi 那样，把 DSH 作为进程外的外部智能体运行。Cordis 不会进入 Cognia 进程。

以下五项事实决定了本设计。每一项都通过阅读已发布产物并在本地实际运行确认，而非取自文档；每一项都会让「显而易见的实现」失败。

**1. 没有可安装的可执行文件。** 其他外部智能体都是 `PATH` 上的 CLI。DSH 对 Cognia 驱动的两种传输层都未发布可执行文件：`@deepseek-ai/dsh-acp` 与 `@deepseek-ai/dsh-sdk-client` 的 `"bin"` 均为 `null`——它们是 Cordis 插件库。唯一发布的二进制 `@deepseek-ai/dsh`（`bin: dsh`）只暴露 `web` 与 `plugin`，且完全不含 ACP 代码。`dsh-sdk-client` 明确写道：*"No bundled-runtime resolution — callers name the runtime executable explicitly."*

**2. npm 包只发布了组合的一半。** DSH 把 Cordis 树分为 *agent 平面*（persona、模型可见工具、工具呈现）与 *host 平面*——「注册表本身、沙箱与审批栈、持久化、模型路由」。npm 只发布 agent 平面的四个 preset。**安全关键的装配全部位于未发布的 host 平面。**

**3. `read-only` 本身并不构成只读。** DSH 工具向模型暴露了提权路径：被拒绝的调用可以携带 `sandbox_permissions: "workspace-write"` 与理由重试，由 `ctx.approval` 裁决。在 Cognia 自己的组合上对 `deepseek-v4-flash` 实测（要求其写入文件）：

```
1. 写入被拒 -> "[sandbox: file access denied under read-only mode]"
2. 模型携带 sandbox_permissions: "workspace-write" 重试
3. 提权被拒——未组合 approval 服务 -> fail closed
4. 未创建任何文件
```

第 3 步才是全部保证所在。该 profile 之所以只读，是因为**提权路径终止于一个缺失的服务**，而不是因为那个 mode 字符串。

**4. 两种传输层近乎互补，而非高低配。** SDK 传输层流式输出全部持久事实——工具调用、推理、用量、子 agent 谱系——但其 wire 没有 server→client 请求（上游的审批能力是 dead capability），也没有 prompt-cancel 方法。ACP server 被上游称为「automation-only」：*"Committed answers only — live progress, reasoning, tool activity, plans, titles, and usage stay off the wire."* 而它能做的，恰是携带权限请求与取消单次对话。两者都不支持会话恢复。

**5. `DSH_HOME` 是一条信任边界。** `resolveDshHome()` 回落到 `~/.dsh`。在该根目录下，DSH 会读取 `cordis.patch.yml`（home 级与 profile 级）以及 profile 的 `package.json`（其 `dependencies` 为树外插件）。这些层**在所有 bundle 层之后生效**，可以 `insert` 任意插件行，可通过 `!!js` YAML 标签执行任意 JavaScript，并且被实时监听。因此，用户主目录下的一个文件足以把写入与网络工具挂载到 Cognia 认证为只读的 profile 上，而所有摘要校验仍然通过。

第六项事实澄清了一个曾被当作阻塞项的问题：Cognia 锁定 `@agentclientprotocol/sdk@1.3.0`，DSH 锁定 `0.25.1`——但**包版本不是兼容性信号，wire 版本才是**，二者同为 `PROTOCOL_VERSION = 1`，已通过对活跃 server 的握手确认。

## 决策

Cognia 将 DSH 的 **host 平面**作为一等源码纳入 `runtime/deepseek-harness/` 并随 Cognia 版本化，安装到隔离运行时目录，并以摘要进行认证。

**三个 profile，两种传输层。** `cognia-sdk-readonly`（默认）、`cognia-sdk-workspace`、`cognia-acp`。会话**不得**跨传输层迁移：两者在「用户能看到什么」与「用户能否否决」上都不同，中途切换会静默改变一次进行中对话的安全属性。

**两条相反的审批不变量，出于同一个原因。** SDK 只读 profile **不组合** `ctx.approval`：既然无人可问，组合它等于把自助提权交给模型。ACP profile **必须组合**：那里请求能抵达用户，省略它会让每个受审批约束的工具都 fail closed 且无从继续——那是坏掉的 agent，而非安全的 agent。两条不变量都写在各自组合文件顶部，并由测试钉住。

**`DSH_HOME` 固定在运行时目录内。** launcher 在其无法规范化到该目录内时拒绝启动；`doctor` 在只读 profile 上将任何游离 patch 层视为致命错误（在已授予写权限的 profile 上降级为警告）。路径规范化可挫败符号链接与同名前缀逃逸。

**策略在 TypeScript，宿主只采集事实。** `doctorDshRuntime()` 与 `buildDshChannelManifest()` 位于 `lib/ai/agent/external/dsh-runtime-install.ts`。Rust 与 Node 宿主只返回**事实**——摘要、Node 版本、平台、游离 patch 层——由渲染端给出判定。按宿主各写一套规则，正是桌面端与 headless 端答案发生漂移的成因。安装采用两阶段同理：宿主暂存并回报摘要，渲染端构建 manifest（profile 与能力词汇表归它所有），宿主写入并原子切换。

**能力事实是数据而非文字描述。** `DSH_SDK_CAPABILITIES` 与 `DSH_ACP_CAPABILITIES` 会与静态表 `RUNTIME_CAPABILITIES.external` 求交——后者授予 `session.resume`、`steer`、`set-model`、`permissions.interrupt-resume`，而 DSH 在两种传输层上都不支持。缺少这一交集，兼容性门禁会认证运行时并不具备的能力，UI 也会渲染出无效控件。

**不把 `node`加入 spawn 白名单。** 启动形式为 `node <launcher.mjs> <composition.yml>`，直接放行裸 `node` 等于废掉整个白名单。Rust `SpawnPolicy` 与 CLI 后端仅在两个路径都能规范化到 Cognia 数据根目录内时才放行。

## 影响

Cognia 从此需要维护一份 Cordis host 组合，其中包含沙箱与审批栈。这是先前调研未曾预期的真实维护面，也是 DSH 不发布 host 平面所带来的代价。它被刻意限制在进程外运行时中。

上游仍是 developer preview 且明确预告破坏性变更，`SESSION_FORMAT_VERSION` 为 `0` 且无兼容承诺——三天内发布了六个 RC。因此**身份是组合与 lockfile 摘要，而非版本字符串**（版本仅用于展示）。SessionEvent codec 在遇到未识别的 **required** 事件时明确失败而非丢弃；上游标记 `ignorable` 的事件降级为有界警告。

默认 profile 不能写入、不能执行命令、也不能向用户提问。对一个实验性接入而言这是正确的默认值，代价是更有意思的场景需要用户显式选择 profile。

Windows 暂不在范围内：`koffi` 是 `dsh-fs-local` 的硬依赖且需要编译。在 macOS 与 Linux 上它虽被安装但从不被 import——其唯一用途位于 `win32()` 路径之后。`node-pty` 是 `dsh-subprocess-local` 的静态 import 且上游无 Linux 预编译产物，因此 workspace profile 在 Linux 需要 node-gyp 工具链；`doctor` 会提前报告，而不是在 spawn 时才失败。

## 备选方案

**vendor host 组合。** 否决：它承载沙箱与审批装配，应当处于评审之下，而非躺在一个复制目录里。

**在 Rust 中重新实现 doctor。** 否决：同一条安全判定存在两份实现，正是桌面端与 headless 端悄然分歧的起点。

**把 `@deepseek-ai/dsh-sdk-client` 加入工作区并正常 import。** 否决：该包属于运行时目录；且 `manager.ts` 可从 `app/layout.tsx` 抵达，因此任何 specifier——即便写在动态 `import()` 内——都必须在构建期解析，会破坏移动端产物。改为按绝对路径从已安装的运行时目录加载。

**只做 ACP，因为它能审批。** 否决：它几乎不报告任何过程信息，用户看着 agent 工作时只会经历长时间静默，然后收到一整块文本。

## 参考

- `runtime/deepseek-harness/` — 组合、launcher、锁定依赖
- `lib/ai/agent/external/dsh-runtime-install.ts` — 共享判定与 manifest 策略
- `lib/ai/agent/external/dsh-session-event-codec.ts` — wire → canonical 事件
- `crates/cognia-external-agent/src/dsh_runtime.rs` — 桌面端生命周期
- `tests/fixtures/dsh/` — 录制的 wire trace（上游与 Cognia 自采）
- [ADR-0090](./0090-unified-agent-execution-and-gateway-compatibility) — 本接入所遵循的执行规格
- [ADR-0049](./0049-external-agent-process-hardening) — `node` 例外所扩展的 spawn 策略
