---
title: "0217 — Agent 集成是位于主机端口之后的包"
description: "外部 Agent 集成、共享的适配器契约和运行时构件从应用私有代码中移出，成为可以独立构建、测试和安装的工作区包。契约把必需的适配器核心与命名的可选能力分开，增加了执行语义（取消作用到哪里、会话如何恢复或分叉、审批在哪里决定、进程如何对应会话），并用类型化的适配器扩展取代对厂商类的 instanceof 判断。集成只能通过主机端口（进程平面、启动环境、审批策略、必需的出站 PII 闸门、日志）接触机器，因此声明能力从不等于获得授权。历史读取器返回中立的会话记录，由主机映射成自己的行；原生恢复会回到上次运行它的那个配置。"
---

# ADR 0217 — Agent 集成是位于主机端口之后的包

**状态：** 已接受（进行中：契约、运行时工具包、DeepSeek Harness 和 Codex 已落地；其余集成、执行引擎和编排按下文阶段推进）
**日期：** 2026-10-05
**修订：** [ADR-0090](./0090-unified-agent-execution-and-gateway-compatibility)（适配器契约和规范事件契约移入 `@cognia/agent-contracts`）、[ADR-0062](./0062-external-agent-session-import)（运行时会话存储的读取器放在其集成包中，返回中立的会话记录）、[ADR-0216](./0216-each-agent-configuration-keeps-its-own-state)（原生恢复记录并回到它的配置）、[ADR-0051](./0051-external-agent-adapter-plugin-type)（插件适配器按新的核心来读取）
**相关：** [ADR-0068](./0068-frontend-package-extraction-and-compile-speed)（包提取规则）、[ADR-0107](./0107-coding-agent-migration)（迁移读取器留在迁移子系统）、[ADR-0142](./0142-agent-sdk-two-layer-product)、[ADR-0169](./0169-one-runtime-one-review-one-control-machine)、[ADR-0197](./0197-the-sidecar-runs-its-typescript-unbuilt)

## 背景

每个外部 Agent 集成都放在 `lib/ai/agent/external/` 里，和运行它们的管理器在一起，并随意导入应用代码：Tauri invoke 封装、日志、PII 闸门、任务工作区存储。第二个主机无法复用其中任何一个。CLI 只能在打包时替换模块来得到自己的副本（`scripts/build/cli-external-agent-aliases.mjs`）。

适配器契约（`ProtocolAdapter`）增长到约 90 个成员，多数是可选的。管理器无条件调用其中一些（`forgetSessions`、`getSessions`、`cancel`、`healthCheck`），而插件适配器并不需要提供这些成员。管理器还用 `instanceof CodexAppServerAdapter` 获取厂商控制。

布尔能力标志无法表达运行时之间真正的差别：

- **DeepSeek Harness** 没有协议层取消。停止一个回合会结束该会话自己的进程，会话必须重新打开。管理器却一直缓存这个已失效的会话，下一个回合就被发往一个已经不存在的运行时。
- **Codex app-server** 在共享进程上取消单个回合，并能原生恢复。
- **Aider** 只能重放主机的会话记录，这不是原生恢复。

Agent 的身份散布在多套词汇中：

- **生态（ecosystem）**（`lib/agent-ecosystem`）
- **运行时（runtime）**（`protocol/external-agent-runtimes.json`）
- **预设（preset）**
- **协议（protocol）**
- **配置实例**

原生恢复只按记录的预设匹配。这样会把读取同一会话存储的其他运行时全部藏起来，而且从不记住某个会话是在哪个配置（也就是哪个账号）上恢复的。

## 决定

### 包的层次

```
@cognia/agent-contracts      类型和极少量纯函数；运行时依赖：无
        ▲                    （ACP SDK 是仅类型依赖，版本精确锁定）
@cognia/agent-runtime-kit    BaseProtocolAdapter、JSON-RPC 对端、LF 帧解码器、
        ▲                    派生回收、内容块、历史构件
@cognia/agent-<集成>         ./manifest、./<运行时客户端>，运行时有自己的会话存储时
                             还有 ./history
        ▲
主机（应用、CLI、无界面主机） 注册集成、实现端口，负责策略、PII、沙箱、持久化，
                             以及映射成自己的数据行
```

规则：

1. 包从不导入 `@/…`、React、Tauri、Dexie 或 zustand。每个包的 `tsconfig.json` 在 `paths` 中只列出允许依赖的包，误写的 `@/` 导入会直接编译失败。
2. 集成包只依赖契约和运行时工具包，彼此之间不互相依赖。
3. `./manifest` 和 `./history` 入口不加载任何运行时、进程或传输模块。打包测试会安装 tarball，再通过 CommonJS 模块缓存证明这一点。
4. 每个包都是 `private`、AGPL-3.0-only、只导出 dist（`types` / `import` / `require` / `default`），并通过 `pnpm agent:packages:pack-test`。该测试会打包这个包和它依赖的所有 `@cognia` 包，在工作区之外从 tarball 安装，通过 ESM 和 CJS 加载每个入口，运行一段冒烟程序，并对严格的 NodeNext 使用方做类型检查。

### 身份

集成复用现有的身份来源，不注册任何新的身份：

- **生态：**`lib/agent-ecosystem` 仍是身份表。集成包导出自己的那一行（`codexManifest.ecosystem`、`deepseekHarnessManifest.ecosystem`），目录列出这些行，而不是复制一份。
- **运行时：**`protocol/external-agent-runtimes.json` 仍是受闸门检查的运行时与预设目录。
- **协议：**从配置或预设读取，从不从运行时行读取。
- **配置实例：**`ExternalAgentConfig.id`。

### 适配器核心与可选能力

`ExternalAgentAdapterCore` 包含任何主机都可以调用的成员。其余成员都是带守卫函数的命名可选能力：

- `supportsSessionRegistry`
- `supportsResume`
- `supportsFork`
- `supportsTurnSteering`
- `supportsSessionModels`
- `supportsModelCatalog`
- `supportsAuthentication`
- `supportsCompaction`
- `supportsSessionListing`

`ProtocolAdapter` 仍是“核心加可选能力”，所以现有的实现都能通过类型检查。管理器现在通过守卫函数或可选链调用可选成员（`adapter.forgetSessions?.()`）。

`missingAdapterCoreMethods(adapter)` 报告插件适配器缺少哪些成员，供插件兼容包装层使用。

### 执行语义

每个运行时声明 `semantics: AgentExecutionSemantics`：

| 字段 | 取值 |
| --- | --- |
| `cancel.scope` | `turn`、`session`、`process` |
| `cancel.reconnectsAfterCancel` | 会话是否需要重新打开 |
| `resume` | `native`、`relaunch-with-session`、`history-replay`、`unsupported` |
| `fork` | `native`、`native-turn-boundary`、`before-entry`、`unsupported` |
| `approvals` | `per-tool-call`、`profile-fixed`、`none` |
| `processModel` | `shared`、`per-session`、`per-turn`、`remote` |

什么都不声明的适配器按保守的 `UNDECLARED_EXECUTION_SEMANTICS` 处理：取消可能结束整个进程并需要重连，不能恢复也不能分叉，审批逐次询问。

DeepSeek Harness 声明进程级取消、每会话一个进程。Codex app-server 声明回合级取消、共享进程、原生恢复，并在回合边界分叉。

如果一次取消需要重连，而适配器已经不再报告该会话，管理器会把它从缓存中移除。因此下一个回合会打开新会话。

### 类型化的厂商扩展

需要暴露厂商控制的集成会定义一个扩展，例如 `defineAdapterExtension<CodexAppServerAdapter>("codex.app-server", resolve)`。主机通过 `manager.getAdapterExtension(agentId, codexAppServerExtension)` 读取它，取代 `getCodexAppServerAdapter` 和管理器里的 `instanceof` 判断。

扩展 id 带命名空间（`vendor.feature`）。

### 主机端口

集成只能通过契约中定义的端口接触机器：

| 端口 | 主机提供的内容 |
| --- | --- |
| `AgentProcessHost` | 派生、写入、有界终止，以及主机范围的 stdout（按行或原始）、stderr 与退出订阅 |
| `AgentLaunchEnvironmentResolver` | 配置自己的凭据、状态根和绑定账号（ADR-0216），在派生前注入 |
| `AgentApprovalPolicy` | 配置的审批列表对单个请求的判断 |
| `AgentOutboundGate` | 主机的 PII 闸门；**必需**，集成发出的每个提示或载荷都要经过它 |
| `AgentLogger` | 结构化日志；条目大小由主机限制 |

桌面应用在现有传输之上实现进程平面。这个传输就是 companion 或 Tauri 桥，使用 `spawn_external_agent`、`send_to_external_agent`、`kill_external_agent` 和 `external-agent://stdout|stdout-raw|stderr|exit`。应用把 `hasNoLeakingPiiDeep` 作为出站闸门传入。

**声明需要并不授予任何权限。**派生白名单、沙箱、放置、权限守卫和审计仍由主机执行；注册一个集成也不会授权它清单中声明的内容。

### 历史读取器与中立会话记录

运行时有自己的会话存储时，它的包会在 `./history` 下导出一个纯函数读取器。读取器把文件内容转换成 `ParsedHistorySession`：

- **会话记录：**中立的 `HistoryPart`（文本、推理、文件、旁白、带已记录结果的工具调用），以及每回合用量和带命名空间的注解。
- **规范状态：**目标、计划、任务、压缩与回滚历史、Agent 间消息，以及已记录的规范事件。
- **损失：**一份明确的损失清单，列出读取器丢弃或近似处理的内容。

读取器从不读取文件系统、从不构造主机的数据行，也从不存储任何东西。对于无法映射的记录，读取器会保留有界的诊断信息，其中的每个字符串都经过主机的脱敏函数（`HistoryReaderHost.redactText`，必需）。

应用负责三件事：发现（根目录、预算、语料缓存）、映射到 `StoredMessage` 的唯一路径（`lib/session-import/history-to-stored.ts`，它调用 `to-parts`），以及会话图。

规范事件和规范会话契约移入了 `@cognia/agent-contracts`，因为集成会产生它们。`@cognia/agent-config-types` 原样重新导出这两份契约。

迁移读取器留在迁移子系统中（ADR-0107）：设置、命令、子 Agent 和记忆。它们把各厂商的文件翻译成 Cognia 自己的设置词汇，覆盖许多厂商，其中包括 Cognia 无法启动的厂商。

### 原生恢复绑定它的配置

导入的会话记录了写入它的预设：

- **候选：**原生恢复把该预设所属生态的所有预设都视为候选（`presetIdsSharingEcosystem`）。Codex 的 ACP 适配器和它的 app-server 读取同一个 `~/.codex/sessions` 会话。
- **记录配置：**一次经过验证的恢复会记录 `runtimeBinding.agentConfigId`。
- **回到原配置：**之后的恢复会回到这个配置。
- **离线时拒绝：**该配置仍然存在但未连接时，恢复返回 `bound-runtime-unavailable`，并列出已连接的其他选择。它从不悄悄把会话移到另一个账号上。

ADR-0216 的隔离规则依然适用：独立状态的配置看不到运行时的主目录，从不作为候选。

### 兼容性

- **旧导入路径：**每个都改为重新导出它的新位置：
  - `types/agent/external-agent.ts`
  - `types/agent/external-agent-lifecycle.ts`
  - `lib/agent-ecosystem/types.ts`
  - `lib/ai/agent/external/protocol-adapter.ts`
  - `@cognia/agent-config-types/{agent-execution,canonical-session,ref-safety,external-agent-capability}`
- **已存储的数据：**配置、会话和导入绑定保持不变。`agentConfigId` 是可选的，没有它的绑定按原来的方式解析。
- **插件适配器：**仍通过现有的覆盖层注册。

## 实施状态

| 阶段 | 范围 | 状态 |
| --- | --- | --- |
| 1 | 基线、身份模型、迁移矩阵（`docs/plans/2026-10-05-agent-package-architecture.md`） | 完成 |
| 2 | `agent-contracts`、`agent-runtime-kit`、`agent-dsh`、`agent-codex`（运行时 + 历史）；DSH 取消语义；原生恢复绑定 | 完成 |
| 3 | ACP 和其余集成、插件兼容包装层、由清单生成目录行、CLI 端口注入 | 计划中 |
| 4 | 中立的工具内核；AI SDK 引擎在没有 Claude SDK 时也能构建和测试 | 计划中 |
| 5 | 位于存储/日志/执行器端口之后的编排包；用组合根打破 Team↔Workflow 导入环 | 计划中 |
| 6 | 文档、闸门、CI 和最终回归 | 计划中 |

## 后果

- **复用：**主机只要实现五个端口就能使用一个集成。DSH 和 Codex 适配器不再导入应用代码。
- **契约约束：**集成包单独做类型检查和打包测试。契约改动如果破坏了已安装的使用方，会在 `agent:packages:pack-test` 中失败，而不是等到之后的应用构建。这项测试已经发现两个真实问题。第一，ACP SDK 的版本范围会解析到一个缺少契约所用类型的版本，现已精确锁定。第二，`@cognia/redact` 无法作为构件安装，所以 PII 闸门被设计成必需的主机端口。
- **发布：**升级一个集成包本身不会改变原生行为。进程平面、安全策略和沙箱仍由主机发布。
- **运行时目录：**仍是运行时与预设行唯一的受检来源。由清单生成这些行属于阶段 3，并保留现有闸门。
