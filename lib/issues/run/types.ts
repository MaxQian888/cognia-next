/**
 * Issue run bridge — contracts (ADR-0132, slice ③).
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

import type {
  Issue,
  IssueActor,
  IssueProject,
  IssueRun,
  IssueRunKind,
  IssueRunWakeup,
} from "@/types/issues"
import type { SettleIssueRunInput } from "@/lib/db/issue-runs"

/**
 * Where the Run gesture came from; picks the team gate policy. `wakeup` is an
 * issue wakeup firing (`lib/issues/wakeups/`): nobody pressed anything, so it
 * gets the unattended policy `im` without a conversation gets.
 */
export type IssueRunOrigin = "interactive" | "im" | "wakeup"

/**
 * Did a person name this run (pick the engine and the moment), as opposed to
 * a door deriving it from the issue? Only named runs may start on an issue in
 * triage. Derived is the default, so a new origin is strict until it says so.
 */
export function isNamedRunOrigin(origin: IssueRunOrigin): boolean {
  return origin === "interactive"
}

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
  /** An open blocker stands in the way (spec 2026-09-06 D5). `detail` lists them. */
  | "blocked"
  /**
   * The issue waits in triage (`Issue.triage`) and nobody named this run: a
   * run whose engine and moment were derived (`im`, `wakeup`) would act on a
   * proposal nobody accepted yet. An `interactive` run — a person picking
   * the engine in the Run dialog — proceeds. See {@link isNamedRunOrigin}.
   */
  | "issue-in-triage"
  /** No adapter is registered under the requested id. */
  | "adapter-missing"

export type IssueRunVerdict =
  { ok: true } | { ok: false; reason: IssueRunRefusalReason; detail?: string }

/**
 * The IM thread a Run gesture came from, when it came from one.
 *
 * `origin: "im"` alone puts a Squad run under the headless gate policy, whose
 * plan gate fails fast on the premise that nobody can answer. A card press in
 * a chat thread has a person on the other end, and the adapter proves it by
 * building the same plan-approval delegate the chat IM lane uses. Without
 * this the run is genuinely unattended, and the fail-fast stands.
 */
export interface IssueRunConversation {
  adapterId: string
  conversationKey: string
  /** remoteUserId of the person who pressed Run; only they (or an operator) may answer. */
  initiatorUserId?: string
}

export interface IssueRunStartContext {
  by: IssueActor
  origin: IssueRunOrigin
  /** Present when the gesture came from an IM card. See {@link IssueRunConversation}. */
  conversation?: IssueRunConversation
  /**
   * Adapter-specific options from the Run dialog (e.g. `base` branch for the
   * GitHub loop). Adapters validate what they read and ignore the rest.
   */
  options?: Readonly<Record<string, unknown>>
  /**
   * Why this run exists beyond the issue itself: a wakeup's instruction and
   * the inputs that fired it. Every adapter appends it to the text its engine
   * receives (`withRunBrief`), after the issue.
   */
  brief?: string
  /** Lineage when an issue wakeup started the run. Adapters store it on the row. */
  wakeup?: IssueRunWakeup
}

/** The engine-facing text with a run brief appended, when there is one. */
export function withRunBrief(text: string, brief: string | undefined): string {
  const trimmed = brief?.trim()
  if (!trimmed) return text
  return text.trim() ? `${text}\n\n${trimmed}` : trimmed
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
  /**
   * Chat sessions the active run is executing in, newest first. Two callers:
   * a wakeup input joins the run by steering the newest one, and a check-in
   * is accepted only from one of them. An adapter that cannot name a session
   * omits this, which makes its runs unjoinable (inputs are held until the
   * run settles) and un-check-in-able, rather than guessed at.
   */
  sessionIds?(run: IssueRun): Promise<string[]>
}
