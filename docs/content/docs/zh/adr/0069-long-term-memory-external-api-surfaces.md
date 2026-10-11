---
title: "ADR-0069 — 长期记忆子系统与外部 API 接口"
description: "记录了自主长期记忆子系统（Dexie v65 + v118治理、预算混合检索、持久学习作业）及其插件、MCP、工作流程、伴随和受控移动接口。"
---

# ADR-0069 — 长期记忆子系统与外部 API 接口

**状态**：已接受（2026-07-14），修订（2026-07-19）**作者**：Max Qian + Claude Fable 5 **基于**基础：数字孪生运行时（ADR-0003，共享embedding/vector后端）、外部桥接MCP服务器（ADR-0008）、Companion 控制面（ADR-0061 / Wave 4.1）、插件权限模型（ADR-0032，`goal:read`/`goal:write`前例）以及可视化工作流内存节点（ADR-0011）。

## 背景

自主长期记忆子系统（`lib/memory/**`、`types/memory/`、Dexie v65 `memories`表）自发货以来已实现内部全布线：每回合提取（`runTurnMemory` 来自聊天 + 团队hook）、通过`resolveSendOptions`注入混合式BM25+向量回忆（“你记得的用户情况”部分）、连接器自动模式回忆、`/remember`显式捕获、节点工作流程store/recall节点、`/memory`控制台和移动同步镜（`memories` `sync_registry.rs`年）。它没有**无ADR**——代码注释指向从未提交的spec文件——且**没有可调用API 接口**：插件、外部MCP代理和配对设备完全无法读写内存。

同时修复了已知缺陷：`MemoryConfig.hybridEnabled`惰性（只有设置开关读取）;工作流调用节点和PET召回桥被忽略`decayHalfLifeDays`;一个陈旧文档声称团队共享内存对象的值绕过PII 门禁（它们是深度门的）;`/remember`的`openMemory`旗帜从未被吞噬。

## 决策

### 1. 一个共享辅助层——`lib/memory/api/`

每个非对话的接口 writes/reads都经过四个助手，绝不会直接对着Dexie：

- `store-memory.ts` — `storeMemoryCore`（`/remember`-parity刻意写入：合并器优先，直接插入+向量汇回退）和`storeExternalMemory`（外部包装器）。节点`action.memory.store`工作流程现在也委派到这里。
- `search-memory.ts` — `searchMemoriesExternal`：配置门控混合回忆，线程用户的 `retrievalTopK` / `relevanceFloor` / `decayHalfLifeDays` / `enableQueryExpansion`;`touch` 默认开启，并选择诊断退出。
- `mutate-memory.ts` — `updateExternalMemory`（PII-gated文本补丁、`version`跳、重新重写向量文档）和`forgetExternalMemory`（仅软失效——硬删除仅限用户面板）。
- `wire.ts` — `toMemoryWireRow`，剥离内部管道（`vectorDocId`、访问计数器、归属内部）的边界投影。

策略区块返回结构化结果（`{ ok: false, reason: "disabled" | "temporary" | "pii_blocked" | "not_found" | "backend_unavailable" }`）;呼叫者编程错误。

### 2. 信任不变量（全部接口）

- **来源`external`**——每写API-surface为新一个`MemoryProvenance`值，检索真实度排名介于`explicit`至`system`之间（0.85）。混凝土接口被印在新的无索引行字段`sourceChannel: "plugin" | "mcp" | "rpc"`和`sourcePluginId`中（无Dexie版本凸起——加法且无索引）。
- **绝不程序化**——外部写入只能创建`semantic`/`episodic`;`storeMemoryCore`中强制执行了只有`user`/`explicit`源才能重写代理行为的既有不变量。
- **PII block 门禁** — 外部存储和文本更新必须传递`hasNoLeakingPii`（仅块;由于外部调用者无法代表用户同意，涂黑选项仍保持本地工作流）。
- **配置 门禁** — `memory.enabled` 门禁一切;`temporary` 阻断读写（忘了允许的停留——它只减少数据量）。

### 3. 插件API — `ctx.memory`（manifest permissions `memory:read` / `memory:write`）

遵循目标模式（manifest-level `PluginPermission` + TS validator + `cognia plugin lint` Rust 对等性 in `cmd_lint.rs` + `createGuardedAPI`），而非向量API-permission模式，因此在安装审核时可以看到授予。`search/list/get/count`需要`memory:read`;`store/update/forget`需要`memory:write`（不是危险级别——和`goal:write`一样）。当内存关闭时，读段会降级为空;`store`把打字`PluginPiiError`扔到PII。没有能力合同或桥梁地图入口（如`goals`，是必然的API）。

### 4. MCP桥接工具——示波器`memory:read`/`memory:write`，均为默认OFF

`memory_search` / `memory_list`（读取范围），`memory_store` / `memory_update` / `memory_forget`（写范围，忘掉标记`destructiveHint`）。注册在`registerMemoryTools`（`lib/external-bridge/mcp-server/server.ts`），处理器在`lib/external-bridge/handlers/memory.ts`，所有电话都通过`runWithGate`（权限门禁+审计日志）。两台望远镜都保持`DEFAULT_ENABLED_SCOPES`——记忆是提炼出来的个人事实，灵敏度与`rag:twin`相同。设置会自动切换从`ALL_BRIDGE_SCOPES`渲染。

### 5. 伴侣 RPC — 六个 `/_rpc/memory_*` 命令

所有调用都经过 desktop_writes_bridge `lib/companion/desktop-write-source.ts`臂（`sourceChannel: "rpc"`）。分类：`memory_store`/`memory_update`/`memory_forget`是`CONTROL_COMMANDS`（波4.1政策——高权限接口的每次远程修改都受门禁控制）;`memory_list`是`READ_ONLY_COMMANDS`;**`memory_search` 故意都不是** ——它会更新 `lastAccessedAt`/`accessCount`（近期访问信号），因此幂等缓存会阻止该信号更新。移动面板通过持久`MOBILE_OUTBOUND_COMMANDS`队列发送`memory_update`和`memory_forget`，然后在enqueue成功后乐观地更新本地镜像。桌面端仍为权威来源，并重新应用 PII、治理、审计与向量生命周期规则。第六个命令 `memory_mutate` 承载完整的管理词汇，现在所有配对客户端都通过它发送写操作（见 §8）。

### 6. `/memory`管理命令

`/memory`打开控制台;`status` / `list [n]` / `forget <id>` 通过聊天管理——`/remember`的 read/manage 对应，`openMemory` 旗帜现在实际上被消耗（`ctx.openSettings("memory")`）。

### 7. 学习记忆治理与命名空间控制平面（2026-07-19 修订）

Dexie v118 在规范的`memories`表上增加了`memoryEvidence`、`memoryJobs`和`memoryAuditEvents`以及治理索引。较旧的行会被保存并明确回填为legacy/unreviewed/unknown，而不是通过LLM回送。来源证据存储的是持久的身份和哈希值，绝非原始的转录记录。提取和会话蒸馏使用租赁、可重试、去重的作业;backup/restore 携带所有四个表，并在重复导入下重新映射引用。

回忆和学习是全球独立且每个聊天控制的。临时模式会禁用这两个功能。包含Web、MCP、工具搜索、屏幕或连接器上下文的回合默认被阻止自动学习;本地code/file工具不会污染转弯。如果用户允许被污染的学习，所产生的记忆和证据仍会被标记为`external-context`。

学习内存支持`global`、`workspace`、`character`和私有`agent`范围，并可选择项目、分支和路径限制。读者会选择宽窄视角，其中最窄的稳定密钥定义获胜;冲突被保留审查，但不予及时注入。容量和陈旧内存维护针对整个命名空间，而非整个范围。Recall在语义、情节和程序内存之间共享显式的代币预算，并将计数报告到聊天运行时 withheld/truncated。

### 8. 一个响应式控制台，写操作路由到主机（2026-10-11 修订）

`/memory` 控制台与手机路由（`/me/memory`）是同一个状态 hook（`hooks/memory/use-memory-console.ts`）之上的两个布局外壳：标签页、快捷视图、筛选维度、排序、多选、URL `?id`、检查器、撤销和唯一的删除确认都只有一份。之所以仍是两个组件，只是因为手机路由不得导入桌面控制台（移动端路由边界测试）；没有任何规则被实现两遍。在 `lg` 以下，桌面控制台的检查器是受控的侧边面板，平板或窄 Tauri 窗口会打开它，而不是悄悄丢弃。

写操作落在哪里只由 `lib/memory/control-plane/routed-manage.ts:memoryWriteAuthority()` 决定一次：

- `"host"`：远程主机传输处于活动状态，或运行时目标是 companion（在 headless 大脑主机上打开的浏览器、驱动远程主机的桌面端、已配对的手机）；
- `"local"`：其余情况——Tauri 桌面端、独立 Web，以及没有主机的独立 Capacitor 手机。它有意不读取 `isCompanionShell()`：未配对的手机没有可以发送写操作的对象。

所有修改记忆的入口（控制台、手机、冲突解决器、聊天记忆芯片、来源部件、上下文工作台面板、设置 → 危险区）都调用 `runMemoryCommand()` / `useMemoryCommand()`。在 `"local"` 下它就是 `manageMemory()`；在 `"host"` 下，命令先经过 PII 门禁（`redactText` + `hasNoLeakingPii`），再作为出站命令 `memory_mutate` `{ command, operationId }` 入队（队列幂等键即 operationId），并通过 `applyMirroredMemoryCommand` 乐观更新本地镜像——镜像无法复现的命令（新建、恢复修订版本、检索反馈）等待主机的行同步回来。

主机执行 `manageMemoryForCaller()`：严格解析命令（`command-wire.ts` 从不接受线上的 `actorId` 或 `commandId`），检查调用方对每一条被触及的行以及目标命名空间的授权，把 `clear` 收窄到该设备可见的行，通过操作账本（kind `"manage"`）重放，并把设备记录为操作者。主机应答后，出站执行器结算该操作（`remote-outcomes.ts`）：成功则安排一次后续 `memories` 拉取；被拒绝则回退 `memories` 同步游标（`rewindSyncTable`，进行中的拉取无法覆盖它），重新拉取规范行，并告诉用户原因。

管理词汇新增 `restore`（把已归档记忆恢复为活跃，PII 干净时重新写入向量，审计 `restored`）与 `relocate`（把记忆移到另一个命名空间；分支与路径限制只在同一工作区内保留，审计 `relocated` 并记录 from/to）。归档立即生效并可撤销；删除是唯一需要先确认的操作，所有入口一致——上下文工作台此前删除时不做确认。

## 后果

- 三次呼叫接口共享一个gate/consolidation实现——PII或信任模式的修复方案在 `lib/memory/api/` 内完成一次。
- 内存控制台可以通过`provenance: "external"` + `sourceChannel`归属并批量清理API-written行。
- 对等性 门禁触摸接口时必须保持绿色：`rust-capability-parity.test.ts`（TS ↔ `cmd_lint.rs`权限）、`spec_parity.rs`（`KNOWN_COMMANDS` ↔ OpenAPI）、rpc.rs 分类哨兵，以及新scope/provenance字符串的en/zh-CN i18n密钥对等性。

## 超出范围（有意为之）

- **孪生嵌入耦合**——记忆回忆仍借用双胞胎的embedding/vector后端（`tryBuildMemoryDeps` → `tryBuildTwinDeps`）;一个从未配置过孪生嵌入的用户会默默获得BM25-only内存。独立的内存嵌入配置仍是未来的工作。
- **跨设备审计同步** — 规范内存是伴随同步镜像的一部分，而evidence/jobs/audit历史目前通过加密应用备份来往返，而非实时设备同步。
- **入站IM内容**仍被来源门禁（仅读回忆）排除在内存写入中——设计上未作更改。
