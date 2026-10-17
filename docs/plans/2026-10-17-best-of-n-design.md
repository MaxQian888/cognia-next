# Best-of-N parallel attempts (W5)

Date: 2026-10-17. Follows `2026-10-16-agent-sandbox-workspace-gap-analysis.md`.
Design review: a read-only Codex pass against `dev` at `966a71933e`.

One prompt runs as N (2–4) isolated candidates from one frozen base, the user
compares them side by side, picks one, and the pick publishes through the
ADR-0227 integration queue. The rest are archived.

## Decisions (user, 2026-10-17)

- **Base:** a committed SHA only. The SHA is resolved once and every candidate
  starts from it. With uncommitted changes in the checkout the start dialog
  says so; they are not carried into the candidates.
- **Publish target:** a new result branch by default, shown explicitly. An
  existing branch moves only when the user picks it. Never pushes.
- **Choosing:** manual only. Check results are shown to inform the choice; no
  AI judge, and neither plugins nor unattended policy can pick a winner.

Further defaults (no product question): picking early is allowed and stops the
remaining candidates; a candidate with no code change is shown but cannot be
published; candidates are limited to one Host and one Git repository; unknown
external-agent cost is shown as unknown, never 0.

## Reuse

- Agent Team durable runtime (`lib/ai/agent/team/durable/`), with a fixed set
  of N independent tasks: no planning step, no answer sharing, no synthesis.
- Workspace bundles per candidate: `acquireWorkspaceBundle` with
  `base: { kind: "gitRef", gitRef: sha }`, owner = the candidate's child
  session. Port blocks come from ADR-0229.
- Per-candidate agent/model through `AgentCapabilityGrantV1` into
  `resolveSendOptions` (ADR-0198), never by editing the returned options.
- Comparison evidence from the changeset pipeline: capture, the same approved
  acceptance profiles per candidate (ADR-0188), review records.
- Publish via `createScmRuntime.integrate` with only the chosen changeset and
  `onConflict: "stop"`.
- Diff rendering via `SourceControlService.diffRevisionFile` + `DiffViewer`
  (read-only), detail via `ChangesetDetail`.

## New

- **Ledger authority** in the Host's `task-workspaces.sqlite`:
  `best_of_n_groups` and `best_of_n_candidates` (ids, request id for
  idempotency, base SHA, target ref, N, budget policy, team run id, phase,
  selected candidate + head SHA, integration id, version, owner lease).
  A Host guard at integration prepare and publish rejects any changeset from a
  group that is not that group's selected winner, so generic SCM paths cannot
  publish a loser. Dexie only keeps a rebuildable projection for the UI and
  paired-device sync.
- **Write leases keyed by physical workspace**: the durable coordinator leases
  `runId:repositoryId` today and isolated-parallel requires disjoint file
  ownership; candidates in different physical roots may edit the same relative
  path, aliases of one root stay mutually exclusive.
- **Phases:** `preparing → running → awaitingSelection → publishing →
published`, plus `cancelling/cancelled/recoveryRequired`; archive progress is
  tracked separately so a cleanup failure never masks a successful publish.
  One failed candidate does not cancel the others; zero successes fails the
  group.
- **Entry points:** `/best-of-n [2|3|4] <prompt>` (plus `status`, `cancel`,
  `pick`) and a composer chip for the next send only. Both call one
  `startBestOfN` service, and the parent message is not sent a second time.
- **UI:** `BestOfNRunCard` under the parent assistant message (same slot as
  `RouterFusionRunCard`), opening a dock/sheet comparison with 2–4 columns:
  agent/model, status, base, files changed, checks, cost, duration, summary.
- **Headless/CLI/plugin:** structured start/get/list/cancel/select/publish/
  archive host commands; plugins get start/observe only (team:read,
  agent:dispatch, agent:control), never select.

## Phases

1. Ledger, idempotent allocation, fixed fan-out, physical-workspace leases,
   shared base, budget, recovery; publish guard for losers.
2. Slash command + composer chip, comparison UI, manual pick, exact-head checks,
   single-winner integration to a result branch, archive, synced summary.
3. Heterogeneous external agents per candidate, CLI/headless/plugin surface,
   paired-device and restart acceptance.

Status (2026-10-17): all three phases are implemented; ADR-0230 records the
phase 3 rules.
