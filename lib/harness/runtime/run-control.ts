/**
 * Starting, steering and recovering Harness Evolution runs in this process
 * (ADR-0237).
 *
 * One driver per run per process: {@link launchHarnessRun} keeps the abort
 * controller of every run it drives, so a cancel reaches the driver doing the
 * work and that driver writes the cancellation itself. A run driven by another
 * window is cancelled by a compare-and-swap write instead; its driver loses
 * its next write and stops.
 *
 * A run that waits for approval is announced with an actionable notification
 * (Approve / Reject), the same pattern workflow approvals use; the command
 * handlers are installed by {@link installHarnessNotificationActions}.
 *
 * Notification copy is English by the runtime-notification precedent (see
 * `lib/workflow/runtime/approval-notify.ts`).
 */

import type { HarnessEvolutionRun, HarnessEvolutionStep } from "@/types/harness/evolution"
import { isTerminalRunStatus, transitionRun } from "../machine"
import { harnessEvolutionSettingsOf } from "../settings"
import {
  HarnessRunCancelledError,
  approveHarnessRunWith,
  driveHarnessRun,
  type HarnessDriverDeps,
} from "./driver"

/** The run viewer for one run. */
export function harnessRunHref(runId: string): string {
  return `/agents/evolution?run=${encodeURIComponent(runId)}`
}

/** Notification-action command key for approve / reject. */
export const HARNESS_RUN_RESPOND_COMMAND = "harness.run.respond"

export class HarnessRunControlError extends Error {
  constructor(
    readonly code: "not-found" | "not-awaiting" | "not-resumable" | "not-adopted" | "busy",
    message: string
  ) {
    super(message)
    this.name = "HarnessRunControlError"
  }
}

export interface HarnessRunControlStore {
  getRun(id: string): Promise<HarnessEvolutionRun | undefined>
  saveRun(next: HarnessEvolutionRun, expectedVersion: number): Promise<HarnessEvolutionRun>
  listOrphanedRuns(now: number): Promise<HarnessEvolutionRun[]>
  listSteps(runId: string): Promise<HarnessEvolutionStep[]>
  putStep(step: HarnessEvolutionStep): Promise<void>
}

export interface HarnessRunControlDeps {
  driver(): Promise<HarnessDriverDeps>
  store: HarnessRunControlStore
  rollback(run: HarnessEvolutionRun): Promise<HarnessEvolutionRun["adoption"]>
  /** Withdraw a run's approval notification. Best-effort. */
  dismissApproval(runId: string): Promise<void>
  now(): number
}

interface ActiveRun {
  controller: AbortController
  done: Promise<HarnessEvolutionRun | undefined>
}

const active = new Map<string, ActiveRun>()

/** Whether this process is driving the run right now. */
export function isHarnessRunActiveHere(runId: string): boolean {
  return active.has(runId)
}

/**
 * Drive a run in the background. Idempotent: a run this process already
 * drives returns its pending result.
 */
export function launchHarnessRun(
  runId: string,
  deps: HarnessRunControlDeps = defaultRunControlDeps()
): Promise<HarnessEvolutionRun | undefined> {
  const running = active.get(runId)
  if (running) return running.done
  const controller = new AbortController()
  const done = (async () => {
    try {
      return await driveHarnessRun(runId, await deps.driver(), { signal: controller.signal })
    } finally {
      active.delete(runId)
    }
  })()
  active.set(runId, { controller, done })
  return done
}

/** Write a transition by compare-and-swap, re-reading once on a lost race. */
async function transitionStored(
  deps: HarnessRunControlDeps,
  runId: string,
  decide: (run: HarnessEvolutionRun) => HarnessEvolutionRun | null
): Promise<HarnessEvolutionRun | undefined> {
  for (let tries = 0; tries < 3; tries++) {
    const run = await deps.store.getRun(runId)
    if (!run) throw new HarnessRunControlError("not-found", "The run no longer exists.")
    const next = decide(run)
    if (!next) return run
    try {
      return await deps.store.saveRun(next, run.version)
    } catch (error) {
      if (tries === 2) throw error
    }
  }
  return undefined
}

/** Stop a run. A run this process drives stops through its driver; any other run by a direct write. */
export async function cancelHarnessRun(
  runId: string,
  deps: HarnessRunControlDeps = defaultRunControlDeps()
): Promise<HarnessEvolutionRun | undefined> {
  const running = active.get(runId)
  if (running) {
    running.controller.abort(new HarnessRunCancelledError())
    const run = await running.done
    await deps.dismissApproval(runId).catch(() => undefined)
    return run
  }
  const run = await transitionStored(deps, runId, (r) =>
    isTerminalRunStatus(r.status)
      ? null
      : transitionRun(r, "cancelled", { error: "Cancelled." }, deps.now())
  )
  await interruptOpenSteps(deps, runId, "cancelled")
  await deps.dismissApproval(runId).catch(() => undefined)
  return run
}

/** Continue an interrupted run (or one whose driver's lease lapsed). */
export async function resumeHarnessRun(
  runId: string,
  deps: HarnessRunControlDeps = defaultRunControlDeps()
): Promise<HarnessEvolutionRun | undefined> {
  const run = await deps.store.getRun(runId)
  if (!run) throw new HarnessRunControlError("not-found", "The run no longer exists.")
  const resumable =
    run.status === "interrupted" ||
    run.status === "queued" ||
    (!isTerminalRunStatus(run.status) &&
      run.status !== "awaiting_approval" &&
      (!run.owner || run.owner.leaseExpiresAt <= deps.now()))
  if (!resumable) {
    throw new HarnessRunControlError(
      "not-resumable",
      "Only an interrupted or stalled run can be resumed."
    )
  }
  return launchHarnessRun(runId, deps)
}

/** Adopt the decision of a run waiting for approval, as the person decided. */
export async function approveHarnessRun(
  runId: string,
  options: { setAsWorkspaceDefault?: boolean } = {},
  deps: HarnessRunControlDeps = defaultRunControlDeps()
): Promise<HarnessEvolutionRun> {
  const run = await approveHarnessRunWith(runId, await deps.driver(), options)
  if (!run) {
    throw new HarnessRunControlError(
      "not-awaiting",
      "This run is not waiting for approval (it may have been decided elsewhere)."
    )
  }
  await deps.dismissApproval(runId).catch(() => undefined)
  return run
}

/** Decline the decision of a run waiting for approval: the base stays. */
export async function rejectHarnessRun(
  runId: string,
  deps: HarnessRunControlDeps = defaultRunControlDeps()
): Promise<HarnessEvolutionRun | undefined> {
  const run = await transitionStored(deps, runId, (r) => {
    if (r.status !== "awaiting_approval") {
      throw new HarnessRunControlError("not-awaiting", "This run is not waiting for approval.")
    }
    return transitionRun(r, "rejected", {}, deps.now())
  })
  await deps.dismissApproval(runId).catch(() => undefined)
  return run
}

/** Undo a completed run's adoption. Refuses after unrelated edits to the agent. */
export async function rollbackHarnessRun(
  runId: string,
  deps: HarnessRunControlDeps = defaultRunControlDeps()
): Promise<HarnessEvolutionRun | undefined> {
  const run = await deps.store.getRun(runId)
  if (!run) throw new HarnessRunControlError("not-found", "The run no longer exists.")
  if (run.status !== "completed" || !run.adoption || run.adoption.rolledBackAt) {
    throw new HarnessRunControlError("not-adopted", "This run has no adoption in effect.")
  }
  const adoption = await deps.rollback(run)
  return transitionStored(deps, runId, (r) =>
    r.status === "completed" ? transitionRun(r, "rolled_back", { adoption }, deps.now()) : null
  )
}

async function interruptOpenSteps(
  deps: HarnessRunControlDeps,
  runId: string,
  why: string
): Promise<void> {
  const now = deps.now()
  for (const step of await deps.store.listSteps(runId)) {
    if (step.status !== "running") continue
    await deps.store.putStep({
      ...step,
      status: "interrupted",
      error: why,
      endedAt: now,
      updatedAt: now,
    })
  }
}

/**
 * Mark runs whose driver died (lease lapsed mid-phase) as interrupted. They
 * resume only on a person's request: a resume spends again, and the app must
 * never do that silently. Runs this process drives are left alone.
 */
export async function recoverOrphanedHarnessRuns(
  deps: HarnessRunControlDeps = defaultRunControlDeps()
): Promise<string[]> {
  const recovered: string[] = []
  for (const orphan of await deps.store.listOrphanedRuns(deps.now())) {
    if (active.has(orphan.id)) continue
    try {
      const run = await transitionStored(deps, orphan.id, (r) =>
        r.status === orphan.status && (!r.owner || r.owner.leaseExpiresAt <= deps.now())
          ? transitionRun(
              (() => {
                const copy = { ...r }
                delete copy.owner
                return copy
              })(),
              "interrupted",
              {},
              deps.now()
            )
          : null
      )
      if (run?.status === "interrupted") {
        await interruptOpenSteps(deps, orphan.id, "The app stopped while this step ran.")
        recovered.push(orphan.id)
      }
    } catch (error) {
      console.warn("Harness run recovery failed", orphan.id, error)
    }
  }
  return recovered
}

// ── approval notification ────────────────────────────────────────────────────

export interface HarnessNotifyDeps {
  notify(input: {
    source: "system"
    level: "warning"
    title: string
    body?: string
    href: string
    dedupeKey: string
    groupKey: string
    directed: true
    projectId?: string
    sourceRef: { kind: string; id: string }
    actions: Array<{
      id: string
      label: string
      command: string
      args: Record<string, unknown>
      variant?: "primary" | "secondary"
    }>
  }): Promise<string>
}

export const HARNESS_APPROVAL_REF_KIND = "harness-evolution-approval"

/** Announce a run waiting for approval. Content-free beyond the agent name and risk. */
export async function notifyHarnessApproval(
  run: HarnessEvolutionRun,
  deps?: HarnessNotifyDeps
): Promise<void> {
  const notify =
    deps?.notify ?? (async (input) => (await import("@/lib/notifications/runtime")).notify(input))
  const decision = run.decision
  try {
    await notify({
      source: "system",
      level: "warning",
      title: `Approve an improved harness for ${run.characterName}?`,
      body: [
        decision?.risk ? `Risk: ${decision.risk}.` : "",
        `Scope: ${run.config.scope}.`,
        decision?.reason ?? "",
      ]
        .filter(Boolean)
        .join(" ")
        .slice(0, 400),
      href: harnessRunHref(run.id),
      dedupeKey: `harness-approval:${run.id}`,
      groupKey: run.id,
      directed: true,
      ...(run.projectId ? { projectId: run.projectId } : {}),
      sourceRef: { kind: HARNESS_APPROVAL_REF_KIND, id: run.id },
      // Workspace scope also asks whether to make the variant the default;
      // that question needs the run viewer, so the inline action is for the
      // other scopes only.
      actions:
        run.config.scope === "workspace"
          ? []
          : [
              {
                id: "approve",
                label: "Approve",
                command: HARNESS_RUN_RESPOND_COMMAND,
                args: { runId: run.id, decision: "approve" },
                variant: "primary",
              },
              {
                id: "reject",
                label: "Reject",
                command: HARNESS_RUN_RESPOND_COMMAND,
                args: { runId: run.id, decision: "reject" },
                variant: "secondary",
              },
            ],
    })
  } catch (error) {
    console.warn("Harness approval notification failed", error)
  }
}

/** Install the Approve / Reject handlers. Returns the unregister function. */
export async function installHarnessNotificationActions(
  deps: HarnessRunControlDeps = defaultRunControlDeps()
): Promise<() => void> {
  const { registerNotificationCommand } = await import("@/lib/notifications/action-registry")
  return registerNotificationCommand(HARNESS_RUN_RESPOND_COMMAND, async (ctx) => {
    const runId = ctx.args?.runId
    const decision = ctx.args?.decision
    if (typeof runId !== "string") return
    if (decision === "approve") await approveHarnessRun(runId, {}, deps)
    else if (decision === "reject") await rejectHarnessRun(runId, deps)
  })
}

/** Archive a run's approval notification once the approval is moot. */
async function dismissApprovalNotification(runId: string): Promise<void> {
  const [{ findByDedupeKey, patchNotification }, { useNotificationStore }, { cascadeReadState }] =
    await Promise.all([
      import("@/lib/db/notifications"),
      import("@/stores/notifications/notification-store"),
      import("@/lib/notifications/read-state"),
    ])
  const record = await findByDedupeKey(`harness-approval:${runId}`, 0)
  if (!record) return
  const store = useNotificationStore.getState()
  if (store.items.some((r) => r.id === record.id)) {
    await store.markDone(record.id)
  } else {
    await patchNotification(record.id, cascadeReadState(record, "done", Date.now()))
  }
}

// ── production wiring ────────────────────────────────────────────────────────

let processOwnerId: string | undefined

function ownerId(): string {
  processOwnerId ??= `harness-driver:${crypto.randomUUID()}`
  return processOwnerId
}

/** Production driver dependencies, bound to the real runners and stores. */
export async function defaultHarnessDriverDeps(): Promise<HarnessDriverDeps> {
  const [
    store,
    usage,
    settingsDb,
    probeRunner,
    editorRunner,
    judges,
    modelCall,
    capture,
    adoption,
  ] = await Promise.all([
    import("@/lib/db/harness-evolution"),
    import("@/lib/db/session-usage"),
    import("@/lib/db/settings"),
    import("./probe-runner"),
    import("./editor-runner"),
    import("./judges"),
    import("./model-call"),
    import("./capture"),
    import("./adoption"),
  ])
  const [probeDeps, modelDeps, captureDeps, adoptionDeps] = await Promise.all([
    probeRunner.defaultProbeRunnerDeps(),
    modelCall.defaultHarnessModelDeps(),
    capture.defaultCaptureDeps(),
    adoption.defaultAdoptionDeps(),
  ])
  const editorDeps = { model: modelDeps, agentic: probeDeps, fs: probeDeps.isolation.fs }
  return {
    store: {
      getRun: store.getHarnessRun,
      saveRun: store.saveHarnessRun,
      claimLease: store.claimHarnessRunLease,
      listSteps: store.listHarnessSteps,
      putStep: store.putHarnessStep,
      getSnapshot: store.getHarnessSnapshot,
      putSnapshot: store.putHarnessSnapshot,
      listRolloutsByCacheKey: store.listRolloutsByCacheKey,
      listExperiences: store.listHarnessExperiences,
      getExperience: store.getHarnessExperience,
      putExperience: store.putHarnessExperience,
      updateExperience: store.updateHarnessExperience,
      deleteExperience: store.deleteHarnessExperience,
      prune: store.pruneHarnessHistory,
    },
    runners: {
      discoverSurface: (input) => probeRunner.discoverProbeToolSurface(input, probeDeps),
      probe: (input) => probeRunner.runProbe(input, probeDeps),
      editor: (input) => editorRunner.runEditorSession(input, editorDeps),
      judge: (ctx) => judges.createSelectionJudge(ctx, modelDeps),
      reflect: (ctx) => judges.runReflector(ctx, modelDeps),
      adopt: (input) => adoption.adoptHarness(input, adoptionDeps),
    },
    capture: (characterId, options) => capture.captureHarness(characterId, options, captureDeps),
    listUsage: (sessionId) => usage.listUsageForSession(sessionId),
    experienceCap: async () =>
      harnessEvolutionSettingsOf(await settingsDb.getSettings()).experienceCapPerAgent,
    notifyAwaitingApproval: (run) => notifyHarnessApproval(run),
    ownerId: ownerId(),
    now: Date.now,
    newId: () => crypto.randomUUID(),
  }
}

export function defaultRunControlDeps(): HarnessRunControlDeps {
  let driver: Promise<HarnessDriverDeps> | undefined
  return {
    driver: () => (driver ??= defaultHarnessDriverDeps()),
    store: {
      getRun: async (id) => (await import("@/lib/db/harness-evolution")).getHarnessRun(id),
      saveRun: async (next, expected) =>
        (await import("@/lib/db/harness-evolution")).saveHarnessRun(next, expected),
      listOrphanedRuns: async (now) =>
        (await import("@/lib/db/harness-evolution")).listOrphanedHarnessRuns(now),
      listSteps: async (runId) =>
        (await import("@/lib/db/harness-evolution")).listHarnessSteps(runId),
      putStep: async (step) => (await import("@/lib/db/harness-evolution")).putHarnessStep(step),
    },
    rollback: async (run) => {
      const adoption = await import("./adoption")
      return adoption.rollbackHarnessAdoption(run, await adoption.defaultAdoptionDeps())
    },
    dismissApproval: dismissApprovalNotification,
    now: Date.now,
  }
}
