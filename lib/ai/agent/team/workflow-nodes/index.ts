/**
 * The Agent Team's workflow node implementations (ADR-0217).
 *
 * `lib/workflow` registers the team node kinds so every workflow host knows
 * them, but it never imports team code: each executor runs through the
 * installable port in `lib/workflow/nodes/teams/team-runtime-port.ts`. This
 * module is what the team side installs there (see `./install.ts`), which
 * keeps the dependency one-way — team → workflow — and breaks the cycle the
 * workflow orchestrator used to close through `built-ins → teams → runtime`.
 */

import type {
  StepExecutionContext,
  StepExecutionResult,
  WorkflowTriggeredFrom,
} from "@/types/workflow/visual"
import type { TeamWorkflowNodes } from "@/lib/workflow/nodes/teams/team-runtime-port"
import { nonRetryable } from "@/lib/workflow/nodes/shared/executor-support"
import { runTeamCompose, runTeamDelegate, runTeamMessage, runTeamStatus } from "./team-ops"

// ── action.team.run ───────────────────────────────────────────────────────
// Per ADR-0022 §5 PR 4. Kicks off a team lifecycle via the F-path synthesizer.
// Wires storeReader/storeWriter from the live Zustand store; the runtime
// itself synthesizes a child VisualWorkflow and runs it through workflow
// runtime. Returns the team-run id (the inner workflowRuns row) so the UI
// can navigate.
export async function runTeamNode(ctx: StepExecutionContext): Promise<StepExecutionResult> {
  const params = ctx.params as { teamId?: string; goal?: string }
  const teamId = params.teamId?.trim()
  if (!teamId) throw nonRetryable("action.team.run requires 'teamId'")

  const [{ useAgentTeamStore }, { runTeamLifecycle }, { buildAgentTeamRuntimeDeps }] =
    await Promise.all([
      import("@/stores/agent/agent-team-store"),
      import("@/lib/ai/agent/team/agent-team-runtime"),
      import("@/lib/ai/agent/team/agent-team-runtime-deps"),
    ])

  const store = useAgentTeamStore.getState()
  const team = store.getTeam(teamId)
  if (!team) throw nonRetryable(`team ${teamId} not found`)

  // When the outer run was kicked off from an IM channel (via
  // `startWorkflowFromIM`, which mirrors the origin onto
  // `trigger.binding`), carry that origin into the synthesized team run so
  // the run-presentation runner fans the team's progress + final result
  // back to the originating conversation. Only set `source: "im"` when both
  // identifiers are present; UI / API runs leave it undefined so their
  // behavior is unchanged.
  const triggerBinding = ctx.trigger.binding
  const triggeredFrom: WorkflowTriggeredFrom | undefined =
    triggerBinding?.adapterId && triggerBinding?.conversationKey
      ? {
          source: "im",
          adapterId: triggerBinding.adapterId,
          conversationKey: triggerBinding.conversationKey,
          ...(triggerBinding.sessionId ? { sessionId: triggerBinding.sessionId } : {}),
        }
      : undefined

  // Loop guard: when THIS workflow was itself started by a team-completion
  // fan-out (trigger.team payload carries chainDepth), thread the depth
  // into the nested lifecycle so its own fan-out can stop at the cap.
  const triggerPayload = ctx.trigger.payload as { chainDepth?: unknown } | undefined
  const triggerChainDepth =
    typeof triggerPayload?.chainDepth === "number" ? triggerPayload.chainDepth : 0

  const partial = buildAgentTeamRuntimeDeps()
  const deps = {
    ...partial,
    ...(triggeredFrom ? { triggeredFrom } : {}),
    triggerChainDepth,
    // IM-originated workflows run headless (gate policy "im"); UI-launched
    // workflows keep the interactive blocking gates.
    origin: triggeredFrom ? ("im" as const) : ("interactive" as const),
    storeReader: {
      getTeam: (id: string) => useAgentTeamStore.getState().getTeam(id),
      getTeammates: (id: string) => useAgentTeamStore.getState().getTeammates(id),
      getTeamTasks: (id: string) => useAgentTeamStore.getState().getTeamTasks(id),
    },
    storeWriter: {
      addMessage: (
        input: Parameters<typeof useAgentTeamStore.getState>[never] extends never
          ? never
          : Parameters<ReturnType<typeof useAgentTeamStore.getState>["addMessage"]>[0]
      ) => useAgentTeamStore.getState().addMessage(input),
      setTaskStatus: (
        taskId: string,
        status: Parameters<ReturnType<typeof useAgentTeamStore.getState>["setTaskStatus"]>[1],
        result?: string,
        error?: string
      ) => useAgentTeamStore.getState().setTaskStatus(taskId, status, result, error),
      updateTeammate: (
        teammateId: string,
        updates: Parameters<ReturnType<typeof useAgentTeamStore.getState>["updateTeammate"]>[1]
      ) => useAgentTeamStore.getState().updateTeammate(teammateId, updates),
      addTask: (
        input: Parameters<ReturnType<typeof useAgentTeamStore.getState>["createTask"]>[0]
      ) => useAgentTeamStore.getState().createTask(input),
      updateTask: (
        taskId: string,
        updates: Parameters<ReturnType<typeof useAgentTeamStore.getState>["updateTask"]>[1]
      ) => useAgentTeamStore.getState().updateTask(taskId, updates),
      addEvent: (event: Parameters<ReturnType<typeof useAgentTeamStore.getState>["addEvent"]>[0]) =>
        useAgentTeamStore.getState().addEvent(event),
      addTeammate: (
        input: Parameters<ReturnType<typeof useAgentTeamStore.getState>["addTeammate"]>[0]
      ) => useAgentTeamStore.getState().addTeammate(input),
    },
  }

  const result = await runTeamLifecycle(teamId, deps, ctx.signal).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err)
    const wrapped = new Error(`action.team.run: ${message}`) as Error & { retryable?: boolean }
    wrapped.retryable = false
    throw wrapped
  })

  return {
    output: {
      teamId,
      teamRunId: result.runId,
      status: result.status,
      reason: result.reason,
    },
  }
}

// ── action.team.task.dispatch ─────────────────────────────────────────────
// Per ADR-0022 §3.6. Synthesizer-emitted node: one per AgentTeamTask. Looks
// up the per-run TeamRunContext (registered by the synthesizer before
// runWorkflow) and delegates to the shared `dispatchTeammate` primitive, which
// claims a teammate, runs one turn (tool-enabled via the sidecar on desktop,
// text-only fallback on web/mobile), validates output, and records pool /
// budget / hooks. The same primitive powers the ultracode `pattern.*` nodes.
//
// Retryable: true → workflow runStep retries on transient failures, and each
// retry re-claims from the pool, naturally rotating to a different teammate.
export async function dispatchTeamTask(ctx: StepExecutionContext): Promise<StepExecutionResult> {
  const params = ctx.params as {
    teamId?: string
    taskId?: string
    title?: string
    description?: string
    expectedOutput?: string
    assignedTo?: string
    dependencies?: string[]
    access?: "read" | "write"
    taskKind?: "general" | "code" | "ui"
    repositoryId?: string
    fileOwnership?: string[]
  }
  if (!params.teamId || !params.taskId) {
    throw nonRetryable("action.team.task.dispatch requires 'teamId' and 'taskId'")
  }
  const teamId = params.teamId
  const taskId = params.taskId
  const [
    { getTeamRunContext },
    { buildTeammatePrompt },
    { dispatchTeammate },
    { readDependencyResults, autoPublishTaskResult },
  ] = await Promise.all([
    import("@/lib/ai/agent/team/team-run-context"),
    import("@/lib/ai/agent/team/agent-team-runtime-deps"),
    import("@/lib/ai/agent/team/teammate/dispatch-teammate"),
    import("@/lib/ai/agent/team/memory/shared-memory-orchestrator"),
  ])
  const teamCtx = getTeamRunContext(ctx.runId)
  if (!teamCtx) {
    throw nonRetryable(
      `action.team.task.dispatch: no TeamRunContext registered for runId=${ctx.runId}`
    )
  }

  const task = {
    id: taskId,
    title: params.title ?? taskId,
    description: params.description ?? "",
    expectedOutput: params.expectedOutput,
  } as Parameters<typeof buildTeammatePrompt>[2]

  // Blackboard read: pull the results of this task's upstream dependencies so
  // the teammate builds on prior work instead of starting cold. Dependency
  // nodes always finish first (they're DAG predecessors), so their
  // `task:<id>` entries are on the board by the time this node runs.
  const depIds = Array.isArray(params.dependencies)
    ? params.dependencies.filter((d): d is string => typeof d === "string" && d.length > 0)
    : []
  const upstream = readDependencyResults(teamId, depIds)
  const upstreamBlock =
    upstream.length > 0
      ? [
          "Upstream results from teammates whose tasks you depend on — build on these:",
          ...upstream.map(
            (u) =>
              `### ${u.taskTitle ?? u.taskId}${u.writerName ? ` (by ${u.writerName})` : ""}\n${u.value}`
          ),
          "",
        ].join("\n\n")
      : ""

  const access = params.access === "read" ? "read" : "write"
  const taskKind =
    params.taskKind === "ui" || params.taskKind === "general" ? params.taskKind : "code"
  const result = await dispatchTeammate(teamCtx, {
    taskId,
    // Persona-aware prompt built from the teammate the pool actually claims,
    // prefixed with any upstream dependency results.
    prompt: (teammate) => {
      const base = buildTeammatePrompt(teamCtx.team, teammate, task)
      return upstreamBlock ? `${upstreamBlock}\n${base}` : base
    },
    signal: ctx.signal,
    validateOutput: true,
    recordToStore: true,
    access,
    taskKind,
    ...(typeof params.repositoryId === "string" ? { repositoryId: params.repositoryId } : {}),
    ...(Array.isArray(params.fileOwnership)
      ? {
          fileOwnership: params.fileOwnership.filter(
            (path): path is string => typeof path === "string" && path.length > 0
          ),
        }
      : {}),
    // Skill-aware claim: prefer the teammate the task was assigned to.
    ...(params.assignedTo ? { preferTeammateId: params.assignedTo } : {}),
  })

  // Blackboard write: publish this task's result under `task:<taskId>` so
  // downstream teammates can read it. PII-gated + best-effort — a blackboard
  // write must never fail the task itself.
  try {
    autoPublishTaskResult(
      { id: teamId },
      { id: taskId, title: params.title ?? taskId },
      result.text,
      { id: result.teammateId, name: result.teammateName }
    )
  } catch {
    /* never fail a completed task on a blackboard write */
  }

  return {
    output: {
      text: result.text,
      teammateId: result.teammateId,
      teammateName: result.teammateName,
      // What this task was dispatched as. A lead review's revision re-dispatch
      // reads them back, so a revision runs with the same access and answers
      // to the same evidence gate as the work it revises.
      access,
      taskKind,
      tokenUsage: result.usage,
      attempt: 1,
      // ADR-0090 Phase 6: surface a degraded dispatch (lesser rail than the
      // teammate's configuration asked for) on the workflow event stream.
      ...(result.degradedReason ? { degradedReason: result.degradedReason } : {}),
    },
  }
}

// ── action.team.task.review ───────────────────────────────────────────────
// Per ADR-0071. Synthesizer-emitted: one per task when `taskReview.enabled`,
// placed between a task's dispatch node and that task's dependents, so an
// unapproved task blocks downstream work at the SCHEDULER — dependents are not
// runnable, rather than downstream nodes being trusted to check a flag.
//
// The lead judges the worker's output plus a deterministic diff of what the
// task actually changed, and returns approved / changes_requested. A
// changes_requested re-dispatches the SAME worker into the SAME worktree with
// the lead's feedback, then reviews again, up to the budget frozen at synthesis.
//
// Not retryable: every failure mode here (exhausted budget, missing worker,
// reviewer failure) is a decision that unreviewed work must not land. Retrying
// would re-run the worker against the same wall and, worse, could let a flaky
// reviewer eventually rubber-stamp.
export async function reviewTeamTask(ctx: StepExecutionContext): Promise<StepExecutionResult> {
  const params = ctx.params as {
    teamId?: string
    taskId?: string
    title?: string
    description?: string
    expectedOutput?: string
    dispatchNodeId?: string
    maxRevisions?: number
  }
  if (!params.teamId || !params.taskId || !params.dispatchNodeId) {
    throw nonRetryable("action.team.task.review requires 'teamId', 'taskId' and 'dispatchNodeId'")
  }
  const { teamId, taskId } = params
  const [
    { getTeamRunContext },
    { dispatchTeammate, UnavailableRequiredTeammateError },
    { buildReviewEvidence },
    { DEFAULT_TASK_REVIEW_MAX_REVISIONS },
  ] = await Promise.all([
    import("@/lib/ai/agent/team/team-run-context"),
    import("@/lib/ai/agent/team/teammate/dispatch-teammate"),
    import("@/lib/ai/agent/team/ledger/review-evidence"),
    import("@/lib/ai/agent/team/gates/task-review-policy"),
  ])

  const teamCtx = getTeamRunContext(ctx.runId)
  if (!teamCtx) {
    throw nonRetryable(
      `action.team.task.review: no TeamRunContext registered for runId=${ctx.runId}`
    )
  }
  // Fail closed. Review is on, so work that reaches here has to be reviewed;
  // silently skipping would be the worst outcome — an unreviewed task
  // presented as approved.
  if (!teamCtx.lead || !teamCtx.runLeadReview) {
    throw nonRetryable(
      "action.team.task.review: task review is enabled but no lead/reviewer is wired for this run"
    )
  }
  const runLeadReview = teamCtx.runLeadReview
  const lead = teamCtx.lead

  const task = {
    id: taskId,
    title: params.title ?? taskId,
    description: params.description ?? "",
    ...(params.expectedOutput ? { expectedOutput: params.expectedOutput } : {}),
  }

  // The dispatch node's output carries both the deliverable and its author —
  // the author is what makes "send it back to whoever wrote it" possible.
  const upstream = ctx.upstream[params.dispatchNodeId] as
    | {
        text?: string
        teammateId?: string
        teammateName?: string
        access?: unknown
        taskKind?: unknown
      }
    | undefined
  if (!upstream || typeof upstream.text !== "string") {
    throw nonRetryable(
      `action.team.task.review: no output from dispatch node "${params.dispatchNodeId}"`
    )
  }
  // A revision is the same task: same access, same evidence gate. Without
  // these a read-only research task was revised with write access and then
  // refused for lacking a code diff. An output from before the dispatch node
  // recorded them falls back to the dispatch node's own defaults.
  const revisionAccess = upstream.access === "read" ? "read" : "write"
  const revisionTaskKind =
    upstream.taskKind === "ui" || upstream.taskKind === "general" ? upstream.taskKind : "code"

  let workerOutput = upstream.text
  let workerId = upstream.teammateId
  let workerName = upstream.teammateName
  // Schema-validated at the node boundary (`z.number().int().min(0)`), and
  // baked in by the synthesizer — no clamping needed here.
  const maxRevisions = params.maxRevisions ?? DEFAULT_TASK_REVIEW_MAX_REVISIONS
  let previousFeedback: string | undefined

  const fail = (reason: string): never => {
    teamCtx.storeWriter.setTaskStatus(taskId, "failed", undefined, reason)
    throw nonRetryable(`action.team.task.review: ${reason}`)
  }

  for (let revision = 0; revision <= maxRevisions; revision++) {
    const executionRoot = teamCtx.workspaceController?.getDispatchExecutionRoot(taskId)
    const evidence = await buildReviewEvidence({
      ...(executionRoot ? { workingDir: executionRoot } : {}),
      taskId,
    })
    const durableEvidence = await (
      await import("@/lib/db/agent-team-runtime")
    ).listAgentTeamEvidence(ctx.runId)
    const durableEvidenceIds = durableEvidence
      .filter((item) => item.taskId === taskId)
      .map((item) => item.id)

    // Registry reviews normally inspect the still-live detached environment;
    // a commit SHA remains optional until explicit branch promotion.
    const reviewedCommitSha = evidence.commitSha

    let verdict: { verdict: "approved" | "changes_requested"; feedback: string }
    try {
      verdict = await runLeadReview({
        team: teamCtx.team,
        lead,
        task: durableEvidenceIds.length > 0 ? { ...task, evidenceIds: durableEvidenceIds } : task,
        ...(workerName ? { workerName } : {}),
        workerOutput,
        evidence,
        revision,
        ...(previousFeedback ? { previousFeedback } : {}),
        signal: ctx.signal,
      })
    } catch (err) {
      // A reviewer/provider failure is not an approval.
      return fail(
        `the lead could not review this task (${err instanceof Error ? err.message : String(err)})`
      )
    }

    teamCtx.storeWriter.addMessage({
      teamId,
      senderId: lead.id,
      type: "direct",
      ...(workerId ? { recipientId: workerId } : {}),
      content: `[review] ${verdict.verdict === "approved" ? "Approved" : "Changes requested"}: ${verdict.feedback}`,
      taskId,
    })
    teamCtx.storeWriter.addEvent?.({
      type: verdict.verdict === "approved" ? "plan_approved" : "plan_rejected",
      teamId,
      teammateId: lead.id,
      taskId,
      data: { scope: "task-review", revision, feedback: verdict.feedback },
      timestamp: new Date(),
    })

    if (verdict.verdict === "approved") {
      // The human board gate composes with this one: an automated approval
      // hands the card to a human when they asked for the last word,
      // otherwise it completes it.
      const requireHumanReview =
        teamCtx.team?.config?.governancePolicy?.approval?.requireResultReview === true
      teamCtx.storeWriter.setTaskStatus(
        taskId,
        requireHumanReview ? "review" : "completed",
        workerOutput
      )
      return {
        output: {
          text: workerOutput,
          verdict: "approved",
          revisions: revision,
          reviewedCommitSha,
          ...(workerId ? { teammateId: workerId } : {}),
          ...(workerName ? { teammateName: workerName } : {}),
        },
      }
    }

    previousFeedback = verdict.feedback
    if (revision === maxRevisions) break

    if (!workerId) {
      return fail("the original worker is unknown, so the lead's changes cannot be applied")
    }
    try {
      const revised = await dispatchTeammate(teamCtx, {
        taskId,
        prompt: [
          `Your work on "${task.title}" was reviewed and needs changes.`,
          "",
          "Reviewer feedback:",
          verdict.feedback,
          "",
          "Revise your work in the same workspace and report what you changed.",
        ].join("\n"),
        signal: ctx.signal,
        validateOutput: true,
        recordToStore: true,
        // Same author, same worktree: a revision addresses feedback on a diff
        // this teammate wrote, so substituting anyone else is meaningless.
        requireTeammateId: workerId,
        workspaceKey: taskId,
        access: revisionAccess,
        taskKind: revisionTaskKind,
      })
      workerOutput = revised.text
      workerId = revised.teammateId
      workerName = revised.teammateName
    } catch (err) {
      if (err instanceof UnavailableRequiredTeammateError) {
        return fail(`the original worker is no longer available to revise this task`)
      }
      return fail(
        `the revision dispatch failed (${err instanceof Error ? err.message : String(err)})`
      )
    }
  }

  return fail(
    `the lead still requested changes after ${maxRevisions} revision(s): ${previousFeedback ?? "no feedback recorded"}`
  )
}

// ── action.team.reconcile ─────────────────────────────────────────────────
// Explicit promotion checkpoint for Registry-managed Agent Team environments.
export async function reconcileTeamRun(ctx: StepExecutionContext): Promise<StepExecutionResult> {
  const params = ctx.params as {
    mode?: "manual" | "merge-all" | "select" | "pipeline"
    selectStrategy?: "manual" | "first-success" | "judge"
    retain?: "all" | "keep-winner" | "prune-losers"
  }
  const { getTeamRunContext } = await import("@/lib/ai/agent/team/team-run-context")
  const teamCtx = getTeamRunContext(ctx.runId)
  if (!teamCtx) {
    throw nonRetryable(`action.team.reconcile: no TeamRunContext registered for runId=${ctx.runId}`)
  }
  if (!teamCtx.workspaceController) {
    return { output: { reconciled: false } }
  }
  const mode = params.mode ?? teamCtx.team.config.workspaceIsolation?.reconcile ?? "manual"
  if (mode === "merge-all") {
    throw nonRetryable(
      "action.team.reconcile: merge-all requires a host-side atomic Registry promotion transaction"
    )
  }
  const selectStrategy =
    params.selectStrategy ?? teamCtx.team.config.workspaceIsolation?.selectStrategy
  const result = await teamCtx.workspaceController.reconcile({
    mode,
    ...(selectStrategy ? { selectStrategy } : {}),
    ...(selectStrategy === "judge"
      ? {
          judge: async (candidates) => {
            const { executeAgent } = await import("@/lib/ai/agent/agent-executor")
            const prompt = candidates
              .map(
                (candidate) => `key=${candidate.key}\n${(candidate.output ?? "").slice(0, 2000)}`
              )
              .join("\n\n")
            const text = (await executeAgent(`Pick the best candidate key only.\n\n${prompt}`, {}))
              .text
            return candidates.find((candidate) => text?.includes(candidate.key))?.key ?? null
          },
        }
      : {}),
  })
  return { output: { reconciled: true, ...result } }
}

/** Every team node implementation, as installed into the workflow port. */
export const teamWorkflowNodes: TeamWorkflowNodes = {
  run: runTeamNode,
  dispatchTask: dispatchTeamTask,
  reviewTask: reviewTeamTask,
  reconcile: reconcileTeamRun,
  compose: runTeamCompose,
  status: runTeamStatus,
  delegate: runTeamDelegate,
  message: runTeamMessage,
}
