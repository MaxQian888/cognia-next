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
import { currentFusionStore } from "../chat/store-provider"
import { tightestTenantLimit } from "../chat/tenant-budget"
import { routeRunRequest } from "../routing/run-route"
import { driveRun } from "../runtime/run-driver"
import { webEvidenceAvailable } from "../tools/web-evidence"
import { createRunApiRouteHost } from "./route-host"
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
 * What a delegate request may name on this device (ADR-0188 B4, WP-D4).
 *
 * A workspace is "authorized" when it is a project this app knows AND its
 * acceptance profiles could be read and approved — the same answer the router
 * uses, so the request is refused at the same place for the same reason
 * instead of passing validation and failing to route.
 */
export interface DelegateRequestAuthorization {
  /** The workspace the request named, when this device authorizes it. */
  authorizedWorkspaceId: string | null
  /** The profile ids approved at their current command hash (WP-D2). */
  approvedProfileIds: readonly string[]
}

const NO_DELEGATE_AUTHORIZATION: DelegateRequestAuthorization = {
  authorizedWorkspaceId: null,
  approvedProfileIds: [],
}

/**
 * Ask WP-D2 about ONE project. A request that names no workspace never gets
 * here, so an ordinary cascade or panel call pays nothing for delegate.
 */
export async function delegateAuthorizationFor(
  workspaceId: string | null | undefined
): Promise<DelegateRequestAuthorization> {
  if (!workspaceId) return NO_DELEGATE_AUTHORIZATION
  try {
    const { acceptanceProfileAvailable } = await import("../verify/acceptance-profiles")
    const availability = await acceptanceProfileAvailable(workspaceId)
    return {
      authorizedWorkspaceId: availability.reason === "project_not_found" ? null : workspaceId,
      approvedProfileIds: availability.approvedProfileIds,
    }
  } catch {
    return NO_DELEGATE_AUTHORIZATION
  }
}

/**
 * The account's own limits, as the request validator reads them.
 *
 * Workspaces and acceptance profiles are delegate's (B4): answered from the
 * project the request named, and `false` for every request that named none —
 * honestly, rather than optimistically.
 */
export function runRequestPolicyOf(
  appSettings: AppSettings,
  delegate: DelegateRequestAuthorization = NO_DELEGATE_AUTHORIZATION
): RunRequestPolicy {
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
    workspaceAuthorized: (workspaceId) => workspaceId === delegate.authorizedWorkspaceId,
    acceptanceProfileExists: (profileId) => delegate.approvedProfileIds.includes(profileId),
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

/**
 * Which entry point a Run API run serves. `/v1/runs` is the gateway lane; a
 * paired phone or browser reaches the same brain path over the companion RPC
 * (`execution_run_*`, WP-C) and its run belongs to the `companion` surface, so
 * the live checks before every reservation and the boot sweep read the
 * companion switch, not the gateway's.
 */
export type RunApiLane = "gatewayRuns" | "companion"

const LANE_ORIGIN: Record<RunApiLane, "gateway" | "companion"> = {
  gatewayRuns: "gateway",
  companion: "companion",
}

/**
 * What a run writes into its conversation (DESIGN §12.1).
 *
 * `input-and-answer` is the Run API's own contract: the run appends the
 * messages it was created with and, when it succeeds, its answer. A companion
 * run that continues a conversation writes `answer-only`, for the reason the
 * chat path does — the person's message is already in the transcript, put
 * there by the surface that took it, and the run's input additionally carries
 * the earlier turns as context, which must never be appended a second time.
 */
export type RunTranscriptMode = "input-and-answer" | "answer-only"

export interface CreateRoutedRunOptions {
  newId?: () => string
  webToolsAvailable?: boolean
  /** The surface and origin the run is recorded under; `gatewayRuns` when omitted. */
  lane?: RunApiLane
  /** What the run appends to its conversation; the Run API's own default when omitted. */
  transcript?: RunTranscriptMode
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
  const lane = options.lane ?? "gatewayRuns"
  // The user's providers through the app's routing engine, with the snapshot
  // standing in for the settings store no headless brain loads. The live smoke
  // routes against the same host, so it is built in one place.
  const host = createRunApiRouteHost(appSettings)
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
    surface: lane,
    origin: LANE_ORIGIN[lane],
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
    writesSessionTranscript: (options.transcript ?? "input-and-answer") === "input-and-answer",
    ...(options.transcript === "answer-only" ? { writesSessionAnswer: true } : {}),
    task: route.task,
    acceptanceProfile: route.acceptanceProfile,
    dataClass: route.dataClass,
    // What a delegate run needs to verify anything (WP-D4): the project its
    // acceptance profile and approval live on, the checkout it stages from,
    // and the profile id itself. The route resolved all three; a non-delegate
    // route carries none of them.
    ...(route.projectId ? { projectId: route.projectId } : {}),
    ...(route.workspaceRoot ? { workspaceRoot: route.workspaceRoot } : {}),
    ...(route.acceptanceProfileId ? { acceptanceProfileId: route.acceptanceProfileId } : {}),
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
 *
 * `lane` names the surface the runs it creates belong to (see {@link RunApiLane});
 * the gateway bridge omits it.
 */
export function runApiDeps(
  snapshot?: AppSettings | null,
  options: { lane?: RunApiLane; transcript?: RunTranscriptMode } = {}
): RunApiDeps {
  const appSettings = liveSettingsReader(snapshot)
  return {
    store: () => currentFusionStore(),
    appSettings,
    policy: async (policyInput) => {
      const settings = appSettings()
      if (!settings) throw new Error("Router + Fusion has no settings to validate a run against")
      return runRequestPolicyOf(settings, await delegateAuthorizationFor(policyInput?.workspaceId))
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
      return createRoutedRun(input, settings, {
        ...(options.lane ? { lane: options.lane } : {}),
        ...(options.transcript ? { transcript: options.transcript } : {}),
      })
    },
    // `POST /v1/runs` answers 202: the run is driven after the answer goes out,
    // and the run's own lease keeps other processes out.
    startRun: (runId) => driveRun(runId, appSettings),
  }
}
