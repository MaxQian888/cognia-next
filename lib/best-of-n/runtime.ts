import type { ChatSession } from "@cognia/agent-config-types"
import type { Project } from "@/types"
import { DEFAULT_TEAM_CONFIG, type AgentTeam } from "@/types/agent/agent-team"
import type { BestOfNGroup } from "@/types/best-of-n"
import { getDurableTeamCoordinator } from "@/lib/ai/agent/team/durable/durable-runtime"
import { beginDurableDispatch } from "@/lib/ai/agent/team/durable/durable-dispatch"
import { controlDurableRun } from "@/lib/ai/agent/team/durable/durable-control"
import {
  acquireWorkspaceBundle,
  getWorkspaceBundle,
  ensureWorkspacePortLease,
} from "@/lib/task-workspace/client"
import { openWorkspaceBundleTurnLease } from "@/lib/task-workspace/run-lease"
import { runWorkspaceUserAction } from "@/lib/task-workspace/user-action"
import { createScmHost, scmErrorCode } from "@/lib/scm/host"
import {
  externalAgentIdFromProviderId,
  isExternalAgentProviderId,
} from "@/lib/ai/agent/external/session/session-models"
import { describeBestOfNAgent } from "./agents"
import { runExternalCandidate } from "./external"
import { BestOfNAttemptError, type BestOfNExecution, type BestOfNInput } from "./core"

export function bestOfNTeam(group: BestOfNGroup, request: BestOfNInput): AgentTeam {
  return {
    id: group.groupId,
    name: "Best-of-N",
    description: "Independent attempts",
    task: request.prompt,
    ...(request.projectId ? { projectId: request.projectId } : {}),
    status: "executing",
    leadId: group.groupId,
    teammateIds: group.candidates.map((candidate) => candidate.candidateId),
    taskIds: group.candidates.map((candidate) => candidate.candidateId),
    messageIds: [],
    progress: 0,
    totalTokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    createdAt: new Date(group.createdAt),
    config: {
      ...DEFAULT_TEAM_CONFIG,
      writeMode: "single-writer",
      maxTeammates: group.n,
      maxConcurrentTeammates: group.n,
      enableMessaging: false,
      enableSharedTaskList: false,
      enableTaskRetry: false,
      enableDeadlockRecovery: false,
      maxRetries: 0,
      repositories: [
        { id: group.repositoryId, path: group.sourceRoot, role: "primary", writable: true },
      ],
      evidencePolicy: {
        requireActivity: true,
        requireOutcome: true,
        requireCodeDiff: false,
        requireVerification: false,
        requireVisualForUi: false,
      },
      resourcePolicy: {
        priority: 0,
        maxConcurrentChildren: group.n,
        maxWallTimeMs: group.budgetPolicy.maxDurationMs ?? 600_000,
        ...(group.budgetPolicy.maxCostUsd == null
          ? {}
          : { maxCostUsd: group.budgetPolicy.maxCostUsd }),
      },
    },
  }
}

/** Production ports use the ordinary confined turn, PII gate, and capture pipeline. */
export function createBestOfNExecution(): BestOfNExecution {
  const coordinator = getDurableTeamCoordinator()
  const scm = createScmHost()
  return {
    async prepare(group, request) {
      await coordinator.prepareRun(bestOfNTeam(group, request), group.teamRunId)
    },
    async acquire(group, candidate, request) {
      const bundle = await runWorkspaceUserAction("task_workspace_bundle_acquire", () =>
        acquireWorkspaceBundle({
          ownerType: "session",
          ownerRef: candidate.childSessionId,
          ...(request.projectId ? { projectId: request.projectId } : {}),
          environmentKind: "managed",
          base: { kind: "gitRef", gitRef: group.baseSha },
          roots: [
            { logicalRootId: group.repositoryId, role: "primary", sourceRoot: group.sourceRoot },
          ],
        })
      )
      const root = bundle.leases.find((lease) => lease.role === "primary")
      if (
        !root ||
        bundle.leases.length !== 1 ||
        bundle.ownerRef !== candidate.childSessionId ||
        bundle.state !== "active"
      ) {
        throw new Error("Best-of-N received an invalid candidate workspace bundle")
      }
      const ports = await runWorkspaceUserAction("task_workspace_port_lease_ensure", () =>
        ensureWorkspacePortLease(root.workspaceId)
      )
      return {
        bundleId: bundle.bundleId,
        workspaceId: root.workspaceId,
        physicalRoot: ports.canonicalRoot,
      }
    },
    async execute({ group, candidate, workspace, request, grant, signal }) {
      const [{ getDb }, { getCharacter }, { getSettings }, { resolveSendOptions }, runner, ipc] =
        await Promise.all([
          import("@/lib/db/schema"),
          import("@/lib/db/characters"),
          import("@/lib/db/settings"),
          import("@/lib/claude/build-options"),
          import("@/lib/claude/run-and-capture"),
          import("@/lib/claude/ipc"),
        ])
      const character = await getCharacter(candidate.agent.agentId)
      if (!character) throw new Error(`Unknown best-of-N agent: ${candidate.agent.agentId}`)
      const bundle = await getWorkspaceBundle(workspace.bundleId)
      if (!bundle || bundle.state !== "active") throw new Error("Candidate workspace disappeared")
      const session: ChatSession = {
        id: candidate.childSessionId,
        title: `Best-of-N ${candidate.index + 1}`,
        kind: "direct",
        characterId: character.id,
        // An external candidate's runtime is part of its identity, so the
        // child conversation shows what actually ran.
        ...(describeBestOfNAgent(candidate.agent).kind === "external"
          ? {
              providerOverride: candidate.agent.provider!,
              ...(candidate.agent.model ? { model: candidate.agent.model } : {}),
            }
          : {}),
        workingDir: workspace.physicalRoot,
        workspaceConfinementEnabled: true,
        ...(request.projectId ? { projectId: request.projectId } : {}),
        createdAt: group.createdAt,
        updatedAt: Date.now(),
      }
      // Host allocated this identity. It has no parent transcript or sibling context.
      const db = getDb()
      await db.transaction("rw", db.sessions, async () => {
        const existing = await db.sessions.get(session.id)
        if (
          existing &&
          (existing.characterId !== character.id || existing.workingDir !== workspace.physicalRoot)
        )
          throw new Error("Candidate session binding changed")
        if (!existing) await db.sessions.add(session)
      })
      const dispatch = await beginDurableDispatch({
        coordinator,
        team: bestOfNTeam(group, request),
        runId: group.teamRunId,
        teammateId: candidate.candidateId,
        taskId: candidate.candidateId,
        access: "write",
        taskKind: "code",
        repositoryId: group.repositoryId,
        isolateFailure: true,
      })
      const turn: { lease: Awaited<ReturnType<typeof openWorkspaceBundleTurnLease>> } = {
        lease: null,
      }
      let costUsd: number | null = null
      try {
        await dispatch.setWorkspace({ workspacePath: workspace.physicalRoot })
        await dispatch.attachControl(
          {
            steer: async () => {
              throw new Error("Independent attempts cannot receive steering")
            },
            terminate: async () => {
              await ipc.interruptSession(session.id)
            },
          },
          session.id
        )
        return await dispatch.run(async () => {
          signal.throwIfAborted()
          turn.lease = await openWorkspaceBundleTurnLease(bundle, group.repositoryId, {
            taskId: candidate.candidateId,
            sessionId: session.id,
            runId: candidate.candidateId,
            parentRunId: group.teamRunId,
            agentId: character.id,
            agentKind: "teammate",
            workspaceRoot: workspace.physicalRoot,
            base: { kind: "gitRef", gitRef: group.baseSha },
          })
          if (!turn.lease) throw new Error("Candidate workspace turn could not be leased")
          // Resolve against the candidate root, never the parent project's mounts.
          // This supplies the normal workspace-confinement path even for a
          // repository that has no saved Project row.
          const candidateProject: Project = {
            id: candidate.candidateId,
            name: session.title,
            roots: [{ id: group.repositoryId, path: workspace.physicalRoot, isPrimary: true }],
            knowledgeBase: [],
            sessionIds: [session.id],
            sessionCount: 1,
            messageCount: 0,
            createdAt: new Date(group.createdAt),
            updatedAt: new Date(group.createdAt),
            lastAccessedAt: new Date(group.createdAt),
          }
          const remainingMs = Math.max(
            1,
            (group.budgetPolicy.maxDurationMs ?? 600_000) - (Date.now() - group.createdAt)
          )
          const declared = describeBestOfNAgent(candidate.agent)
          const options =
            declared.kind === "external"
              ? null
              : await resolveSendOptions({
                  session,
                  character,
                  appSettings: await getSettings(),
                  activeProject: candidateProject,
                  agentKind: "teammate",
                  capabilityGrants: [grant],
                  routingSurface: "agent",
                  routingContextHint: { promptText: request.prompt, category: "coding" },
                })
          // A Cognia agent whose own default runtime is external takes the same lane.
          const externalConfigId =
            declared.kind === "external"
              ? declared.configId
              : isExternalAgentProviderId(options?.provider)
                ? externalAgentIdFromProviderId(options?.provider)
                : undefined
          let text: string
          if (externalConfigId !== undefined) {
            if (!externalConfigId)
              throw new Error("Best-of-N candidate names an unscoped external agent")
            // The external execute contract has no dollar cap and reports no cost.
            if (group.budgetPolicy.maxCostUsd != null)
              throw new Error("The selected runtime cannot enforce the best-of-N cost budget")
            ;({ text } = await runExternalCandidate({
              configId: externalConfigId,
              prompt: request.prompt,
              model: declared.kind === "external" ? candidate.agent.model : options?.model,
              workingDirectory: workspace.physicalRoot,
              signal: AbortSignal.any([signal, AbortSignal.timeout(remainingMs)]),
              onCapture: dispatch.capture,
            }))
          } else {
            const sendOptions = options!
            // The frozen execution spec is the sidecar's runtime authority. The
            // AI-SDK lane does not enforce SendOptions.maxBudgetUsd, so a dollar
            // cap must fail closed there instead of silently becoming advisory.
            const runtimeAdapter = sendOptions.execution?.runtimeAdapter
            const costCap = group.budgetPolicy.maxCostUsd
            if (
              costCap != null &&
              (runtimeAdapter !== "claude-agent-sdk" ||
                sendOptions.maxBudgetUsd == null ||
                !Number.isFinite(sendOptions.maxBudgetUsd) ||
                sendOptions.maxBudgetUsd <= 0 ||
                sendOptions.maxBudgetUsd > costCap / group.n)
            ) {
              throw new Error("The selected runtime cannot enforce the best-of-N cost budget")
            }
            const result = await runner.runAndCaptureAssistantReply(
              session.id,
              request.prompt,
              sendOptions,
              {
                signal,
                timeoutMs: remainingMs,
                onEvent: dispatch.capture,
                execution: { kind: "team", runId: group.teamRunId, taskId: candidate.candidateId },
              }
            )
            const reportedCost = result.usage?.totalCostUsd
            // AI-SDK's result adapter emits zero when the provider supplies no
            // cost. Preserve unknown instead of turning that wire default into
            // a claim that the attempt was free.
            costUsd =
              reportedCost == null || (reportedCost === 0 && runtimeAdapter !== "claude-agent-sdk")
                ? null
                : reportedCost
            if (result.resultSubtype?.startsWith("error"))
              throw new BestOfNAttemptError(
                `Candidate execution ended: ${result.resultSubtype}`,
                costUsd
              )
            text = result.text
          }
          await turn.lease.settle("ready")
          let changeset
          try {
            changeset = await scm.captureChangeset({
              workspaceId: workspace.workspaceId,
              targetRef: group.targetRef,
              title: `Best-of-N ${candidate.index + 1}`,
              requiredChecks: request.requiredChecks ?? [],
            })
          } catch (error) {
            if (scmErrorCode(error) !== "nothing_to_capture") throw error
          }
          await dispatch.complete({
            text,
            ...(costUsd === null ? {} : { costUsd }),
            ...(changeset
              ? {
                  commitSha: changeset.headSha,
                  workspaceRevision: changeset.headSha,
                  diffContent: JSON.stringify(changeset.files),
                }
              : {}),
          })
          return {
            hasChanges: changeset?.files.some((file) => !file.excluded) ?? false,
            costUsd,
            ...(changeset
              ? { changesetId: changeset.changesetId, headSha: changeset.headSha }
              : {}),
          }
        }, signal)
      } catch (error) {
        const cleanup = await Promise.allSettled([
          dispatch.fail(error),
          turn.lease?.settle(signal.aborted ? "cancelled" : "failed"),
        ])
        const failed = cleanup.filter(
          (item): item is PromiseRejectedResult => item.status === "rejected"
        )
        if (failed.length)
          throw new BestOfNAttemptError("Candidate execution and cleanup failed", costUsd, {
            cause: new AggregateError([error, ...failed.map((item) => item.reason)]),
          })
        throw new BestOfNAttemptError(
          error instanceof Error ? error.message : String(error),
          costUsd,
          { cause: error }
        )
      } finally {
        dispatch.dispose()
      }
    },
    async stop(group) {
      const { interruptSession } = await import("@/lib/claude/ipc")
      await Promise.all(
        group.candidates
          .filter((candidate) =>
            ["running", "cancelRequested", "recoveryRequired"].includes(candidate.status)
          )
          .map((candidate) => interruptSession(candidate.childSessionId))
      )
      if (await coordinator.store.getRun(group.teamRunId))
        await controlDurableRun(group.teamRunId, "stop", { coordinator })
    },
    async finish(group) {
      const run = await coordinator.store.getRun(group.teamRunId)
      if (!run) return
      await coordinator.store.updateRunIfCurrent(run.id, run, {
        status:
          group.phase === "cancelled"
            ? "cancelled"
            : group.phase === "recoveryRequired"
              ? "needs_input"
              : "completed",
        updatedAt: Date.now(),
        completedAt: Date.now(),
      })
    },
  }
}
