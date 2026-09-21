/**
 * Where a paired phone's or browser's Router + Fusion call lands in the brain
 * (ADR-0188 D25, the `companion` surface; B2 companion RPC).
 *
 * A companion reaches the brain over the companion RPC: Rust dispatches the
 * command to the writes bridge (`rpc/data_sync.rs`), and
 * `lib/companion/desktop-write-source.ts` hands these names here. This module
 * is the one Router + Fusion module that dispatcher may import for them, and
 * with the companion switch off it answers without loading anything else and
 * without opening the fusion database.
 *
 *  - `execution_run_create`, `execution_run_resume`, `execution_run_get` and
 *    `execution_run_events` are the Run API for a paired device
 *    (`api/companion-run-host.ts`): the actor is the device Rust authenticated
 *    (`callerDeviceId`, overwritten server-side), and the run belongs to the
 *    `companion` surface.
 *  - `claude_call_reserve_respond` is a companion renderer answering a
 *    `call_reserve_request` the host's sidecar raised for a turn that
 *    companion started. The companion's own ledger decided; this host only
 *    says whether it relays the decision, and Rust writes it to the sidecar.
 *  - `execution_run_control` (cancel and approve) is routed here first by
 *    {@link routeCompanionRunControl} when it names a companion run, which has
 *    no execution-run projection for the cockpit's control plane to find.
 *
 * The gate is checked on this side, and it is the authoritative one (D36):
 * off is `403 ROUTER_FUSION_DISABLED`; a tripped breaker is `503`, because a
 * companion run is explicitly chosen fusion work and fails rather than being
 * answered by an ordinary turn (D38). Every outcome is a value, never a throw,
 * in the `{ ok, value | error }` envelope the gateway's Run API bridge uses.
 */

import { recordFusionFault } from "./breaker"
import { toInfrastructureFault, RouterFusionInfrastructureError } from "./faults"
import { breakerThresholdOf, routerFusionGate, type RouterFusionGateSettings } from "./feature-gate"
import { runExplicitFusion, trippedSurfaceError } from "./guard"
import type { BridgeError, BridgeOutcome } from "./run-api-bridge"

/** The companion commands this module answers (their descriptors are in `protocol/companion-commands.json`). */
export const ROUTER_FUSION_COMPANION_COMMANDS = [
  "execution_run_create",
  "execution_run_resume",
  "execution_run_get",
  "execution_run_events",
  "claude_call_reserve_respond",
] as const
export type RouterFusionCompanionCommand = (typeof ROUTER_FUSION_COMPANION_COMMANDS)[number]

export function isRouterFusionCompanionCommand(
  command: string
): command is RouterFusionCompanionCommand {
  return (ROUTER_FUSION_COMPANION_COMMANDS as readonly string[]).includes(command)
}

/** A reservation answer the sidecar accepts (`build_call_reserve_decision_payload`). */
export const CALL_RESERVE_DECISIONS = ["granted", "refused", "bypass"] as const

/** A page of events is never larger than this; the caller pages on. */
export const COMPANION_EVENTS_PAGE_MAX = 500

export type CompanionRunHost = typeof import("../api/companion-run-host")

let loading: Promise<CompanionRunHost> | null = null

/**
 * Load the companion Run API host after the gate said on. A failed import is an
 * infrastructure fault and is not cached, like `load-engine.ts`.
 */
export function loadCompanionRunHost(
  importer: () => Promise<CompanionRunHost> = () => import("../api/companion-run-host")
): Promise<CompanionRunHost> {
  if (!loading) {
    loading = importer().catch((error: unknown) => {
      loading = null
      throw new RouterFusionInfrastructureError(
        "import_failed",
        `Router + Fusion could not be loaded: ${error instanceof Error ? error.message : String(error)}`,
        error
      )
    })
  }
  return loading
}

export function __resetCompanionRunHostForTesting(): void {
  loading = null
}

export interface CompanionBridgeDeps {
  /** The host's full account settings (`current-settings.ts`); the gate reads its switches. */
  settings: RouterFusionGateSettings | null | undefined
  /** Test seam. */
  loadHost?: () => Promise<CompanionRunHost>
}

/**
 * The health of each companion operation in the host feature manifest, from
 * the companion switch (D36: a companion reads the effective state instead of
 * guessing). Off: none of them runs here. Tripped: a run is refused until the
 * switch is re-armed, but a reservation answer is still relayed — it needs no
 * fusion state on this host.
 */
export function companionOperationHealth(
  settings: RouterFusionGateSettings | null | undefined
): Record<RouterFusionCompanionCommand, { healthy: boolean; reason?: string }> {
  const gate = routerFusionGate(settings, "companion")
  const run =
    gate === "on"
      ? { healthy: true }
      : { healthy: false, reason: gate === "off" ? "ROUTER_FUSION_DISABLED" : "breaker_tripped" }
  const relay =
    gate === "off" ? { healthy: false, reason: "ROUTER_FUSION_DISABLED" } : { healthy: true }
  return {
    execution_run_create: run,
    execution_run_resume: run,
    execution_run_get: run,
    execution_run_events: run,
    claude_call_reserve_respond: relay,
  }
}

function refused(
  status: number,
  code: string,
  message: string,
  details?: Record<string, unknown>
): BridgeOutcome {
  return { ok: false, error: { status, code, message, ...(details ? { details } : {}) } }
}

function invalid(field: string, message: string): BridgeOutcome {
  return refused(422, "SCHEMA_INVALID", message, { paths: [field] })
}

function text(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key]
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function gateRefusal(settings: CompanionBridgeDeps["settings"]): BridgeOutcome | null {
  const gate = routerFusionGate(settings, "companion")
  if (gate === "off") {
    return refused(
      403,
      "ROUTER_FUSION_DISABLED",
      "Router + Fusion is switched off for companions on this host"
    )
  }
  if (gate === "tripped") {
    const tripped = trippedSurfaceError("companion")
    return refused(503, tripped.code, tripped.message)
  }
  return null
}

/**
 * The relay verdict for a companion's reservation answer. Validated here so a
 * malformed decision is refused before Rust writes anything to the sidecar;
 * the sidecar itself re-validates the decision word.
 */
function reserveRelayVerdict(payload: Record<string, unknown>): BridgeOutcome {
  const sessionId = text(payload, "sessionId")
  if (!sessionId) return invalid("sessionId", "sessionId is required")
  const requestId = text(payload, "requestId")
  if (!requestId) return invalid("requestId", "requestId is required")
  const decision = payload.decision
  if (!(CALL_RESERVE_DECISIONS as readonly unknown[]).includes(decision)) {
    return invalid("decision", "decision must be granted, refused or bypass")
  }
  if (
    payload.attemptNo !== undefined &&
    !(Number.isInteger(payload.attemptNo) && (payload.attemptNo as number) >= 1)
  ) {
    return invalid("attemptNo", "attemptNo must be a positive integer")
  }
  if ((decision === "refused" || decision === "bypass") && !text(payload, "code")) {
    return invalid("code", `a ${String(decision)} answer carries its code`)
  }
  return { ok: true, value: { relay: true, sessionId, requestId, decision } }
}

/**
 * Run one companion Router + Fusion command. Never throws: the caller is an RPC
 * dispatcher whose only way to say "403" is this shape.
 */
export async function dispatchRouterFusionCompanionCommand(
  command: RouterFusionCompanionCommand,
  payload: Record<string, unknown>,
  deps: CompanionBridgeDeps
): Promise<BridgeOutcome> {
  if (command === "claude_call_reserve_respond") {
    // Relaying needs no fusion state on this host — the companion's ledger
    // already decided — so a tripped breaker here does not hold the turn
    // hostage. Off is still off: the host refuses to act for companions, and
    // the sidecar's own timeout turns the unanswered call into a bypass.
    if (routerFusionGate(deps.settings, "companion") === "off") {
      return gateRefusal(deps.settings)!
    }
    return reserveRelayVerdict(payload)
  }

  const gated = gateRefusal(deps.settings)
  if (gated) return gated

  const deviceId = text(payload, "callerDeviceId")
  if (!deviceId) {
    // Rust stamps this on every call; its absence is a caller the host could
    // not authenticate as a device, which has no actor to run as.
    return refused(403, "COMPANION_ACTOR_REQUIRED", "this command needs a paired device")
  }
  const runId = text(payload, "runId") ?? ""
  const settings = deps.settings as import("@cognia/agent-config-types").AppSettings | null

  // Shape checks before anything loads: a malformed call is not a fault.
  let create: {
    mode: "cascade" | "panel"
    text: string
    sessionId: string | null
    key: string
  } | null = null
  let events: { afterSeq: number; limit?: number } = { afterSeq: 0 }
  switch (command) {
    case "execution_run_create": {
      const mode = payload.mode
      if (mode !== "cascade" && mode !== "panel") {
        return invalid("mode", "mode must be cascade or panel")
      }
      if (typeof payload.text !== "string") return invalid("text", "text is required")
      const key = text(payload, "idempotencyKey")
      if (!key) return invalid("idempotencyKey", "idempotencyKey is required")
      create = { mode, text: payload.text, sessionId: text(payload, "sessionId") ?? null, key }
      break
    }
    case "execution_run_events": {
      const afterSeq = payload.afterSeq ?? 0
      if (!Number.isInteger(afterSeq) || (afterSeq as number) < 0) {
        return invalid("afterSeq", "afterSeq must be a non-negative integer")
      }
      const limit = payload.maxEvents
      if (
        limit !== undefined &&
        !(
          Number.isInteger(limit) &&
          (limit as number) >= 1 &&
          (limit as number) <= COMPANION_EVENTS_PAGE_MAX
        )
      ) {
        return invalid("maxEvents", `maxEvents must be between 1 and ${COMPANION_EVENTS_PAGE_MAX}`)
      }
      events = {
        afterSeq: afterSeq as number,
        ...(limit !== undefined ? { limit: limit as number } : {}),
      }
      if (!runId) return invalid("runId", "runId is required")
      break
    }
    case "execution_run_get":
    case "execution_run_resume":
      if (!runId) return invalid("runId", "runId is required")
      break
  }

  const load = deps.loadHost ?? loadCompanionRunHost
  try {
    return await runExplicitFusion<BridgeOutcome>({
      surface: "companion",
      threshold: breakerThresholdOf(deps.settings),
      fusion: async () => {
        const host = await load()
        const actor = await host.companionActor(deviceId)
        switch (command) {
          case "execution_run_create":
            return toOutcome(
              await host.createCompanionRun(settings, {
                actor,
                mode: create!.mode,
                text: create!.text,
                sessionId: create!.sessionId,
                idempotencyKey: create!.key,
              })
            )
          case "execution_run_get":
            return toOutcome(await host.getCompanionRun(settings, { actor, runId }))
          case "execution_run_events":
            return toOutcome(
              await host.listCompanionRunEvents(settings, { actor, runId, ...events })
            )
          case "execution_run_resume":
            return toOutcome(
              await host.resumeCompanionRun(settings, { actor, runId, body: payload.body })
            )
        }
      },
    })
  } catch (error) {
    // `runExplicitFusion` turned an infrastructure fault into this and the
    // breaker has counted it; a companion run fails, it is never faked.
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

/** What `execution_run_control` answers for a companion run (`RunControlResult` shape). */
export type CompanionRunControlOutcome = Awaited<
  ReturnType<CompanionRunHost["controlCompanionRun"]>
>

/**
 * `execution_run_control` for a companion run, or `null` when the command is
 * not one — the caller then runs the cockpit's control plane exactly as before.
 *
 * With the companion switch off nothing loads and nothing is asked: every
 * control command takes the existing path. With it on, the fusion database is
 * asked whether the run is a companion run; if that question itself fails, the
 * command still takes the existing path (ordinary run control must not break
 * because the fusion database did) and the fault feeds the breaker.
 */
export async function routeCompanionRunControl(
  payload: Record<string, unknown>,
  deps: CompanionBridgeDeps
): Promise<CompanionRunControlOutcome | null> {
  const gate = routerFusionGate(deps.settings, "companion")
  if (gate === "off") return null
  const runId = text(payload, "runId")
  const deviceId = text(payload, "callerDeviceId")
  const action = text(payload, "action")
  const expectedRevision = payload.expectedRevision
  if (!runId || !deviceId || !action || !Number.isInteger(expectedRevision)) return null
  const settings = deps.settings as import("@cognia/agent-config-types").AppSettings | null
  const threshold = breakerThresholdOf(deps.settings)
  const load = deps.loadHost ?? loadCompanionRunHost

  let host: CompanionRunHost
  try {
    host = await load()
    if (!(await host.isCompanionRun(settings, runId))) return null
  } catch (error) {
    const fault = toInfrastructureFault(error)
    if (fault) recordFusionFault("companion", fault.code, threshold)
    return null
  }
  if (gate === "tripped") {
    return { accepted: false, reason: "source_rejected", code: "ROUTER_FUSION_UNAVAILABLE" }
  }
  const interruptId = text(payload, "interruptId")
  try {
    return await runExplicitFusion({
      surface: "companion",
      threshold,
      fusion: async () =>
        host.controlCompanionRun(settings, {
          actor: await host.companionActor(deviceId),
          command: {
            runId,
            action,
            expectedRevision: expectedRevision as number,
            ...(interruptId ? { interruptId } : {}),
          },
        }),
    })
  } catch (error) {
    const code = (error as { code?: unknown }).code
    return {
      accepted: false,
      reason: "source_rejected",
      code: typeof code === "string" ? code : "ROUTER_FUSION_UNAVAILABLE",
    }
  }
}
