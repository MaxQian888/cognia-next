/**
 * What actually ran, as the Host reports it (ADR-0182).
 *
 * A placement says what the brain *asked for*. This is the other half: the
 * Host answers on `external-agent://placement` with the tier it could really
 * attest, the user the image really runs as, the digests it really pulled —
 * and, when the run fell back, the `sandbox_fallback_*` reason.
 *
 * # Why the answer is not the request
 *
 * Three of these differ from what was asked on purpose:
 *
 * - **tier** — a project asks for a floor; the driver attests what it has. A
 *   run that asked for `container` on a daemon with `runsc` registered can be
 *   given gVisor, and the UI must say which it got.
 * - **user** — `remoteUser` is remapped onto the workspace owner, and an
 *   image that declares none gets the tier default. Neither is visible in the
 *   spec.
 * - **egressEnforced / credentialsMode** — Step ① enforces egress only on the
 *   `off` tier, and the Host says so rather than letting a UI infer
 *   enforcement from a policy that is only recorded.
 *
 * So a UI that rendered the request would be lying about all three. Every
 * surface reads this report instead.
 *
 * # The wire shape
 *
 * `{agentId, placement}` — see `SandboxPlacementEvent`. This module flattens
 * it into one record per agent so a surface never walks the nesting, and so
 * a field a Host did not send is `undefined` rather than a guess.
 */

import type { EgressTier, IsolationTier } from "@/types/sandbox/environment-spec"
import { SANDBOX_PLACEMENT_CHANNEL } from "@/types/sandbox/environment-spec"

const ISOLATION_TIERS: readonly IsolationTier[] = ["container", "gvisor", "vm"]
const EGRESS_TIERS: readonly EgressTier[] = ["off", "allowlist", "on"]

/** One agent's placement as the Host reported it. */
export interface SandboxPlacementReport {
  agentId: string
  /**
   * `sandbox` when it ran in one, `fallback` when the placement was stripped,
   * `unknown` for a kind this build does not recognize.
   */
  kind: "sandbox" | "fallback" | "unknown"
  /** The `sandbox_fallback_*` reason, on a fallback. */
  code?: string
  message?: string
  driver?: string
  specDigest?: string
  /** The canonical pinned reference the sandbox ran, `registry/repository@sha256:…`. */
  image?: string
  /** The `sha256:…` part of `image`. */
  imageDigest?: string
  sizeClassId?: string
  tier?: IsolationTier
  bundleDigest?: string
  bundleReleaseTag?: string
  libc?: string
  user?: string
  uid?: number
  /** True when a declared user was remapped onto the workspace owner. */
  userRemapped?: boolean
  egressTier?: EgressTier
  /**
   * Whether egress is actually enforced for this sandbox. `false` through
   * Step ① on every tier but `off` — the enforcing proxy arrives with
   * ADR-0185, and a UI that showed "allowlist" as enforcement would be
   * claiming a control nothing applies yet.
   */
  egressEnforced?: boolean
  /**
   * How the sandbox got its provider credentials. Ambient provider keys are
   * stripped before the container sees them, so this is `gateway-lease` when
   * a managed gateway task's per-task lease rode in and `none` otherwise.
   * Per-sandbox gateway tickets for ordinary spawns are ADR-0185.
   */
  credentialsMode?: string
}

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined

const object = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {}

const oneOf = <T extends string>(allowed: readonly T[], value: unknown): T | undefined =>
  typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : undefined

/**
 * Read a placement event into a report.
 *
 * Tolerant by construction: the event comes from a Host that may be newer or
 * older than this client, and a field it does not send is absent rather than
 * wrong. `kind` falls back to `"unknown"` for the same reason — a client that
 * guessed "sandbox" for an unrecognized kind would claim a sandbox ran.
 */
export function readPlacementEvent(payload: unknown): SandboxPlacementReport | null {
  const event = object(payload)
  const agentId = text(event.agentId)
  if (!agentId) return null
  const placement = object(event.placement)
  const kind =
    placement.kind === "sandbox" || placement.kind === "fallback"
      ? placement.kind
      : ("unknown" as const)

  const report: SandboxPlacementReport = { agentId, kind }
  const set = <K extends keyof SandboxPlacementReport>(
    key: K,
    value: SandboxPlacementReport[K] | undefined
  ) => {
    if (value !== undefined) report[key] = value
  }

  if (kind === "fallback") {
    set("code", text(placement.code))
    set("message", text(placement.message))
    return report
  }
  if (kind !== "sandbox") return report

  const image = text(placement.image)
  set("driver", text(placement.driver))
  set("specDigest", text(placement.specDigest))
  set("image", image)
  set("imageDigest", image?.includes("@") ? image.slice(image.lastIndexOf("@") + 1) : undefined)
  set("sizeClassId", text(placement.sizeClassId))
  set("tier", oneOf(ISOLATION_TIERS, placement.isolationTier))

  const bundle = object(placement.bundle)
  set("bundleDigest", text(bundle.digest))
  set("bundleReleaseTag", text(bundle.releaseTag))
  set("libc", text(bundle.libc))

  const user = object(placement.user)
  set("user", text(user.name))
  set("uid", typeof user.uid === "number" ? user.uid : undefined)
  if ("remappedFrom" in user) {
    set("userRemapped", user.remappedFrom !== null && user.remappedFrom !== undefined)
  }

  // `enforced: false` is a claim, and a missing field is a Host that did not
  // say. Collapsing them would let a UI print "not enforced" about a Host
  // that never answered the question.
  const egress = object(placement.egress)
  set("egressTier", oneOf(EGRESS_TIERS, egress.tier))
  set("egressEnforced", typeof egress.enforced === "boolean" ? egress.enforced : undefined)

  set("credentialsMode", text(object(placement.credentials).mode))
  return report
}

/**
 * The last report per agent id.
 *
 * Module-scoped and last-write-wins: a reconnect re-places the agent and the
 * newer answer is the true one. Bounded by the number of live agents, and an
 * entry is dropped when its agent exits.
 */
const reports = new Map<string, SandboxPlacementReport>()
const listeners = new Set<(report: SandboxPlacementReport) => void>()

export function recordPlacementReport(report: SandboxPlacementReport): void {
  reports.set(report.agentId, report)
  for (const listener of listeners) listener(report)
}

export function sandboxPlacementReport(agentId: string): SandboxPlacementReport | undefined {
  return reports.get(agentId)
}

export function forgetPlacementReport(agentId: string): void {
  reports.delete(agentId)
}

/** Subscribe to reports as they arrive. Returns an unsubscribe. */
export function onSandboxPlacementReport(
  listener: (report: SandboxPlacementReport) => void
): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function __resetPlacementReportsForTests(): void {
  reports.clear()
  listeners.clear()
}

/**
 * Start recording what the Host reports.
 *
 * Takes the listen function rather than importing one so the caller decides
 * which host it is talking to — the same reason `agent-transport.ts` exists —
 * and so this module stays free of Tauri and transport imports.
 */
export async function subscribeSandboxPlacements(
  listen: (channel: string, handler: (payload: unknown) => void) => Promise<() => void>
): Promise<() => void> {
  return listen(SANDBOX_PLACEMENT_CHANNEL, (payload) => {
    const report = readPlacementEvent(payload)
    if (report) recordPlacementReport(report)
  })
}
