/**
 * Runs the live smoke's cases through the real engine (ADR-0188 D20, B5 WP-E3).
 *
 * Nothing here re-implements the engine. Each case is:
 *
 *  1. routed by `routeRunRequest` — the Run API's own ActionRouter entry, over
 *     the route host the caller built (the user's providers through the app's
 *     routing engine, or the simulated tiers);
 *  2. created by the ledger (`FusionLedgerStore.createRun`) in a DEDICATED
 *     fusion database that belongs to this smoke alone, against a tenant limit
 *     of "the total cap minus what this database has booked" — so the $5 total
 *     is enforced by `planRunCreation`, not by the harness;
 *  3. executed by `executeFusionRun`, the orchestrator every Run API run uses,
 *     with the executor the caller chose, observed on the way;
 *  4. read back from the ledger: the run's budget, its attempt rows, its sealed
 *     result and its journal.
 *
 * Before the first run is created the harness asks the ledger to create one
 * that is a microusd over what the total still allows; unless the ledger
 * refuses it for the tenant budget, the cap is not in place and nothing runs.
 *
 * The runs' cross-database effects (the cockpit row, the usage rows) are
 * recorded and counted, never applied: a smoke writes no account database.
 * Any unexpected error stops the smoke; the cases after it are reported as
 * not run, because a paid run does not carry on past something it does not
 * understand.
 */

import type { AppSettings } from "@cognia/agent-config-types"
import type { RoleCallExecutor, RouteDecision } from "@cognia/router-fusion"
import {
  LIVE_SMOKE_BUDGET_MODE,
  ledgerRefusedOverCap,
  LiveCapError,
  remainingTotalMicrousd,
  type LiveCapPlan,
  type PlannedCase,
} from "@cognia/router-fusion/live/cap"
import { caseRunRequest, classifyRouteRefusal } from "@cognia/router-fusion/live/cases"
import { observeExecutor, type ObservedCall } from "@cognia/router-fusion/live/observed-executor"
import {
  unconfirmedDeployments,
  type LiveProviderListing,
} from "@cognia/router-fusion/live/providers"
import {
  addUsage,
  answerPreview,
  CAP_ENFORCEMENT_RULE,
  callRecordsOf,
  capabilityMatrix,
  disclaimerFor,
  emptyUsage,
  LIVE_SMOKE_REPORT_SCHEMA,
  LIVE_SMOKE_REPORT_VERSION,
  summarizeRetries,
  type LiveCaseOutcome,
  type LiveCaseReport,
  type LiveSmokeLabel,
  type LiveSmokeReport,
} from "@cognia/router-fusion/live/report"
import { resolveDeploymentLlmConfig } from "@/lib/ai/renderer-llm-client"

import { createRunApiRouteHost } from "../api/route-host"
import { EXECUTABLE_MODES, readRunResult } from "../api/run-api"
import { splitDeploymentId } from "../calls/role-call-executor"
import { liveRefusalFor, type ChatRouteHost } from "../chat/route-chat-turn"
import { fusionContentCodec } from "../db/content-codec"
import { FusionDB, fusionDatabaseName } from "../db/fusion-db"
import { FusionLedgerStore, type CreateRunInput } from "../db/ledger-store"
import type { OutboxAppliers } from "../db/outbox"
import { encodeRunInput } from "../db/run-input"
import type { FusionOutboxKind, FusionOutboxRow } from "../db/types"
import { routeRunRequest, type RunRoute } from "../routing/run-route"
import { executeFusionRun } from "../runtime/orchestrator-host"
import { webEvidenceAvailable } from "../tools/web-evidence"
import type { NetworkGuard } from "./network-guard"

/**
 * The route host a live smoke uses: the user's providers through the app's own
 * routing engine, and the snapshot in place of the settings store the smoke
 * never loads. It is the Run API's own host (`api/route-host.ts`), so a case
 * that routes here routes exactly as `POST /v1/runs` would — a second copy of
 * that construction would be a second set of capabilities to assess against.
 */
export function createLiveRouteHost(appSettings: AppSettings): ChatRouteHost {
  return createRunApiRouteHost(appSettings)
}

interface RoutedCase {
  runId: string
  request: ReturnType<typeof caseRunRequest>
  route: RunRoute
}

async function routeCase(
  host: ChatRouteHost,
  planned: PlannedCase,
  input: { workspaceId: string; newId: () => string }
): Promise<RoutedCase> {
  const { definition } = planned
  const runId = input.newId()
  const request = caseRunRequest(definition, {
    capMicrousd: planned.capMicrousd,
    budgetMode: LIVE_SMOKE_BUDGET_MODE,
    workspaceId: input.workspaceId,
  })
  const route = await routeRunRequest(host, {
    runId,
    decisionId: input.newId(),
    request,
    messages: definition.messages,
    jsonSchema: definition.jsonSchema,
    sessionId: `live-smoke:${runId}`,
    webToolsAvailable: webEvidenceAvailable(),
    // The modes this build executes, plus the one the case asks for: the
    // router assesses that mode against this host's capabilities, and its
    // exclusions — not a flag here — say whether the build can run it.
    executableModes: [...new Set([...EXECUTABLE_MODES, definition.mode])],
  })
  return { runId, request, route }
}

/** An error as `Name: message` on one line (compile errors span several). */
export function oneLine(error: unknown): string {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  return text.replace(/\s*\n\s*/g, " ").trim()
}

function reserveOf(decision: RouteDecision | null, actionId: string): number | null {
  return (
    decision?.candidates.find((candidate) => candidate.action_id === actionId)
      ?.reserve_cost_microusd ?? null
  )
}

/** Pinned deployments this host holds no usable credential for (the executor's own resolution). */
export function missingCredentials(
  appSettings: AppSettings,
  roles: Readonly<Record<string, string | undefined>>
): string[] {
  const missing = new Set<string>()
  for (const deploymentId of Object.values(roles)) {
    if (!deploymentId) continue
    const ref = splitDeploymentId(deploymentId)
    if (
      !ref ||
      !resolveDeploymentLlmConfig(appSettings, ref.providerId, ref.modelId, "router-fusion:smoke")
    ) {
      missing.add(deploymentId)
    }
  }
  return [...missing]
}

// ── preview (dry run) ─────────────────────────────────────────────────────────

export interface CasePreview {
  caseId: string
  mode: string
  capMicrousd: number
  requestedCapMicrousd: number
  modeRunCapMicrousd: number
  /** `error`: routing threw instead of deciding (the message is in `detail`). */
  status: "selected" | "skipped" | "refused" | "error"
  detail: string
  actionId: string | null
  roles: Record<string, string>
  reserveMicrousd: number | null
  reasons: string[]
  /** Pinned deployments without a usable credential (only when checked). */
  missingCredentials: string[]
  /** Pinned deployments outside the confirmed providers (the fence must hold). */
  unconfirmed: string[]
}

export interface PreviewInput {
  routeHost: ChatRouteHost
  appSettings: AppSettings
  plan: LiveCapPlan
  /** The providers a run may call; null for no fence. */
  allowedProviderIds: readonly string[] | null
  checkCredentials: boolean
  newId?: () => string
}

/** Route every case without creating or running anything: what a run would do. */
export async function previewLiveSmoke(input: PreviewInput): Promise<CasePreview[]> {
  const newId = input.newId ?? (() => globalThis.crypto.randomUUID())
  const previews: CasePreview[] = []
  for (const planned of input.plan.cases) {
    const base = {
      caseId: planned.definition.id,
      mode: planned.definition.mode,
      capMicrousd: planned.capMicrousd,
      requestedCapMicrousd: planned.requestedCapMicrousd,
      modeRunCapMicrousd: planned.modeRunCapMicrousd,
    }
    let route: RunRoute
    try {
      route = (await routeCase(input.routeHost, planned, { workspaceId: newId(), newId })).route
    } catch (error) {
      previews.push({
        ...base,
        status: "error",
        detail: `routing failed: ${oneLine(error)}`,
        actionId: null,
        roles: {},
        reserveMicrousd: null,
        reasons: [],
        missingCredentials: [],
        unconfirmed: [],
      })
      continue
    }
    if (route.kind === "refused") {
      const refusal = classifyRouteRefusal(planned.definition.mode, route)
      previews.push({
        ...base,
        status: refusal.kind,
        detail: refusal.detail,
        actionId: null,
        roles: {},
        reserveMicrousd: null,
        reasons: refusal.reasons,
        missingCredentials: [],
        unconfirmed: [],
      })
      continue
    }
    const roles = { ...route.roles } as Record<string, string>
    previews.push({
      ...base,
      status: "selected",
      detail: `selected ${route.actionId}`,
      actionId: route.actionId,
      roles,
      reserveMicrousd: reserveOf(route.decision, route.actionId),
      reasons: [],
      missingCredentials: input.checkCredentials
        ? missingCredentials(input.appSettings, roles)
        : [],
      unconfirmed: input.allowedProviderIds
        ? unconfirmedDeployments(roles, input.allowedProviderIds)
        : [],
    })
  }
  return previews
}

// ── the run ───────────────────────────────────────────────────────────────────

export interface RunLiveSmokeInput {
  label: LiveSmokeLabel
  appSettings: AppSettings
  routeHost: ChatRouteHost
  executor: RoleCallExecutor
  plan: LiveCapPlan
  providers: LiveProviderListing[]
  /** The providers a run may call; null for no fence. */
  allowedProviderIds: readonly string[] | null
  /** Where the delegate case's fixture repository was written, if it was. */
  fixtureRoot: string | null
  network: NetworkGuard | null
  /** The dedicated database's main name; a fresh one per smoke by default. */
  databaseName?: string
  now?: () => number
  newId?: () => string
  sleep?: (ms: number) => Promise<void>
  log?: (line: string) => void
}

function recordingAppliers(effects: Map<string, Record<string, number>>): OutboxAppliers {
  const record = (kind: FusionOutboxKind) => async (row: FusionOutboxRow) => {
    const byKind = effects.get(row.runId) ?? {}
    byKind[kind] = (byKind[kind] ?? 0) + 1
    effects.set(row.runId, byKind)
    return "applied" as const
  }
  return {
    usage_row: record("usage_row"),
    execution_run_milestone: record("execution_run_milestone"),
    execution_run_projection: record("execution_run_projection"),
    session_message: record("session_message"),
  }
}

function countBy(values: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1
  return counts
}

function emptyCase(
  planned: PlannedCase,
  outcome: LiveCaseOutcome,
  detail: string,
  extra: Partial<LiveCaseReport> = {}
): LiveCaseReport {
  return {
    id: planned.definition.id,
    mode: planned.definition.mode,
    title: planned.definition.title,
    outcome,
    detail,
    runId: null,
    capMicrousd: planned.capMicrousd,
    spentMicrousd: 0,
    overspendMicrousd: 0,
    modelCalls: 0,
    costStatus: null,
    route: null,
    reasons: [],
    result: null,
    error: null,
    calls: [],
    usage: emptyUsage(),
    retry: summarizeRetries([], { executorCalls: 0, unledgeredCalls: 0, httpRequests: null }),
    events: {},
    effects: {},
    durationMs: 0,
    ...extra,
  }
}

async function spentInDatabase(db: FusionDB): Promise<number> {
  const runs = await db.fusionRuns.toArray()
  return runs.reduce((sum, run) => sum + run.budget.spentMicrousd, 0)
}

export async function runLiveSmoke(input: RunLiveSmokeInput): Promise<LiveSmokeReport> {
  const now = input.now ?? (() => Date.now())
  const newId = input.newId ?? (() => globalThis.crypto.randomUUID())
  const log = input.log ?? (() => {})
  const { plan } = input

  const name = fusionDatabaseName(input.databaseName ?? `cognia-live-smoke-${newId()}`)
  const db = new FusionDB(name)
  await db.open()
  const store = new FusionLedgerStore({ db, codec: fusionContentCodec(name), now, newId })
  const observed = observeExecutor(input.executor, now)
  const effects = new Map<string, Record<string, number>>()
  const appliers = recordingAppliers(effects)
  const leaseOwner = `live-smoke:${newId()}`
  const cases: LiveCaseReport[] = []
  let probed = false
  let stoppedBy: string | null = null

  try {
    for (const planned of plan.cases) {
      const { definition } = planned
      if (stoppedBy) {
        cases.push(emptyCase(planned, "not_run", `not run: the smoke stopped at ${stoppedBy}`))
        continue
      }
      const startedAt = now()
      log(`case ${definition.id} (${definition.mode}): routing`)
      let runId: string | null = null
      try {
        const routed = await routeCase(input.routeHost, planned, { workspaceId: newId(), newId })
        const { route, request } = routed
        if (route.kind === "refused") {
          const refusal = classifyRouteRefusal(definition.mode, route)
          log(`case ${definition.id}: ${refusal.detail}`)
          cases.push(
            emptyCase(planned, refusal.kind, refusal.detail, {
              reasons: refusal.reasons,
              durationMs: now() - startedAt,
            })
          )
          continue
        }
        const roles = { ...route.roles } as Record<string, string>
        const routeReport = {
          actionId: route.actionId,
          ruleId: route.ruleId,
          roles,
          reserveMicrousd: reserveOf(route.decision, route.actionId),
          reasonCodes: route.decision.reason_codes,
        }
        const unconfirmed = input.allowedProviderIds
          ? unconfirmedDeployments(roles, input.allowedProviderIds)
          : []
        if (unconfirmed.length > 0) {
          cases.push(
            emptyCase(
              planned,
              "refused",
              "refused: the route pinned a provider the user did not confirm",
              {
                route: routeReport,
                reasons: unconfirmed.map((id) => `PROVIDER_NOT_CONFIRMED:${id}`),
                durationMs: now() - startedAt,
              }
            )
          )
          continue
        }

        const remaining = remainingTotalMicrousd(plan.totalCapMicrousd, await spentInDatabase(db))
        const runInput: CreateRunInput = {
          runId: routed.runId,
          sessionId: null,
          surface: "gatewayRuns",
          origin: "gateway",
          decision: route.decision,
          actionId: route.actionId,
          ruleId: route.ruleId,
          roleDeployments: roles,
          config: route.config,
          capMicrousd: route.capMicrousd,
          maxModelCalls: route.maxModelCalls,
          deadlineMs: route.deadlineMs,
          budgetMode: request.budget.mode,
          // The total cap, as the ledger's tenant limit (D20).
          tenantLimitRemainingMicrousd: remaining,
          title: definition.title,
          task: route.task,
          acceptanceProfile: route.acceptanceProfile,
          dataClass: route.dataClass,
          ...(definition.usesFixtureRepo && input.fixtureRoot
            ? { workspaceRoot: input.fixtureRoot }
            : {}),
          driver: "orchestrator",
        }

        if (!probed) {
          // The cap is in place only if the ledger itself refuses a run that
          // does not fit the total. Nothing has been sent yet.
          const probe = await store.createRun({
            ...runInput,
            runId: newId(),
            decision: { ...route.decision, decision_id: newId() },
            capMicrousd: remaining + 1,
          })
          if (!ledgerRefusedOverCap(probe)) {
            throw new LiveCapError(
              "CAP_NOT_ENFORCED_BY_LEDGER",
              `the ledger did not refuse a run of ${remaining + 1} microusd against a remaining total of ${remaining} (${probe.ok ? "created" : probe.code})`
            )
          }
          probed = true
        }

        const stored = await store.artifactStore(null).put(
          encodeRunInput({
            messages: definition.messages,
            allowDegraded: definition.allowDegraded,
            jsonSchema: definition.jsonSchema,
          }),
          "application/json",
          `live-smoke-input/${routed.runId}`
        )
        const created = await store.createRun({ ...runInput, inputArtifactId: stored.artifactId })
        if (!created.ok) {
          cases.push(
            emptyCase(planned, "refused", `refused by the ledger: ${created.code}`, {
              route: routeReport,
              reasons: [
                created.code,
                ...(created.availableMicrousd !== undefined
                  ? [`available_microusd:${created.availableMicrousd}`]
                  : []),
              ],
              durationMs: now() - startedAt,
            })
          )
          continue
        }
        runId = routed.runId
        await db.fusionArtifacts.update(stored.artifactId, { runId })

        log(`case ${definition.id}: running ${route.actionId}`)
        const httpBefore = input.network?.records.length ?? 0
        const outcome = await executeFusionRun(
          {
            store: async () => store,
            appliers,
            leaseOwner,
            appSettings: () => input.appSettings,
            executor: observed.executor,
            // AUTH-07 at every reservation, against this smoke's settings.
            liveRefusal: (run, deploymentId) =>
              liveRefusalFor(
                input.routeHost,
                deploymentId,
                run.dataClass ?? "internal",
                run.surface
              ),
            now,
            ...(input.sleep ? { sleep: input.sleep } : {}),
          },
          { runId }
        )

        const run = await store.getRun(runId)
        const summary = await store.runSummary(runId)
        const sealed = run ? await readRunResult(store, run) : { result: null, expired: false }
        const events = await store.listEvents(runId)
        const mine: ObservedCall[] = observed.calls.filter((call) => call.runId === runId)
        const { calls, unledgeredCalls } = callRecordsOf(summary?.attempts ?? [], mine)
        const retry = summarizeRetries(calls, {
          executorCalls: mine.length,
          unledgeredCalls,
          httpRequests: input.network ? input.network.records.length - httpBefore : null,
        })
        const result = sealed.result
        const outcomeOf: Record<typeof outcome.kind, LiveCaseOutcome> = {
          succeeded: "succeeded",
          failed: "failed",
          cancelled: "cancelled",
          busy: "error",
          // Delegate outcomes (WP-D4). Neither is a smoke result: a parked run
          // is waiting on a person and a reconciling one on a decision about a
          // side effect, and the smoke runs neither mode.
          waiting: "error",
          reconciling: "error",
        }
        const detail =
          outcome.kind === "succeeded"
            ? `${outcome.result.mode_executed} run sealed, quality ${outcome.result.quality_status}`
            : outcome.kind === "failed"
              ? `failed: ${outcome.code}`
              : outcome.kind === "cancelled"
                ? "cancelled"
                : "another worker held the run's lease"
        log(`case ${definition.id}: ${detail}`)
        cases.push({
          ...emptyCase(planned, outcomeOf[outcome.kind], detail),
          runId,
          spentMicrousd: run?.budget.spentMicrousd ?? 0,
          overspendMicrousd: run?.budget.overspendMicrousd ?? 0,
          modelCalls: run?.budget.modelCalls ?? 0,
          costStatus: run?.costStatus ?? null,
          route: routeReport,
          result: result
            ? {
                qualityStatus: result.quality_status,
                verificationStatus: result.verification.status,
                warnings: result.warnings,
                answerChars: result.answer.length,
                answerPreview: answerPreview(result.answer),
              }
            : null,
          error:
            outcome.kind === "failed"
              ? { code: outcome.code, message: outcome.message }
              : (run?.error ?? null),
          calls,
          usage: calls.reduce((total, call) => addUsage(total, call.usage), emptyUsage()),
          retry,
          events: countBy(events.map((event) => event.type)),
          effects: effects.get(runId) ?? {},
          durationMs: now() - startedAt,
        })
      } catch (error) {
        if (error instanceof LiveCapError) throw error
        const message = oneLine(error instanceof Error ? error.message : error)
        const code = error instanceof Error ? error.name : "Error"
        log(`case ${definition.id}: stopped: ${code}: ${message}`)
        const run = runId ? await store.getRun(runId).catch(() => undefined) : undefined
        cases.push(
          emptyCase(planned, "error", `stopped by ${code}`, {
            runId,
            spentMicrousd: run?.budget.spentMicrousd ?? 0,
            overspendMicrousd: run?.budget.overspendMicrousd ?? 0,
            modelCalls: run?.budget.modelCalls ?? 0,
            error: { code, message },
            durationMs: now() - startedAt,
          })
        )
        stoppedBy = definition.id
      }
    }

    const spent = await spentInDatabase(db)
    const records = input.network?.records ?? []
    return {
      schema: LIVE_SMOKE_REPORT_SCHEMA,
      version: LIVE_SMOKE_REPORT_VERSION,
      label: input.label,
      generatedAt: new Date(now()).toISOString(),
      disclaimer: disclaimerFor(input.label),
      budgetMode: LIVE_SMOKE_BUDGET_MODE,
      totalCapMicrousd: plan.totalCapMicrousd,
      plannedMicrousd: plan.plannedMicrousd,
      totalSpentMicrousd: spent,
      remainingMicrousd: remainingTotalMicrousd(plan.totalCapMicrousd, spent),
      capEnforcement: {
        ledgerProbe: probed ? "refused_over_cap" : "not_reached",
        rule: CAP_ENFORCEMENT_RULE,
      },
      providers: input.providers,
      fixtureRoot: input.fixtureRoot,
      network: {
        mode: input.network?.mode === "observe" ? "observed" : "blocked",
        requests: records.length,
        blocked: records.filter((record) => record.blocked).length,
      },
      cases,
      capabilities: capabilityMatrix(cases),
    }
  } finally {
    db.close()
  }
}
