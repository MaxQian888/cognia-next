# 内置 Agent 工具完整性审计（2026-08-14）

本文取代 [`agent-built-in-tool-gap-analysis-2026-07-18.md`](./agent-built-in-tool-gap-analysis-2026-07-18.md) 的部分结论，详见 §11。
英文版：[`agent-builtin-tool-completeness-audit-2026-08-14.md`](./agent-builtin-tool-completeness-audit-2026-08-14.md)。

这是一份审计产物，不是 ADR。它记录内置 Agent 工具面在 **2026-08-14 修复之前**的实际行为，按三条轴衡量，每条结论都带 `file:line` 证据。审计本身未修改任何生产代码。

> **修复进行中。** 针对安全层与最高严重度 P0 的第一轮修复已经落地。下文标记 ✅ 的发现已修复，**这些章节的 `file:line` 引用描述的是修复前的代码，已与 `main` 不一致**；未标记的仍未修复，其引用依然准确。
>
> **已修复——安全层。** **SEC-1、SEC-2、SEC-3**（禁闭层现已覆盖全部写工具与带路径的读工具；`collectPathTargets` 读取全部 17 个路径键及 `paths[]`，并采集**每一个**存在的键而非只取首个匹配；`file-ops` 写工具均调用 `assertNotSecretEscape`，传输类工具对源与目标双向校验）·**SEC-4**（`get_env`/`list_env` 的 `revealSecrets` 已移除）·**SEC-6**（两份拒绝清单改为由 `requiresApproval` 元数据派生，`CORE_MUTATING_TOOL_NAMES` 已接上电）·**SEC-7**（`kill_shell` 改判档位）·**SEC-8**（Anthropic 轨现已对两个 cognia 自有 MCP 服务强制计划模式，SDK 原生与用户 MCP 工具仍交由 SDK 治理）·**SEC-12**（外部 agent 桥在鉴权之后按各工具 zod shape 校验输入）。
>
> **已修复——P0。** **P0-1**（`bash` 的 spawn 失败与信号终止返回 `isError`）·**P0-2**（JSON-Schema→zod 转换现已保留 `enum`/`const`、字符串/数值/数组边界、`default` 以及嵌套 `properties`/`required`，不再把对象塌缩——已用直接 parse 测试验证）·**P0-4**（Monitor 三兄弟不再在桥上广告，因其在那里永远不可用；`sessionId` 已透传）·**P0-6**（resolver 缺失时 `lsp`/`codeGraph` 进入拒绝清单）·**P0-7**（错误提示不再把模型引向并不存在的 `file_delete`）·**P0-8**（`ast_grep_*` 改在会话 cwd 下运行）·**P0-9**（被中断的改写返回错误）·**P0-11**（`impactCount` 附带 `impactCountExact`）。
>
> **已修复——P1/P2。** **P1-1**（ai-sdk 轨将 `AbortSignal` 透传进 handler；`grep`/`glob` 与 `ast_grep_*` 已消费它，中断现在会杀掉子进程而非留下孤儿）·**P1-4**（统一的 `plan-mode-policy.mjs` 取代已漂移的多份副本）·**P2-0**（**完全关闭**——167/167 个 sidecar 测试文件全部纳入运行，门禁测试从 1428 增至 1726；与一个并行修复共同完成）·§7 中缺失的 9 个 i18n key，以及新增的 `sdk-native` 标签。
>
> **SEC-5 部分修复。** 两处低成本改动已落地：扩充 `SDK_CORE_TOOL_NAMES`，并把 SDK 原生工具作为第五个来源接入 `lib/tools/tool-catalog.ts`（同时接好两处 UI 来源清单与 i18n，否则新条目会被静默丢弃）。核心缺陷——`allowedTools` 在一条轨上是预批准、在另两条轨上是白名单——**尚未**修复，需要产品决策。
>
> **P0-3 刻意未修。** 曾尝试把 `ok: false` 一律映射为 `error`，随后回退：该做法与一项有测试固定的设计决策冲突——「拒绝」应当是模型可读可适应的结构化结果，而非中断步骤的工具错误。详见 `lib/claude/plugin-tool-ipc.ts` 中的说明。真正关闭它需要逐工具裁定「拒绝 vs 错误」，并配合 P1-2 的信封统一。
>
> **SEC-9 已修复。** 两份机密集合现已取并集（`.gpg`、`.config/gcloud`、`.config/gh`、`.git-credentials`、`_netrc`、`.pypirc` 原先仅存在于 sidecar 侧；`.cognia`、`.npmrc`、`.pgpass`、`id_rsa`、`id_ed25519`、`known_hosts` 原先仅存在于 CLI 侧）。CLI 侧新增符号链接解析与双分隔符切分，两侧现均在 macOS 与 Windows 上大小写折叠；CLI 的路径键清单补入 `workdir`、`output`、`oldPath`/`newPath`、`pathA`/`pathB` 以及数组型 `paths[]`。两个强制点仍刻意分离——Cognia 不应信任运行在被约束进程内的检查——但数据不再漂移。已验证：16/16 条凭据路径被拒，普通项目路径仍放行。
>
> **P0-13 已修复。** supervisor 路径（在所有生产接线下真正执行的那条）现已记录 pid，因此 `get_tracked_processes` 不再恒为空，`get_process_manager_status` 不再对一个不可能非空的注册表宣称 `enabled: true`，`terminate_process` 也不再拒绝它刚刚启动的 pid。
>
> **P1-5 部分修复。** `list_shells` 在宿主失败时抛出错误，而不是报告「零个 shell」；`git_stage` 改为报告索引中真实暂存的内容（当路径被忽略或无变更时，`git add` 会以 0 退出却什么都没暂存）。该发现中其余的吞错点未改动。
>
> **仍未修复：** SEC-5（核心）、**SEC-10、SEC-11**，**P0-3、P0-5、P0-10、P0-12**，**P1-2、P1-3、P1-6、P1-7** 及 P1-5 的其余部分，以及 **§7 的其余部分**。§9 的实施章节未改动。

---

## 1. 摘要

按仓库当前实际强制的那把尺子衡量，工具面是健康的：metadata↔实现的 parity 门禁全绿，1428 个 sidecar 测试全过。而缺陷几乎全部落在**那道门禁看不见的地方**。

三个结构性事实解释了绝大部分发现：

1. **parity 门禁在很大程度上是同义反复。** 它断言 `READ_ONLY_TOOL_NAMES` 等于 `requiresApproval === false` 的集合——这只保证与 JSON 里那个值一致，从不检查那个值是否正确。`kill_shell` 被标为只读，门禁随即把这个错误值传播到四道权限门。同理 `TOOL_NAMES_BY_CATEGORY` 是从它所比对的同一份 JSON 派生出来的，所以只有 `coreFiles` 有真正的注册顺序门禁。
2. **工作区禁闭是按工具名逐个登记的，28 个写操作工具里有 23 个从未登记。** `classifyToolCallConfinement` 对三个硬编码集合之外的任何名字返回 `null`（无意见），而 `null` 随后满足下游每一处 `!== "ask"` 判断。
3. **`allowedTools` 在不同供应商上含义相反。** Anthropic 轨上它是「预批准」，完全不构成限制；AI-SDK 轨与 CLI 轨上它是穷尽白名单。

**可达性最高的缺陷**：在 `acceptEdits` 模式（常用、非默认）下，`file_binary_write` 与 `file_append` 被自动批准、对禁闭层不可见、且没有凭据兜底。把攻击者公钥写入 `~/.ssh/authorized_keys` 不会产生任何提示——与代码自称「在每种模式下都成立」的不变量直接矛盾。

规模：**83** 个 sidecar 内置 + **~35** 个宿主路由 + **5** 个 A2UI + **3** 个 native-Anthropic。**9** 个对标工具缺失，其中 **6 个其实已由 SDK 原生提供**。

---

## 2. 范围、分母与方法

**全量审计**（每个 handler 从头读到尾，每个声明的 schema 键都追到使用点或判定为幻想参数）：

| 家族                       | 事实来源                                | 数量 |
| -------------------------- | --------------------------------------- | ---- |
| A — sidecar 内置           | `lib/settings/builtin-tools-data.json`  | 83   |
| B — 宿主路由「提升为内置」 | 无——12 个分散的 `is*BuiltinTool()` 谓词 | ~35  |
| A2UI 桥                    | `sidecar/a2ui-tools/tool-defs.mjs`      | 5    |

**快速核查入附录**：`lib/plugin/registries/native-anthropic-tool-registry.ts`（3 个）。

**三条缺口轴：**

1. **契约自洽**（硬底线）——声明的参数必须被读取并生效。默认裁决是*把参数实现出来*。
2. **官方工具集**——只作盲点清单，不照抄。
3. **子系统可达性**——分母是 `CLAUDE.md` 里约 40 行的 Subsystem Map。

**单个工具的「完整」定义**：生效所有声明参数 · 响应 `AbortSignal` · 返回统一结果/错误信封 · 以与其副作用相符的档位登记进权限目录 · 声明壳可用性并有测试钉住。

**跨壳规则**：能力矩阵 + 可测降级。只有当宿主具备能力却未注入时，降级才算 _bug_；真正的环境限制保留降级，但必须返回指明原因的结构化错误。

**实测基线**（非假设）：`pnpm sidecar:test` → 1428 测试，1426 通过，0 失败。`pnpm lint:i18n` → OK，且其输出本身说明了它为何抓不到 §7 的 i18n 缺口：_"21065 literal refs, 1327 dynamic skipped"_。

**第一条基线比看上去窄**——见 P2-0。`sidecar:test:builtin` 只 glob 了八个目录、漏掉五个，导致 17 个 co-located 测试文件从不在 CI 中运行。直接执行它们是绿的（137 测试全过），但它们不构成任何门禁。其中之一是 `confinement.test.mjs`——正是钉住 SEC-1 与 SEC-2 背后那段分类逻辑的测试。

**并非通过运行时调用建立。** 行为结论来自阅读代码、运行现有测试套件、静态追溯依赖注入。下文有两条标注为「已实测」，因为子 agent 直接执行了 handler；其余均为静态结论。§12 列出这留下的敞口。

---

## 3. 严重度模型

- **SEC** — 系统就自身防护向**用户**陈述了不实内容。排在一切之上。
- **P0** — 系统向**模型**陈述不实：幻想参数、静默失败、吞掉的错误、广告了却已死的工具。它们让 Agent 基于错误前提推理。
- **P1** — 能用但不健壮：无取消、信封不一致、账目失准。
- **P2** — 卫生问题：测试缺失、目录缺失、死常量。

---

## 4. 安全发现

### SEC-1 — `acceptEdits` 自动批准了两个禁闭层看不见的写工具

`ACCEPT_EDITS_TOOL_NAMES`（`sidecar/dispatch/ai-sdk-tools.mjs:68-76`）包含 `file_append` 与 `file_binary_write`。二者都不在 `WRITE_TOOLS` / `READ_TOOLS` / `BASH_TOOLS`（`sidecar/builtin-tools/confinement.mjs:134-146`）中，故 `classifyToolCallConfinement` 在 `:198` 返回 `null`。自动批准的守卫条件是 `confVerdict !== "ask"`（`ai-sdk-tools.mjs:325`）——而 `null !== "ask"` 为真。两个 handler 都不调用 `assertNotSecretEscape`；该兜底全仓库仅 5 处调用：`core/write.mjs:58`、`core/edit.mjs:121` 与 `:154`、`core/notebook-edit.mjs:64`、`core/apply-patch.mjs:125`。

```jsonc
// acceptEdits 模式；fileExtras 默认开启（packages/agent-config-types/src/index.ts:211-224）
{
  "tool": "mcp__cognia-tools__file_binary_write",
  "path": "/Users/me/.ssh/authorized_keys",
  "data": "<base64 key>",
  "createDirectories": true,
}
```

无提示、无判定、无兜底。而 `ai-sdk-tools.mjs:229-231` 明写凭据路径拒绝「是在**每一种**模式下强制的硬安全不变量，包括 bypassPermissions」。事实并非如此。

`ACCEPT_EDITS_TOOL_NAMES` 的注释表明作者**确实**考虑过范围——它刻意排除了执行、进程、git 变更与重命名/移动。错误在于它纳入的两个工具，恰好是禁闭层零覆盖的那两个。

**修法**：把所有写操作工具加入 `WRITE_TOOLS`，并把 `collectPathTargets`（`confinement.mjs:155-166`）扩展到 `file_path`/`path`/`workdir` 之外；给每个 `file-ops/` handler 加上 `assertNotSecretEscape`。

### SEC-2 — 禁闭层只覆盖 28 个写操作工具中的 5 个

`classifyToolCallConfinement` 对以下工具**不给任何判定**：`apply_patch`、`Monitor`、`file_append`、`file_binary_write`、`file_copy`、`file_rename`、`file_move`、`directory_create`、`directory_delete`、`git_stage`、`git_commit`、`start_process`、`terminate_process`、`shell_execute_advanced`、`terminal_repl_spawn`、`terminal_repl_write`、`terminal_repl_kill`、`ast_grep_replace`、`clone_dep_source`、`web_clone`、`web_clone_convert`。

`directory_delete` 最尖锐：`fsp.rm(path, {recursive})`（`file-ops/directory-ops.mjs:48`）可作用于机器上任意目录，即便在 `bypassPermissions` 下也无判定。

雪上加霜的是 `collectPathTargets` 只读 `file_path`、`path`、`workdir`，不读 `source`、`destination`、`oldPath`、`newPath`、`directory`、`cwd`、`output`、`pathA`、`pathB`、`paths[]`、`globs[]`，也读不到 `apply_patch` 内嵌在 diff 正文里的路径——所以有几个工具即便加进集合也仍然采集不到目标。`:163-164` 的 `else if` 还意味着同时带 `file_path` 与 `path` 的工具永远只检查前者。

### SEC-3 — 读取侧泄漏了 `Read` 被拒绝读取的凭据

`confinement.mjs:18-19` 承诺「除机密外可读整机」。但只有 `read`/`ls`/`grep`/`glob` 享有那条拒绝。以下工具均为 `requiresApproval: false`，因而在计划模式、`dontAsk` 与 headless 下被自动放行：

| 工具             | 参数                                              | 效果                                                         |
| ---------------- | ------------------------------------------------- | ------------------------------------------------------------ |
| `content_search` | `directory`（`file-ops/content-search.mjs:42`）   | `{directory:"~/.ssh", pattern:"PRIVATE KEY"}` 返回**匹配行** |
| `file_diff`      | `pathA`,`pathB`（`file-ops/file-diff.mjs:18-19`） | 以补丁形式打印**完整文件内容**                               |
| `file_search`    | `directory`（`file-ops/file-search.mjs:15`）      | 枚举 `~/.aws`、`~/.gnupg`、`~/.kube`                         |
| `file_hash`      | `path`（`file-ops/file-hash.mjs:14`）             | 密钥轮换预言机                                               |

即：`Read("~/.ssh/id_rsa")` 被拒，而 `file_diff` 无需批准即可返回同样的字节。

### SEC-4 — `get_env` / `list_env` 以只读档位交出机密

二者均为 `requiresApproval: false`。`get_env` 接受 `revealSecrets: true`（`sidecar/builtin-tools/environment.mjs:83-108`）以绕过脱敏。模块注释 `:5-6` 声称该标志「由父层的逐次批准流程把关」——**并不存在这样的门**；`revealSecrets` 在该文件外没有任何消费者。sidecar 自身的 `process.env` 携带 `ANTHROPIC_API_KEY` 与 `CLAUDE_CODE_OAUTH_TOKEN`（`sidecar/dispatch/subprocess-env.mjs:12`，由 `subprocess-env.test.mjs:27-29` 断言）。

在计划模式（`ai-sdk-tools.mjs:262-270`）、`dontAsk`（`:286`）与 headless（`:358-364`）下均可达。headless 分支的注释说只读内置「无法变更宿主」——这话没错，但不相干：它们可以把宿主**外泄**出去。

### SEC-5 — `allowedTools` 在一条轨上是预批准，在另两条轨上是白名单

| 轨        | 语义                   | 证据                                                                                                                         |
| --------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Anthropic | **预批准；不构成限制** | 随包 `sdk.d.ts:1393-1399`：_「自动放行、不再提示的工具名……要限制可用工具，请改用 `tools` 选项。」_ cognia 从不设置 `tools`。 |
| AI-SDK    | **穷尽白名单**         | `ai-sdk-tools.mjs:141` `passesAllowList`                                                                                     |
| CLI 宿主  | **穷尽白名单**         | `cli/src/agent/tool-host/policy.ts:89`：_「非空白名单是穷尽的——未列出的一律排除。」_                                         |

配置了 `allowedTools: ["Read","Grep"]` 的角色，在 OpenAI/Gemini 上得到两个工具，在 Claude 上得到**全部**工具面。仓库自己的注释（`ai-sdk-tools.mjs:122`）把该字段称作「角色/技能/模式的工具白名单」，所以这个误解是内部既存的，而非潜在风险。

两个后果：

- allow 模式的工具过滤器取数于 `lib/tools/tool-catalog.ts`，其四个来源不含 SDK 原生工具——`Bash`、`Read`、`Task`、`EnterWorktree`、`TaskStop` 都不在这份 UI 自称完整的清单里（`build-options.ts:2057-2071`）。
- `SDK_CORE_TOOL_NAMES`（`lib/skills/recording/tool-catalog.ts:23-34`）只有 11 个名字。`intersectAllowedTools`（`:54-71`）切分生成技能的工具，`generate-skill.ts:104-110` 只保存 `kept`——于是 `ReadMcpResource` 被从产物里静默剥离，并被告知用户「不存在」，尽管 SDK 提供了它。

### SEC-6 — 受限模式与 IM 上限只拒绝 28 个写工具中的 5 个

`RESTRICTED_MODE_DENIED_TOOLS`（`lib/workspace/restricted-tools.ts:7-24`）与 IM 字面量（`lib/claude/build-options.ts:2878-2887`）是两份手工维护的清单，覆盖同样的五个逻辑工具。两边都缺：`apply_patch`、`Monitor`、`kill_shell`、全部 7 个 `file-ops` 写工具、`git_stage`、`git_commit`、`start_process`、`terminate_process`、`shell_execute_advanced`、全部 3 个 `terminal_repl_*`、`ast_grep_replace`、`clone_dep_source`、两个 `web_clone*`，以及 `get_env`/`list_env`。

因此一条入站的 Telegram/Slack/Discord/飞书消息可以触达 `directory_delete`、`shell_execute_advanced` 和 `terminal_repl_spawn`——一个不受禁闭的 PTY。`lib/connectors/im-permission-ceiling.ts:25-58` 是正交的：它只拒绝技能、computer-use、OCR 与调度工具。

**正确的清单其实早已存在，只是没插上电。** `CORE_MUTATING_TOOL_NAMES`（`sidecar/builtin-tools/core/core-tools.mjs:55-63`）的文档写着「受限模式 / IM 通道拒绝这些」，且**确实**包含 `apply_patch` 与 `Monitor`——但全仓库对它的引用只有自身定义与自身测试。`isRestrictedTool`（`restricted-tools.ts:33-38`）同理，它是唯一会拒绝整个 `mcp__cognia-plugin-tools__` 前缀的谓词，却只被自己的测试引用，而 `build-options.ts:2899-2906` 用的是裸数组。两者都违反工作规则 7——在类型上有文档、未被强制、也未被测试钉为「刻意休眠」。

### SEC-7 — `kill_shell` 档位判错，且 metadata 自相矛盾

`kill_shell` 是 `requiresApproval: false`；`terminate_process` 是 `true`。二者都终止进程，且在同一份 JSON 里。这个错误值把 `kill_shell` 送进 `READ_ONLY_TOOL_NAMES`，于是它在计划模式、`dontAsk`、headless、受限模式与 IM 会话中一律自动放行。处于 UI 标称「只读」模式的 Agent 可以无提示杀掉用户的 dev server。

`terminal_repl_read` 形状相同：`requiresApproval: false`，但 `drain: true` 是**默认值**且会清空环形缓冲（`terminal-repl-tool.mjs:277-280`）——它自己的描述就写着「默认具破坏性」。

### SEC-8 — Anthropic 轨对插件/宿主工具没有任何计划模式约束

`grep -n '"plan"' sidecar/dispatch/anthropic.mjs` 无结果。`canUseTool`（`:467-545`）把计划模式整体委托给 SDK，而 SDK 只认识自己的原生工具，对 `mcp__cognia-plugin-tools__*` 一无所知。于是在 Claude 上的计划模式中，每个插件工具都可达：全部 23 个 `browser_*`（含 `browser_evaluate`、`browser_fill_form`）、7 个 computer-use 工具（含 `perform_action`）、`terminal_dock_write`、`ocr.extract`、`manage_scheduled_task`。AI-SDK 轨对这些全部在 `ai-sdk-tools.mjs:268` 抛错。

分歧是双向的：Anthropic 轨过于宽松，AI-SDK 轨则粗暴过严——真正只读的工具（`browser_snapshot`、`clipboard_history_list`、`terminal_dock_read_recent`）在那里被无谓拒绝。

### SEC-9 — CLI「镜像」是第二个、错法不同的实现

`cli/src/agent/tool-host/policy.ts:18-22` 自称是 `confinement.mjs` 的镜像。两者互不为超集。

|                  | sidecar `confinement.mjs`               | cli `policy.ts`                                                      |
| ---------------- | --------------------------------------- | -------------------------------------------------------------------- |
| 覆盖工具         | 18 个名字，其余一律 `null`              | **每一个**工具                                                       |
| 路径键           | 3 个                                    | 16 个 + 递归 `edits`/`files`/`operations`                            |
| `workdir`        | ✅                                      | ❌                                                                   |
| 符号链接解析     | ✅ `realpathSync.native`                | ❌ 纯字面                                                            |
| 大小写折叠       | 仅 Windows                              | ❌ 无                                                                |
| 路径切分         | `/[\\/]+/`                              | 仅 `path.sep`——Windows 上以 `/` 分隔的路径切出单段，全部检查失效放行 |
| 越界读           | allow                                   | 硬拒绝                                                               |
| 仅此侧的机密目录 | `.gpg`、`.config/gcloud`、`.config/gh`  | `.cognia`、`.npmrc`                                                  |
| 仅此侧的机密文件 | `.git-credentials`、`_netrc`、`.pypirc` | `.pgpass`、`id_rsa`、`id_ed25519`、`known_hosts`                     |

两边都未覆盖：`oldPath`/`newPath`、`pathA`/`pathB`、`output`、`paths[]`、`globs[]`、`apply_patch` 内嵌路径，以及任何 shell **命令文本**。`~/.config/gh/hosts.yml`（GitHub OAuth token）在 CLI 轨上无保护。

### SEC-10 — `bash` 没有允许清单，这让子系统黑名单沦为装饰

`BLOCKED_COMMANDS` / `ALLOWED_COMMANDS`（`sidecar/builtin-tools/safety.mjs:112,167`）只由 `validateShellCommand`（`:469`）强制，而它的调用方只有 `shell-advanced.mjs:53` 与 `process/inventory.mjs:228`。`core/bash.mjs` 对三者零引用——已验证。`bash` 虽被禁闭层分类，但只通过 `workdir`；`command` 字符串从不解析，故 `bash({command:"cat ~/.ssh/id_rsa"})` 采集不到目标、得不到判定。

对本次约定的「永不可达黑名单」——订阅/支付、备份恢复、密钥环、权限设置——的后果是：四者仅靠**没有类型化工具**来保护，而 `bash` 绕过了全部四者（`security find-generic-password` 既不在阻止清单也不在允许清单里）。此外 `node`、`python`、`deno`、`bun`、`ruby` 都在 `ALLOWED_COMMANDS` 中，所以连走允许清单的 `shell_execute_advanced` 也等同于任意代码执行。

另：`confinement.mjs:37-54` 保护 `.ssh`、`.aws`、`.gnupg` 等，却**不保护** `<app_data>/cognia/`——`vectors.sqlite`、设置存储、备份归档与订阅投影都在那里——而既定策略是「越界只读一律 allow」，连「ask」都不触发。

### SEC-11 — `SlashCommand` 是一座无门禁的提权桥

`runSlashCommandBuiltinTool`（`lib/claude/slash-builtin-tools.ts:104`）在无任何宿主侧批准的情况下，通过实时注册表分发任意已注册命令。其文档串（`:7-14`）声称内置 UI 命令只返回指引；但 `/remember` 有真实 handler 并执行真实记忆写入（`lib/slash-commands/actions/remember.ts:38`），且 `lib/slash-commands/actions/` 下还有 `billing.ts`。manifest 会向模型枚举多达 60 条命令（`:57-62`）。任何在工具层强制的黑名单在这里都被绕过。

### SEC-12 — 外部 agent 桥不做任何输入校验

`sidecar/cognia-tool-bridge.mjs:237` 对原始 JSON-RPC 参数直接 `def.handler(args ?? {}, {})`；zod shape 只用于*生成*对外广告的 schema（`:227`）。对全部 42 个文件/git/进程/环境工具，既无类型校验，**也不应用任何 `.default()`**。具体后果：`content_search` 的 `maxResults` 上限彻底消失（`length >= undefined` 恒为 false）、`shell_execute_advanced` **无超时**运行、`start_process` 得到 `NaN` 超时、`terminal_repl_read` 返回空串。另外 `:121-123` 会捕获任何 schema 转换失败并把该工具广告成**不接受任何参数**。

---

## 5. P0 — 系统对模型撒谎

### P0-1 — `bash` 把 spawn 失败报告为成功输出 _（已实测）_

`core/bash.mjs:324-328` 在 `child.on("error")` 时把错误信息追加到输出并调用 `finish({code: null})`；`:353` 计算 `failed = timedOut || (code !== 0 && code !== null)`，故 `null` 永不为失败，`:354` 返回不带 `isError` 的 `toolText(body)`。执行一个不存在的 shell 二进制返回 `{"content":[{"type":"text","text":"spawn /nonexistent ENOENT"}]}` 且 `isError: undefined`。模型会把 ENOENT 当作普通命令输出来读。

### P0-2 — schema 保真度取决于走哪条轨

`jsonSchemaPropToZod`（`sidecar/builtin-tools/plugin-tools.mjs:216-257`）只读 `type`、`items`、`description` 与顶层 `required`。它**静默丢弃** `enum`、`const`、`default`、`format`、`pattern`、`minLength`/`maxLength`、`minimum`/`maximum`、`minItems`/`maxItems`、`uniqueItems`、`additionalProperties`、`oneOf`/`anyOf`/`allOf`、`$ref`/`$defs`、**嵌套 `properties`** 与**嵌套 `required`**。`case "object"`（`:243-245`）把任何嵌套对象塌缩成 `z.record(z.string(), z.unknown())`。AI-SDK 轨则通过 `jsonSchema()`（`ai-sdk-tools.mjs:717`）原样透传，全保真。

最严重的三个：

- **`dispatch_agent`** —— `subagentId` 的 enum **就是**发现机制（`lib/claude/agents/dispatch-agent-tool.ts:92` 有明确注释）。在 Anthropic 轨上它退化为裸可选字符串，`dispatches` 退化为不透明记录数组，而 `parseDispatchAgentArgs` 会**静默丢弃**非法项（`:216-217`）——一次扇出可能悄悄缩水。
- **`working_set`** —— 丢失 4 值 `action` enum 和整个 `entry` 子 schema（3 个 enum、`required`、`summary` 1–512、`refs.maxItems:4`）。下游会重新校验，所以代价是重试而非正确性。
- **`terminal_dock_*`** —— 丢失 `additionalProperties:false`、`type:"integer"` 和全部边界；而 handler 对越界值的反应是**静默回落到默认值**（`lib/terminal/dock-tool-handler.ts:106-112`、`:200-203`），模型永远不知道自己的边界被忽略了。

### P0-3 — 宿主路由工具无法返回工具错误

`lib/claude/plugin-tool-ipc.ts:478-566` 的每个分支都返回 `{...baseResponse, result}`。通往真正 `tool-error` 的路径只有 `ai-sdk-tools.mjs:733` 与 `plugin-tools.mjs:160-162`，二者都以 `response.error` 为键，而那些分支从不设置它。失败的 `web_search`、`Skill`、`SlashCommand`、`team_*`、`vector_*`、`session_*`、`spawn_task`、`read_active_editor` 或 `working_set` 抵达模型时都是**成功**结果，只是载荷里写着 `ok:false` 或以字面量 `"Error: "` 开头。

### P0-4 — 外部 agent 桥上广告了已死的工具

`sidecar/cognia-tool-bridge.mjs:199-212` 既不传 `hostRpc` 也不传 `sessionId`，故 `Monitor`、`monitor_cancel`、`monitor_list` 永远返回 `"monitors are not available in this session"`（`core/monitor.mjs:157-159`、`:231`、`:253`）——却仍然出现在桥的 `tools/list` 中，因为 `visibleBuiltinTools`（`cli/src/agent/tool-host/policy.ts:79-98`）没有运行时可用性的概念。

### P0-5 — headless CLI 把通道对象当成能力

`agent-host.mjs:124` 无条件创建 `hostRpc`；`ai-sdk.mjs:556-558` 与 `anthropic.mjs:238-240` 随后依据它的**真值性**选择宿主后端 shell 注册表。而 `createHostRpc`（`sidecar/host-rpc.mjs:29-61`）没有握手，无法判断是否有人在监听。`grep -rn "host_rpc" cli/src/` 无结果——CLI 从不应答这些帧。于是在打包 CLI 下，每一次 `bash(run_in_background)`、`bash_output`、`kill_shell`、`list_shells` 与 monitor 调用都**停滞 30 秒后失败**，而可用的进程内 `createBgShellRegistry()` 作为死代码无人可达。对比 Rust 侧的显式降级（`src-tauri/src/jobs/mod.rs:82,87`）。

### P0-6 — `lsp`/`codeGraph` 静默消失，而设置开关仍显示开启

`sidecar/builtin-tools/index.mjs:169` 与 `:174` 以 `flag && resolver` 守卫注册，而 `namesForDisabledCategories`（`:284-296`）仅以 `!flag` 守卫拒绝清单。当 `flag === true` 且 `resolver === null` 时，两个分支都不覆盖这 14 个名字：它们**既未注册也未被拒绝**。由于 `disallowedTools` 是有明文记载的纵深防御（`anthropic.mjs:327-333`），一条陈旧的 `Character.allowedTools` 条目或一个被幻觉出来的 `mcp__cognia-tools__lsp_hover` 在 SDK 边界既不被服务也不被拒绝。

LSP 很容易进入该状态：`opts.lsp` 仅在 `(appSettings.lsp?.enabled ?? appSettings.builtinTools?.lsp) && !supportAgent && opts.cwd` 时被填充（`lib/claude/build-options.ts:2191-2192`），所以 `builtinTools.lsp === true` 配 `settings.lsp.enabled === false`、**或**支持型会话、**或**任何没有 `cwd` 的会话，都会落入缺口。codeGraph 只有缺 `cwd` 一种。

设置 UI 不给任何信号：`components/settings/tools/tool-settings-section.tsx:99` 只读静态 JSON 加持久化开关，把类别渲染为「开」并列出全部工具徽章，没有任何运行时可用性探测。`lib/tools/tool-catalog.ts:98-117` 同样无条件把每个内置标为 `enabled: true`。

相关：`lsp_diagnostics` 无法区分「宿主不可用」与「文件干净」。`sidecar/dispatch/lsp-resolver-factory.mjs:49` 在 resolver 为空时抛错，但 `:53` 返回 `[]`，被 `lsp.mjs:167-171` 渲染成 `"No diagnostics."`。其余四个 `lsp_*` 都正确地抛出 `toolError`。这是最危险的方向：模型会据此认定编辑通过了编译。

### P0-7 — 幻想参数，以及承诺了未实现行为的描述

- **`bash_output.from_offset`** —— 描述（`core/bash.mjs:88-91`）称*「读取从不消费，早先的区间随时可重读」*。但进程内注册表 `bash-sessions.mjs:124` 只解构 `{filter, maxChars}`，且 `:130` 推进游标。该参数是幻想的**且**读取会消费。这正是桥以及任何没有 `hostRpc` 的会话所使用的注册表。
- **`bash.detach`** —— 文档写「需配合 run_in_background」，却从不校验；且 `bash-sessions.mjs:50` 根本不读它，所以「分离」的 shell 仍会被 `killAll()` 回收，与「聊天会话结束后继续运行」矛盾。
- **`apply_patch`** —— 声称「全部 hunk 干净应用才写入，否则什么都不写」（`:32-33`、`:244`）。原子性只在 hunk *匹配*阶段成立；提交阶段（`:208-226`）没有 try/catch，第 N 个文件失败会裸抛，而 1..N-1 已经落盘。
- **`team_delegate`** 读取 `systemPrompt`（`lib/claude/team-builtin-tools.ts:818`），而它**根本没有在 schema 中声明**——一个未声明的参数。
- **`load_skill_resource`** —— `offset.minimum:0` 与 `limit.minimum:1/maximum:65536` 是幻想的；handler 只做裸 `typeof === "number"` 判断（`skill-builtin-tools.ts:178-179`）。
- 声明了却从不强制的 enum：`team_request_consensus.type`、`team_propose_decision.impacts`、`vector_search.filters[].operation`、`web_fetch.format`、`load_skill.skill_id`。
- **`file_delete` 并不存在。** `safety.mjs:478` 在命令被阻止时告诉模型*「请改用 file_delete / directory_delete / process 工具」*。全仓库不存在这样的工具——这条错误信息把模型引向一个不存在的工具。

### P0-8 — `ast_grep_replace` 在错误的目录里改写文件

`runSg` 以 `cwd: opts.cwd` 启动子进程（`sidecar/builtin-tools/ast-grep/run.mjs:166`），但 `execAstGrepSearch` 与 `execAstGrepReplace` 都只传**一个参数**（`ast-grep/index.mjs:49`、`:103`），故 `opts = {}`、`cwd` 为 `undefined`。子进程于是继承 **sidecar 进程的** cwd，而非 `sendOptions.cwd`。schema 中记载的默认值 `paths: ['.']`（`index.mjs:32`，在 `run.mjs:57` 解析）因此相对于 Tauri 或 CLI 启动 sidecar 的位置解析。`ast_grep_search` 返回令人困惑的空结果；`ast_grep_replace` 在 `dry_run:false` 时**写入一棵不相干的目录树**。

这与禁闭缺口叠加：`ast_grep_replace` 不在任何禁闭集合中，既不调 `assertPathInside` 也不调 `assertNotSecretEscape`，仅靠批准弹窗授权。它的两个同类写工具反而更规矩——`web_clone`/`web_clone_convert` 自我禁闭（`webclone/run.mjs:102,136`），`clone_dep_source` 禁闭到解析出的 git 根。

### P0-9 — 被截断的 `ast-grep` 改写被报告为干净成功

`ast-grep/run.mjs:224-235` 的输出体积分支杀掉子进程并返回 `{...parsed, truncated:true, truncatedReason:"output size"}`，**不带 `error` 字段**，于是 `index.mjs:113` 走 `toolText` 分支，`format.mjs:76` 渲染出 `[APPLIED] changed N matches in M files` 且 `isError` 未设置。一次**写到一半被 SIGKILL** 的 `--update-all` 改写，抵达模型时是一次已完成的操作。

相邻问题：`run.mjs:106` 通过 `if (!Array.isArray(parsed)) return { matches: [], totalMatches: 0 }` 丢弃 ast-grep 返回的 JSON _对象_（其错误载荷形状），渲染成 `"No matches found."`——与真正的零结果搜索无法区分。

### P0-10 — 五个 A2UI 工具无条件报告成功

`dispatch` 就是 `emit({type:"a2ui_dispatch", …})`（`sidecar/a2ui-tools/index.mjs:69-71`）——一次即发即忘的 stdout 写入，没有任何确认。每个 handler 都返回 `{ok:true, dispatched:true}`；`try/catch` 只在 `emit` 本身抛错时才触发。于是 `a2ui_update_components`、`a2ui_data_model_update`、`a2ui_delete_surface`、`a2ui_handle_connector_action` 对**不存在的 `surfaceId`**、已断开的渲染端或已销毁的窗口，一律报告成功。`dispatched: true` 只意味着「已写入 stdout」——模型无从知道用户是否真的看到了那个界面。

### P0-11 — `codegraph_impact` 报告一个它自己知道是错的影响面数字

`sidecar/builtin-tools/code/tools.mjs:207-209` 的注释称 `impactCount`「始终反映真实的爆炸半径大小」。而 `code/graph.mjs:46` 在 `MAX_RESULTS = 500`（`:16`）处提前返回且不设任何标志，所以在任何大到值得分析的图上，这个数字都只是下界而非总数——而影响分析恰恰是 Agent 用来判断一次改动是否安全的工具。它的 co-located 测试用的是极小的图，从未触到这个上限。

同文件相关项：`codegraph_status` 被描述为*「开销小——先调它」*，而 `run()`（`tools.mjs:87`）会 await `syncStale()` → `ensureIndexed()` → 一次全仓库 tree-sitter 构建。

### P0-12 — `Task` 被处理但从未被广告

`buildDispatchAgentManifestEntry` 只发出 `dispatch_agent`（`lib/claude/agents/dispatch-agent-tool.ts:153`）。`Task` 在 `plugin-tool-ipc.ts:653` 作为别名被接受，并出现在 `NEVER_PRUNE_TOOLS`（`build-options.ts:821`）与 `PLAN_ALLOWED_PLUGIN_TOOLS`（`ai-sdk-tools.mjs:57`）中——为一个任何 manifest 都不包含的名字提供剪枝保护和计划模式豁免。

### P0-13 — 进程追踪在结构上是坏的

`start_process` 的 supervisor 路径（`process/lifecycle.mjs:60-75`）不调用 `trackedPids.add` 就返回；只有回退路径（`:78-87`）会填充它——而回退路径在**所有生产接线下都不可达**，因为 `index.mjs:164` 总是提供 `bgShells`。因此 `get_tracked_processes` 恒返回空，`get_process_manager_status` 对一个结构上不可能非空的注册表报告 `{enabled: true, trackedCount: 0}`，而 `terminate_process` 会以*「pid N 不是本会话启动的」*拒绝几秒钟前刚由 `start_process` 启动的 pid。在桥上更糟：`createBgShellRegistry` 不导出 `killByPid`（`bash-sessions.mjs:209`），故 `terminate_process` 拒绝**每一个** pid，而 `start_process` 本来也只返回 `pid: null`。`trackedPids` 还是跨全部并发会话共享的模块级状态（`process/inventory.mjs:17`），尽管每条提示语都写着「本会话」。

---

## 6. P1 — 能用，但不健壮

### P1-1 — 没有任何内置工具响应 `AbortSignal`

系统性问题。`ai-sdk-tools.mjs:101` 以字面空对象调用 `def.handler(effective, {})`；`options.abortSignal` 仅用于约束批准门（`:659`、`:720`）。`plugin-tools.mjs:141` 干脆不接受 `extra`，桥亦然（`cognia-tool-bridge.mjs:237`）。有两个模块已为 signal 布好线却从未收到：`core/rg.mjs:157,168` 与 `ast-grep/run.mjs:135,167`。

后果：用户中断无法停止进行中的 `bash`、`Monitor` 长轮询（最长 24 小时，`core/monitor.mjs:29`）、耗时数分钟的 `grep` 或 PDF 抽取。120 秒的只读兜底（`read-only-timeout.mjs`）是*放弃*而非取消 handler——它在 `:84-87` 显式地把孤儿分离出去。`web` 与 `vector` 都声明了 `signal` 依赖，而生产解析器从不填充它。

一处值得记录的内部不一致：`read-only-timeout.mjs:70-77` 刻意保持其定时器 REF'd，并附注释解释 unref 会让事件循环在等待中途排空——而 `plugin-tools.mjs:84` 恰恰 unref 了自己的定时器。

### P1-2 — 至少五种互不兼容的结果形状

| 形状                          | 例子                                                                                                  |
| ----------------------------- | ----------------------------------------------------------------------------------------------------- |
| `{ok, code?, error?}`         | `web-builtin-tools.ts:124`、`working-set-tool.ts:80-160`、`vector-builtin-tools.ts:229`               |
| `{available, reason?/error?}` | `editor-builtin-tools.ts:96,101,115`——且在同一个联合里 `error` 与 `reason` 混用                       |
| 裸字符串                      | `slash-builtin-tools.ts:100-115`、`team-builtin-tools.ts` 的大部分                                    |
| `{ok, reason}`                | 四个 `terminal_dock_*`（`dock-tool-handler.ts`）——用 `reason` 而非 `error`                            |
| 裸数组 / 裸对象               | `team_read_memory`、`team_list_members`、`task_get`、`team_propose_decision`、`twin_knowledge_search` |

`skill-builtin-tools.ts` 与 `team-builtin-tools.ts` 各自在文件内部就使用了不止一种形状。`web_fetch` 把 `ok` 复用为 HTTP 状态标志，所以 404 会产生 `ok:false` 且**没有 `error` 字段**（`web-tools-core.ts:445`）。

### P1-3 — `timeoutMs: 0` 抹掉了两个工具唯一的恢复路径

`ask_user` 与 `dispatch_agent` 声明 `timeoutMs: 0`（`ask-user-tool.ts:84`、`dispatch-agent-tool.ts:161`），这使 `awaitPluginToolResponse` 根本不创建定时器（`plugin-tools.mjs:70-93`），120 秒安全网失效。AI-SDK 轨在中断时会结算挂起调用（`ai-sdk.mjs:1580-1583`）；Anthropic 轨则依赖 `drainPendingRoundTrips`（`anthropic.mjs:120-154`），因为 `Query.interrupt()` 不触碰它们。

但排空只结算 *sidecar 侧*的 promise，什么都没有传回渲染端：`plugin-tool-ipc.ts:643-647` 从不把 `abortSignal` 转发给 `runAskUser`，而 `stores/agent/ask-user-store.ts` 没有取消路径——**回合被杀死后模态框仍留在屏幕上**，用户最终作答时其 `toolUseId` 已被删除，回复被静默丢弃。在 CLI headless（`cognia run`）中 `ask_user` 被无条件 manifest 却没有任何应答方，回合会永久阻塞。

### P1-4 — 计划模式白名单与 `ask_user` 分歧

`PLAN_ALLOWED_PLUGIN_TOOLS`（`ai-sdk-tools.mjs:57`）有 3 个名字；`PLAN_ALLOWED_HOST_TOOLS`（`policy.ts:58-63`）有 4 个，多出 `ask_user`。实际二者等价，因为 `ask_user` 在读取模式之前就被短路（`ai-sdk-tools.mjs:210-214`）。但两份清单仍应收敛为单一共享常量——这是潜在而非活跃的分歧。计划模式真正的缺口是 SEC-8。

### P1-5 — 被吞掉、读起来像干净结果的错误

- `diagnosticsAfterWrite` 在任何 LSP 失败时返回 `""`（`core/write.mjs:47-49`），于是 `edit`/`write`/`apply_patch` 把「干净」与「LSP 崩了」渲染成同一个样子。
- `list_shells` 在任何 `jobs.list` RPC 失败时返回 `[]`（`bash-host-sessions.mjs:200-207`）——30 秒超时读起来就是「没有 shell」。
- `statOrNull`（`shared/fs-stat.mjs:14-20`）吞掉一切，故 `file_exists` 把 `EACCES` 报成 `{exists:false}`。
- `file_search`/`content_search` 传 `suppressErrors: true`，于是权限拒绝的子树不可见，而部分遍历被报告为 `truncated: false`。
- `git_repo_inspect` 有三处 `.catch(() => null)`，于是 detached HEAD、未出生分支、无上游与 `git` 崩溃在成功信封里都是 `null`。
- `detectRipgrep` 返回 `null` 不可观测（`core/rg.mjs:51-58`）——5 秒 PATH 探测超时与「未安装 rg」完全相同，随后 JS 回退以不同的 gitignore 保真度和不同的上限运行，且不告知模型。
- `git_stage` 无条件回显 `staged: args.paths`，哪怕 `git add` 实际什么都没暂存。
- `directory_create` 对已存在目录返回 `{created: true}`。

### P1-6 — 未声明的上限、截断与超时

以下没有一条出现在任何抵达模型的 `.describe()` 中。代表性的一组：`grep` 把行裁到 1000 字符，JS 回退上限为 2000 匹配 / 50 000 文件 / 单文件 4 MB；`read` 上限为每行 2000 字符、输出 256 KB、PDF 50 页、图片 5 MB；`content_search` **静默**跳过大于 5 MB 的文件，并通过 `dot:false` 硬排除所有 dotfile——而 `respectGitignore` 参数对此有强烈误导；gitignore 取反（`!pattern`）被静默丢弃（`core/gitignore.mjs:45`）；git 工具共享 30 秒超时与 16 MB 捕获上限，且**只有 `git_diff` 应用 256 KB 显示上限**；进程快照可能有 1.5 秒陈旧且无标记；`terminal_repl` 在空闲 10 分钟后杀掉会话，而下一次读取报告 `{exited:true, exitCode:null}`，与崩溃无法区分。

另有 codegraph 侧一整组：行数上限 100、源码字节上限 12 000（`code/tools.mjs:21-22`）、BFS 上限 500（`code/graph.mjs:16`，即 P0-11 的成因）、索引器 5 MB 跳过、上下文预算 24 000→9 000 字符。ast-grep：匹配上限 100、超时 30 秒、stdout 10 MB。clonedeps：manifest 上限 5、克隆超时 120 秒、`--depth 1`。webclone：任务超时 180 秒。

两条比「未声明」更糟：

- **`rg` 超时以成功收场。** `core/rg.mjs:175-208` 在 30 秒杀掉子进程，然后 resolve `{stdout: <部分>, code: 0, truncated: false}`——`grep` 把一次不完整扫描呈现为完整结果。
- **`edit` 的模糊匹配器**使用 `BLOCK_ANCHOR_THRESHOLD = 0.65`（`core/fuzzy-replace.mjs:15`）——它会替换与 `old_string` 仅 65% 相似的代码块，而描述只说「容忍空白差异的策略」。

### P1-7 — 不同失败原因产生相同消息

`"file not found"` 在 `read`、`edit`、`notebook-edit`、`apply_patch`、`file_hash`、`file_diff` 中同时覆盖 ENOENT、EACCES、ELOOP 与 ENOTDIR。`apply_patch` 把「无 hunk 匹配」与「hunk 匹配歧义」报成同一句，而它给出的建议只对其中一种有效。`"pid N 不是本会话启动的"` 既用于外来 pid，也用于本会话刚启动的 pid。git 的兜底分支对通常只是「PATH 里没有 git」的情况建议「重启 sidecar」（`git/run.mjs:68-71`）。codegraph 的 `no indexed symbol matches` 覆盖四种不同成因：符号确实不存在、文件超过 5 MB 被静默跳过、被 ignore glob 排除、或语法解析器加载失败导致整文件解析为零节点。

---

## 7. P2 — 卫生

### P2-0 — 17 个 co-located sidecar 测试文件从不在 CI 运行

`.github/workflows/test.yml` 运行 `pnpm sidecars:test` → `sidecar:test` → `sidecar:test:builtin`，其 glob 覆盖 `__tests__/`、`shared/`、`core/`、`file-ops/`、`process/`、`git/`、`code/`、`code/languages/`——**不含** `builtin-tools/*.test.mjs`（顶层）、`ast-grep/`、`clonedeps/`、`webclone/`、`a2ui-tools/`。而 Jest 整体排除 `/sidecar/`（`jest.config.ts:123`）。

被遗漏的：`confinement.test.mjs`、`exit-plan.test.mjs`、`index.test.mjs`、`plugin-tools.test.mjs`、`result-cap.test.mjs`，`ast-grep/` 下 5 个、`clonedeps/` 下 4 个、`webclone/` 下 2 个，以及 `a2ui-tools/tool-defs.test.mjs`。直接执行：**137 个测试，137 通过**。它们并没有坏——只是不构成任何门禁，所以它们覆盖的工具（`ast_grep_*`、`clone_dep_source`、`web_clone*`）拥有真实测试却零回归保护；而 `confinement.test.mjs` 钉住的正是 SEC-1/SEC-2 背后的分类逻辑，却从不运行。

`sidecar/package.json:14` 有**另一份互不相交**的 glob，它覆盖了上述目录却漏掉 `__tests__/`——而且没有任何地方调用它，因为根脚本调用的是 `sidecar:test:builtin` 而非 `pnpm --dir sidecar test`。两份 glob，都不完整。

**修法**：确立唯一权威 glob，并加一条检查断言 `sidecar/` 下每个 `*.test.mjs` 都被它匹配。

### P2-1 — 其他卫生问题

- **缺失 `webclone/dist/` 会拖垮整个工具服务器。** `sidecar/builtin-tools/webclone/run.mjs:19-25` 静态导入 `../../webclone/dist/index.js`，该目录被 gitignore（`.gitignore:158`）且仅由 `prebuild` 产出。由于 `builtin-tools/index.mjs:24` 在顶层导入 webclone 类别——不像 ast-grep 的惰性二进制探测或 terminalRepl 的惰性 `node-pty` require——缺失 `dist/` 会导致**全部 83 个内置工具**失败，而非仅两个 webclone 工具。
- **缺失 co-located 测试**：`sidecar/builtin-tools/core/todo.mjs`（`core/` 下唯一没有的）、`sidecar/a2ui-tools/index.mjs`、`sidecar/dispatch/anthropic.mjs`（700+ 行，含整个 `canUseTool` 门）、`sidecar/dispatch/lsp-resolver-factory.mjs`、`code/store*.mjs`、四个 `code/languages/*.mjs`。`lib/` 侧：`lib/claude/computer-use-active-settings.ts`、`lib/claude/chat-middleware/feature-flag.ts`、`lib/claude/agents/subagents/` 下 6 个文件。家族 B 是干净的：16/16 齐备。
- **非 co-located 的 sidecar 测试**：`environment.mjs`、`shell-advanced.mjs`、`terminal-repl-tool.mjs` 的测试在 `__tests__/` 而非源文件旁。
- **A2UI 缺席于每一份目录与每一条策略。** `lib/tools/tool-catalog.ts` 聚合四个来源，A2UI 一个都不在；它也完全不在 `builtin-tools-data.json` 中，因此这 5 个工具**在任何地方都没有 `requiresApproval` 或 `riskLevel`**，被排除在 `READ_ONLY_TOOL_NAMES` 与 `namesForDisabledCategories` 之外，且无法被查看、过滤或用 `allowedTools` 管控。它们只在 Anthropic 轨注册（`anthropic.mjs:287`）——`ai-sdk-tools.mjs` 中零命中——所以 OpenAI/Gemini/本地会话没有任何交互界面，只能回退到 ` ```a2ui ` 围栏块。其 `alwaysLoad: true` 是在调用点以字面量传入，而非像内置服务器与用户服务器那样经 `serverAlwaysLoad()`（`anthropic.mjs:247`、`:270`），所以即便用户专门开启工具搜索来压缩提示，它们仍占据缓存前缀。`sidecar/a2ui-tools/index.mjs:4` 与 `:62` 的文档串说「四个桥工具」，实际有五个——这个计数早于 `a2ui_handle_connector_action`，而同级的 `a2ui-mcp.mjs:5-7` 是对的。
- **`fileExtras`、`git`、`process` 缺少注册顺序门禁。** 只有 `CORE_TOOL_NAMES` 有真门禁。`FILE_EXTRAS_TOOL_NAMES`（`file-ops/index.mjs:37-51`）已经与 JSON 的顺序不一致，而两个文件都把提示缓存前缀稳定性列为顺序重要的理由。
- **`desktopOnly` 是死标志。** 在 `lib/settings/builtin-tools.ts:50` 声明并设在 `coreFiles` 上，无人读取。工作规则 7：在类型上有、UI 里没有、测试没钉。
- **死绑定**：`taskStatusSchema`（`core/tasks.mjs:22`）从未被引用——真正的 enum 内联在 `:44`。`TaskList`（`:276`）是四个任务工具中唯一没有 try/catch 的。`codeGraphResolver` 未出现在 `collectCogniaToolDefs` 的 JSDoc 中（`index.mjs:134-141`）。
- **桥从不 dispose。** `lsp-resolver-factory.mjs:6-7` 与 `codegraph-resolver-factory.mjs:6` 都写明调用方 MUST 调 `dispose()`；`anthropic.mjs:827` 与 `ai-sdk.mjs:1674` 遵守，`cognia-tool-bridge.mjs` 不遵守——被拉起的语言服务器、SQLite 存储与文件监视器会存活到进程结束。
- **9 个缺失的 i18n key。** `builtin-tools-data.json` 声明 83 个 `descriptionKey`，实际只有 74 个存在。在**两个语言**、split 源文件与单体文件中都缺失：`toolSettings.tools.codegraph{Status,Search,Node,Callers,Callees,Impact,Context,Explore,Files}`。它们在 `components/settings/tools/tool-settings-section.tsx:385` 经 `t(tool.descriptionKey)` 消费——正是 `lint:i18n` 跳过的动态引用。由于未配置 `getMessageFallback`，面板会渲染出字面 key 路径并记录一条 `IntlError`；不会崩溃。

---

## 8. 子系统可达性

分母为 `CLAUDE.md` 的 Subsystem Map。逐行大表因篇幅从略，结论如下。

### 统领性发现：可达性是倒置的

`lib/external-bridge/mcp-server/server.ts` 向**外部** MCP 客户端暴露约 30 个丰富工具——`memory_search`、`memory_store`、`rag_search`、`wiki_search`、`schedule_task`、`connectors_*`、`runtime_query`、`workflow_*`。而 `build-options.ts:2157,2161` 仅从用户配置的服务器构建 `opts.mcpServers`，从不接入自身这座桥。**一个通过桥接入的第三方 Claude Code 实例，在 cognia 内部的能力严格强于 cognia 自己的 Agent。** 下列清单的大部分，只要给这座已存在的服务器接上一个带权限作用域的进程内客户端即可关闭。

**完全不可达**（按缺口代价排序）：长期记忆（0069）· 内容捕获（0060）· 原生视频处理（`crates/cognia-media`，整个 crate 带插件 API 却零消费者）· Attention Radar（0060）· 光学压缩（0063）· 公共分享链接（0037）· 平台连接器（0009）· Wiki lint（0060）· 其后是会话锚点/永久链接（0094）、语音/TTS（0075）、性能面板（0035）、桌面选区感知（0095）、市场集成（0026）、插件 Dexie 表、WebRTC 传输（0021）、移动同步（0027）、CLI↔App 桥（0078）、桌面宠物（0058）、风险→仪式策略（0070），以及外部桥自身（0008）。

**可读不可写、而写显然有用**：Pro IDE（有 `read_active_editor`，无 `reveal_in_editor`/`open_diff`）· 技能录制器（`record_skill_status` 可读，无开始/停止/回放）· 数字孪生（`twin_knowledge_search` 可读且仅限团队会话，无摄入工具）· OCR（抽取可用，但 `lib/db/ocr-results.ts` 中的既存结果不可读，被迫重复 OCR）· SCM（11 个 `git_*` 包的是 git CLI 而非 `crates/cognia-git`，故 Agent 看不到面板的暂存状态）· `/goal`（只读注入，无法回写进度）。

**脆弱——仅经可被用户禁用的插件可达**：调度器最尖锐（`plugins/cognia-scheduler-tools` 是**唯一**路径），其次是可视化工作流（禁用后只剩 `wf_run_workflow_typed`）、computer use、嵌入式浏览器、OCR、工作区后端。五个插件 API 面——`integrations`、`templates`、`media`、`perf`、`memory`——**完全没有消费者**：接缝造好了，插头从未插上。

### 「永不可达黑名单」目前无法真正强制

订阅/支付、备份恢复、密钥环、权限设置面都没有类型化工具，这是对的——但 SEC-10 表明 `bash` 无论如何都能触达全部四者，SEC-11 表明 `SlashCommand` 绕过任何工具层清单。黑名单只有在**触达真正发生的地方**强制才有意义：在 `isSecretPath`、在 `bash` 自身的命令处理、在 slash 注册表的分发路径。

---

## 9. 实施章节

### 9.1 九个「缺失」工具中有六个已经原生存在

`sidecar/node_modules/@anthropic-ai/claude-agent-sdk/sdk-tools.d.ts` 声明了 `EnterWorktreeInput`（:2922）、`ExitWorktreeInput`（:2932）、`TaskStopInput`（:704）、`ListMcpResourcesInput`（:714）、`ReadMcpResourceInput`（:761）、`ReadMcpResourceDirInput`（:751）。cognia 对它们零引用。逐一静态追溯每道过滤器——`enforceAnthropicToolSurface`、`allowedTools` 转发、三处 `disallowedTools` 来源、`namesForDisabledCategories`、`buildMcpDisallowedToolNames`——未发现任何一处会丢弃它们，因此在默认会话中它们**今天就应该**在 Anthropic 轨可达。**这是静态结论，也是首先需要实测确认的一条。**

因此工作不是「新建九个工具」，而是：

1. 在真实会话中验证 Anthropic 轨可达性。
2. 修 `SDK_CORE_TOOL_NAMES`（`lib/skills/recording/tool-catalog.ts:23-34`），并把 SDK 原生工具作为第五个来源加入 `lib/tools/tool-catalog.ts`。两处都很小，却能止住误导性的「未知工具」报告与不完整的过滤器清单（SEC-5）。
3. 之后再按下表的成本升序做 AI-SDK 轨对等实现。

### 9.2 AI-SDK 轨对等实现的建造顺序

| 工具                             | 成本                 | 已有什么 / 缺什么                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| -------------------------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TaskStop`                       | **最低**             | `stopTask` 端到端已存在——`sidecar/dispatch/control.mjs:34` 已放行，能力 `tasks.background` `:71`，句柄 `agent-execution-handle.ts:137`，`sdk-subagent-bridge.ts:122` 在每次 `task_started` 时注册取消。目前仅人工可触发（`subagent-part.tsx:286`、`job-center-panel.tsx:509`）。只缺工具包装与权限档位。                                                                                                                                                                                                                                |
| `ListMcpResources`               | 低–中                | `listResources()` 已在调用（`mcp-runtime-gateway.mjs:69-84`），其元数据已被类型化、传输——然后**丢弃**：`components/settings/mcp/mcp-server-card.tsx` 只渲染 `toolCount`。需要把活跃客户端从 `ai-sdk-mcp.mjs:385` 引出。                                                                                                                                                                                                                                                                                                                 |
| `ReadMcpResource` / `…Dir`       | 中                   | 同样的管道，外加一道**新的 URI 形权限门**：`isMcpToolPermitted`（`ai-sdk-mcp.mjs:364`）按带命名空间的工具名过滤，无法表达资源 URI。注意 `readResource` 在全仓库**从未被调用**。                                                                                                                                                                                                                                                                                                                                                         |
| `ListPlugins` / `SearchPlugins`  | 低                   | `wf_list_plugins`（`plugins/workflow-ai/src/tools/resource-tools.ts:185`）已验证读取路径；元数据不敏感；无作用域不变量。四个发现类工具中最便宜的。                                                                                                                                                                                                                                                                                                                                                                                      |
| `ListSkills` / `SearchSkills`    | 低，但**被策略阻塞** | `wf_list_skills` 已返回完整无作用域表——但在聊天中提供它会破坏一条刻意的不变量：`invocationPolicy: "explicit"` 排除（`build-options.ts:1027-1031`）与 `session.disabledSkillIds`，由 `lib/skills/runtime-loader.ts:76-78` 强制。**实施前需要一个产品决策。**                                                                                                                                                                                                                                                                             |
| `EnterWorktree` / `ExitWorktree` | **最高**             | `crates/cognia-git/src/worktree.rs` 有全部 11 个操作，但只有 5 个有 Tauri command（`commands.rs:280-314`）——`add_managed`、`remove_managed`、`lock`、`unlock`、`create_branch_here` 没有。此外还缺：sidecar 侧的 allowed-roots 注册（`registerDialogPathInRust` 仅渲染端可用）、**可变的会话级 `cwd`**（目前只在构造期，`index.mjs:150`）、禁闭重定作用域、`SessionExecutionContext` 持久化，以及三份拒绝清单的补充。`WorktreeCreate`/`WorktreeRemove`/`CwdChanged` 已作为 hook 事件存在（`lib/claude/hooks/event-catalog.ts:67-71`）。 |

关于会话任务图上的 `TaskStop`（区别于 SDK 后台任务）：目前没有可供「停入」的终态。`core/tasks.mjs:22` 声明 `pending`/`in_progress`/`completed`；`"deleted"`（`:44`）是抹除而非记录。且 `:203` 把任何非 `completed` 的前置视为永久阻塞，所以被停止的任务会永久卡死它所阻塞的一切。任务状态也是进程内的，id 每个 sidecar 进程从 `"1"` 重新开始（`:92-93`），所以重启后一份引用任务 `"3"` 的持久化转录可能静默绑定到另一个任务。

### 9.3 子系统工具，按既定策略

策略：只读一律可达；写按副作用分档；订阅/支付、备份恢复、密钥环与权限面永不可达——**按 §8 强制，而非靠工具缺席**。

价值最高且全部只读（因而无需门禁）：`memory_search`/`memory_list`、`capture_list`/`capture_get`、`radar_read`、`optical_archive_read`、`share_links_list`、`ocr_results_query`、`wiki_lint_read`、`connectors_inbox_read`。每一个在外部桥或某张 Dexie 表里都已有可用实现，工作量在暴露而非逻辑。值得分档的写侧候选：`goal_record_progress`、`twin_ingest`、`skill_recording_start/stop`、`reveal_in_editor`。

---

## 10. 门禁改造——让这类缺陷不可能再发生

不做这些而只修单点，同类缺陷会自由重现。

1. **让 parity 测试超越同义反复**（`sidecar/builtin-tools/__tests__/metadata-parity.test.mjs`）：
   - 断言每个 `descriptionKey` 在**两个**语言下都能解析（可抓住 §7 的 9 个 key）；
   - 断言每个 `requiresApproval: true` 的工具都已在 `confinement.mjs` 中分类；
   - 在 metadata 中增加一个声明式副作用字段，并断言 `requiresApproval` 由它派生，使 `kill_shell` 不可能与 `terminate_process` 相矛盾；
   - 为 `fileExtras`、`git`、`process` 补注册顺序门禁。
2. **让拒绝清单由数据派生。** 用一个计算集合替换 `RESTRICTED_MODE_DENIED_TOOLS` 与 IM 字面量——所有 `requiresApproval: true` 的工具，加 `kill_shell`、`terminate_process`、`get_env`、`list_env`，同时发出裸名与带命名空间两种形式，并加一条测试：出现未被覆盖的新写工具即失败。把 `CORE_MUTATING_TOOL_NAMES` 与 `isRestrictedTool` 接上电，而不是继续休眠。
3. **给家族 B 一份清单。** 仿照 `builtin-tools-data.json`：名称、风险、批准档位、壳可用性，外加一条把它与 `is*BuiltinTool()` 级联绑定的 parity 测试。今天新增一个宿主路由工具要改三个文件且无编译期关联，而级联的优先级本身已不一致——`web_*`/`Skill`/`working_set`/`vector_*` 遮蔽插件，而 `ask_user`/`dispatch_agent`/`Task`/`terminal_dock_*` 反被插件遮蔽（`plugin-tool-ipc.ts:478-661`）。
4. **把路径策略抽取为共享的零 `@/` 包。** sidecar 与 CLI 可以保留各自的强制点——那条约束是「不信任被约束的进程」——但可以共享*数据*。加一条测试断言两侧运行时集合相等。
5. **转发 `AbortSignal`。** 在 `ai-sdk-tools.mjs:101`、`plugin-tools.mjs:141` 与 `cognia-tool-bridge.mjs:237` 三处各改一行，就能解锁两个已经布好线的模块。
6. **统一家族 B 的结果信封**，并让 `plugin-tool-ipc.ts` 能够返回 `{error}`，使失败的宿主路由工具以工具错误的形式抵达模型。
7. **裁定 `allowedTools` 的含义**并在边界处适配。要么在 Anthropic 轨设置 SDK 的 `tools` 选项使其成为真白名单，要么在另两条轨上改名。一个字段两种含义无法长期存活。
8. **确立权威的 sidecar 测试 glob**（P2-0），并加一条检查断言 `sidecar/` 下每个 `*.test.mjs` 都被匹配。在此之前，本文其他每一处修复都可能在五个目录里静默回归——包括 SEC-1 与 SEC-2 背后的禁闭逻辑。
9. **在外部 agent 桥上校验输入。** `cognia-tool-bridge.mjs:237` 应当用它本来就构造了的 zod shape 去 `parse`，而不是原样透传 JSON-RPC 参数。仅此一处改动，就能在该轨上为全部 83 个内置恢复每一个 `.default()`、`.min()`、`.max()` 与 `.enum()`（SEC-12）。

---

## 11. 对 2026-07-18 那份笔记的修订

均已回代码复核，未继承其结论。其中三条已不成立：

- **「待办 #2 —— 推送式监控」已关闭。** `Monitor`、`monitor_cancel`、`monitor_list` 今天已在 `coreFiles` 类别中发布，由 Rust `crates/cognia-jobs` 支撑。笔记仍将其列为未建。
- **「待办 #3 —— 检查点/回退与 worktree 生命周期工具」已部分失效。** `EnterWorktree`/`ExitWorktree` 由 SDK 原生提供，而 SDK 自有的检查点控制（`readFile`、`rewindFiles`、`seedReadState`）已在 `checkpoint` 能力后存在（`sidecar/dispatch/control.mjs:15-39`），并已在 `components/chat/checkpoint-action.tsx` 暴露。真正缺失的是 Agent 侧的访问，而非机制本身。
- **它自己的验证契约未被满足。** 该笔记要求「英文与中文工具目录消息保持一致」；而 9 个 `codegraph_*` key 在两个语言中都缺失（§7）。
- 它关于可等待 `bash_output`/`list_shells` 已关闭的说法在桌面成立，但在外部 agent 桥与 headless CLI 上不成立（P0-4、P0-5）。

`ADR-0002` 在此议题上同样陈旧：它列出五个 `builtinTools` 类别，实际有十二个。那属于 ADR 变更，留待单独决策。

---

## 12. 附录与覆盖边界

**已快速核查，未发现 P0 级缺陷**：`lib/plugin/registries/native-anthropic-tool-registry.ts`——三个第一方 Anthropic 工具（`computer_20251124`、`bash_20250124`、`text_editor_20250728`），其契约不由本仓库控制。

**已全量覆盖**：家族 A 全部 83 个、家族 B 约 35 个、A2UI 5 个——每个 handler 从头读到尾，每个声明参数都已追踪。

**明确未覆盖：**

- 插件贡献的工具（`plugins/**`），除 §8 的可达性问题外。约 23 个 `browser_*`、7 个 computer-use 与 `wf_*` 家族未逐个审计。
- 来自用户配置的 MCP 服务器工具。
- 运行时行为。未驱动真实桌面会话，也未通过调用工具来证明某道门的行为，除标注*已实测*的两处外。§9.1 中六个 SDK 原生工具的 Anthropic 轨可达性是静态结论，排期前应先实测确认。
- Windows 与 Linux 的路径行为由代码推断而非执行验证。若干发现（SEC-9 的 `path.sep` 切分、大小写折叠）与平台相关。
- 严重度按可达性与影响面排序，而非按利用难度。除两处已实测的 handler 执行外，未构造任何 PoC。
