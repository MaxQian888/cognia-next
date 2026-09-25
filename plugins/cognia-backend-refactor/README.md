# Go Backend Refactor Suite

A first-party cognia plugin that packages a reusable **refactoring system for Go backends** out of cognia's own features — roles (characters), two workflow nodes, skills, an agent team, and an end-to-end workflow template. Point it at a clean clone of a Go repository (first target: [NJUPT-SAST/sast-link-backend](https://github.com/NJUPT-SAST/sast-link-backend)) and run the pipeline.

It is Go-specific: the gates run `go build` / `go vet` / `go test`, and the roles and skills are written for Go layering, testing, and module upgrades.

## What it contributes

| Capability               | Contribution                                                                                                          |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| `character-pack`         | **6 role personas** — analyst, architect, refactorer, tester, reviewer, doc-writer                                    |
| `workflow` (custom node) | **`agent.turn`** — a synchronous, tool-enabled, cwd-scoped Claude turn (the only piece that actually edits code)      |
| `workflow` (custom node) | **`pipeline.stop`** — fails the run with a reason; ends every path that must not continue                             |
| `skills`                 | 5 inline playbooks — go-clean-architecture, refactor-playbook, go-testing, backend-infra, dependency-upgrade          |
| `subagent`               | 2 read-only reasoning helpers — go-analyzer, diff-reviewer                                                            |
| `agent-team-template`    | **Refactor Review Board** — architect + analyst + reviewer (deliberation)                                             |
| `workflow-template`      | **Go Backend Refactor Pipeline** — the editing spine, with a reviewer verdict gate and a human approval before commit |

## How it works (and why it's built this way)

cognia has exactly one execution path that runs a **tool-enabled** Claude turn (Bash/Read/Edit/Glob/Grep with a working directory): the chat/character path (`resolveSendOptions` → sidecar → Claude Agent SDK). Agent-Team teammate dispatch is **text-only**, and `action.character.send` only enqueues a message. So:

- **`agent.turn`** drives the actual edits through `ctx.agent.runCharacterTurn` — a role persona runs as a real, `cwd`-scoped, tool-enabled turn and the workflow waits for the result. **Desktop-only** (needs the Tauri sidecar).
- **`action.system.terminal`** runs the Go quality gate (`go build/vet/test`) and branches on exit code.
- The **Refactor Review Board** team is for the reasoning phases (analysis / plan / review) where text output is the deliverable.

## The pipeline

```
trigger → clean ─ success → analyze → plan → refactor → gate1
            └ failure → stop: uncommitted changes
gate1 ─ success → ok1 ┐
      └ failure → fix1 → gate2 ─ success → ok2 ┤
                               └ failure → stop: still failing
ok1 ┴ ok2 → test → coverage gate → review → verdict
verdict ─ VERDICT: APPROVE → docs → list changes → approve (you)
        └ anything else → stop: changes requested
approve ─ approved → commit
        └ rejected / 24 h timeout → stop: commit not approved
```

- **clean** refuses to start unless the clone has no uncommitted or untracked files, so the commit can only ever contain this run's changes.
- **gate1 / gate2** give the refactor one bounded fix attempt. The runtime executes each node once (no loops), so a second failure stops the run.
- **verdict** reads the reviewer's final line. Only an explicit `VERDICT: APPROVE` (with no `VERDICT: REQUEST CHANGES` anywhere) continues; a missing or ambiguous verdict stops — it fails closed.
- **approve** is an `action.approval.request` step: a notification-center card (or your paired phone) shows the files about to be committed. Rejecting, or not answering within 24 hours, stops the run.
- **commit** stages tracked changes (`git add --update`) plus the new, non-ignored files the run created — never `git add -A`.
- Every stop is a **`pipeline.stop`** node, so the run is recorded as **failed** with the reason, not as a success.

Each agent step runs a role via `agent.turn` scoped to `{{ $vars.repoPath }}`. Role agents also self-verify (`go build/test`) within each turn, so the gate is a checkpoint, not the only safety net.

The **Refactor Review Board** team is a _separate_ deliberation surface (run it on its own for multi-agent analysis/plan/review). It is intentionally **not** wired into the editing pipeline: team dispatch is text-only and can't read the repo, whereas the pipeline's `architect`/`reviewer` `agent.turn` steps are tool-enabled and inspect the actual code.

## Running it

The pipeline edits code through the sidecar and runs `go`/`git` in the desktop terminal, so it runs in the **Tauri desktop app** only. In the browser and on mobile the characters, skills, team, and template still load, but the pipeline cannot run.

1. `pnpm tauri dev`, then enable **Go Backend Refactor Suite** in Settings → Plugins.
2. Clone the target repo locally (e.g. `git clone https://github.com/NJUPT-SAST/sast-link-backend`) and make sure `git status` is clean.
3. In the workflow editor → right sidebar → **Settings → Plugins & capabilities**, find **Go Backend Refactor Pipeline** and click **Use** (projects it into a new, editable workflow).
4. Set a workflow variable **`repoPath`** to the absolute path of your clone, then **Run**.
5. When the run reaches **Approve commit**, review the listed files (and the Review step's output) and approve or reject.

Watch progress in the run-history timeline + per-step inspector.

### Permissions

- Every `agent.turn` runs in the **`dontAsk`** permission mode: it never prompts, runs exactly the tools the role pre-approves (`allowedTools` — Read/Glob/Grep for the architect; plus Bash for the analyst and reviewer; Read/Edit/Write/Glob/Grep for the doc writer; plus Bash for the refactorer and tester), and denies everything else. That is the least privilege an unattended run can work with; the previous `bypassPermissions` approved every tool the session could reach. If a turn still had a tool turned away, the step fails instead of passing a half-done turn on.
- The mode is set on the node call, not on the characters, so an ordinary chat with a refactor role keeps your normal permission prompts.
- `dontAsk` relies on the Claude Agent SDK honouring the role's `allowedTools`. With a non-Claude provider, only read-only tools are pre-approved, so the editing roles cannot edit.
- The roles' `workingDir` is injected at run time by the node, so the same pack refactors any clone.

## Development

```bash
# Tests (co-located *.test.ts)
pnpm exec jest plugins/cognia-backend-refactor
```

Built-in discovery is wired in `lib/plugin/core/browser-builtin-registry.ts`.
