/**
 * Isolated text evaluation host for the existing Squad admission, durable
 * coordinator and wave/DAG scheduler. Nothing is installed in the live Squad
 * store: its records, blackboard, journal and traces belong to this invocation.
 * Native tools, remote runtimes and interactive gates need an isolated host
 * with those capabilities and are refused here before model spend.
 */
import { createDurableTeamCoordinator } from "@cognia/agent-orchestration/coordinator"
import { createMemoryTeamRunStore } from "@cognia/agent-orchestration/memory-store"
import { hasNoLeakingPiiDeep } from "@cognia/redact"
import type { AppSettings } from "@cognia/agent-config-types"
import type { AgentTeam, AgentTeammate, AgentTeamTask } from "@/types/agent/agent-team"
import type { AgentTraceSpan } from "@/types/agent-trace/span"
import type { EvalSample } from "@/types/eval/eval"
import type { EvalPersistenceScope } from "@/lib/db/eval-lab"
import { startSquadRun } from "@/lib/ai/agent/team/squad/start-squad-run"
import { runTeamWaves } from "@/lib/ai/agent/team/team-wave-runner"
import type { TeamRunContext } from "@/lib/ai/agent/team/team-run-context"
import { buildLeadExecutionConfig } from "@/lib/ai/agent/team/squad/lead-execution"
import { createPureModelEvalTarget } from "./targets/model"
import { applyPiiGate } from "@/lib/workflow/nodes/ai/pii-gate"

export interface TeamEvalDefinition {
  team: AgentTeam
  members: AgentTeammate[]
  tasks: AgentTeamTask[]
  settings: AppSettings | null
}
export interface IsolatedTeamEvalInput {
  teamId: string
  prompt: string
  traceId: string
  signal?: AbortSignal
  timeoutMs?: number
  maxOutputTokens?: number
  reasoningEffort?: "low" | "medium" | "high"
  scope?: EvalPersistenceScope
  maxCostUsd?: number
  price?: { inputPerMillion: number; outputPerMillion: number; currency: string }
  /** Incremental capture survives cancellation of a later member call. */
  onSpan?(span: AgentTraceSpan): void
  /** Invocation-owned transcript capture; never writes to the live message store. */
  onMemberResult?(entry: { agentId: string; taskId: string; output: string }): void
  /** Awaited evidence barrier before each provider dispatch, including synthesis. */
  onCall?(event: TeamEvalCallEvent, signal?: AbortSignal): Promise<void>
}
export interface TeamEvalCallEvent {
  state: "admitted" | "settled"
  callId: string
  agentId: string
  taskId: string
  dependencies?: Array<{ agentId: string; taskId: string; output: string }>
  sample?: EvalSample
  error?: string
}
export interface TeamEvalMemberInput {
  team: AgentTeam
  member: AgentTeammate
  prompt: string
  settings: AppSettings | null
  signal: AbortSignal
  maxOutputTokens: number
  reasoningEffort?: "low" | "medium" | "high"
  price?: IsolatedTeamEvalInput["price"]
}
export interface TeamEvalExecutionDeps {
  loadDefinition(teamId: string, scope?: EvalPersistenceScope): Promise<TeamEvalDefinition>
  runMember(input: TeamEvalMemberInput): Promise<EvalSample>
}
export interface IsolatedTeamEvalResult {
  runId: string
  status: "completed" | "failed" | "cancelled" | "timed_out" | "blocked"
  output?: string
  reason?: string
  traceId: string
  spans: AgentTraceSpan[]
  wallTimeMs: number
  costKnown: boolean
  executionProfile: "isolated-text"
}

const MAX_TASKS = 32
const MAX_OUTPUT_TOKENS = 2048
const MAX_RUN_TOKENS = 131_072

const defaults: TeamEvalExecutionDeps = {
  async loadDefinition(teamId, scope) {
    scope?.assertActive()
    const [{ useAgentTeamStore }, { getSettings }] = await Promise.all([
      import("@/stores/agent/agent-team-store"),
      import("@/lib/db/settings"),
    ])
    scope?.assertActive()
    const store = useAgentTeamStore.getState()
    const team = store.getTeam(teamId)
    if (!team) throw new Error(`Evaluation Squad ${teamId} not found`)
    // Clone before the first async settings read, so roster/task edits cannot
    // produce a mixed definition while the account read is in flight.
    const definition = structuredClone({
      team,
      members: store.getTeammates(teamId),
      tasks: store.getTeamTasks(teamId),
    })
    const settings = structuredClone(await getSettings(scope))
    scope?.assertActive()
    return { ...definition, settings }
  },
  async runMember(input) {
    const selection = buildLeadExecutionConfig({
      lead: {
        ...input.member,
        config: {
          ...input.member.config,
          provider: input.member.config.provider ?? input.team.config.defaultProvider,
          model: input.member.config.model ?? input.team.config.defaultModel,
        },
      },
      settings: input.settings,
    })
    const providerId =
      selection.provider ?? input.team.config.defaultProvider ?? selection.defaultProvider
    const modelId = selection.model ?? input.team.config.defaultModel
    if (!providerId || !modelId)
      throw new Error("Evaluation member requires an explicit provider and model")
    const gated = applyPiiGate("redact", {
      user: input.prompt,
      system: input.member.config.systemPrompt ?? input.team.config.defaultSystemPrompt,
    })
    if (!hasNoLeakingPiiDeep({ system: gated.system, user: gated.user }))
      throw new Error("Evaluation prompt failed the PII gate")
    const target = createPureModelEvalTarget({
      label: input.member.name,
      providerId,
      modelId,
      isLocal: false,
      settings: {
        defaultProvider: selection.defaultProvider,
        providerSettings: selection.providerSettings,
        customProviders: selection.customProviders,
      },
      systemPrompt: gated.system,
      reasoningEffort: input.reasoningEffort,
      parameters: {
        maxOutputTokens: input.maxOutputTokens,
        temperature: input.team.config.defaultTemperature,
      },
      ...(input.price ? { price: input.price } : {}),
    })
    return target.run(
      {
        id: "member-call",
        datasetId: "isolated-team",
        input: gated.user,
        capability: "text",
        source: "handwritten",
        createdAt: 0,
        updatedAt: 0,
      },
      input.signal
    )
  },
}

function unsupported(definition: TeamEvalDefinition): string | undefined {
  const { team, members, tasks } = definition
  if (
    team.config.workingDir ||
    team.config.repositories?.length ||
    team.config.environmentRef ||
    team.config.workspaceIsolation?.enabled ||
    team.config.ultracode?.enabled
  )
    return "unsupported_evaluation_native_or_pattern_profile"
  if (!tasks.length || tasks.length > MAX_TASKS) return "unsupported_evaluation_task_count"
  if (!members.some((member) => member.role === "teammate"))
    return "unsupported_evaluation_empty_roster"
  if (
    tasks.some(
      (task) =>
        task.assignedTo &&
        !members.some((member) => member.id === task.assignedTo && member.role === "teammate")
    )
  )
    return "unsupported_evaluation_assignment"
  const approval = team.config.governancePolicy?.approval
  if (
    team.config.requirePlanApproval ||
    approval?.requirePlanApproval ||
    approval?.requireResultReview ||
    approval?.requireDelegationApproval ||
    team.config.taskReview?.enabled ||
    team.config.adaptiveReplan?.enabled ||
    team.config.progressLedger?.enabled
  )
    return "unsupported_evaluation_interactive_or_adaptive_profile"
  const capabilities = team.config.capabilities
  if (
    capabilities &&
    Object.values(capabilities).some((value) => Array.isArray(value) && value.length)
  )
    return "unsupported_evaluation_plugin_capabilities"
  if (
    members.some(
      (member) =>
        (member.config.runtime && member.config.runtime !== "claude") ||
        member.config.twinId ||
        member.config.externalAgentConfigId ||
        member.config.capabilities ||
        member.config.tools?.length ||
        member.config.execution ||
        member.config.requirePlanApproval
    )
  )
    return "unsupported_evaluation_member_capabilities"
  if (team.config.defaultExecution) return "unsupported_evaluation_execution_policy"
  if (
    team.config.allowedTools?.length ||
    team.config.knowledgeTwinIds?.length ||
    team.config.sharedMemoryAdapterId
  )
    return "unsupported_evaluation_external_side_effects"
  return undefined
}

/** No credential-bearing settings or prompts are returned in the run journal. */
export async function runIsolatedTeamEval(
  input: IsolatedTeamEvalInput,
  overrides: Partial<TeamEvalExecutionDeps> = {}
): Promise<IsolatedTeamEvalResult> {
  const deps = { ...defaults, ...overrides }
  const began = performance.now()
  const runId = `eval-team-${crypto.randomUUID()}`
  const spans: AgentTraceSpan[] = []
  let costKnown = true
  const answer = (
    status: IsolatedTeamEvalResult["status"],
    reason?: string,
    output?: string
  ): IsolatedTeamEvalResult => ({
    runId,
    status,
    ...(reason ? { reason } : {}),
    ...(output !== undefined ? { output } : {}),
    traceId: input.traceId,
    spans,
    wallTimeMs: Math.max(0, performance.now() - began),
    costKnown,
    executionProfile: "isolated-text",
  })
  input.scope?.assertActive()
  input.signal?.throwIfAborted()
  const frozen = structuredClone(await deps.loadDefinition(input.teamId, input.scope))
  const refusal = unsupported(frozen)
  if (refusal) return answer("blocked", refusal)
  const maxOutputTokens = input.maxOutputTokens ?? MAX_OUTPUT_TOKENS
  if (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > 32768)
    return answer("blocked", "invalid_evaluation_output_budget")
  if (
    input.maxCostUsd !== undefined &&
    (!input.price || input.maxCostUsd <= 0 || !Number.isFinite(input.maxCostUsd))
  )
    return answer("blocked", "evaluation_cost_cap_requires_valid_rates")
  if (
    input.price &&
    (![input.price.inputPerMillion, input.price.outputPerMillion].every(
      (value) => Number.isFinite(value) && value >= 0
    ) ||
      input.price.currency !== "USD")
  )
    return answer("blocked", "unsupported_evaluation_price")
  if (input.price) {
    const selections = new Set(
      frozen.members
        .filter((member) => member.role === "teammate")
        .map((member) =>
          JSON.stringify([
            member.config.provider ??
              frozen.team.config.defaultProvider ??
              frozen.settings?.defaultProvider,
            member.config.model ?? frozen.team.config.defaultModel ?? frozen.settings?.defaultModel,
          ])
        )
    )
    if (selections.size > 1) return answer("blocked", "heterogeneous_evaluation_rates_required")
  }
  const controller = new AbortController()
  const timeoutMs = Math.min(
    input.timeoutMs ?? 600_000,
    frozen.team.config.defaultTimeout ?? 600_000
  )
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
    return answer("blocked", "invalid_evaluation_timeout")
  const timer = setTimeout(
    () => controller.abort(new DOMException("Evaluation deadline exceeded", "TimeoutError")),
    timeoutMs
  )
  const signal = input.signal
    ? AbortSignal.any([input.signal, controller.signal])
    : controller.signal
  const teamId = `${runId}:team`
  const team: AgentTeam = { ...frozen.team, id: teamId, task: input.prompt }
  const tasks = frozen.tasks.map((task) => ({ ...task, teamId, status: "pending" as const }))
  const members = frozen.members
    .filter((member) => member.role === "teammate")
    .map((member) => ({ ...member, teamId }))
  const maxConcurrency = Math.max(
    1,
    Math.min(team.config.maxConcurrentTeammates ?? 1, members.length)
  )
  const store = createMemoryTeamRunStore()
  const journal: Array<{ runId: string; at: number }> = []
  const coordinator = createDurableTeamCoordinator({
    store,
    journal: {
      runPrepared: async (entry) => {
        journal.push({ runId: entry.runId, at: entry.at })
      },
    },
    redactForPersistence: (text) => (hasNoLeakingPiiDeep(text) ? text : undefined),
    paths: {
      normalize: (path) => path,
      isWithinRoot: (path, root) => path === root || path.startsWith(root + "/"),
    },
    remoteSessions: {
      release: async () => {
        throw new Error("Remote sessions are unsupported in isolated text evaluation")
      },
    },
    globalConcurrency: maxConcurrency,
  })
  const outputs = new Map<string, string>()
  const free = new Set(members.map((member) => member.id))
  let capturedCost = 0
  let reservedCost = 0
  let reservedTokens = 0
  let capturedTokens = 0
  let unresolvedCost = 0
  let unresolvedTokens = 0
  let lifecycle: Promise<void> | undefined
  let failure: Error | undefined
  try {
    const launch = await startSquadRun(
      {
        squadId: teamId,
        goal: input.prompt,
        origin: "evaluation",
        triggeredFrom: { source: "api" },
        runId,
      },
      {
        awaitRuntimeReady: async () => true,
        loadStore: async () => ({
          getTeam: (id) => (id === teamId ? team : undefined),
          getTeammates: () => members,
          getTeamTasks: () => tasks,
          updateTeam: (_id, patch) => {
            Object.assign(team, patch)
          },
        }),
        evaluateReadiness: async () => ({ ready: true, blockers: [], evaluatedAt: Date.now() }),
        findLiveRun: async () => undefined,
        createRunRecords: async (seed) => {
          await coordinator.prepareRun(
            {
              id: teamId,
              leadId: team.leadId,
              objective: input.prompt,
              repositories: [
                { id: "text", role: "primary", path: "/isolated-evaluation", writable: false },
              ],
              resourcePolicy: { priority: 0, maxConcurrentChildren: maxConcurrency },
            },
            runId
          )
          await store.updateRun(runId, { executionConstraints: seed.executionConstraints })
          return { runId, executionRunId: `execution:team:${runId}`, created: true }
        },
        runLifecycle: async () => {
          lifecycle = (async () => {
            const result = await runTeamWaves({
              teamCtx: { runId, teamId, team } as TeamRunContext,
              tasks,
              initialConcurrency: maxConcurrency,
              wallClockTimeoutMs: timeoutMs,
              signal,
              checkpoint: async ({ remaining }) => ({
                remaining,
                finish: false,
                decision: {
                  action: "continue",
                  reasoning: "fixed evaluation graph",
                  newTasks: [],
                  cancelTaskIds: [],
                  reorderTaskIds: [],
                  newMembers: [],
                },
              }),
              runWave: async (workflow) => {
                const ordered = workflow.nodes.filter(
                  (node) => node.type === "action.team.task.dispatch"
                )
                const pending = [...ordered]
                const workers = Array.from(
                  { length: Math.min(maxConcurrency, pending.length) },
                  async () => {
                    while (pending.length) {
                      signal.throwIfAborted()
                      const next = pending.findIndex((node) => {
                        const task = tasks.find((item) => item.id === node.id)!
                        return task.assignedTo ? free.has(task.assignedTo) : free.size > 0
                      })
                      if (next < 0) return
                      const node = pending.splice(next, 1)[0]!
                      const task = tasks.find((item) => item.id === node.id)!
                      const member = task.assignedTo
                        ? members.find((item) => item.id === task.assignedTo)!
                        : members.find((item) => free.has(item.id))!
                      free.delete(member.id)
                      const childId = `${runId}:${task.id}`
                      await coordinator.registerChild({
                        runId,
                        childRunId: childId,
                        teammateId: member.id,
                        taskId: task.id,
                        repositoryId: "text",
                        access: "read",
                        runtime: "isolated-text",
                      })
                      await coordinator.withChildAdmission(
                        childId,
                        async (admittedSignal) => {
                          input.scope?.assertActive()
                          const upstream = task.dependencies
                            .map((id) => `Dependency ${id}:\n${outputs.get(id) ?? ""}`)
                            .join("\n\n")
                          const prompt = [
                            `Team objective:\n${input.prompt}`,
                            `Role: ${member.description}`,
                            `Task: ${task.title}\n${task.description}`,
                            task.expectedOutput ? `Expected output: ${task.expectedOutput}` : "",
                            upstream,
                          ]
                            .filter(Boolean)
                            .join("\n\n")
                          const tokenReservation =
                            new TextEncoder().encode(
                              prompt +
                                (member.config.systemPrompt ??
                                  team.config.defaultSystemPrompt ??
                                  "")
                            ).length +
                            maxOutputTokens +
                            1024
                          const costReservation = input.price
                            ? (tokenReservation * input.price.inputPerMillion +
                                maxOutputTokens * input.price.outputPerMillion) /
                              1_000_000
                            : 0
                          if (
                            capturedTokens + reservedTokens + unresolvedTokens + tokenReservation >
                            (team.config.tokenBudget || MAX_RUN_TOKENS)
                          )
                            throw new Error("evaluation_token_budget_exhausted")
                          if (
                            input.maxCostUsd !== undefined &&
                            capturedCost + reservedCost + unresolvedCost + costReservation >
                              input.maxCostUsd
                          )
                            throw new Error("evaluation_cost_budget_exhausted")
                          reservedTokens += tokenReservation
                          reservedCost += costReservation
                          const at = Date.now()
                          const spanId = `${childId}:call`
                          let sample: EvalSample | undefined
                          let callError: unknown
                          let admitted = false
                          try {
                            await input.onCall?.(
                              {
                                state: "admitted",
                                callId: spanId,
                                agentId: member.id,
                                taskId: task.id,
                                dependencies: task.dependencies.map((id) => ({
                                  agentId: tasks.find((row) => row.id === id)?.assignedTo ?? "",
                                  taskId: id,
                                  output: outputs.get(id) ?? "",
                                })),
                              },
                              admittedSignal
                            )
                            admitted = true
                            admittedSignal.throwIfAborted()
                            sample = await deps.runMember({
                              team,
                              member,
                              prompt,
                              settings: frozen.settings,
                              signal: admittedSignal,
                              maxOutputTokens,
                              reasoningEffort: input.reasoningEffort,
                              price: input.price,
                            })
                            outputs.set(task.id, sample.output)
                            if (!sample.output.trim())
                              throw new Error("evaluation_member_returned_empty_output")
                            input.onMemberResult?.({
                              agentId: member.id,
                              taskId: task.id,
                              output: sample.output,
                            })
                            if (
                              sample.error ||
                              (sample.executionStatus && sample.executionStatus !== "completed")
                            )
                              throw new Error(sample.error ?? sample.executionStatus)
                          } catch (error) {
                            callError = error
                            throw error
                          } finally {
                            reservedTokens -= tokenReservation
                            reservedCost -= costReservation
                            const usageKnown =
                              !!sample &&
                              sample.metricAvailability?.usage !== "unavailable" &&
                              sample.metricAvailability?.usage !== "partial"
                            const priced =
                              !!sample &&
                              (sample.metricAvailability?.cost === "known" ||
                                sample.metricAvailability?.cost === "estimated")
                            if (!priced) costKnown = false
                            if (!usageKnown) unresolvedTokens += tokenReservation
                            if (!priced) unresolvedCost += costReservation
                            if (input.maxCostUsd !== undefined && (!usageKnown || !priced)) {
                              controller.abort(new Error("evaluation_accounting_unavailable"))
                            }
                            if (sample) {
                              capturedCost += sample.costUsd
                              capturedTokens += sample.usage.inputTokens + sample.usage.outputTokens
                            } else costKnown = false
                            const endTime = Date.now()
                            const span = {
                              id: spanId,
                              spanId,
                              traceId: input.traceId,
                              sessionId: runId,
                              runId,
                              agentId: member.id,
                              agentName: member.name,
                              surface: "agent-team",
                              providerName: "cognia.team",
                              operationName: "chat",
                              startTime: at,
                              endTime,
                              durationMs: endTime - at,
                              ...(sample ? { usage: sample.usage } : {}),
                              ...(sample && priced ? { costUsdEstimate: sample.costUsd } : {}),
                              ...(callError
                                ? {
                                    errorType:
                                      callError instanceof Error ? callError.name : "Error",
                                  }
                                : {}),
                              metadata: {
                                accountingScope: "call",
                                attemptId: spanId,
                                usageKnown,
                                costKnown: priced,
                              },
                            } as AgentTraceSpan
                            if (admitted) spans.push(span)
                            try {
                              if (admitted)
                                await input.onCall?.({
                                  state: "settled",
                                  callId: spanId,
                                  agentId: member.id,
                                  taskId: task.id,
                                  ...(sample ? { sample } : {}),
                                  ...(callError
                                    ? {
                                        error:
                                          callError instanceof Error
                                            ? callError.message
                                            : String(callError),
                                      }
                                    : {}),
                                })
                              if (admitted) input.onSpan?.(span)
                            } finally {
                              free.add(member.id)
                            }
                            await store.updateChild(childId, {
                              status: callError ? "failed" : "completed",
                              completedAt: endTime,
                              updatedAt: endTime,
                              resourceUsage: {
                                promptTokens: sample?.usage.inputTokens ?? 0,
                                completionTokens: sample?.usage.outputTokens ?? 0,
                                totalTokens:
                                  (sample?.usage.inputTokens ?? 0) +
                                  (sample?.usage.outputTokens ?? 0),
                                wallTimeMs: endTime - at,
                                toolTimeMs: 0,
                                attempts: 1,
                                failures: callError ? 1 : 0,
                                ...(sample && priced ? { costUsd: sample.costUsd } : {}),
                              },
                            })
                          }
                        },
                        signal
                      )
                    }
                  }
                )
                const settled = await Promise.allSettled(workers)
                const rejected = settled.find((item) => item.status === "rejected")
                if (rejected?.status === "rejected") throw rejected.reason
                if (pending.length) throw new Error("evaluation_unresolved_assignment")
                return { runId, status: "succeeded", output: outputs.get(ordered.at(-1)!.id) }
              },
            })
            if (result.status !== "succeeded")
              throw new Error(result.error?.message ?? result.status)
            await store.updateRun(runId, {
              status: "completed",
              completedAt: Date.now(),
              updatedAt: Date.now(),
            })
          })()
          return lifecycle
        },
        parkFailedLaunch: async (_id, reason) => {
          await store.updateRun(runId, {
            status: "failed",
            recoveryReason: reason,
            completedAt: Date.now(),
            updatedAt: Date.now(),
          })
        },
      }
    )
    if (!launch.started) return answer("blocked", launch.reason)
    await lifecycle
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error))
  } finally {
    clearTimeout(timer)
  }
  const terminalTasks = tasks.filter(
    (task) => !tasks.some((other) => other.dependencies.includes(task.id))
  )
  const output =
    terminalTasks.length === 1
      ? (outputs.get(terminalTasks[0]!.id) ?? "")
      : JSON.stringify(Object.fromEntries(outputs))
  if (signal.aborted)
    return answer(
      signal.reason?.name === "TimeoutError"
        ? "timed_out"
        : controller.signal.reason?.message === "evaluation_accounting_unavailable"
          ? "failed"
          : "cancelled",
      String(signal.reason?.message ?? "cancelled"),
      output
    )
  if (failure) return answer("failed", failure.message, output)
  return answer("completed", undefined, output)
}
