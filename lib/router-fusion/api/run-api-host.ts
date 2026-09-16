/**
 * What the Run API needs from the rest of the app (ADR-0188 B2–B3).
 *
 * `run-api.ts` decides who may do what and keeps the API's promises —
 * idempotency, actor isolation, session versions. This module is the wiring
 * under it: it routes a validated request against the user's own providers and
 * rule rows across every mode the request allows, creates the run, opens the
 * conversation a gateway run belongs to, and hands the run to the orchestrator.
 *
 * Split in two because the promises are worth testing without a routing engine,
 * and the wiring is worth testing without an HTTP shape.
 */

import type { AppSettings, ChatSession } from "@cognia/agent-config-types"
import { createMappingRegistry, ProviderRoutingEngine } from "@cognia/provider-routing"
import { buildRoutingEngineDeps } from "@cognia/provider-routing/build-preview-engine"
import { DEFAULT_ROUTING_CONFIG } from "@cognia/provider-types/model-mapping"
import {
  usdToMicrousd,
  type ExecutionMode,
  type Message,
  type RunRequestPolicy,
} from "@cognia/router-fusion"
import { normalizeRouterFusionSettings } from "@cognia/router-fusion/settings/settings"
import { textFromParts } from "@/lib/chat/team-transcript"
import { listMessages } from "@/lib/db/messages"
import { createSession, getSession } from "@/lib/db/sessions"

import { liveSettingsReader } from "../calls/live-settings"
import { createChatRouteHost } from "../chat/chat-route-host"
import { currentFusionStore } from "../chat/store-provider"
import { tightestTenantLimit } from "../chat/tenant-budget"
import { routeRunRequest } from "../routing/run-route"
import { driveRun } from "../runtime/run-driver"
import { webEvidenceAvailable } from "../tools/web-evidence"
import {
  EXECUTABLE_MODES,
  titleFor,
  type CreateRunFromApiInput,
  type RunApiActor,
  type RunApiDeps,
  type RunApiResult,
  type SessionPort,
} from "./run-api"

/**
 * The account's own limits, as the request validator reads them. Workspaces and
 * acceptance profiles belong to delegate, which this build does not execute, so
 * they are answered honestly rather than optimistically: nothing is authorized
 * until B4 wires the real workspace trust.
 */
export function runRequestPolicyOf(appSettings: AppSettings): RunRequestPolicy {
  const settings = normalizeRouterFusionSettings(appSettings.routerFusion)
  return {
    trackedBudgetEnabled: settings.budgetMode === "tracked",
    // Auto may land on any executable mode; the route applies the chosen
    // action's own cap, so the request is bounded by the largest of them here.
    maxRunCapMicrousd: (mode: ExecutionMode | "auto") =>
      mode === "auto"
        ? Math.max(
            ...EXECUTABLE_MODES.map((executable) =>
              usdToMicrousd(settings.runCapUsdByMode[executable])
            )
          )
        : usdToMicrousd(settings.runCapUsdByMode[mode]),
    workspaceAuthorized: () => false,
    acceptanceProfileExists: () => false,
    minimumProfile: "economy",
    // A degraded result is labelled and never counted as a fusion success; a
    // caller that asks for one gets one.
    degradeAllowed: true,
  }
}

/**
 * What a session snapshot shows a caller: the text of each user and assistant
 * turn. Tool calls, reasoning and attachments are the app's own rendering and
 * stay out, as does a turn with no text at all.
 */
export function visibleMessages(
  messages: ReadonlyArray<{ role: string; parts?: readonly unknown[] }>
): Message[] {
  const out: Message[] = []
  for (const message of messages) {
    if (message.role !== "user" && message.role !== "assistant") continue
    const content = textFromParts(message.parts ?? [])
    if (content.trim().length === 0) continue
    out.push({ role: message.role, content })
  }
  return out
}

/** A gateway run's conversation: an ordinary session, tagged with the key that opened it. */
export function sessionPort(): SessionPort {
  return {
    get: (sessionId) => getSession(sessionId),
    open: (actor: RunApiActor, title: string): Promise<ChatSession> =>
      createSession({
        title,
        titleAuto: true,
        origin: { kind: "gateway-api", keyId: actor.keyId ?? "local", keyName: actor.keyName },
      }),
    messages: async (sessionId) => visibleMessages(await listMessages(sessionId)),
  }
}

export interface CreateRoutedRunOptions {
  newId?: () => string
  webToolsAvailable?: boolean
}

/**
 * Route the request against the user's own providers and create its run. A
 * request that nothing can serve is refused with the router's own reasons — a
 * Run API caller asked for Router + Fusion explicitly, so it is never quietly
 * answered by something else (D5/D38).
 */
export async function createRoutedRun(
  input: CreateRunFromApiInput,
  appSettings: AppSettings,
  options: CreateRoutedRunOptions = {}
): Promise<RunApiResult<{ runId: string }>> {
  const newId = options.newId ?? (() => globalThis.crypto.randomUUID())
  const engineDeps = buildRoutingEngineDeps(appSettings)
  const host = {
    ...createChatRouteHost({
      appSettings,
      engine: new ProviderRoutingEngine(
        createMappingRegistry(appSettings.modelMappings ?? []),
        appSettings.routingConfig ?? DEFAULT_ROUTING_CONFIG,
        engineDeps
      ),
      engineDeps,
    }),
    // A headless brain never loads the settings store; the snapshot stands in.
    currentSettings: liveSettingsReader(appSettings),
  }
  const runId = newId()
  const route = await routeRunRequest(host, {
    runId,
    decisionId: newId(),
    request: input.request,
    messages: input.messages,
    jsonSchema: input.jsonSchema,
    sessionId: input.session.id,
    webToolsAvailable: options.webToolsAvailable ?? webEvidenceAvailable(),
    executableModes: EXECUTABLE_MODES,
  })
  if (route.kind === "refused") {
    return {
      ok: false,
      error: {
        status: 422,
        code: route.code,
        message: "no action fits this request's modes, budget, limits and data rules",
        details: { reasons: route.reasons },
      },
    }
  }

  const store = await currentFusionStore()
  // The tenant limit is the tightest budget scope over every provider the run may call.
  const tenantRemaining = await tightestTenantLimit(
    appSettings.costBudget,
    Object.values(route.roles)
  )
  const created = await store.createRun({
    runId,
    inputArtifactId: input.inputArtifactId,
    sessionId: input.session.id,
    surface: "gatewayRuns",
    origin: "gateway",
    decision: route.decision,
    actionId: route.actionId,
    ruleId: route.ruleId,
    roleDeployments: { ...route.roles } as Record<string, string>,
    config: route.config,
    // A request may lower the action's cap, never raise it (D22).
    capMicrousd: Math.min(route.capMicrousd, input.capMicrousd),
    maxModelCalls: route.maxModelCalls,
    deadlineMs: route.deadlineMs,
    budgetMode: input.request.budget.mode,
    tenantLimitRemainingMicrousd: tenantRemaining,
    actorKeyId: input.actor.keyId,
    actorKeyName: input.actor.keyName,
    // The cockpit row's own title: a Run API run has no local engine run to
    // borrow one from.
    title: titleFor(input.messages),
    expectedSessionVersion: input.request.expected_session_version ?? input.sessionVersion,
    currentSessionVersion: input.sessionVersion,
    writesSessionTranscript: true,
    task: route.task,
    acceptanceProfile: route.acceptanceProfile,
    dataClass: route.dataClass,
    // Driven from its stored input: a worker that finds it after a crash carries on.
    driver: "orchestrator",
  })
  if (!created.ok) {
    return {
      ok: false,
      error: {
        status:
          created.code === "SESSION_BUSY" || created.code === "SESSION_VERSION_CONFLICT"
            ? 409
            : 422,
        code: created.code,
        message: `the run could not be created: ${created.code}`,
        ...(created.activeRunId ? { details: { activeRunId: created.activeRunId } } : {}),
      },
    }
  }
  return { ok: true, value: { runId: created.run.runId } }
}

/**
 * The Run API, wired to this app.
 *
 * `snapshot` is the settings the bridge read for its gate check. The desktop
 * window's live store wins whenever it is loaded; a headless brain, which never
 * loads that store, works from the snapshot instead of from nothing.
 */
export function runApiDeps(snapshot?: AppSettings | null): RunApiDeps {
  const appSettings = liveSettingsReader(snapshot)
  return {
    store: () => currentFusionStore(),
    appSettings,
    policy: () => {
      const settings = appSettings()
      if (!settings) throw new Error("Router + Fusion has no settings to validate a run against")
      return runRequestPolicyOf(settings)
    },
    session: sessionPort(),
    createRun: async (input) => {
      const settings = appSettings()
      if (!settings) {
        return {
          ok: false,
          error: {
            status: 503,
            code: "SETTINGS_UNAVAILABLE",
            message: "the app has no settings loaded yet",
          },
        }
      }
      return createRoutedRun(input, settings)
    },
    // `POST /v1/runs` answers 202: the run is driven after the answer goes out,
    // and the run's own lease keeps other processes out.
    startRun: (runId) => driveRun(runId, appSettings),
  }
}
