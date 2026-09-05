import type { WorkflowTriggeredFrom } from "@/types/workflow/visual"
import { registerNodeExecutor } from "../registry"
import { createCharacter, updateCharacter } from "@/lib/db/characters"
import { createTeam, updateTeam } from "@/lib/db/teams"
import { nonRetryable } from "../shared/executor-support"

// ── action.character.create ───────────────────────────────────────────────
registerNodeExecutor({
  kind: "action.character.create",
  typeVersion: 1,
  execute: async (ctx) => {
    const params = ctx.params as {
      name?: string
      systemPrompt?: string
      description?: string
      avatarColor?: string
      avatarEmoji?: string
      model?: string
    }
    if (!params.name?.trim()) {
      throw nonRetryable("action.character.create requires a non-empty 'name'")
    }
    if (!params.systemPrompt?.trim()) {
      throw nonRetryable("action.character.create requires a 'systemPrompt'")
    }
    const character = await createCharacter({
      name: params.name.trim(),
      systemPrompt: params.systemPrompt,
      description: params.description,
      avatarColor: params.avatarColor,
      avatarEmoji: params.avatarEmoji,
      model: params.model,
    })
    return {
      output: { characterId: character.id, name: character.name },
    }
  },
})

// ── action.character.update ───────────────────────────────────────────────
registerNodeExecutor({
  kind: "action.character.update",
  typeVersion: 1,
  execute: async (ctx) => {
    const params = ctx.params as {
      characterId?: string
      patch?: Record<string, unknown>
    }
    const id = params.characterId?.trim()
    if (!id) {
      throw nonRetryable("action.character.update requires 'characterId'")
    }
    if (!params.patch || typeof params.patch !== "object") {
      throw nonRetryable("action.character.update requires a non-empty 'patch' object")
    }
    // Strip immutable fields the UI shouldn't be able to override.
    const {
      id: _id,
      createdAt: _ca,
      isBuiltIn: _bi,
      ...safePatch
    } = params.patch as Record<string, unknown>
    void _id
    void _ca
    void _bi
    await updateCharacter(id, safePatch as Parameters<typeof updateCharacter>[1])
    return { output: { characterId: id, patched: Object.keys(safePatch) } }
  },
})

// ── action.team.create ────────────────────────────────────────────────────
registerNodeExecutor({
  kind: "action.team.create",
  typeVersion: 1,
  execute: async (ctx) => {
    const params = ctx.params as {
      name?: string
      members?: Array<{ characterId: string; role?: string }>
      orchestration?: "round_robin" | "supervisor" | "mention_round_robin"
      supervisorCharacterId?: string
      description?: string
    }
    if (!params.name?.trim()) {
      throw nonRetryable("action.team.create requires a non-empty 'name'")
    }
    if (!Array.isArray(params.members) || params.members.length === 0) {
      throw nonRetryable("action.team.create requires at least one member")
    }
    const team = await createTeam({
      name: params.name.trim(),
      description: params.description,
      members: params.members,
      orchestration: params.orchestration,
      supervisorCharacterId: params.supervisorCharacterId,
    })
    return { output: { teamId: team.id, name: team.name } }
  },
})

// ── action.team.update ────────────────────────────────────────────────────
registerNodeExecutor({
  kind: "action.team.update",
  typeVersion: 1,
  execute: async (ctx) => {
    const params = ctx.params as {
      teamId?: string
      patch?: Record<string, unknown>
    }
    const id = params.teamId?.trim()
    if (!id) {
      throw nonRetryable("action.team.update requires 'teamId'")
    }
    if (!params.patch || typeof params.patch !== "object") {
      throw nonRetryable("action.team.update requires a 'patch' object")
    }
    const {
      id: _id,
      createdAt: _ca,
      isBuiltIn: _bi,
      ...safePatch
    } = params.patch as Record<string, unknown>
    void _id
    void _ca
    void _bi
    await updateTeam(id, safePatch as Parameters<typeof updateTeam>[1])
    return { output: { teamId: id, patched: Object.keys(safePatch) } }
  },
})

// ── action.agent.turn ─────────────────────────────────────────────────────
// Full tool-enabled agent turn (sidecar on desktop, honest text-only
// degradation on web). Logic in ./actions/agent-turn for testability.
// Not retryable — an agent turn can have side effects (tool calls).
registerNodeExecutor({
  kind: "action.agent.turn",
  typeVersion: 1,
  retryable: false,
  execute: async (ctx) => (await import("../actions/agent-turn")).runAgentTurn(ctx),
})

// ── action.character.send ─────────────────────────────────────────────────
// Posts a message into a character's chat session. The session is created
// on first send if it doesn't exist. The chat UI (when open) picks up the
// new message and the AI responds normally; when the UI is closed, the
// message lands and AI response fires the next time the session is opened.
// For platform-bound (connector) sessions, prefer `action.connector.send`.
registerNodeExecutor({
  kind: "action.character.send",
  typeVersion: 1,
  execute: async (ctx) => {
    const params = ctx.params as {
      characterId?: string
      sessionId?: string
      content?: string
      role?: "user" | "assistant"
    }
    const characterId = params.characterId?.trim()
    const content = params.content ?? ""
    if (!characterId) throw nonRetryable("action.character.send requires 'characterId'")
    if (!content) throw nonRetryable("action.character.send requires non-empty 'content'")
    const role = params.role === "assistant" ? "assistant" : "user"

    const [{ getCharacter }, { listSessions, createSession }, { persistMessages, listMessages }] =
      await Promise.all([
        import("@/lib/db/characters"),
        import("@/lib/db/sessions"),
        import("@/lib/db/messages"),
      ])

    const character = await getCharacter(characterId)
    if (!character) throw nonRetryable(`character ${characterId} not found`)

    let sessionId = params.sessionId?.trim() || ""
    if (!sessionId) {
      // Re-use the most recent session for the character, or create a new one.
      const all = await listSessions()
      const matching = all.filter((s) => s.characterId === characterId)
      sessionId = matching[0]?.id ?? ""
      if (!sessionId) {
        const created = await createSession({
          title: `${character.name} (workflow)`,
          characterId,
        })
        sessionId = created.id
      }
    }

    type UIMessageLike = Parameters<typeof persistMessages>[1][number]
    const existing = await listMessages(sessionId)
    const id = `msg_wf_${ctx.runId}_${ctx.stepId}`
    const message = {
      id,
      role,
      parts: [{ type: "text" as const, text: content }],
    } as unknown as UIMessageLike
    const next: UIMessageLike[] = [...existing, message]
    await persistMessages(sessionId, next)
    return {
      output: {
        characterId,
        sessionId,
        messageId: id,
        role,
        deliveryDeferred: role === "user", // AI auto-respond requires the chat UI to be open
      },
    }
  },
})

// ── action.team.run ───────────────────────────────────────────────────────
// Per ADR-0022 §5 PR 4. Kicks off a team lifecycle via the F-path synthesizer.
// Wires storeReader/storeWriter from the live Zustand store; the runtime
// itself synthesizes a child VisualWorkflow and runs it through workflow
// runtime. Returns the team-run id (the inner workflowRuns row) so the UI
// can navigate.
registerNodeExecutor({
  kind: "action.team.run",
  typeVersion: 1,
  execute: async (ctx) => {
    const params = ctx.params as { teamId?: string; goal?: string }
    const teamId = params.teamId?.trim()
    if (!teamId) throw nonRetryable("action.team.run requires 'teamId'")

    const [{ useAgentTeamStore }, { runTeamLifecycle }, { buildAgentTeamRuntimeDeps }] =
      await Promise.all([
        import("@/stores/agent/agent-team-store"),
        import("@/lib/ai/agent/agent-team-runtime"),
        import("@/lib/ai/agent/agent-team-runtime-deps"),
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
        addEvent: (
          event: Parameters<ReturnType<typeof useAgentTeamStore.getState>["addEvent"]>[0]
        ) => useAgentTeamStore.getState().addEvent(event),
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
  },
})

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
registerNodeExecutor({
  kind: "action.team.task.dispatch",
  typeVersion: 1,
  retryable: true,
  execute: async (ctx) => {
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
      import("@/lib/ai/agent/agent-team-runtime-deps"),
      import("@/lib/ai/agent/team/dispatch-teammate"),
      import("@/lib/ai/agent/team/shared-memory-orchestrator"),
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
      access: params.access === "read" ? "read" : "write",
      taskKind:
        params.taskKind === "ui" || params.taskKind === "general" ? params.taskKind : "code",
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
        tokenUsage: result.usage,
        attempt: 1,
        // ADR-0090 Phase 6: surface a degraded dispatch (lesser rail than the
        // teammate's configuration asked for) on the workflow event stream.
        ...(result.degradedReason ? { degradedReason: result.degradedReason } : {}),
      },
    }
  },
})

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
registerNodeExecutor({
  kind: "action.team.task.review",
  typeVersion: 1,
  retryable: false,
  execute: async (ctx) => {
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
      import("@/lib/ai/agent/team/dispatch-teammate"),
      import("@/lib/ai/agent/team/review-evidence"),
      import("@/lib/ai/agent/team/task-review-policy"),
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
      { text?: string; teammateId?: string; teammateName?: string } | undefined
    if (!upstream || typeof upstream.text !== "string") {
      throw nonRetryable(
        `action.team.task.review: no output from dispatch node "${params.dispatchNodeId}"`
      )
    }

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
  },
})

// ── action.team.reconcile ─────────────────────────────────────────────────
// Explicit promotion checkpoint for Registry-managed Agent Team environments.
registerNodeExecutor({
  kind: "action.team.reconcile",
  typeVersion: 1,
  execute: async (ctx) => {
    const params = ctx.params as {
      mode?: "manual" | "merge-all" | "select" | "pipeline"
      selectStrategy?: "manual" | "first-success" | "judge"
      retain?: "all" | "keep-winner" | "prune-losers"
    }
    const { getTeamRunContext } = await import("@/lib/ai/agent/team/team-run-context")
    const teamCtx = getTeamRunContext(ctx.runId)
    if (!teamCtx) {
      throw nonRetryable(
        `action.team.reconcile: no TeamRunContext registered for runId=${ctx.runId}`
      )
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
              const text = (
                await executeAgent(`Pick the best candidate key only.\n\n${prompt}`, {})
              ).text
              return candidates.find((candidate) => text?.includes(candidate.key))?.key ?? null
            },
          }
        : {}),
    })
    return { output: { reconciled: true, ...result } }
  },
})

// ── action.team.compose / status / delegate / message ────────────────────
// Agent-team surface exposure (multi-bot orchestration) — logic in
// ./actions/team-ops so this registry stays thin. Compose can run a whole
// team lifecycle (autoStart) and delegate can await a full background /
// external / team run — both are single-shot side effects, so no retry.
registerNodeExecutor({
  kind: "action.team.compose",
  typeVersion: 1,
  retryable: false,
  execute: async (ctx) => (await import("../actions/team-ops")).runTeamCompose(ctx),
})

registerNodeExecutor({
  kind: "action.team.status",
  typeVersion: 1,
  execute: async (ctx) => (await import("../actions/team-ops")).runTeamStatus(ctx),
})

registerNodeExecutor({
  kind: "action.team.delegate",
  typeVersion: 1,
  retryable: false,
  execute: async (ctx) => (await import("../actions/team-ops")).runTeamDelegate(ctx),
})

registerNodeExecutor({
  kind: "action.team.message",
  typeVersion: 1,
  execute: async (ctx) => (await import("../actions/team-ops")).runTeamMessage(ctx),
})
