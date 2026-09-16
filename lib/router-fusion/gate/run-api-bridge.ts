/**
 * Where a `/v1/runs` request lands in the brain (ADR-0188 D9, B2).
 *
 * The gateway serves the HTTP; the brain owns the data. Rust round-trips each
 * request through the companion writes bridge, and
 * `lib/companion/desktop-write-source.ts` hands the `router_fusion_*` family to
 * this module — the one Router + Fusion module a shared dispatcher may import.
 *
 * Two things happen here and nowhere else:
 *
 *  - **The gate is checked on this side too.** The gateway checks its own copy
 *    of the switch, but the brain's setting is the authoritative one (D36): a
 *    surface switched off between the gateway's last snapshot and now must not
 *    execute a run. Off is `403 ROUTER_FUSION_DISABLED`, and a tripped breaker
 *    is `503` — the Run API is explicitly chosen work, so it fails rather than
 *    being answered by the ordinary path (D38).
 *  - **Errors are values, not throws.** Rust needs the status and code to
 *    answer with, so every outcome comes back as `{ ok }`, including the ones
 *    that went wrong.
 */

import type { AppSettings } from "@cognia/agent-config-types"

import type { RouterFusionGateSettings } from "./feature-gate"
import { breakerThresholdOf, routerFusionGate } from "./feature-gate"
import { runExplicitFusion, trippedSurfaceError } from "./guard"
import { loadRouterFusionHost, type RouterFusionHost } from "./load-engine"

export const ROUTER_FUSION_BRIDGE_PREFIX = "router_fusion_"

/** The commands Rust sends, mirroring `brain_bridge::command` in the gateway crate. */
export const ROUTER_FUSION_BRIDGE_COMMANDS = [
  "router_fusion_run_create",
  "router_fusion_run_get",
  "router_fusion_run_events",
  "router_fusion_run_cancel",
  "router_fusion_run_resume",
  "router_fusion_run_feedback",
  "router_fusion_session_get",
  "router_fusion_artifact_get",
  "router_fusion_artifact_read",
  "router_fusion_chat_create",
  "router_fusion_chat_result",
] as const
export type RouterFusionBridgeCommand = (typeof ROUTER_FUSION_BRIDGE_COMMANDS)[number]

export function isRouterFusionBridgeCommand(command: string): command is RouterFusionBridgeCommand {
  return (ROUTER_FUSION_BRIDGE_COMMANDS as readonly string[]).includes(command)
}

export interface BridgeError {
  status: number
  code: string
  message: string
  details?: Record<string, unknown>
}

export type BridgeOutcome = { ok: true; value: unknown } | { ok: false; error: BridgeError }

function refused(status: number, code: string, message: string): BridgeOutcome {
  return { ok: false, error: { status, code, message } }
}

export interface RouterFusionBridgeDeps {
  settings: RouterFusionGateSettings | null | undefined
  /** Test seam. */
  loadHost?: () => Promise<RouterFusionHost>
}

function actorOf(payload: Record<string, unknown>) {
  const actor = (payload.actor ?? {}) as Record<string, unknown>
  return {
    keyId: typeof actor.keyId === "string" ? actor.keyId : null,
    keyName: typeof actor.keyName === "string" ? actor.keyName : "",
    scopes: Array.isArray(actor.scopes)
      ? (actor.scopes.filter((s) => typeof s === "string") as string[])
      : [],
  }
}

/**
 * Run one bridged Run API command. Never throws: the caller is an RPC
 * dispatcher whose only way to say "403" is this shape.
 */
export async function dispatchRouterFusionBridgeCommand(
  command: RouterFusionBridgeCommand,
  payload: Record<string, unknown>,
  deps: RouterFusionBridgeDeps
): Promise<BridgeOutcome> {
  const gate = routerFusionGate(deps.settings, "gatewayRuns")
  if (gate === "off") {
    return refused(
      403,
      "ROUTER_FUSION_DISABLED",
      "Router + Fusion runs are switched off for this host"
    )
  }
  if (gate === "tripped") {
    const tripped = trippedSurfaceError("gatewayRuns")
    return refused(503, tripped.code, tripped.message)
  }

  const load = deps.loadHost ?? loadRouterFusionHost
  const actor = actorOf(payload)
  const runId = typeof payload.runId === "string" ? payload.runId : ""
  const sessionId = typeof payload.sessionId === "string" ? payload.sessionId : ""
  const artifactId = typeof payload.artifactId === "string" ? payload.artifactId : ""

  try {
    return await runExplicitFusion<BridgeOutcome>({
      surface: "gatewayRuns",
      threshold: breakerThresholdOf(deps.settings),
      fusion: async () => {
        const host = await load()
        // Built per call: the settings, the account database and the routing
        // engine can all have moved since the last request.
        // Every caller hands this dispatcher the full account settings (see
        // `current-settings.ts`); the gate type only names the part it reads.
        const apiDeps = host.runApiDeps(deps.settings as AppSettings | null | undefined)
        const scopes = actor.scopes.filter(host.isRunApiScope)
        const runActor = { keyId: actor.keyId, keyName: actor.keyName, scopes }
        switch (command) {
          case "router_fusion_run_create": {
            const idempotencyKey =
              typeof payload.idempotencyKey === "string" ? payload.idempotencyKey : undefined
            const result = await host.createRunFromApi(apiDeps, {
              actor: runActor,
              body: payload.body,
              ...(idempotencyKey ? { idempotencyKey } : {}),
            })
            return toOutcome(result)
          }
          case "router_fusion_run_get":
            return toOutcome(await host.getRunFromApi(apiDeps, { actor: runActor, runId }))
          case "router_fusion_run_events": {
            const afterSeq = typeof payload.afterSeq === "number" ? payload.afterSeq : 0
            const limit = typeof payload.limit === "number" ? payload.limit : undefined
            return toOutcome(
              await host.listRunEventsFromApi(apiDeps, {
                actor: runActor,
                runId,
                afterSeq,
                ...(limit !== undefined ? { limit } : {}),
              })
            )
          }
          case "router_fusion_run_cancel":
            return toOutcome(await host.cancelRunFromApi(apiDeps, { actor: runActor, runId }))
          case "router_fusion_run_resume":
            return toOutcome(
              await host.resumeRunFromApi(apiDeps, { actor: runActor, runId, body: payload.body })
            )
          case "router_fusion_run_feedback":
            // The body is the caller's own; the Run API validates it against the contract.
            return toOutcome(
              await host.submitFeedbackFromApi(apiDeps, {
                actor: runActor,
                runId,
                body: payload.feedback,
              })
            )
          case "router_fusion_session_get":
            return toOutcome(await host.getSessionFromApi(apiDeps, { actor: runActor, sessionId }))
          case "router_fusion_artifact_get":
            // The gateway names its own origin; the read URL points back at it.
            return toOutcome(
              await host.getArtifactFromApi(apiDeps, {
                actor: runActor,
                artifactId,
                baseUrl: typeof payload.baseUrl === "string" ? payload.baseUrl : "",
              })
            )
          case "router_fusion_chat_create": {
            const idempotencyKey =
              typeof payload.idempotencyKey === "string" ? payload.idempotencyKey : undefined
            return toOutcome(
              await host.createChatRunFromApi(apiDeps, {
                actor: runActor,
                body: payload.body,
                ...(idempotencyKey ? { idempotencyKey } : {}),
              })
            )
          }
          case "router_fusion_chat_result":
            return toOutcome(
              await host.chatResultFromApi(apiDeps, {
                actor: runActor,
                runId,
                model: payload.model,
              })
            )
          case "router_fusion_artifact_read":
            return toOutcome(
              await host.readArtifactFromApi(apiDeps, {
                actor: runActor,
                artifactId,
                token: payload.token,
              })
            )
        }
      },
    })
  } catch (error) {
    // `runExplicitFusion` turned an infrastructure fault into this; the caller
    // sees 503, and the breaker has already counted it.
    const code = (error as { code?: unknown }).code
    return refused(
      503,
      typeof code === "string" ? code : "ROUTER_FUSION_UNAVAILABLE",
      error instanceof Error ? error.message : String(error)
    )
  }
}

function toOutcome(
  result: { ok: true; value: unknown } | { ok: false; error: BridgeError }
): BridgeOutcome {
  return result.ok ? { ok: true, value: result.value } : { ok: false, error: result.error }
}
