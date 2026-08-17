/**
 * Issue run bridge — contracts (ADR-0130, slice ③).
 *
 * An `IssueRunAdapter` dispatches a local issue to one existing execution
 * engine and reports back when the engine reaches a terminal state. The bridge
 * NEVER executes anything itself: `agent` assignees run through
 * `lib/agent-tasks/runtime.ts`, `team` assignees through
 * `lib/ai/agent/agent-team.ts`, and GitHub-linked issues optionally through the
 * `github-delivery` plugin's `runIssueLoop`. Adding an engine is one adapter
 * file plus a `registerIssueRunAdapter` call in the tracker's initializer.
 *
 * Ownership rule (shared with `lib/issues/state-machine.ts`): a run owns
 * `in_progress`; when it ends the issue advances to `in_review` and STOPS.
 * `done` is the human's call — no adapter may promote past review.
 */

import type { Issue, IssueActor, IssueProject, IssueRun, IssueRunKind } from "@/types/issues"
import type { SettleIssueRunInput } from "@/lib/db/issue-runs"

/** Where the Run gesture came from; picks the team gate policy. */
export type IssueRunOrigin = "interactive" | "im"

/** Everything an adapter needs to decide and to start. */
export interface IssueRunTarget {
  issue: Issue
  /** The delivery container, when it still exists. */
  project: IssueProject | undefined
}

/**
 * Why an adapter refuses to run an issue. Keyed for i18n at the UI layer
 * (`issues.run.refusal.*`); never a free-text string, so the Run button can
 * explain itself without string matching.
 */
export type IssueRunRefusalReason =
  /** The issue has no assignee, or the assignee kind is not this adapter's. */
  | "assignee-kind-mismatch"
  /** The assignee id resolves to nothing (deleted Character / AgentTeam, or an unknown namespace). */
  | "assignee-not-found"
  /** The AgentTeam is already executing / planning / paused; its task snapshot is fixed. */
  | "team-busy"
  /** GitHub loop needs a linked GitHub issue on the row. */
  | "no-github-ref"
  /** GitHub loop needs the delivery container to be bound to that repository. */
  | "no-github-repo"
  /** GitHub loop runs only on the desktop host (clone + git). */
  | "desktop-only"
  /** No enabled GitHub account to run the loop through. */
  | "no-github-account"
  /** Another run is already active for this issue. */
  | "run-active"
  /** The issue is done / canceled; runs only start on open issues. */
  | "issue-finished"
  /** No adapter is registered under the requested id. */
  | "adapter-missing"

export type IssueRunVerdict =
  { ok: true } | { ok: false; reason: IssueRunRefusalReason; detail?: string }

export interface IssueRunStartContext {
  by: IssueActor
  origin: IssueRunOrigin
  /**
   * Adapter-specific options from the Run dialog (e.g. `base` branch for the
   * GitHub loop). Adapters validate what they read and ignore the rest.
   */
  options?: Readonly<Record<string, unknown>>
}

/**
 * `null` while the engine is still working; a settlement once it is terminal.
 * Adapters must be idempotent here — the reconciler calls `poll` on every
 * active run at boot and whenever an engine table changes.
 */
export type IssueRunPollResult = SettleIssueRunInput | null

export interface IssueRunAdapter {
  /** Stable id persisted on `IssueRun.adapterId`. */
  readonly id: string
  readonly kind: IssueRunKind
  /** Whether this adapter could run the target right now. Pure w.r.t. the tracker. */
  canRun(target: IssueRunTarget): Promise<IssueRunVerdict>
  /**
   * Dispatch to the engine and record the run (`createIssueRun`). Must throw
   * on engine failure — the bridge surfaces it; nothing swallows a failed
   * dispatch into a silent "queued" row.
   */
  start(target: IssueRunTarget, context: IssueRunStartContext): Promise<IssueRun>
  /** Inspect engine state for an active run. See `IssueRunPollResult`. */
  poll(run: IssueRun): Promise<IssueRunPollResult>
  /** Best-effort engine-side cancel. The bridge settles the run as `cancelled` afterwards. */
  cancel?(run: IssueRun): Promise<void>
}
