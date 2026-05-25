# Backend Refactor Suite

A first-party cognia plugin that packages a reusable **backend-refactoring development system** out of cognia's own features — roles (characters), a tool-enabled workflow node, skills, an agent team, and an end-to-end workflow template. Point it at a cloned Go repository (first target: [NJUPT-SAST/sast-link-backend](https://github.com/NJUPT-SAST/sast-link-backend)) and run the pipeline.

## What it contributes

| Capability               | Contribution                                                                                                     |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `character-pack`         | **6 role personas** — analyst, architect, refactorer, tester, reviewer, doc-writer                               |
| `workflow` (custom node) | **`agent.turn`** — a synchronous, tool-enabled, cwd-scoped Claude turn (the only piece that actually edits code) |
| `skills`                 | 5 inline playbooks — go-clean-architecture, refactor-playbook, go-testing, backend-infra, dependency-upgrade     |
| `subagent`               | 2 read-only reasoning helpers — go-analyzer, diff-reviewer                                                       |
| `agent-team-template`    | **Refactor Review Board** — architect + analyst + reviewer (deliberation)                                        |
| `workflow-template`      | **backend-refactor-pipeline** — the editing spine                                                                |

## How it works (and why it's built this way)

cognia has exactly one execution path that runs a **tool-enabled** Claude turn (Bash/Read/Edit/Glob/Grep with a working directory): the chat/character path (`resolveSendOptions` → sidecar → Claude Agent SDK). Agent-Team teammate dispatch (`executeAgent` → AI SDK `streamText`) is **text-only**, and `action.character.send` only enqueues a message. So:

- **`agent.turn`** drives the actual edits — it reuses `runAndCaptureAssistantReply` (the same headless runner connectors use) to run a role persona as a real, `cwd`-scoped, tool-enabled turn and wait for the result. **Desktop-only** (needs the Tauri sidecar).
- **`action.system.terminal`** runs the Go quality gate (`go build/vet/test`, lint) and branches on exit code.
- The **Refactor Review Board** team is for the reasoning phases (analysis / plan / review) where text output is the deliverable.

## The pipeline

```
trigger → analyze → plan → refactor → gate1 ─ success → ok1 ┐
                                            └ failure → fix1 → gate2 ─ success → ok2 ┤
                                                                      └ failure → failnote (stop)
                                                          ok1 ┴ ok2 → test → coverage gate → review → docs → commit
```

Each agent step runs a role via `agent.turn` scoped to `{{ $vars.repoPath }}`. `gate1`/`gate2` are `action.system.terminal` running `go build/vet/test`, branching on exit code. The runtime executes each node once (no loops), so the fix path is a **bounded one-retry**: a failed gate routes to a `refactorer` fix turn, then `gate2` re-verifies — success rejoins the shared tail (via the `ok1`/`ok2` passthroughs), a second failure stops at `failnote` for manual inspection. Role agents also self-verify (`go build/test`) within each turn, so the gate is a checkpoint, not the only safety net.

The **Refactor Review Board** team is a _separate_ deliberation surface (run it on its own for multi-agent analysis/plan/review). It is intentionally **not** wired into the editing pipeline: team dispatch is text-only and can't read the repo, whereas the pipeline's `architect`/`reviewer` `agent.turn` steps are tool-enabled and inspect the actual code — strictly more capable for those phases.

## Running it

The pipeline edits code through the sidecar, so it runs in the **Tauri desktop app**:

1. `pnpm tauri dev`, then enable **Backend Refactor Suite** in Settings → Plugins.
2. Clone the target repo locally (e.g. `git clone https://github.com/NJUPT-SAST/sast-link-backend`).
3. In the workflow editor → right sidebar → **Settings → Plugins & capabilities**, find **backend-refactor-pipeline** and click **Use** (projects it into a new, editable workflow).
4. Set a workflow variable **`repoPath`** to the absolute path of your clone, then **Run**.

Watch progress in the run-history timeline + per-step inspector.

### Notes

- All roles use `permissionMode: "bypassPermissions"` because the run is headless — an interactive permission prompt has no UI to answer it. The agent operates on the repo you explicitly point it at.
- The roles' `workingDir` is injected at run time by the node, so the same pack refactors any clone.

## Development

```bash
# Tests (co-located *.test.ts)
pnpm exec jest --testPathPatterns="plugins/cognia-backend-refactor"

# Scoped coverage (≥90% gate)
pnpm exec jest --coverage \
  --testPathPatterns="plugins/cognia-backend-refactor" \
  --collectCoverageFrom="plugins/cognia-backend-refactor/src/**/*.ts" \
  --collectCoverageFrom="!**/*.test.ts"
```

Built-in discovery is wired in `lib/plugin/core/browser-builtin-registry.ts`.
