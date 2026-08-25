---
title: "0147 — The repository declares its own workspace"
description: "`.cognia/workspace.json` becomes a real source — setup scripts, actions, variables, roots, execution defaults and suggested capabilities shipped with the code — behind a two-layer gate, because a repository file that runs shell is code delivered by git pull."
---

# ADR 0147 — The repository declares its own workspace

**Status:** Accepted
**Date:** 2026-08-25
**Related:** [ADR-0144](./0144-workspace-as-the-unit-of-work), [ADR-0111](./0111-managed-workspace-registry), [ADR-0090](./0090-unified-agent-execution)

## Context

`lib/project-environment/workspace-config.ts` — the schema, the validator, the
confined-relative-path checks and the merge for `.cognia/workspace.json` — was
written in full, had its own tests, and was called by nothing. Not partially
wired: `readWorkspaceConfig`, `parseWorkspaceConfig` and `mergeWorkspaceConfig`
had zero callers anywhere in the repository. The three native fields
(`sparsePaths`, `cacheLinks`, `include`) had no implementation on either side.

Meanwhile the two surfaces that load a project environment before a turn — the
chat controller and the scheduler executor — both used the raw device-local
row. So a repository could describe its own setup and Cognia would never look,
and every new contributor had to be told the setup out of band.

This is the recurring defect class in this codebase: fully built, never wired.

## Decision

### The file is a real source, and it is gated

The file ships `setup` and `actions` — shell scripts run before a turn — plus
`variables` that become that process's environment, `cacheLinks` that symlink
directories into the working tree, and `include` that copies gitignored files
in. Reading it is code execution delivered by `git pull`.

**Two decisions, not one.** Workspace Trust already answers "is this checkout
mine": granted once per folder, revocable, the same gate that guards
`.claude/settings.json` hooks. That is necessary and NOT sufficient — it is
granted before the repository's later commits exist, and a contributor who
trusted a folder in March did not approve the setup script that landed in it in
August. So:

1. **Untrusted → the file is not read at all.** Not "read but ignore the
   scripts": `roots` widens the agent's filesystem reach and `variables` reach
   the same process, so there is no half of this file that is safe to honour in
   a checkout the user has not vouched for.
2. **Trusted → the CONTENT must have been approved.** The approved digest lives
   on the trust row; revoking trust deletes the row and drops it. A first sight
   and a later change are the same gate state with different wording, because
   they need the same answer from the user.

### The digest covers everything, and covers the parsed form

Not a hand-picked "dangerous" subset. Deciding which half of the file is safe
is a judgement that will eventually be wrong — `variables` alone can set
`NODE_OPTIONS=--require ./evil.js`. It digests the PARSED, canonicalized
configuration, so reformatting, key reordering and comment churn do not
re-prompt while any semantic change does. Arrays keep their order: `actions`
runs in order, so sorting them would collide two different configurations onto
one digest.

### Local wins on a variable collision

Reversing what `mergeWorkspaceConfig` originally did. Both sides configure the
same workspace; the difference is "this device" versus "shared with the
repository", and the more specific layer has to win — otherwise a value the
user set for their own machine stops working after a pull with nothing on
screen to connect the two. The reverse failure is covered by reporting it:
`overriddenVariables` names every repository value this device shadows.

### Suggestion versus instruction

Three fields describe the workspace rather than a script to run, and all three
are seeded rather than imposed:

- `defaults.execution` / `defaults.base` apply only where the workspace has no
  remembered default of its own, and lose to the new-chat picker.
- `roots` and `capabilities` (new in the schema) are applied at APPROVAL time —
  the moment the user says yes to this exact content — and each declaration is
  recorded as offered on the trust row.

**Seed once, never re-seed.** The seed key is remembered after the thing it
created is gone, so removing a seeded root or clearing a seeded capability
sticks. A repository telling a new contributor "this project uses the Jira
server" is useful; a repository silently overturning that contributor's answer
on the next pull is not.

### Provisioning is part of creating the tree

`sparsePaths`, `cacheLinks` and `include` are applied inside the worktree
creation, not as a later touch-up: a half-provisioned worktree handed to an
agent is worse than none, so a failure rolls the acquisition back the same way
a failed materialize does. The order is load-bearing — sparse-checkout first
(it deletes the paths it excludes, which would remove a link made before it),
then the cheap symlinks, then the file copies.

Every path is re-validated host-side. The renderer's parser rejects `..` and
absolute paths, but `apply_provisioning` is reachable from any caller of the
acquire command — a plugin, the CLI, a paired device — and "someone upstream
checked it" is how a path traversal ships. An `include` that resolves through a
symlink out of the checkout is skipped: the same escape, one indirection later.

Only Git worktree isolation is provisioned. A shadow workspace materializes an
explicit snapshot, and narrowing or linking into it would contradict the
snapshot it was built from.

### Every refusal is visible

Each non-approved path returns the device-local environment untouched — exactly
the behaviour before this existed, which is a safe floor and a silent one. So
the verdict is surfaced twice: a card in the environment panel that always
states it (including the boring "this repository ships none") and shows the
setup script verbatim before offering to approve it, and one notification per
workspace per content. Once per content, not once per turn: a turn resolves its
environment on every message, and three notifications for one standing fact is
how a user learns to dismiss them unread.

## Consequences

**What this buys.** A repository can describe its own setup once and every
contributor gets it — including the parts that are invisible in a fresh
worktree (the gitignored `.env`, the package cache) and the parts that are
expensive to get wrong (which sub-packages to check out, whether work here
belongs in its own tree).

**What it costs.** `TrustedWorkspace` gains three optional fields
(`approvedConfigDigest`, `approvedConfigAt`, `seededDeclarations`). No Dexie
version bump: they are not indexed. `AcquireWorkspaceBundle` gains an optional
`provisioning` field on both sides; it is `#[serde(default)]`, so an older
caller is unaffected and no contract regeneration is required (the command is
not on the companion surface).

**A new shared piece.** `lib/i18n/runtime-translator.ts` — `useTranslations` for
code that is not a component. Working Rule 4 is about what the user reads, not
about `.tsx`, and lib-side notifications had no way to obey it; the English-only
strings in `lib/scheduler/notification-integration.ts` are what that gap looks
like in production.

**Deliberately not done.** A `.cognia/workspace.json` editor (the file is
edited in the repository, like every other committed config), per-branch
configurations, and machine-wide approval — approval is per device, because
trust is.

**Correction to ADR-0144.** Its "deliberately not done" list named
`.cognia/workspace.json` as marked dormant and not read. That no longer holds.
