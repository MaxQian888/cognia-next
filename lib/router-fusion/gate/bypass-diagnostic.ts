/**
 * The visible notice for an ordinary call Router + Fusion let through unledgered
 * (ADR-0188 D38).
 *
 * A chat turn that bypasses the ledger carries a "Not ledgered" badge on its
 * message. A background utility, an Agent completion or a workflow node has no
 * message to badge, so its bypass is raised as a `routerFusionBypassed`
 * diagnostic instead: the notification center files it (with the fault code and
 * the feature that called), and the structured log records it even where no UI
 * listens (the headless brain).
 *
 * Not spammy by construction. A fault that recurs is one incident, so a surface
 * raises the notice once per app session; every later bypass on that surface is
 * counted and logged with the session's running count. The breaker
 * (`breaker.ts`) still counts every fault, and trips the surface after the
 * threshold — that trip has its own toast (`RouterFusionInitializer`).
 *
 * Loaded statically by the gate, so it imports nothing from the rest of Router +
 * Fusion; the translator is loaded only when a notice is actually raised.
 */

import { createDiagnostic, type CogniaDiagnostic, type DiagnosticSource } from "@cognia/diagnostics"
import type { RouterFusionSurface } from "@cognia/router-fusion/settings/switches"

import { dispatchDiagnostic } from "@/lib/diagnostics/bus"

import type { RouterFusionInfrastructureError } from "./faults"

export type BypassTranslator = (key: string, values?: Record<string, unknown>) => string

export interface LedgerBypass {
  surface: RouterFusionSurface
  /** The feature whose call went out unledgered, e.g. `conversation-title`. */
  featureId: string
  fault: Pick<RouterFusionInfrastructureError, "code" | "message">
}

export interface LedgerBypassReporterDeps {
  dispatch?: (diagnostic: CogniaDiagnostic, origin: { kind: "background"; id: string }) => void
  translator?: () => Promise<BypassTranslator>
  now?: () => number
}

export interface LedgerBypassReporter {
  /** Record one bypass. Resolves once the notice (if any) has been raised. */
  report(bypass: LedgerBypass): Promise<void>
  /** Bypasses seen on a surface in this app session. */
  count(surface: RouterFusionSurface): number
}

const NAMESPACE = "routerFusion.bypass"

async function defaultTranslator(): Promise<BypassTranslator> {
  const { getRuntimeTranslator } = await import("@/lib/i18n/runtime-translator")
  return getRuntimeTranslator(NAMESPACE)
}

/** Where the notification center files the notice. */
function sourceOf(surface: RouterFusionSurface): DiagnosticSource {
  return surface === "agentsWorkflows" ? "workflow" : "provider"
}

function sentenceKey(surface: RouterFusionSurface): string {
  return surface === "utilityLedger" || surface === "agentsWorkflows" ? surface : "other"
}

export function createLedgerBypassReporter(
  deps: LedgerBypassReporterDeps = {}
): LedgerBypassReporter {
  const counts = new Map<RouterFusionSurface, number>()
  const announced = new Set<RouterFusionSurface>()

  return {
    count: (surface) => counts.get(surface) ?? 0,

    async report(bypass) {
      const count = (counts.get(bypass.surface) ?? 0) + 1
      counts.set(bypass.surface, count)
      if (announced.has(bypass.surface)) {
        // Already on screen for this session: count it, log it, stay quiet.
        console.warn(
          `[router-fusion] ${bypass.featureId} called on the original path, unledgered ` +
            `(${bypass.fault.code}; ${count} on ${bypass.surface} this session)`
        )
        return
      }
      announced.add(bypass.surface)

      const values = { feature: bypass.featureId, code: bypass.fault.code }
      let message = `${bypass.featureId}: ${bypass.fault.code}`
      try {
        const t = await (deps.translator ?? defaultTranslator)()
        const key = sentenceKey(bypass.surface)
        const sentence = t(key, values)
        // The runtime translator answers a missing key with the key's own path.
        if (sentence && sentence !== `${NAMESPACE}.${key}`) message = sentence
      } catch {
        // The feature and the fault code still tell a reader what happened.
      }
      const diagnostic = createDiagnostic("routerFusionBypassed", {
        source: sourceOf(bypass.surface),
        message,
        meta: {
          extra: {
            surface: bypass.surface,
            featureId: bypass.featureId,
            faultCode: bypass.fault.code,
            bypassCount: count,
          },
        },
        detail: [bypass.fault.code, bypass.fault.message].join("\n"),
        ...(deps.now ? { now: deps.now } : {}),
      })
      ;(deps.dispatch ?? dispatchDiagnostic)(
        diagnostic,
        // One dedupe scope per surface: a later session's notice bumps the same
        // notification row instead of adding one.
        { kind: "background", id: `router-fusion:${bypass.surface}` }
      )
    },
  }
}

const sessionReporter = createLedgerBypassReporter()

/**
 * Raise the notice for one bypassed call. Never throws: the call it describes
 * has already gone out, and a notice that failed must not become its error.
 */
export function reportLedgerBypass(bypass: LedgerBypass): void {
  void sessionReporter.report(bypass).catch((error: unknown) => {
    console.error("[router-fusion] the unledgered-call notice could not be raised", error)
  })
}
