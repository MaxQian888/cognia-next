# Codex GUI workflow gap mapping — 2026-08-06

## Conclusion

Cognia should extend its existing Task Workspace, source-control, browser annotation, project,
scheduler, and subagent models rather than add parallel subsystems. The largest missing pieces are
durable chat-level execution identity, project environment definitions, a provider-neutral PR
boundary, temporary Browser Adjust state, and an explicit local-only CDP authorization ledger.

## Primary-source behavior

### Managed worktrees and Handoff

The ChatGPT desktop app creates a managed Git worktree for a chat, starts it from a selected branch,
and returns the chat to the same worktree on later handoffs. Dirty tracked and untracked changes can
seed the worktree. Ignored files move only when explicitly matched by `.worktreeinclude`; source
symlinks are skipped and existing destinations are not overwritten. Managed worktrees are
disposable, but pinned/running/permanent worktrees are protected and a snapshot is saved before
automatic cleanup.

Cognia already owns the stronger low-level primitives in ADR-0086: `TaskWorkspaceService` uses a Git
worktree or non-Git shadow root, records authoritative snapshots, stores content-addressed blobs,
builds cumulative forward/inverse patches, performs three-way apply, supports exact undo, pins tasks,
and prunes only safe rows. The GUI gap is binding this lifecycle to `ChatSession` and exposing
Local↔Worktree transitions and restoration.

Sources:

- [Worktrees](https://learn.chatgpt.com/docs/environments/git-worktrees.md)
- `docs/content/docs/en/adr/0086-task-scoped-resource-workspaces.md`
- `crates/cognia-task-workspace/src/service.rs`
- `src-tauri/src/task_workspace.rs`

### Unified review and GitHub pull requests

Codex's review pane operates on repository state, not only agent-authored files. It supports Last
turn, Unstaged/Uncommitted, Staged, Commit, and Branch views; multi-root Last turn review; inline
comments; file/hunk stage, unstage, and revert; and the commit/push/create-PR loop. PR context uses
the authenticated GitHub CLI and degrades when `gh` is absent or unauthenticated.

Cognia already has parsed Git diffs, per-hunk actions, content-hash remapping, AI review findings,
commit/push controls, worktree management, and GitHub PR observation. The missing unification is a
shared scope/comment/bundle contract and an extensible PR adapter joining these surfaces.

Sources:

- [Code review](https://learn.chatgpt.com/docs/code-review.md)
- [Local environments — built-in Git tools](https://learn.chatgpt.com/docs/environments/local-environment.md)
- `components/source-control/`
- `lib/git/hunk-review.ts`
- `lib/github/pr-observe/`

### Project-scoped local environments

Codex local environments provide automatic worktree setup scripts plus reusable actions executed in
the integrated terminal. Definitions are project-scoped and may provide OS-specific scripts. Cognia
must keep definitions device-local and store secret values only in its existing OS keyring.

Sources:

- [Local environments](https://learn.chatgpt.com/docs/environments/local-environment.md)
- [Integrated terminal](https://learn.chatgpt.com/docs/integrated-terminal.md)
- `lib/terminal/`
- `lib/credentials/keyring-store.ts`

### Browser Adjust and developer mode

Codex Browser Adjust attaches structured font/text/spacing/color feedback to an annotation and
temporarily previews changes before the annotation is sent. Developer mode allows deeper CDP access
only after a global feature setting and an explicit per-use approval; managed policy can disable the
feature. CDP can expose sensitive DOM, console, network, and runtime data.

Cognia already has embedded-browser annotations, captures, console/network drains, Computer Use,
recording, and remote-browser separation. The missing control plane is temporary adjustment state
plus an expiring grant bound to the Cognia chat and embedded-browser session, with redacted,
append-only audit metadata. Full CDP must fail closed outside local Tauri and for remote targets.

Sources:

- [Browser — Styling feedback and Developer mode](https://learn.chatgpt.com/docs/browser.md)
- [Developer settings](https://learn.chatgpt.com/docs/developer-settings.md)
- `lib/browser/`
- `lib/db/browser-annotations.ts`
- `src-tauri/src/browser/embedded.rs`

### Faster entry and global agent threads

Codex exposes project/recent entry and subagent thread inspection. Cognia already persists normal
chat sessions (including pins, recency, lineage, project scope, and hidden imported subagent
sessions), provides a workspace switcher with a recent group, and renders nested subagent trees
inside messages. Quick Chat therefore should create an ordinary persisted Cognia task with defaults;
the global thread browser should project existing thread/session data instead of transferring live
ownership. Promotion must snapshot into a new primary task and refuse while a child is running.

Sources:

- [Projects and chats — Quick chat](https://learn.chatgpt.com/docs/projects.md)
- [Subagents — Managing subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents.md)
- `packages/agent-config-types/src/index.ts`
- `lib/claude/subagent-tree.ts`
- `components/chat/message-parts/subagent-tree.tsx`
- `components/shell/workspace-switcher.tsx`

## Implemented foundation in this change

- Public `ProjectEnvironment`, `SessionExecutionContext`, review/PR, Browser Adjust, and CDP types.
- Optional `Project.pinned`, `Project.defaultEnvironmentId`, and `ChatSession.executionContext`.
- Scheduler chat-like payload parity for `executionContext`.
- Dexie v144 project-environment and CDP grant/audit tables.
- Device-local environment CRUD with a hard plain-variable/keyring-reference collision guard.
- Exact session/browser/origin/capability/expiry CDP grant validation and append-only audit writes.
- A fail-closed local-Tauri CDP policy that rejects remote execution targets and redacts URLs.
- Content-addressed review comments with stale/ambiguous hunk remapping.
- Durable per-chat Task Workspace identity and scheduled setup no-bypass policy.
