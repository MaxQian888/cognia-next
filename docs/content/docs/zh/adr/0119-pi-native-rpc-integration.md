---
title: ADR-0119 — Pi 原生 RPC 接入
description: "新增内建 `pi-rpc` 协议，直接驱动 `pi --mode rpc` 取代社区 ACP 桥，且不削弱外部智能体的强制沙箱。"
---

# ADR-0119 — Pi 原生 RPC 接入

**状态**：已接受（2026-08-14）

## 背景

Pi 此前只能经社区 ACP 桥 `npx -y pi-acp` 接入（`lib/ai/agent/external/ecosystem-adapters.ts`）。该桥把 Pi 的原生 RPC 投影到更小的 ACP 词汇表上，thinking level、steering 与 follow-up 队列、compaction 生命周期、带分叉的会话树以及 usage 明细因此全部丢失或被压平。该桥还是执行路径上的第三方代码，不在 Cognia 的认证范围内。

Pi 本身提供了一等的本地协议：`pi --mode rpc` 在 stdio 上讲一套 JSONL 命令/事件流。它**不是** JSON-RPC——帧是 `{type, id, …}` 命令对象，应答为 `{"type":"response", "command", "success", …}`——因此 `json-rpc-peer.ts` 无法复用，只能仿照。

该协议有四条性质是通过在本机实跑 Pi 0.84.1 确认的，而非从文档推断，因为每一条都会让朴素实现出错：

1. **响应不是先进先出。** `abort` 的应答晚于其后才发出的 `get_state` 的应答。关联只能依据 `id`。
2. **入站畸形帧不会终止 Pi。** 它回 `{"type":"response","command":"parse","success":false}` 且**不带 `id`**；假定每个响应都带 id 的关联层会永久泄漏一个 pending request。
3. **`set_thinking_level` 接受非法输入。** 它返回 `success: true`，静默降级为 `off`，并先发出 `thinking_level_changed`。校验必须在 Cognia 侧依据 `get_available_thinking_levels` 完成，而该结果按模型而异。
4. **`--no-extensions` 并不构成隔离。** `~/.agents/skills/` 下的 skills 与 Pi 内置的 inline extension 仍会加载。

另外，Node 的 `readline`——即 `cli/src/runtime/external/node-backend.ts` 用来给所有外部智能体 stdout 分帧的实现——会在 U+2028 与 U+2029 处断行。`JSON.stringify` 不转义这两个字符，因此正文含 U+2028 的单个合法 Pi 帧会被切成若干无法解析的片段。Rust host（`BufReader::lines()`）是字节导向的，不受影响。

## 决策

新增内建 `ExternalAgentProtocol` `pi-rpc`，并在 `ExternalAgentManager.registerDefaultAdapters()` 中注册 `PiRpcAdapter`。不新增 execution rail，不新增 Dexie schema version，路径上不出现任何 ACP。

**分帧。** adapter 自持严格 LF codec：只按 `\n` 字节分帧，删除尾部单个 `\r`，绝不把 U+2028/U+2029 或孤立 `\r` 当作分隔符。它容忍半帧与单 chunk 多帧，并施加 16 MiB 单帧、32 MiB 缓冲上限，越界即报 `protocol_frame_invalid`。为向它提供未分帧的字节，`node-backend.ts` 增加按需启用的 raw chunk 转发模式，仅供 `pi-rpc` 使用；ACP、Codex、OpenCode 保持既有 `readline` 路径不变。它们同样暴露于该 U+2028 缺陷，但属既存问题，不在本 ADR 范围内。

**会话。** 每个 Cognia session 独占一个 Pi 进程，绝不通过 `switch_session` 共享。Cognia 生成 session UUID 并传入 `--session-id`，Pi 将其视为"使用该精确 id，不存在则创建"——因此恢复就是再次传入同一 flag，持久化的 link 只保存该 UUID、cwd 与 Pi 版本。任何跨设备负载中都不出现 session 文件的绝对路径。分叉使用 `--fork`。每 host 上限 4 个进程，超限回收最近最少使用的空闲进程，否则返回 `resource_limit`。

**版本策略。** `0.84.1` 为认证版本。更低版本以 `runtime_version_unsupported` 拒绝。更高版本放行但标记为未认证并打点，使 Pi 升级降级为一条警告而非一次中断。

**沙箱。** 无例外。Pi 与其他所有外部智能体一样运行在强制的 `cognia-external-agent-launcher` 之下；launcher 缺失或平台非 macOS/Linux 时，会话以 `sandbox_unavailable` 被拒。ADR-0077 的"从不回退到无沙箱进程"原样重申，规划期间考虑过的三条逃生通道（桌面一次性确认、CLI flag、headless 环境变量）全部否决——Pi 不应成为侵蚀该不变量的先例。

**扩展与权限。** 第一方 Cognia extension 以原始 TypeScript 分发（Pi 直接加载 `.ts`，无构建步骤），并在构建期做 SHA-256 pin。隔离的含义是 `--no-extensions --no-skills --no-prompt-templates --no-approve`；`AGENTS.md`/`CLAUDE.md` 上下文文件刻意仍然加载，因为它们是数据而非可执行代码。由于 Pi 即使在隔离下仍保留自身内置 inline extension，extension 的 `session_start` 握手断言的是**预期的扩展集合**，而非断言集合为空。5 秒内未完成握手或哈希不符，会话以 `extension_handshake_failed` fail closed。

extension 经 `pi.on("tool_call")` 拦截每一次 Pi 原生工具调用，把五种 canonical 权限模式映射到 Pi 的 `read`/`grep`/`find`/`ls`/`edit`/`write`/`bash`。`plan` 与 `dontAsk` 另在启动时固定 Pi 自身的 `--tools` 允许名单，使限制性模式拥有进程级底线，而不仅依赖拦截。

**工具投影。** extension 复用既有 tool host，不新增通道：从自身环境读取 `COGNIA_TOOLHOST_{SOCKET,TOKEN,SERVER}`，并与 broker 讲既定的 `hello` / `authorize` / `exec` 协议。规划期提出的 session 级控制文件被废弃——相对于既有的环境变量 + `0600` unix socket，它冗余且严格更差。

## 影响

- tool-host token 现在会进入 Pi 进程环境，模型的 `bash` 工具可以读到它；而今天该 token 只到达受信的 bridge。接受这一点的理由是：权限权威是 broker 的 `authorize()` 而非持有 token——每次调用都会重新核对工具可见性、工作区 confinement、`needsApproval` 与审批 gate，因此泄漏 token 并不能带来沙箱进程本就无法经同 uid socket 触达的能力。此处记录它，是因为这确实是纵深防御的一次收窄，而不是无关紧要。
- Windows 以及任何缺少可用沙箱 launcher 的主机无法本地运行 Pi，需经配对桌面或 headless host 接入，与其他外部智能体一致。
- 隔离会在 Cognia 发起的会话中停用用户自己的 Pi 扩展栈。这正是目的：`pi-permission-system` 等社区权限引擎同样 hook `tool_call`，两套引擎拦截同一次调用会产生重复确认与不可预测的阻断。
- Cognia 从不读取 Pi 的凭证。认证诊断只调用 `pi auth check --provider <id> --json --no-refresh`；`--credentials`、`print-api-key`、`print-bearer-token` 一律禁用。
- `pi-acp` 作为独立的 experimental 兼容 preset 保留。迁移是显式且可回滚的，原地更新配置以保住 team、scheduler 与 runtime 对 agent id 的引用，且不假定 ACP session id 能映射到 Pi session。
