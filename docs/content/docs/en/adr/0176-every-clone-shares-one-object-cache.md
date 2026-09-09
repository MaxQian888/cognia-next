---
title: "0176: Every clone shares one object cache"
description: "The bare-mirror cache, the credential policy, and the git runner move into one leaf crate that cognia-git, cognia-task-workspace and src-tauri all depend on. The cache root becomes process-global and absolute, a clone budget kills the child instead of dropping a future, and the guarded clone gets a cache it never had."
---

# ADR 0176: Every clone shares one object cache

**Status:** Accepted
**Date:** 2026-09-09
**Amends:** ADR-0150 (repository supply and object cache)
**Related:** ADR-0067 (Tier-A crate decomposition), ADR-0026 (plugin workspace backends), ADR-0132 (Issue to PR runs), ADR-0144 (the workspace is the unit of work)

## Context

Four places in this repository clone a git repository, and until now they shared
almost nothing.

1. `src-tauri/src/github/workspace.rs`, the Marketplace and Issue-to-PR
   workspace clone. The only one with a mirror.
2. `crates/cognia-git/src/repo.rs::clone_repo_guarded`, the guarded clone behind
   `git_clone_guarded`, used by plugins and agents. **No cache at all.**
3. `crates/cognia-task-workspace/src/mirror.rs`, which owned the mirror
   *algorithm* (URL normalisation, cache paths, freshness, argument vectors) and
   nothing that could run it.
4. `crates/cognia-plugin-runtime/src/wasm/installer.rs`, `git clone --depth=1`
   for plugin installation. Shallow on purpose, and out of scope here.

ADR-0150 already put the mirror algorithm in one place. What stayed duplicated
was everything *around* it: the cache root, the orchestration that drives git,
and the credential policy. All of that lived in `src-tauri`. `cognia-git` is a
Tier-A leaf, so it could not reach any of it. That is the whole reason finding 2
exists. Not an oversight, a dependency direction.

An audit on 2026-09-09 found four defects in what was there, each verified in
code rather than inferred.

### The cache root was relative

`mirror_root(base_dir)` derived the cache from the *worktree base directory*,
whose default `DEFAULT_BASE_DIR` is the **relative** string
`"cognia-github-worktrees"`. In production the cache therefore lived under
whatever the process working directory happened to be. Meanwhile the garbage
collector swept `mirror_root(None)`, and a caller that injected a base wrote to
`<base>/.mirrors`, somewhere else again. The writer and the collector could
disagree about where the cache was, so mirrors accumulated in a directory
nothing ever swept, and the sweep ran against a directory nothing had written.

### The credential was hard-coded to github.com

`apply_git_auth_env` set `http.https://github.com/.extraheader` as a literal.
A GitHub Enterprise remote got the isolation environment and no credential,
which surfaces as `could not read Username for 'https://...'` with nothing
naming the cause.

### The clone budget did not stop git

`clone_repo_guarded` enforced its budget with
`tokio::time::timeout(budget, exec::run(..))`. `exec::run` awaits
`tokio::process::Command::output()`, and `tokio::process::Command` defaults to
`kill_on_drop(false)`. Dropping that future on timeout does not kill git. It
leaves `git clone` running, still writing into the directory the timeout branch
then deletes. The clone timed out. The process did not.

### The algorithm's home could not grow one

`cognia-task-workspace` has no tokio and must not acquire one, because its
service is already called under `spawn_blocking`. So the orchestration could not
live beside the algorithm, and it could not live in `src-tauri` if `cognia-git`
was to reach it. It had nowhere to be.

## Decision

### 1. A leaf crate, deliberately sync

`crates/cognia-git-mirror` holds the mirror plan (moved verbatim from
`cognia-task-workspace`), the one credential policy, the git runner, and the
orchestration that drives them. It is a leaf that everyone may depend on, on the
`cognia-instrument` precedent. `cognia-git`, `cognia-task-workspace` and
`src-tauri` all carry it and it carries none of them.

It is **sync**. `cognia-task-workspace` must not grow a tokio dependency, and
both async callers already have a `spawn_blocking` boundary. Being sync is also
what lets the budget be a real `try_wait` plus `kill` rather than a dropped
future.

`cognia-task-workspace` re-exports the plan under its existing `mirror_*` names,
so every prior caller compiles unchanged.

### 2. The root is process-global and absolute

`set_root` is called once, from `task_workspace::install`, the single seam both
hosts pass through: the desktop shell at `lib.rs` boot and `cognia-server` at
`bin/cognia-server.rs`. It resolves to `<data_dir>/task-workspaces/mirrors`.

`root()` falls back to a path under the system temp directory, never a relative
one. A cache that silently follows the working directory is how the first defect
happened, and it is not a mistake worth being able to make twice.

The `base_dir` parameter survives in `github/workspace.rs::mirror_root` as a
**test seam only**, and the absent case now stays absent rather than folding
into `DEFAULT_BASE_DIR`.

### 3. One request object carries the budget

`MirrorRequest` names the cache root, the remote, an optional credential, extra
refspecs, and a wall-clock budget. A struct rather than an eighth positional
parameter, because a call site with eight positional arguments is one where the
credential and the refspecs get swapped without the compiler noticing.

The budget reaches every git invocation the mirror makes. A cache that can
outlive the request it exists to make faster is not a cache, it is a hang, and
the fallback to the network, which is what makes a cache miss survivable, never
gets to run.

### 4. A cache miss is never an error

Every failure in the mirror path returns "use the network" rather than
propagating: a corrupt mirror, an unfetchable remote, a branch created upstream
since the last fetch. Each costs one slow clone. A cache that can fail a run is
worse than no cache.

### 5. The guarded clone gets the cache, at depth 0 only

`clone_repo_guarded` tries the mirror before the network, but **only on the
blobless default**. A caller that passed `depth` asked for the *small* clone and
gets `--single-branch` with it. A mirror derive is full commit history, so
serving that request from the cache would quietly hand back something larger
than was asked for, and the size post-condition, not the cache, is what would
report it. At `depth == 0` the mirror's `--filter=blob:none` derive is exactly
what `guarded_clone_args` already does.

No credential is ever passed on that path. The guard rails reject URLs carrying
one before it is reached.

### 6. `origin` is named, not assumed

`DerivedOrigin::RealRemote` re-points a derived checkout at the real remote, and
`DerivedOrigin::Mirror` leaves it on the mirror. The two callers want opposite
things. A workspace that exists to push cannot have a local directory as
`origin`, while the managed source checkout never pushes and keeps the mirror so
the worktree layer can `git fetch origin` against a private repository without
ever being handed a credential. Getting it backwards is a defect that only shows
up after the agent has finished its work, so it is a parameter with a name
rather than a default.

### 7. The sandbox follows the same credential policy

The E2B backend put the token in the clone URL and therefore on a command line
inside the microVM, readable by anything the agent runs that can list
processes, and left in `<workspace>/.git/config` for a plain `cat` afterwards.
That workspace is handed to an agent acting on an issue body anyone can file.

It now clones a credential-free `https://github.com/<repo>.git` and supplies the
same `GIT_CONFIG_COUNT` extraheader triple per command, keyed on the remote's
origin. Because a facade that silently drops a per-command environment would
put the token back on argv, the backend **probes** for support (one echo of a
nonce it planted in the environment) and refuses to clone if the probe fails.
There is no fallback: the alternative to refusing is the leak.

The default factory now adapts the SDK's `commands.run(cmd, { envs })` rather
than casting the raw SDK object to a facade shape it does not have. Pushing
takes the credential per call too, so a workspace that outlives the
installation token it was cloned with can still push after a rotation.

### 8. The deployment is a value, not a loosened allow-list

`https://api.github.com` was a literal in six places. Every one of them meant
"github.com only", so a self-hosted GitHub Enterprise Server was not so much
unsupported as unreachable, with nothing saying so.

`lib/github/host.ts` holds a `GithubHost` instead. The API base cannot be
derived from the web base, which is why the value carries both: github.com
serves its API from a different *host* (`api.github.com`) and GHES from a
*path* on the same one (`/api/v3`).

A host belongs to an **account**, not to the application. A user can hold a
github.com PAT and an enterprise App at once, and a credential must reach only
the deployment that issued it. So the URL is a field on the account's stored
credential, absent for every account that existed before, and absent means
github.com.

Nothing is widened by default. `resolveGithubHostForRemote` answers `undefined`
for a host nobody configured rather than falling back to github.com, because
that fallback is precisely how a github.com token would be sent to whatever
server a remote named. Recognising `github.acme.com` on its shape is the
mistake, and configuration is the gate.

`parseGithubHost` refuses `http://`, a URL carrying userinfo, and anything that
is not a URL. The Rust side re-validates independently in `canonical_host_root`
before the value reaches a `git clone` argument, because that is where it
decides which origin a credential header is keyed on.

### 9. A workspace can be supplied from a remote, and the credential stops at the seam

Everything downstream of a git root already worked. `acquire_workspace_bundle`,
`create_execution`, `apply_provisioning` and `inspect_bundle_root` all want a
non-bare checkout with commits in it, and none of them changes here. What was
missing was any way to *get* one without a human cloning the repository first,
which is why an issue run could not start on a headless server.

`cognia-task-workspace::remote_source` supplies one: mirror, derive, done. It is
two host commands rather than one, on purpose. Putting the credential on
`task_workspace_bundle_acquire` would move a `service.internal` secret onto a
`workspace.write` payload that a paired phone holding a `host.admin` lease can
send. So the supply command lives on the loopback service plane, and the
acquisition beside it stays exactly as reachable as it was.

The credential is write-only on the way in (`skip_serializing`, and a hand-written
`Debug` that redacts) and is used exactly once, by the mirror fetch.
`cognia-task-workspace` never learns it: a test scans the store's bytes and the
checkout's own `.git/config` for the token.

**`origin` points at the mirror here, the opposite of the workspace clone.** A
workspace that exists to push cannot have a local directory as its `origin`. A
managed *source* checkout is the other case: it never pushes, and two things
downstream run `git fetch origin` on it with no credential at all
(`fetch_origin_throttled`, `resolve_pull_request_base`). Against a private
repository those fail. Leaving `origin` on the mirror makes them work, because
the mirror is a directory on this machine that was fetched *with* the
credential. The real remote is recorded as a second credential-free remote named
`upstream`, so the checkout still says where the code came from.

A pull-request base is asked for by name at mirror time and fetched into the
checkout, because GitHub does not advertise `refs/pull/*` and a plain clone of
the mirror brings `refs/heads/*` and nothing else.

### 10. The network clone kills what it started

`exec::run_within` spawns the child, keeps the handle, and ends the budget with
a `kill` and a `wait`. The caller deleting the half-written destination is now
deleting a directory nothing is writing to. stderr is drained on its own task,
because a clone is chatty and a pipe nobody reads is a git that blocks on the
write instead of making progress. `kill_on_drop(true)` covers the case the
budget cannot: the whole future being dropped by a cancelled caller or a
shutting-down runtime.

`exec::run` keeps `classify_failure`, so the Source Control panel's error
messages are unchanged.

## Consequences

- One repository is one mirror, shared by the workspace clone and the guarded
  clone, on desktop and on a headless server alike. The second clone of a
  repository does not go to the network for objects the first one already
  fetched.
- Mirrors are reclaimed by age (30 days untouched) on the task-workspace
  maintenance schedule, from the same root every writer clones into.
- A GitHub Enterprise remote now gets a credential keyed on its own origin.
- The old relative cache is deleted, once per process, on the first pass of the
  maintenance loop. It is not migrated: those mirrors are refetchable and the
  path they sit at depends on the working directory the process happened to
  have, so a process started elsewhere simply finds nothing. Only `.mirrors` is
  taken. The worktrees beside it are live workspaces, and a failure to delete is
  logged and dropped, because a cache sweep must never be able to fail a clone.
- The plugin installer's `--depth=1` clone still goes to the network. It is
  shallow by intent, and a mirror derive is not what it asked for.
- The delivery plugin's `browserSiteProviders` still declares `github.com`
  alone. That is a static manifest declaration, evaluated before any account
  exists, so the explicit-confirmation browser fallback stays github.com-only
  until a manifest can name a per-account domain. The API path it backs up is
  host-aware, so this affects only that fallback.
- `parseGitHubRepo` in the Agent Team PR-feedback resolver still recognises
  github.com alone. It reads the same parser, but has no configured-host list
  to hand it. That list arrives with the unified delivery face, and until then
  the behaviour is unchanged rather than wrong.
- The workspace clone's *network fallback* still has no wall-clock budget. That
  is unchanged behaviour and out of scope here. Only the mirror path in front of
  it is bounded.

## Implementation

| Concern | Lives in |
| --- | --- |
| Plan (URLs, paths, freshness, argv) | `crates/cognia-git-mirror/src/plan.rs` |
| Credential policy | `crates/cognia-git-mirror/src/credential.rs` |
| Budgeted git runner | `crates/cognia-git-mirror/src/runner.rs` |
| Orchestration, root, GC | `crates/cognia-git-mirror/src/lib.rs` |
| Boot: cache root | `src-tauri/src/task_workspace.rs::install` |
| GC schedule | `src-tauri/src/task_workspace.rs::reclaim_stale_mirrors` |
| Workspace clone adapter | `src-tauri/src/github/workspace.rs` |
| Guarded clone | `crates/cognia-git/src/repo.rs::clone_from_mirror` |
| Killing timeout | `crates/cognia-git/src/exec.rs::run_within` |
| Sandbox credential | `plugins/e2b-sandbox/src/workspace-backend.ts` |
| GitHub deployment | `lib/github/host.ts` |
| Per-account host | `lib/integrations/github-auth.ts` |
| Host validation (Rust) | `src-tauri/src/github/workspace.rs::canonical_host_root` |
| Supply from a remote | `crates/cognia-task-workspace/src/remote_source.rs` |
| Supply command (loopback only) | `src-tauri/src/companion_api/rpc/service_plane.rs` |
| Supply client | `lib/task-workspace/client.ts` |
| Push credential forwarding | `lib/github/workspace.ts::commitAndPush` |
