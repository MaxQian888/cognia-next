---
title: ADR 0038 — Source Control panel (VSCode-style Git)
description: A full VSCode-built-in-Git equivalent panel — stage/unstage/discard at file and hunk level, commit (amend/signoff), branch ops, fetch/pull/push/sync, stash, merge-conflict resolution, blame, a commit-graph, and a Timeline — backed by a hybrid Rust subsystem (git2 reads + system-git for network/writes) and rendered with Monaco's DiffEditor.
---

# ADR 0038 — Source Control panel (VSCode-style Git)

> **Status**: Accepted. Implemented end-to-end and since extracted to a
> dedicated crate — `crates/cognia-git/` (ADR-0067 Phase 2, moved out of the
> original `src-tauri/src/git/`): **62 `git_*` commands**, the `lib/git/` seam +
> `stores/git/` store + `hooks/git/` controllers, the
> `components/source-control/` UI, the `/source-control` route, and a StatusBar
> branch/sync indicator.

## Context

cognia-next already had a "project" concept (`stores/project/project-store.ts`,
`Project.rootDir`) that the integrated terminal uses as its working directory,
and it embeds Monaco for the Canvas surface — but there was **no version-control
UI**. The sidecar's VSCode `scm` shim is explicitly Tier-4 "NotSupported" with a
note that a real Source Control UI is a "future separate plan". This ADR is that
plan: a VSCode-built-in-Git equivalent bound to the active project's repository.

Scope is the VSCode **built-in** Git feature set. Two capabilities originally
scoped out as GitLens / Git-Graph territory — a commit-graph view
(`commit-graph-view.tsx`, reached through the Timeline) and porcelain blame
(`git_blame` → `blame-view.tsx`) — were subsequently added and are now part of
the panel (see **Implemented since**).

## Decisions

### D1 — Hybrid backend: git2 for reads, system `git` for network/writes

`git2` in `src-tauri/Cargo.toml` is configured `default-features = false` with
`vendored-libgit2` and **no `https`/`ssh` features** — so this libgit2 build has
zero network transport compiled in. That hard-locks the split:

- **Reads** (status, diff, log/history, branches, remotes, stash list, conflicts,
  blame) use `git2` directly — fast, structured, no subprocess. They run on
  `spawn_blocking` because libgit2 is synchronous. The shared read core lives in
  the crate's `read.rs` (the module `twin/code_repo.rs` should migrate onto in a
  follow-up).
- **Mutations + network** (stage/unstage/discard, commit, branch
  switch/create/delete/rename, fetch/pull/push/sync, stash push/pop/apply/drop,
  tag, reset, restore, sequencer/interactive-rebase, worktree, conflict
  resolution) shell out to the user's system `git` via the crate's `exec.rs`.
  Shelling out is also what makes `pre-commit`/`commit-msg`/`pre-push` hooks,
  GPG/SSH signing, gitattributes filters, and the OS credential manager / SSH
  agent all behave exactly as in the user's terminal — which git2 would bypass.
  This matches what VSCode itself does.

### D2 — Repo binding from the active project; Open-Folder fallback

The panel binds to the active project's `rootDir` (the same source the terminal
uses for its cwd). When no project `rootDir` is set, an "Open Folder" picker
(`pickDirectory` from `lib/files/file-bridge.ts`) lets the user point at any
repo. A new `/source-control` route lives in the GuildRail activity bar
(`AUXILIARY_ENTRIES`), hidden on the mobile shell like `/performance`.

### D3 — Monaco DiffEditor for diffs and conflict resolution

Reuses the offline Monaco setup (`lib/canvas/monaco-loader.ts`) and the
ResizeObserver `layout()` fix from `components/canvas/canvas-panel.tsx`. Each
diff hunk carries a **self-contained unified patch** (file header + one `@@`
block) built in the crate's `diff.rs`; hunk-level stage/unstage/discard send that
patch back to `git apply --cached`/`--reverse`. Conflict resolution renders a
side-by-side Monaco diff of ours vs theirs with accept-ours/theirs/both.

### D4 — Single-owner fs watcher for live refresh

A `notify` watcher (the crate's `watcher.rs`, the subsystem's only managed
state) emits debounced `git://status-changed` events, ignoring everything under
`.git/` except the refs/index/merge state and dropping gitignored working-tree
churn via the `ignore` crate. To avoid an unmount race, the watcher has a
**single owner**: the always-mounted StatusBar controller
(`useGitBranchIndicator`). The panel never starts its own watcher — it refreshes
on mount and after every mutation, so correctness never depends on the event
firing.

### D5 — Typed error model

The crate's `error.rs` defines a `thiserror` enum serialized as
`{ kind, detail }` (`NotARepo` / `DirtyWorkingTree` / `MergeConflict` /
`AuthRequired` / `NetworkFailed` / `PatchFailed` / `LockHeld` /
`GitNotInstalled` / …). The renderer switches on `err.kind` to drive distinct UI
(conflict → resolver, auth → credential CTA, not-a-repo → Open Folder) instead of
locale-fragile substring matching. Every `detail` is passed through a
URL-credential redactor (`exec::redact`) before it leaves the backend.

## Lives in

| Layer    | Paths                                                                 |
| -------- | --------------------------------------------------------------------- |
| Backend  | `crates/cognia-git/src/` — `commands`, `read`, `exec`, `status`, `diff`, `diff_stat`, `stage`, `commit`, `branch`, `remote`, `stash`, `merge`, `history`, `blame`, `tag`, `reset`, `restore`, `sequencer`, `interactive_rebase`, `worktree`, `repo`, `watcher`, `error`, `types` (extracted from `src-tauri/src/git/` per ADR-0067 Phase 2) |
| Seam     | `lib/git/` (`commands.ts`, `events.ts`, `types.ts`, `language-map.ts`, `load.ts`) |
| State    | `stores/git/git-store.ts`, `hooks/git/{use-git-repo,use-git-actions,use-git-branch-indicator}.ts` |
| UI       | `components/source-control/*` (incl. `blame-view`, `commit-graph-view`, `timeline-view`), `app/source-control/page.tsx`, GuildRail + StatusBar entries |

## Verification

- Rust: `cargo test -p cognia-git` (read the tee'd log — RTK masks cargo exit
  codes). System-git tests are gated behind a `git --version` probe; the
  cargo target lives at the repo root `target/`.
- Frontend: `pnpm typecheck`, `pnpm build`, `pnpm test` (co-located, ≥90%),
  `pnpm lint:i18n` (the `sourceControl` namespace + `desktop.guildRail.sourceControl`).
- Manual (`pnpm tauri dev`): open a dirty repo → stage a hunk → commit → switch
  branch → fetch/pull/push/sync → stash → resolve a conflict → blame → Timeline.

## Implemented since (originally scoped out)

- **Commit-graph view** (`commit-graph-view.tsx`, via the Timeline) and
  **porcelain blame** (`git_blame` → `blame-view.tsx`).
- **`git init`** from the not-a-repo state (`git_init` in `repo.rs`) plus
  `git_ignore_add` — the not-a-repo state is no longer explainer-only.
- **Worktree management** from the sync toolbar: list, create, open, remove,
  optionally delete the linked branch, and prune stale worktree records through
  the existing `git_worktree_*` command seam.

## Out of scope / follow-ups

- Multi-repo workspaces (one active repo per project) and submodules.
- Backing the sidecar VSCode `scm` shim with this UI.
- Migrating `twin/code_repo.rs` onto the crate's `read.rs` and converging
  `github/workspace.rs` onto the crate's `exec.rs`.
- Not yet implemented (candidate follow-ups): `git clone` into the panel,
  in-panel `git config` writes (empty-ident recovery), reflog/recovery view, GPG
  `-S` commit signing (only signoff today), and line-level / sub-hunk staging.
