---
name: concurrent-tree-safety
description: Protocol for working in this repo when other Codex/agent sessions share the same working tree or branch. Use at the start of any session where concurrent work is plausible, before any git stage/commit/reset/branch operation, and immediately after discovering your edits were reverted or files you didn't touch are staged. Every rule here comes from a real incident.
---

# Concurrent-Tree Safety Protocol

Multiple agent sessions routinely share this working tree. Each rule below
prevented — or would have prevented — a recorded incident.

## Hard rules

1. **Pathspec-only staging.** Never `git add -A`, `git add .`, or
   `git commit -a`. Stage exactly your files:
   `rtk git add path/a.ts path/b.test.ts && rtk git commit -m "..." `
   (Incident: a concurrent agent's `git add -A` staged 40 unrelated files
   into someone else's commit; recovery required `git reset` + re-adding
   only-mine.)

2. **Verify identity before every commit.** Immediately before committing,
   run `rtk git status` and `rtk git branch --show-current`:
   - Branch name is what you expect (incident: a concurrent agent *renamed*
     the live branch mid-session; fix was `git branch -f`).
   - Staged list contains ONLY your files. If anything else is staged,
     `git reset` (unstage) first — never sweep it into your commit.

3. **Commit in phases, early.** Finish a phase → commit it with pathspecs.
   Long-lived uncommitted edits are what clobbers destroy. (Incident: an
   in-progress two-ADR change was clobbered; salvage lives in tag
   `qc-stash-backup`.)

4. **No destructive tree ops while shared.** `git reset --hard`,
   `git checkout -- .`, `git stash` (it stashes EVERYONE's edits), branch
   deletion, and `lint-staged`-triggered stashes all hit concurrent work.
   If you must run one, snapshot first: `git tag backup/<topic>-<step>`.

5. **Re-verify after long operations.** After any multi-minute operation
   (test suite, build, subagent fan-out), diff-check the files YOU edited
   this session — concurrent processes have reverted tracked edits
   mid-session more than once. New files survive clobbers better than edits
   to tracked files; when designing a change, prefer new modules over broad
   in-place rewrites if concurrency is active.

6. **i18n messages are a shared hotspot.** `i18n/messages/*.json` is edited
   by almost every UI task; concurrent commits have swept others' keys.
   Add your keys, commit them with your feature files promptly, and if your
   keys vanish, check `git log -p --` on the messages files before
   re-adding.

7. **Schema versions are claims, not facts.** Dexie versions and similar
   monotonic counters get taken by concurrent branches (v66, v69 were both
   lost this way). Use the `dexie-migration` skill's claim procedure.

## Recovery moves

- Edits reverted, file still tracked: `git log --oneline -- <file>` +
  `git diff HEAD -- <file>` to see who/what moved it; re-apply from your
  session context (you have the content), not from memory.
- Wrong-branch commit: `git branch -f <right> <sha>` /
  `git cherry-pick`, never rebase a branch a concurrent session may have
  checked out.
- Before any salvage: `git tag backup/pre-salvage` so the salvage itself
  can't lose state.
