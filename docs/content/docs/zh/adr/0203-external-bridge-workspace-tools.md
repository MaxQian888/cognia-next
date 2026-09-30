---
title: "0203 — External Bridge 工作区、Git 与 Shell 工具"
description: "本地 MCP 客户端通过 loopback External Bridge 获得受限的开发机能力：在按客户端授权的工作区根目录上列出/读取/搜索/写入文件、只读 Git 与受监管的 Shell 任务；同时引入面向模型的结果词汇（pending/continuation、决策完备的失败、输入钳制、任务 attention）和由工具自身声明的审计投影。借鉴 WebCodex，但不引入其代码。"
---

# ADR 0203 — External Bridge 工作区、Git 与 Shell 工具

**状态：** 已接受
**日期：** 2026-09-29
**相关：** [ADR-0008](./0008-external-bridge)（External Bridge；远程暴露仍然推迟）、[ADR-0062](./0062-external-agent-session-import)（外部 Agent 观测）、[ADR-0155](./0155-plugins-reach-the-host-through-one-door)（唯一宿主入口）、[ADR-0196](./0196-a-library-crate-links-tauri-only-when-asked)、[ADR-0201](./0201-the-desktop-browser-runs-chromium-locally)（`browser_*` 采用相同的信封拆分）

## 背景

路线图 `docs/plans/2026-09-29-webcodex-evaluation-and-bridge-roadmap.md` 研究了 WebCodex，结论是它对 Cognia 的价值在于协议纪律而非拓扑。对照代码复核后，路线图的若干前提需要修正：

- 宿主的 `fs_*_workspace` 命令会把路径限制在传入的根目录内，但对本地渲染进程传入的任意绝对根目录都照单全收。如果只是“薄注册”，等于暴露了整块磁盘。
- `SENSITIVE_FILE_NAMES`（`crates/cognia-files`）只在 `fs_walk_workspace` 中隐藏凭据；读取、列目录和内容搜索仍会返回 `.env`。
- `cognia-jobs` 中担心的 pgid 复用窗口并不存在：进程组信号只会在组长尚未被回收时、由持有它的任务发出。
- 渲染进程此前只能启动归属于定时任务的 job。
- 审计日志从不记录参数，“绝不记录原始参数”本来就成立；按工具投影是增加信息，而非删减。
- 路线图中基于 hook 的“外部 Agent 观测”与 ADR-0062 重复：后者已能导入并实时监听 Claude Code、Codex 等十余种 Agent 的会话历史。

## 决策

### 四个默认关闭的权限范围，一组十六个工具

| 权限范围 | 工具 |
| --- | --- |
| `workspace:read` | `workspace_roots`、`workspace_list`、`workspace_read`、`workspace_search` |
| `workspace:write` | `workspace_write`、`workspace_edit`、`workspace_move`、`workspace_delete` |
| `git:read` | `git_status`、`git_diff`、`git_log`、`git_show` |
| `shell:run` | `shell_run`、`job_output`、`job_list`、`job_kill` |

路线图中单独的 `jobs:run` 并入 `shell:run`：每条命令都以受监管 job 运行，启动与读取/停止属于同一授权。不提供任何 Git 写操作。

执行只复用已有宿主能力：`lib/files/workspace-fs`、`lib/git/commands` + `readWorkspaceDiff`，以及经由 `lib/jobs/background-jobs` 的 `cognia-jobs` 监管器。渲染进程核心为 `lib/external-bridge/handlers/workspace.ts`；MCP sidecar 通过现有 orchestration proxy 转发 `workspace_tool`，与 `browser_tool` 完全一致。

### 按客户端、按 id 授权根目录

`ExternalBridgeSettings.workspaceGrants` 将调用方（`mcp:stdio`，或 HTTP 凭据对应的 `mcp:<clientId>`）映射到 `WorkspaceRoot.id`。工具只接受根目录 id 与相对路径；绝对路径、盘符/UNC 前缀和 `..` 一律拒绝而非修正。没有授权即没有根目录，与权限范围无关。授权入口：设置 → External Bridge → 工作区访问。

### 两级路径策略

`lib/external-bridge/workspace/path-policy.ts` 基于共享的 `isSensitiveResourcePath`，补充 Rust 与 sidecar 谓词中已有的凭据名称和目录，以及 `.git` 内部文件：

- **secret**：所有工具一律拒绝，包括目录列表、搜索命中、Git 状态和差异；
- **bulk**（`node_modules`、`target` 等，即 `SNAPSHOT_SKIP_DIRS`）：扫描时跳过，按名称仍可读取。

读取符号链接会被拒绝（其目标无法参与分类）。命令中出现 secret 路径时升级为应用内确认；这只是绊线而非沙箱，`shell:run` 的说明明确告知命令以用户自身权限运行。

### 确认与出站闸门

`classifyCommand` 为 `deny` 时直接拒绝；为 `ask` 或命令涉及凭据路径时，每次都通过 consent broker 在应用内询问（询问前后清除会话授权，“始终允许”不会延续）。每次删除同样询问。文件内容、匹配行、差异、提交信息与任务输出先做 PII 脱敏，再必须通过 `hasNoLeakingPiiDeep`。写入或编辑的文本若含脱敏占位符则拒绝，避免把脱敏后的内容写回覆盖原文。Git 日志不返回作者邮箱。

### 面向模型的结果词汇（`lib/external-bridge/tool-result.ts`）

- **Pending/continuation**：超出等待预算的工作返回 `executionState: "pending"` 以及确切的 `continuation` 调用。
- **决策完备的失败**：沿用 `code`，并附 `failureStage`、`stateChanged`、`outcomeUnknown`（处理器中途抛错）以及至多一个 `followUp`，其 `mechanicallyFollowable` 表明能否原样执行。`runWithGate` 对所有工具的权限拒绝（`scope_denied`）与处理器异常（`handler_error`，结果未知）都采用此形状。
- **轮次经济**：人体工学类输入（字节预算、等待、分页大小）被钳制并在 `adjusted` 中报告；身份类输入一律失败关闭。
- **被动 attention**：`jobs://exited` 按 owner session 路由给启动该 job 的客户端，按字节上限、仅投递一次地附带在该客户端下一次工作区类工具结果中。

`structuredContent` 只携带这些控制字段；工作区数据放在 `<untrusted_content>` 围栏的文本块中（与 ADR-0201 相同的拆分）。

### 工具自有的审计投影

`runWithGate` 接受工具声明的 `audit` 投影（根目录 id 与路径，或仅命令首词）。`auditProjection` 最多保留八个有界标量；无法投影则不记录。结果存于 `McpAuditLogRow.projection`，并显示在审计面板的行详情中。

### 归属客户端的 job

`background_job_spawn_bridge`（仅桌面本地，`client.local`）以 owner session `external-bridge:jobs:<client>` 启动 job；Rust 侧校验 id 字符集，使其无法冒充聊天会话。`background_job_wait` 暴露现有的 `jobs.wait` 长轮询。每会话 job 上限约束每个客户端。

### 插件对齐

`plugin_tool_invoke` 现在还要求与插件清单中工作区类权限对应的 bridge 权限范围（`filesystem:read` → `workspace:read`，`filesystem:write` → `workspace:write`，`shell:execute` / `process:spawn` / `tests:run` / `python:execute` / `notebook:execute` → `shell:run`）。MCP server 负责盖上调用方的有效权限范围，渲染进程据此核对插件清单。

## 否决方案

- 引入 `webcodex-runner` / `webcodex-server` 代码、通过 `externalBin` 运行，或由插件持有监听器（见路线图“明确否决”）。
- 基于 hook 的 `record_external_observation` 工具：ADR-0062 的实时会话导入已从外部 Agent 自身历史中完成观测。
- 通过 relay 实现远程可达（路线图 Phase 3）：在 ADR-0008 的远程暴露决策连同 relay 身份设计重新开启之前，`bind_mode = "relay"` 继续被拒绝。
- 全局的 trusted/restricted 权限开关：按权限范围、按根目录、按调用的确认更精细。

## 影响

- 本地 MCP 客户端可以在用户授予的根目录中完成真实的文件、Git 与命令工作，且仅限于此。
- `shell:run` 是 bridge 最强的授权，设置中的说明如实告知。
- 有意保留的问题：job 监管器从不从内存表中移除已结束的 job。该泄漏早于本 ADR，另行跟踪。
