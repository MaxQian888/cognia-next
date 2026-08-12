# Multica vs. Cognia — External Evidence and Gap Analysis (2026-08-12)

## Scope and evidence standard

This note examines Multica as a benchmark for Cognia's agent-team and remote-runtime work. It
uses first-party repository source, versioned documentation, release records, and GitHub project
metadata. It deliberately does **not** treat the aspirational `VISION.md` as shipped behavior.

- Repository: [`multica-ai/multica`](https://github.com/multica-ai/multica)
- Commit inspected: [`b904e6b71c02ee6ebad6fa5340d685a8dbdc38f2`](https://github.com/multica-ai/multica/tree/b904e6b71c02ee6ebad6fa5340d685a8dbdc38f2)
- Commit timestamp: `2026-08-12T01:26:03+08:00`
- Latest release at review time: [`v0.4.23`, published 2026-08-11](https://github.com/multica-ai/multica/releases/tag/v0.4.23)
- Review date: `2026-08-12` (Asia/Shanghai)

Cognia was reconciled against committed baseline
[`f33c74295588cfbdce97cecc99f1f0638d5ec6e6`](https://github.com/MaxQian888/cognia-next/tree/f33c74295588cfbdce97cecc99f1f0638d5ec6e6)
plus the local working tree on `2026-08-12`. The checkout was heavily dirty, so anything absent from
that commit is labeled **working-tree-only** rather than counted as shipped.

Evidence labels used below:

- **Shipped** — documented as current behavior and corroborated by implementation, schema,
  executable entry points, tests, or release history.
- **Documented claim** — stated by the README/current docs, but not independently exercised in
  this review.
- **Planned** — explicitly future-facing, issue-only, feature-flagged, or described as a future
  direction in source comments.
- **Not found** — no first-party implementation or documentation was located at the checked SHA;
  this is a bounded repository finding, not proof that an external/private service cannot do it.

## Executive readout

Multica is best understood as a **server-authoritative operating layer for human + coding-agent
work**, not as a model host or a general chat client. Its core loop is:

```text
shared issue / chat / webhook / schedule
  -> durable server-side task
  -> runtime-specific queue
  -> daemon on a connected computer claims the task
  -> local coding-agent CLI executes against a workdir
  -> progress, tool activity, result, usage, comments and PR state return to the shared record
```

The most consequential gap relative to Cognia is therefore not "more agents". Cognia already has
substantial local agent-team task, board, scheduler, workflow, and worktree machinery. Multica's
advantage is that **the workspace, issue, comments, assignee, task queue, runtime availability, and
review history are one multi-user server record**, while any connected daemon can be an execution
worker. The server keeps the coordination state; the machine keeps the code, CLI login, and command
execution boundary. This split is explicit in the current docs and architecture
([run path and boundary](https://github.com/multica-ai/multica/blob/b904e6b71c02ee6ebad6fa5340d685a8dbdc38f2/apps/docs/content/docs/how-multica-works.mdx#L8-L38),
[daemon/server responsibilities](https://github.com/multica-ai/multica/blob/b904e6b71c02ee6ebad6fa5340d685a8dbdc38f2/apps/docs/content/docs/daemon-runtimes.mdx#L8-L24),
[PostgreSQL authority and realtime recovery](https://github.com/multica-ai/multica/blob/b904e6b71c02ee6ebad6fa5340d685a8dbdc38f2/apps/docs/content/docs/developers/architecture.mdx#L72-L118)).

That advantage comes with meaningful caveats:

1. Agent processes are deliberately unsandboxed by default and inherit the daemon user's filesystem,
   credentials, home directory, and unrestricted network access.
2. Multica has session continuity and explicit issue/project/skill context, but no shipped,
   platform-owned semantic memory layer; a code comment calls that a long-term answer.
3. It has execution telemetry and operational metrics, but no first-party agent-evaluation or
   quality-regression subsystem was found.
4. The repository calls itself open source, but its custom license forbids third-party hosted or
   embedded commercial services without a commercial license and restricts removal of branding.
   It should be treated as **source-available under the Multica License**, not as plain Apache-2.0.

## What Multica ships

### 1. Product scope and system of record

Issues are the durable unit of shared work: title/description, status, priority, assignee, dates,
labels, custom properties, project/sub-issue relationships, activity, execution logs, and agent
results live together. An assignee may be a human, agent, or squad; one issue can accumulate many
agent tasks without overwriting earlier runs
([issue model](https://github.com/multica-ai/multica/blob/b904e6b71c02ee6ebad6fa5340d685a8dbdc38f2/apps/docs/content/docs/issues.mdx#L8-L39),
[issue/task separation](https://github.com/multica-ai/multica/blob/b904e6b71c02ee6ebad6fa5340d685a8dbdc38f2/apps/docs/content/docs/issues.mdx#L41-L74)).
The same server-side issues can be rendered as list, board, table, Gantt, or swimlane views
([current UI claim](https://github.com/multica-ai/multica/blob/b904e6b71c02ee6ebad6fa5340d685a8dbdc38f2/apps/docs/content/docs/issues.mdx#L76-L85)).

This is a stronger collaboration contract than a locally persisted agent-team board: comments,
status changes, assignments, run records, runtime state, and PR state have one authoritative
workspace scope and are visible to multiple members in real time.

### 2. Runtime fabric and execution semantics

A daemon discovers installed agent CLIs, registers one runtime per `(computer, tool, workspace)`,
keeps a persistent connection, receives server wakeups, and polls as a backstop. It heartbeats every
15 seconds; the server normally marks a lost daemon offline within about three minutes. Queued work
waits up to two hours, interrupted work fails and may retry, and a restarted daemon re-registers and
reclaims unfinished work
([dispatch and heartbeat behavior](https://github.com/multica-ai/multica/blob/b904e6b71c02ee6ebad6fa5340d685a8dbdc38f2/apps/docs/content/docs/daemon-runtimes.mdx#L51-L64)).

The queue is runtime-bound: when a selected runtime is offline, the task waits rather than migrating
to another computer. Defaults are 20 concurrent tasks per daemon and 6 per agent; the effective cap
is the smaller limit
([assignment execution](https://github.com/multica-ai/multica/blob/b904e6b71c02ee6ebad6fa5340d685a8dbdc38f2/apps/docs/content/docs/assigning-issues.mdx#L25-L42),
[concurrency](https://github.com/multica-ai/multica/blob/b904e6b71c02ee6ebad6fa5340d685a8dbdc38f2/apps/docs/content/docs/daemon-runtimes.mdx#L68-L78)).
The task state machine distinguishes `deferred`, `queued`, `dispatched`,
`waiting_local_directory`, `running`, `completed`, `failed`, and `cancelled`, and preserves every
run record
([task lifecycle](https://github.com/multica-ai/multica/blob/b904e6b71c02ee6ebad6fa5340d685a8dbdc38f2/apps/docs/content/docs/tasks.mdx#L8-L54)).

This is a real distributed control plane, but not a general-purpose scheduler: a task is intentionally
pinned to the agent's selected runtime, and custom runtimes must implement an already-supported
protocol family rather than introduce an arbitrary new execution protocol.

### 3. Providers and model selection

Multica does not ship models. It invokes agent CLIs already installed and authenticated on the
runtime host. The README names 20 runtime families; the current provider matrix has 21 visible tool
identities because Oh-My-Pi is represented separately while sharing the Pi protocol family. The
matrix covers Claude Code, Codex, Cursor, Copilot, OpenCode/OpenClaw, Kimi, Hermes, Pi/Oh-My-Pi,
Reasonix, Qoder variants, Qwen variants, and others, and records session-resume, managed-MCP, and
skill-injection support per CLI
([runtime list](https://github.com/multica-ai/multica/blob/b904e6b71c02ee6ebad6fa5340d685a8dbdc38f2/README.md#L147-L166),
[provider capability matrix](https://github.com/multica-ai/multica/blob/b904e6b71c02ee6ebad6fa5340d685a8dbdc38f2/apps/docs/content/docs/providers.mdx#L19-L45)).

Models are discovered from the runtime/tool/account and retain the upstream CLI's entitlement and
authentication semantics. If no model is chosen, the CLI default is used
([model source](https://github.com/multica-ai/multica/blob/b904e6b71c02ee6ebad6fa5340d685a8dbdc38f2/apps/docs/content/docs/providers.mdx#L47-L57)).
This buys breadth and avoids model custody, but means model catalogs, billing, approval behavior,
and some failure semantics remain provider-specific.

### 4. Context, sessions, skills, MCP, and integrations

Multica's context model is explicit rather than retrieval-centric:

- an issue contributes description, discussion, metadata, agent instructions, model, skills, and
  runtime configuration;
- a project contributes its name, description, repository list, refs, and optional local-directory
  binding, plus `.multica/project/resources.json`
  ([project resource injection](https://github.com/multica-ai/multica/blob/b904e6b71c02ee6ebad6fa5340d685a8dbdc38f2/apps/docs/content/docs/project-resources.mdx#L8-L33));
- chats can attach project context and attempt to resume the original CLI session; if the local
  session is gone, a fresh session starts while server message history remains
  ([chat context and resumption](https://github.com/multica-ai/multica/blob/b904e6b71c02ee6ebad6fa5340d685a8dbdc38f2/apps/docs/content/docs/chat.mdx#L8-L42));
- workspace skills are `SKILL.md` bundles with optional references, templates, and scripts; they can
  be created, URL-imported, file-imported, copied from a runtime, bound to many agents, and injected
  through each CLI's native discovery path
  ([skill packaging/import](https://github.com/multica-ai/multica/blob/b904e6b71c02ee6ebad6fa5340d685a8dbdc38f2/apps/docs/content/docs/skills.mdx#L8-L59),
  [binding and trust warning](https://github.com/multica-ai/multica/blob/b904e6b71c02ee6ebad6fa5340d685a8dbdc38f2/apps/docs/content/docs/skills.mdx#L61-L87));
- 16 provider identities currently accept Multica-managed MCP configuration; configuration is
  materialized or forwarded per provider
  ([provider matrix](https://github.com/multica-ai/multica/blob/b904e6b71c02ee6ebad6fa5340d685a8dbdc38f2/apps/docs/content/docs/providers.mdx#L67-L85),
  [frontend allowlist implementation](https://github.com/multica-ai/multica/blob/b904e6b71c02ee6ebad6fa5340d685a8dbdc38f2/packages/core/agents/mcp-support.ts)).

There is also a substantial Composio connection/tool-router implementation and UI, but it is behind
the `composio_mcp_apps` feature flag and the repository's own package README labels parts of its
surface as MVP/roadmap. It should be counted as **gated implementation**, not as an unconditional
headline feature
([SDK scope and roadmap](https://github.com/multica-ai/multica/blob/b904e6b71c02ee6ebad6fa5340d685a8dbdc38f2/server/pkg/composio/README.md),
[feature-gated agent surface](https://github.com/multica-ai/multica/blob/b904e6b71c02ee6ebad6fa5340d685a8dbdc38f2/packages/views/agents/tabs/agent-mcp-tab.tsx)).

### 5. Memory: useful continuity, not yet platform-owned durable memory

All documented tools support session resumption, with Multica persisting the provider session ID and
falling back to a fresh session if it cannot resume
([session semantics](https://github.com/multica-ai/multica/blob/b904e6b71c02ee6ebad6fa5340d685a8dbdc38f2/apps/docs/content/docs/providers.mdx#L59-L65)).
Issue comments, project descriptions, metadata, and skills are durable, explicit memory channels.

However, Multica deliberately disables Codex native auto-memory by default because it is opaque and
can leak context across tasks/workspaces. The implementation says the long-term answer is a
Multica-owned, user-visible, project- or issue-scoped memory store — wording that makes the absence
of that store explicit at this SHA
([memory isolation and future direction](https://github.com/multica-ai/multica/blob/b904e6b71c02ee6ebad6fa5340d685a8dbdc38f2/server/internal/daemon/execenv/codex_memory.go#L11-L48)).
Provider-local persistence (for example Hermes session/state work in `v0.4.23`) should not be
confused with a platform-wide semantic memory, retrieval, conflict-resolution, or provenance model.

### 6. Agent coordination and automation

Four first-class trigger sources converge on the same task mechanism: assignment, comment mention,
chat, and Autopilot. Agents can post progress/results as comments and update the issue status under
their own identity; task completion and issue completion deliberately remain separate
([trigger and progress behavior](https://github.com/multica-ai/multica/blob/b904e6b71c02ee6ebad6fa5340d685a8dbdc38f2/apps/docs/content/docs/assigning-issues.mdx#L25-L42)).

**Squads** provide leader-mediated routing. The leader is invoked first, receives a roster and fixed
operating protocol, delegates via exact `@mention` links (which create new tasks), records an
evaluation event, then stops. Later member comments re-trigger the leader for the next decision.
This is genuine multi-agent coordination, but it is issue/comment-driven and mainly sequential; it
is not a free-form DAG engine or a synchronized shared-context swarm
([squad dispatch protocol](https://github.com/multica-ai/multica/blob/b904e6b71c02ee6ebad6fa5340d685a8dbdc38f2/apps/docs/content/docs/squads.mdx#L29-L64)).

**Autopilots** hold a runbook, agent/squad assignee, optional project/subscribers, and schedule or
webhook triggers. They can either create an issue for reviewable work or create a run-only task.
Webhook delivery has event filters, idempotency keys, signature support, replay records, rate limits,
and delivery history; high sustained failure rates automatically pause the automation
([modes and schedules](https://github.com/multica-ai/multica/blob/b904e6b71c02ee6ebad6fa5340d685a8dbdc38f2/apps/docs/content/docs/autopilots.mdx#L8-L59),
[webhook and reliability behavior](https://github.com/multica-ai/multica/blob/b904e6b71c02ee6ebad6fa5340d685a8dbdc38f2/apps/docs/content/docs/autopilots.mdx#L59-L141)).

No first-party visual DAG/node workflow authoring surface was found. Multica's higher-level
orchestration primitives are issues/sub-issues/stages, squads, and Autopilots.

### 7. Git, worktrees, and pull-request review

Project resources support ordinary Git URLs and runtime-managed checkouts, plus Desktop-selected
local directories. Repository-backed work uses separate worktrees by default for concurrency;
direct local-directory work is explicitly unsandboxed and serialized on the real path
([resource types and worktree behavior](https://github.com/multica-ai/multica/blob/b904e6b71c02ee6ebad6fa5340d685a8dbdc38f2/apps/docs/content/docs/project-resources.mdx#L8-L64)).

The GitHub App auto-links pull requests to issues through issue identifiers and mirrors PR state,
diff size, CI, mergeability/conflicts, and stale snapshots into issue detail. A merged PR with close
intent can move the issue to `done` when no other linked PR remains open. GitHub integration is
read-only; the agent pushes/opens PRs through credentials and CLIs on its runtime host
([GitHub scope and switches](https://github.com/multica-ai/multica/blob/b904e6b71c02ee6ebad6fa5340d685a8dbdc38f2/apps/docs/content/docs/github-integration.mdx#L8-L40),
[PR linkage and review data](https://github.com/multica-ai/multica/blob/b904e6b71c02ee6ebad6fa5340d685a8dbdc38f2/apps/docs/content/docs/github-integration.mdx#L44-L84)).
Self-hosted deployments additionally support Forgejo, Gitea, and GitLab webhook mirrors.

### 8. Deployment, clients, and collaboration

The server stack is Go REST/WebSocket + Next.js + PostgreSQL 17/pgvector, deployable through Docker
Compose or Helm. Execution daemons stay on user-controlled laptops, remote machines, containers, or
VMs; Cloud and self-hosted deployments share the same data/execution boundary
([self-host architecture and install](https://github.com/multica-ai/multica/blob/b904e6b71c02ee6ebad6fa5340d685a8dbdc38f2/SELF_HOSTING.md#L1-L50)).

Clients include:

- web;
- Electron Desktop for macOS, Windows, and Linux, with a bundled daemon, per-workspace tabs, and
  auto-update
  ([desktop behavior](https://github.com/multica-ai/multica/blob/b904e6b71c02ee6ebad6fa5340d685a8dbdc38f2/apps/docs/content/docs/desktop-app.mdx#L8-L69));
- an Expo/React Native iOS client buildable from source. It is not in the App Store, and Android is
  not available
  ([mobile limitations](https://github.com/multica-ai/multica/blob/b904e6b71c02ee6ebad6fa5340d685a8dbdc38f2/apps/docs/content/docs/mobile-app.mdx#L8-L22)).

Workspaces support `owner`, `admin`, and `member` roles, while each agent separately scopes who can
invoke it (`Only me`, selected members, or whole workspace). Admins can manage agents but cannot
bypass an agent owner's invocation scope
([workspace roles](https://github.com/multica-ai/multica/blob/b904e6b71c02ee6ebad6fa5340d685a8dbdc38f2/apps/docs/content/docs/members-roles.mdx#L8-L29),
[agent access](https://github.com/multica-ai/multica/blob/b904e6b71c02ee6ebad6fa5340d685a8dbdc38f2/apps/docs/content/docs/agents-create.mdx#L80-L104)).
Slack, Feishu/Lark, DingTalk, and WeCom can trigger agent chats and issue creation; sender binding and
workspace membership are checked on each message. DingTalk and WeCom are community-maintained, and
WeCom currently requires a single backend replica
([channel capability and limitations](https://github.com/multica-ai/multica/blob/b904e6b71c02ee6ebad6fa5340d685a8dbdc38f2/apps/docs/content/docs/channels.mdx#L8-L28),
[identity and deployment rules](https://github.com/multica-ai/multica/blob/b904e6b71c02ee6ebad6fa5340d685a8dbdc38f2/apps/docs/content/docs/channels.mdx#L36-L86)).

### 9. Security and governance

Multica is unusually explicit about its execution risk: by default an agent child process has the
full permissions of the daemon OS user, unrestricted network, the real `HOME`/`XDG_*`, host CLI
credentials, bypassed approvals, Codex `danger-full-access`, and Claude
`--permission-mode bypassPermissions`. The recommended isolation boundary is a dedicated OS user,
container, or VM
([security boundary](https://github.com/multica-ai/multica/blob/b904e6b71c02ee6ebad6fa5340d685a8dbdc38f2/apps/docs/content/docs/security-model.mdx#L8-L32),
[unsandboxed defaults](https://github.com/multica-ai/multica/blob/b904e6b71c02ee6ebad6fa5340d685a8dbdc38f2/apps/docs/content/docs/security-model.mdx#L34-L48)).

Blast-radius reductions do exist: per-task workdirs, task-scoped Codex state, and task/agent-bound
temporary API tokens. Runtime privacy, workspace roles, agent invocation scopes, audit logs around
sensitive configuration, and encrypted credentials for several integrations provide control-plane
governance. But `custom_env` values are stored plaintext in the server database, and MCP secrets
follow the same storage/display model
([credential warning](https://github.com/multica-ai/multica/blob/b904e6b71c02ee6ebad6fa5340d685a8dbdc38f2/apps/docs/content/docs/agents-create.mdx#L106-L128)).

### 10. Observability, evaluations, and portability

Shipped observability includes per-run streaming transcripts/tool events/errors, status timing,
classified failure reasons, retry records, token/cost aggregation per issue/agent/runtime, usage
dashboards, daemon logs/disk usage, health/readiness endpoints, and optional Prometheus metrics on a
separate management listener
([execution log](https://github.com/multica-ai/multica/blob/b904e6b71c02ee6ebad6fa5340d685a8dbdc38f2/apps/docs/content/docs/tasks.mdx#L56-L84),
[CLI run/usage surfaces](https://github.com/multica-ai/multica/blob/b904e6b71c02ee6ebad6fa5340d685a8dbdc38f2/apps/docs/content/docs/cli.mdx#L229-L288),
[Prometheus endpoint](https://github.com/multica-ai/multica/blob/b904e6b71c02ee6ebad6fa5340d685a8dbdc38f2/SELF_HOSTING_ADVANCED.md#L561-L581)).

No evaluation dataset, scorer, prompt/model A/B runner, quality benchmark registry, regression gate,
or human-review calibration subsystem was found. The squad command named `activity ... evaluation`
records a leader's routing decision; it is not an LLM evaluation framework.

For portability, code and provider credentials can remain on runtime machines, skills use portable
folder bundles, the product is API/CLI-driven, and a self-hosted operator owns the PostgreSQL data
and can `pg_dump` it before forward-only migrations
([backup procedure](https://github.com/multica-ai/multica/blob/b904e6b71c02ee6ebad6fa5340d685a8dbdc38f2/apps/docs/content/docs/self-host-quickstart.mdx#L281-L308)).
No documented one-click workspace export/import bundle, cloud-to-self-host migration tool, or
provider-neutral archive format for issues/comments/tasks was found.

## Claims and plans that should not be counted as shipped

The README says everything it lists is live, and its current feature list is broadly supported by
the checked docs and source. The separate vision document explicitly says it describes the future,
including broader knowledge-work use, automatic transformation of conversations into structured
plans, evidence gathering, and several agents moving work in parallel
([future narrative](https://github.com/multica-ai/multica/blob/b904e6b71c02ee6ebad6fa5340d685a8dbdc38f2/VISION.md#L43-L90),
[its own disclaimer](https://github.com/multica-ai/multica/blob/b904e6b71c02ee6ebad6fa5340d685a8dbdc38f2/VISION.md#L94-L98)).

The following should therefore be treated carefully:

- **General knowledge-work operating system** — a declared direction; the shipped product remains
  centered on coding-agent CLIs, issues, repositories, and PR review.
- **Platform-owned durable semantic memory** — explicitly described in source as the long-term
  answer, not a current store.
- **Composio MCP Apps** — substantial feature-gated/MVP implementation, not universally enabled.
- **iOS distribution** — source-buildable client, not App Store distribution; no Android client.
- **Strong process sandbox** — explicitly not provided by default.
- **Visual workflow/evaluation platform** — not found; Autopilots and squads solve narrower problems.

## Verified Cognia comparison

### The real gap: product authority, not primitive capability

Cognia already has most of the _local_ pieces that a superficial Multica comparison would call
missing:

- Durable single-agent work items have an eight-state lifecycle, dependencies, priority, approval
  policy, comments, durable attempt records, scheduler linkage, pause/resume/cancel, and a board UI.
  Attempts have stable identities but their lifecycle, execution linkage, result, error and
  interrupted state are deliberately updated; they are not immutable
  ([contract](https://github.com/MaxQian888/cognia-next/blob/f33c74295588cfbdce97cecc99f1f0638d5ec6e6/types/agent/agent-task.ts),
  [storage](https://github.com/MaxQian888/cognia-next/blob/f33c74295588cfbdce97cecc99f1f0638d5ec6e6/lib/db/agent-tasks.ts),
  [runtime](https://github.com/MaxQian888/cognia-next/blob/f33c74295588cfbdce97cecc99f1f0638d5ec6e6/lib/agent-tasks/runtime.ts),
  [board](https://github.com/MaxQian888/cognia-next/blob/f33c74295588cfbdce97cecc99f1f0638d5ec6e6/components/agent/agent-task-board.tsx)).
- Agent Teams have a Kanban board, task comments and attachments, dependencies, lead/member roles,
  heterogeneous runtimes, concurrency/budget controls, HITL gates, consensus/delegation, and durable
  workflow-run history. Team definitions and tasks survive restart in local persisted state, while
  live ephemera remain process-local
  ([team model](https://github.com/MaxQian888/cognia-next/blob/f33c74295588cfbdce97cecc99f1f0638d5ec6e6/types/agent/agent-team.ts),
  [persist boundary](https://github.com/MaxQian888/cognia-next/blob/f33c74295588cfbdce97cecc99f1f0638d5ec6e6/stores/agent/agent-team-store/store.ts),
  [board](https://github.com/MaxQian888/cognia-next/blob/f33c74295588cfbdce97cecc99f1f0638d5ec6e6/components/agent/workspace/board/task-board.tsx)).
- The existing Scheduler can run an Agent Team after restart, and Visual Workflows already support
  manual, cron, webhook, connector, chat, and goal-completion triggers plus `action.team.run`
  ([team scheduler](https://github.com/MaxQian888/cognia-next/blob/f33c74295588cfbdce97cecc99f1f0638d5ec6e6/lib/scheduler/executors/team-executor.ts),
  [trigger bridge](https://github.com/MaxQian888/cognia-next/blob/f33c74295588cfbdce97cecc99f1f0638d5ec6e6/lib/workflow/runtime/trigger-bridge.ts)).
- The team board is projected to Dexie and synchronized read-only to mobile; mobile mutations return
  through capability-gated Companion RPCs and re-run the desktop transition guard
  ([projection](https://github.com/MaxQian888/cognia-next/blob/f33c74295588cfbdce97cecc99f1f0638d5ec6e6/lib/db/agent-team-projection.ts),
  [mobile write handlers](https://github.com/MaxQian888/cognia-next/blob/f33c74295588cfbdce97cecc99f1f0638d5ec6e6/lib/companion/agent-team-write-handlers.ts)).

Those capabilities do not reduce to an offline-only desktop. In headless mode, one host-owned brain
serves an account-scoped Dexie database, OIDC maps every member of the same organization to the same
account, and authenticated Companion RPCs serialize board mutations through that brain
([OIDC organization mapping](https://github.com/MaxQian888/cognia-next/blob/f33c74295588cfbdce97cecc99f1f0638d5ec6e6/src-tauri/src/companion_api/middleware.rs),
[headless account authority](https://github.com/MaxQian888/cognia-next/blob/f33c74295588cfbdce97cecc99f1f0638d5ec6e6/cli/src/serve/account.ts),
[team write path](https://github.com/MaxQian888/cognia-next/blob/f33c74295588cfbdce97cecc99f1f0638d5ec6e6/lib/companion/agent-team-write-handlers.ts)).
The original claim that Cognia has **no server authority** was therefore too broad.

The remaining collaboration difference is narrower and observable in the contracts. Cognia does not
yet have Multica's workspace-member/role, subscriber, human-or-agent assignee, and actor-attributed
issue contract spanning task, run, review and PR. For example, the team-task RPC path does not inject
the authenticated caller into task mutations and task comments are persisted with the generic
`authorId: "user"`. Cognia has an account-authoritative execution host; Multica has a more complete
multi-user **work-item product model** on top of its authority.

### Reverification of the original gap claims

The four load-bearing claims were re-traced through contracts, persistence, runtime callers,
transport and UI, then checked against targeted tests. The result materially changes the first
draft:

| Original claim                            | Result        | Repository evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ----------------------------------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No server-authoritative shared work plane | **Narrowed**  | Headless OIDC organization members resolve to one account and mutations route through one brain. Missing pieces are collaboration semantics and actor attribution, not a total lack of server authority.                                                                                                                                                                                                                                                                                                              |
| No multi-host runtime protocol            | **Narrowed**  | Cognia already has local `ExecutionBroker`, host identities, canonical `hostRef`, cross-host capability/credential/lease preflight, durable AgentTeam recovery, remote-host transports, and a separate Postgres deploy-agent claim/heartbeat/lease protocol. What is not wired is coding-agent worker registration and AgentTeam child claim/dispatch across several concurrently connected hosts.                                                                                                                    |
| No durable task-to-PR/CI lineage          | **Disproved** | `durable-v2` persists run, child/task, repository, workspace path, branch, checkpoint commit, evidence, delivery graph, PR number/URL, head SHA, CI/approval/merge state and PR feedback ([contracts](https://github.com/MaxQian888/cognia-next/blob/f33c74295588cfbdce97cecc99f1f0638d5ec6e6/types/agent/agent-team-runtime.ts), [persistence](https://github.com/MaxQian888/cognia-next/blob/f33c74295588cfbdce97cecc99f1f0638d5ec6e6/lib/db/agent-team-runtime.ts)).                                               |
| No automation-to-review bridge            | **Disproved** | Visual Workflow has fail-closed lead review, durable human approvals and Scheduler task creation/history; workflow execution has durable idempotent admission, while Scheduler has consecutive-failure auto-pause ([team review](https://github.com/MaxQian888/cognia-next/blob/f33c74295588cfbdce97cecc99f1f0638d5ec6e6/lib/workflow/nodes/teams/index.ts), [approval registry](https://github.com/MaxQian888/cognia-next/blob/f33c74295588cfbdce97cecc99f1f0638d5ec6e6/lib/workflow/runtime/approval-registry.ts)). |

This means Multica's most useful lesson is to connect and productize existing Cognia authorities,
not to introduce another task store, PR lineage model, approval engine, execution broker, fleet
monitor, worktree registry, or generic lease implementation.

### Gap matrix

| Dimension                 | Multica at checked SHA                                                                                                                                   | Cognia committed baseline                                                                                                                                                                                                                                                                                                                                                                                         | Verdict                                                 |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Shared work authority     | PostgreSQL-backed multi-user workspace; issues, comments, assignments, tasks, runs and PR state are one realtime record                                  | Headless OIDC + one account brain provide server authority and remote board writes, but the task contract lacks per-actor attribution, member roles, subscribers and one issue-level projection across task/run/review/PR                                                                                                                                                                                         | **Partial product/contract gap, not a new-store gap**   |
| Runtime fleet             | Many daemons remain registered concurrently, heartbeat, advertise installed CLIs, receive wakeups, claim runtime-bound tasks and recover unfinished work | Agent Fleet observes and controls local Claude Code/Codex/OpenCode sessions; Remote Host stores several hosts but activates one process-wide transport. The deploy fleet has claim/lease/heartbeat, but its closed operation enum is deployment-only ([agent gateway](https://github.com/MaxQian888/cognia-next/blob/f33c74295588cfbdce97cecc99f1f0638d5ec6e6/crates/cognia-ops-controller/src/agent_gateway.rs)) | **Confirmed distributed coding-worker integration gap** |
| Cross-host team execution | Server queue dispatches work to the agent's bound daemon                                                                                                 | Capability/credential/lease preflight exists, but its source says a future cross-host dispatcher must call it; `openAgentSession` is likewise intentionally dormant for the later team binding phase ([preflight](https://github.com/MaxQian888/cognia-next/blob/f33c74295588cfbdce97cecc99f1f0638d5ec6e6/lib/ai/agent/execution/cross-host-preflight.ts))                                                        | **Confirmed P0 integration gap**                        |
| Agent/squad board         | First-class shared issue board with human, agent and squad assignees                                                                                     | Single-agent and team boards already exist; Cognia's team execution is more expressive (parallel DAG, heterogeneous runtimes, HITL, budgets), while Multica's issue-level human/agent assignee model is more collaborative                                                                                                                                                                                        | **Execution parity; collaboration semantics gap**       |
| Automation                | Autopilot creates a reviewable issue or run-only task; schedule/webhook history, idempotency and auto-pause are productized together                     | Visual Workflow already has team review, durable multi-device approvals, durable idempotent workflow admission, Scheduler task creation/history and failure auto-pause; the remaining difference is one shared audience/subscriber/delivery view                                                                                                                                                                  | **Capability parity; product projection gap**           |
| Worktree isolation        | Runtime-managed worktrees; local-directory mode is explicitly serialized/unsafe                                                                          | Task Workspace already has snapshot/patch/undo, a wired Registry with SQLite ownership/lease tables, an AgentTeam isolation/lineage path, and Chat managed-workspace entry. ADR-0111's `Proposed` status is stale relative to committed source; multi-root bundle composition and full scheduler/team/user-worktree convergence are not runtime-complete                                                          | **Existing primitives; convergence/product gap**        |
| Work-to-PR lineage        | Issue identifier auto-links PR; issue shows PR, diff, CI, mergeability and merge outcome; GitHub plus self-hosted GitLab/Gitea/Forgejo mirrors           | `durable-v2` has durable task/run/workspace/branch/commit-evidence/PR/CI/approval/merge lineage, stacked delivery graphs and PR feedback. GitHub is the implemented delivery adapter; Multica has broader provider mirrors and a more unified issue detail                                                                                                                                                        | **Local parity; provider/product breadth gap**          |
| Coding-agent breadth      | 20 CLI families, capability matrix for resume/MCP/skills                                                                                                 | ACP/OpenCode external runtime plus native Claude/AI SDK rails; documented executable presets are narrower, while model/API provider breadth is much larger                                                                                                                                                                                                                                                        | **Different strategy; no need to chase count**          |
| Memory and learning       | Explicit issue/project/skill context and session resume; platform-owned semantic memory is explicitly future work                                        | Long-term memory, vector retrieval, employee twin, PII-gated memory paths and skill authoring already exist                                                                                                                                                                                                                                                                                                       | **Cognia advantage**                                    |
| Post-run learning         | No eval/regression or platform memory materialization system found                                                                                       | At the committed baseline, AgentTeam automatically generates approval-required retrospectives and can apply approved prompt, decomposition, team-memory and versioned-environment changes. The current working tree deliberately removes that legacy automatic trigger while migrating to user-triggered generic Run Review; generalized any-run/skill materialization remains **working-tree-only**              | **Capability exists; current generalization unshipped** |
| Visual orchestration      | No visual DAG authoring found                                                                                                                            | Mature visual workflow editor/runtime, typed nodes, durable waitpoints, recovery and team synthesis                                                                                                                                                                                                                                                                                                               | **Cognia advantage**                                    |
| Security                  | Explicitly unsandboxed by default; dedicated user/container/VM is the recommended boundary; some custom env/MCP secrets are plaintext server data        | Capability/permission gates, workspace trust, secret references, PII redaction and audited HITL are substantial strengths. Route tickets and Task Workspace exist but are feature-gated/default-off, so they are not universal baseline guarantees                                                                                                                                                                | **Cognia advantage, with rollout qualifications**       |
| Deployment/collaboration  | Mature shared Go/PostgreSQL server; Compose/Helm; web/Electron/iOS                                                                                       | Tauri/web/Capacitor plus headless Compose/Kubernetes stack, but cloud/multi-tenant execution phases and shared work authority are not one finished SaaS collaboration product                                                                                                                                                                                                                                     | **Infrastructure partly present; product gap**          |
| Mobile                    | Source-build iOS, no Android/App Store                                                                                                                   | Capacitor iOS and Android with Companion sync/control surfaces                                                                                                                                                                                                                                                                                                                                                    | **Cognia advantage**                                    |
| License                   | Custom source-available license restricts hosted/embedded commercial use and branding removal                                                            | AGPL-3.0-or-later                                                                                                                                                                                                                                                                                                                                                                                                 | **Do not copy code without legal review**               |

### What not to copy

- Do not replace Cognia's workflow/team engine with Multica's narrower issue-comment squad protocol.
  Add a shared work-item adapter around the existing engine.
- Do not trade Cognia's permission, PII, sandbox, secret-reference and provenance controls for
  Multica's bypass-by-default execution posture. Copy the clarity of its security documentation,
  not the boundary.
- Do not chase 20 CLI adapters as a vanity metric. Extend the ACP-first compatibility matrix only
  where real demand and conformance tests justify the maintenance cost.
- Do not copy Multica implementation code into Cognia without legal review; its additional license
  terms are incompatible with treating the repository as ordinary Apache-2.0 source.

## Recommended priority order for Cognia

The verified priority order is:

1. **P0 — Activate distributed AgentTeam dispatch by extension, not duplication.** Add coding-runtime
   registration, availability/capacity and child-run claim routing around the existing
   `ExecutionBroker`, `ResolvedAgentExecutionSpec.hostRef`, durable AgentTeam coordinator,
   cross-host preflight, Remote Host identity/transport, `ExecutionRun` journal/bindings and recovery
   leases. Extract or generalize the proven claim/heartbeat/lease mechanics from
   `cognia-ops-controller` only where their deployment-specific operation model can remain isolated.
   Do not add a queue inside AgentTeam, another run authority, or a second generic lease store.
2. **P1 — Add collaboration semantics to the existing account authority.** Extend the current task
   contracts with stable human/agent principals, actor-attributed comments and transitions,
   workspace roles, subscribers and revisions. Project `AgentTask`, AgentTeam durable-v2,
   `ExecutionRun` journal/bindings, `ActionReviewReceipt`, `AgentTeamDecision` and delivery evidence
   into one work-item view; do not introduce a third task/run/review model or replace headless Dexie
   merely to imitate Multica's PostgreSQL choice.
3. **P1 — Productize the lineage Cognia already has.** Surface durable-v2's child/workspace/branch,
   evidence, PR/CI and delivery-graph records in the shared task/board/mobile views. Add SCM adapters
   behind the existing provider seams only when demanded; do not rebuild the lineage schema.
4. **P1/P2 — Unify automation review UX, not its engine.** Compose existing cron/webhook triggers,
   team review, approval registry, Scheduler history/idempotency/auto-pause, notifications and
   action-review receipts into one reviewable-work preset with audience/subscriber and delivery
   history. The implementation work is projection and authoring UX, not a new Autopilot runtime.
5. **P2 — Aggregate existing Agent Fleet and canonical journals across the new host dispatcher.**
   Fleet monitoring, remote control, run events and usage already exist locally; add host dimension
   and quality evaluation after distributed dispatch is real. Do not create another fleet monitor.
6. **Do not copy — unsandboxed-by-default trust posture or restrictive license.** Multica's candor is
   worth copying; its security trade-off and source-available license are not product capabilities.

### Mandatory reuse map

Any implementation proposal derived from this comparison should name the existing authority it
extends. A proposal that introduces a parallel generic authority should be rejected unless it first
proves that the existing contract cannot carry the required invariant.

| New product need                          | Existing Cognia authority to extend                                                                                                                                                                                     | Prohibited duplicate                                                 |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Shared issue/work-item projection         | `AgentTask`; AgentTeam durable-v2; `ExecutionRun` journal and audience bindings; `ActionReviewReceipt`; `AgentTeamDecision`; evidence and delivery graph                                                                | Generic task, run, review, decision or lineage ledger                |
| Distributed coding-worker dispatch        | `ExecutionBroker`; runtime target/remote-host registries; `ResolvedAgentExecutionSpec.hostRef`; cross-host preflight; SecurityStore principals/grants; durable AgentTeam recovery; ops-controller claim/lease semantics | AgentTeam-local queue, parallel broker or unrelated generic lease DB |
| Worktree and code-delivery review         | Task Workspace Registry; AgentTeam child/checkpoint/evidence/delivery graph; GitHub delivery adapter; unified source-control review                                                                                     | New workspace registry, PR tracker or review sheet                   |
| Reviewable scheduled/webhook automation   | Workflow invocation authority; durable waitpoints/approval registry; fan-out subscriptions; outbound delivery/idempotency ledgers; Scheduler; team review and revision node                                             | New Autopilot runtime, approval engine or delivery-history store     |
| Multi-host fleet operations/observability | Agent Fleet projection/control; canonical `ExecutionRun` journal; runtime target registry; existing usage and execution-event projections                                                                               | Second fleet monitor or second event journal                         |

### Verification record

The comparison above is based on source tracing from contract to persistence, runtime caller,
transport and mounted UI, followed by targeted executable checks on the current checkout:

- PR/CI delivery graph, GitHub adapter, PR-feedback reconciliation, cross-host preflight, approval
  registry and headless-account tests: **6 suites, 29 tests passed**.
- `action.team.task.review`: **14 targeted tests passed**.
- Scheduler consecutive-failure auto-pause: **1 targeted test passed**.
- `cognia-ops-controller` Rust tests could not start on the dirty working tree because its lockfile
  currently resolves `rcgen 0.14.9`, while the checked source uses the `0.13.2` API. The source,
  Postgres schema and in-file tests establish the deployment claim/lease implementation, but this
  run is intentionally not reported as passing.
- `cognia-task-workspace` Rust tests were not completed because another Cargo build held the shared
  build locks for several minutes; no pass/fail claim is made from that attempt.

These checks validate the corrected classifications; they are not a claim that the entire dirty
working tree passes its full test suite.

## Maturity and community snapshot

Multica is young and fast-moving. GitHub reports the repository was created on `2026-01-13`; at the
review snapshot it had approximately **45,444 stars**, **5,775 forks**, at least **100 contributors**
(the first contributors API page was full), **765 open issues**, and **531 open pull requests**
([repository API snapshot](https://api.github.com/repos/multica-ai/multica),
[open issues](https://github.com/multica-ai/multica/issues?q=is%3Aissue+is%3Aopen),
[open PRs](https://github.com/multica-ai/multica/pulls?q=is%3Apr+is%3Aopen)).
Seven non-prerelease versions from `v0.4.17` through `v0.4.23` were published between 2026-08-03 and
2026-08-11, and 223 PRs were merged from 2026-08-01 through the review date
([release history](https://github.com/multica-ai/multica/releases)).

These are strong adoption and delivery-velocity signals. They are not equivalent to stability:
the product is still pre-1.0, carries a very large open issue/PR queue, regularly changes daemon and
provider compatibility behavior, has a source-build-only iOS client, and documents several sharp
deployment/security edges. Cognia should benchmark the architecture and interaction contracts, not
assume every Multica surface is a mature standard.

## Licensing conclusion

The repository's license embeds the unmodified Apache-2.0 text but makes it subordinate to additional
conditions. Without a separate commercial license, source code may not be used to provide any hosted
service to third parties (even a free public instance) or embedded in a commercially distributed
third-party product. Internal use is allowed. UI branding and attribution may not be removed without
a separate branding waiver; backend/CLI-only derivatives must retain attribution and state that they
are built on Multica
([additional commercial and hosting restrictions](https://github.com/multica-ai/multica/blob/b904e6b71c02ee6ebad6fa5340d685a8dbdc38f2/LICENSE#L1-L42),
[branding and attribution restrictions](https://github.com/multica-ai/multica/blob/b904e6b71c02ee6ebad6fa5340d685a8dbdc38f2/LICENSE#L44-L82)).

Consequences for Cognia:

- architecture and product ideas can be studied;
- code reuse, embedding, managed hosting, or UI derivation requires legal review and may require a
  commercial license plus a separate branding waiver;
- do not describe Multica's repository as simply "Apache-2.0" or assume its code can be incorporated
  under Cognia's license.
