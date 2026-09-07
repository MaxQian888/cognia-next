/**
 * Run-time capability preflight (ADR 0060 — L0).
 *
 * Before any step executes, the orchestrator checks every executable node's
 * capability requirements (`NodeCatalogEntry.requires`, with legacy
 * `desktopOnly` mapped via `effectiveRequires`) against what the local
 * runtime can do. A miss fails the run at t=0 with one structured,
 * recoverable failure (`capability-missing:<cap>`) instead of an
 * executor-internal throw halfway through a run with side effects.
 *
 * Deliberately NOT part of `validateWorkflow`: validation is
 * platform-agnostic and shared with the editor — a saved desktop workflow
 * must stay "valid" when opened on web. Capability is a property of *this
 * runner*, not of the definition. The preflight re-runs on resume by design:
 * a device resuming a run must also hold the required capabilities.
 */

import type { VisualWorkflow, WorkflowNodeKind } from "@/types/workflow/visual"
import { detectLocalCapabilities, type CapabilityId } from "@/lib/platform/capabilities"
import { missingCapabilities, nodeCatalogEntry } from "@/lib/workflow/nodes/catalog"

export interface CapabilityPreflightFailure {
  nodeId: string
  kind: WorkflowNodeKind
  missing: CapabilityId[]
}

/** Error-code prefix stamped on the run row; suffix = first missing capability. */
export const CAPABILITY_MISSING_CODE_PREFIX = "capability-missing:"

export interface CapabilityPreflightOptions {
  /**
   * When set, only these node ids are checked — mirrors the orchestrator's
   * `restrictToStepIds` bounding (single-node runs must not fail on
   * unrelated nodes elsewhere in the graph).
   */
  restrictToNodeIds?: ReadonlyArray<string>
  /**
   * Node ids whose outputs are pre-seeded (`seedOutputs`) — they cache-hit
   * instead of executing, so their requirements don't apply.
   */
  seededNodeIds?: ReadonlyArray<string>
  /**
   * Capabilities satisfiable via a paired device (ADR 0061 P3) — the union
   * of active `pairedDevices` rows' reported manifests. A requirement missing
   * locally but present here passes preflight; the hub-side proxy executor
   * owns the run-time "is a device actually reachable" failure.
   */
  remoteCapabilities?: ReadonlyArray<CapabilityId>
}

/**
 * Check every executable node (loop-container children included — they run
 * via the loop runtime; `annotation.*` excluded — no execution) against
 * `local`. Returns one failure per node with unmet requirements, in node
 * order. Empty array = clear to run.
 */
export function preflightCapabilities(
  workflow: Pick<VisualWorkflow, "nodes">,
  local: readonly CapabilityId[] = detectLocalCapabilities(),
  opts: CapabilityPreflightOptions = {}
): CapabilityPreflightFailure[] {
  const restrict = opts.restrictToNodeIds ? new Set(opts.restrictToNodeIds) : undefined
  const seeded = new Set(opts.seededNodeIds ?? [])
  const remote = new Set(opts.remoteCapabilities ?? [])
  const failures: CapabilityPreflightFailure[] = []
  for (const node of workflow.nodes) {
    if (node.type.startsWith("annotation.")) continue
    if (restrict && !restrict.has(node.id)) continue
    if (seeded.has(node.id)) continue
    const missing = missingCapabilities(nodeCatalogEntry(node.type), local).filter(
      (cap) => !remote.has(cap)
    )
    if (missing.length > 0) failures.push({ nodeId: node.id, kind: node.type, missing })
  }
  return failures
}

/**
 * Union of capability manifests reported by active paired devices — the
 * `remoteCapabilities` input for {@link preflightCapabilities}. Best-effort:
 * an unreadable registry yields the empty set (preflight then falls back to
 * strict local checking).
 */
export async function remoteCapabilityUnion(now: number = Date.now()): Promise<CapabilityId[]> {
  const union = new Set<CapabilityId>()
  try {
    const { listPairedDevices } = await import("@/lib/db/paired-devices")
    const { isPlaceable } = await import("@/lib/placement/liveness")
    const rows = await listPairedDevices()
    for (const row of rows) {
      if (row.revokedAt !== undefined || row.pausedAt !== undefined) continue
      // Preflight decides whether a run *can* start. Counting a device that
      // has been dark for days let a workflow pass the gate and then hang on
      // dispatch until it timed out — the check has to use the same liveness
      // rule the dispatcher will use, or it is answering a different question.
      if (!isPlaceable({ online: true, lastSeenAt: row.lastSeenAt ?? 0, source: "request" }, now)) {
        continue
      }
      for (const cap of row.capabilities ?? []) union.add(cap as CapabilityId)
    }
  } catch {
    // Dexie unavailable — fall through; the remote host below may still count.
  }
  try {
    // The host this client is *driving* (ADR-0082), which is not a paired
    // device and therefore invisible to the loop above. Without it a run
    // preflighted against a cloud server was judged by the desktop's own
    // baseline, so `always-on` / `headless` work the server could have run was
    // rejected before it started.
    const { activeHostCapabilities } = await import("@/stores/remote-host/remote-host-store")
    for (const cap of activeHostCapabilities()) union.add(cap as CapabilityId)
  } catch {
    // No remote-host store in this runtime (mobile, headless) — nothing to add.
  }
  if (!union.has("browser")) {
    for (const cap of await probeRemoteBrowserCapability()) union.add(cap)
  }
  return [...union]
}

/** Cached for the process: the runtime's compile-time answer does not change. */
let remoteBrowserProbe: Promise<CapabilityId[]> | null = null

/**
 * Ask whether an ADR-0085 remote browser runtime is actually reachable.
 *
 * `browser` is absent from the headless baseline, and that is correct as a
 * static fact: the remote runtime is gated four ways (an env flag off by
 * default, a compile feature, a user setting, and a health probe), so a brain
 * usually cannot browse. But when it *can*, a static baseline would reject a
 * browser node the host would have run perfectly well.
 *
 * `browser_runtime_status` is asked first for the same reason the preview pane
 * asks it first: it is the one RPC the gateway answers when the runtime is not
 * compiled, and every other one is refused with `browser_disabled`.
 */
async function probeRemoteBrowserCapability(): Promise<CapabilityId[]> {
  remoteBrowserProbe ??= (async (): Promise<CapabilityId[]> => {
    try {
      const { transport } = await import("@/lib/tauri")
      const status = await transport.call<{ compiled?: boolean; healthy?: boolean }>(
        "browser_runtime_status",
        {}
      )
      if (!status?.compiled || status.healthy === false) return []
      const readiness = await transport.call<{ capabilities?: string[] }>("browser_capability", {
        userEnabled: true,
      })
      return readiness?.capabilities?.includes("browser") ? ["browser"] : []
    } catch {
      // No gateway, no transport, or a refusal. Contributing nothing is the
      // honest answer, and preflight then fails at t=0 with a named capability
      // rather than letting the node throw mid-run.
      return []
    }
  })()
  return remoteBrowserProbe
}

/** Test-only: forget the cached probe. */
export function __resetRemoteBrowserProbeForTesting(): void {
  remoteBrowserProbe = null
}

/** One-line human summary used as the run failure message. */
export function formatPreflightFailures(failures: CapabilityPreflightFailure[]): string {
  const parts = failures.map((f) => `${f.nodeId} (${f.kind}): ${f.missing.join(", ")}`)
  return `Missing platform capabilities — ${parts.join("; ")}`
}
