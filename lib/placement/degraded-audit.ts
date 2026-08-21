"use client"

/**
 * Record that placement did not go where it was configured to go.
 *
 * Degrading silently is the failure this exists to prevent. When the configured
 * execution authority is unreachable the work still runs — locally — and that
 * divergence has to be visible somewhere a human looks, or the first anyone
 * learns of it is a duplicated side effect or a run nobody can explain.
 *
 * Two existing authorities carry it; neither is a new store. The notification
 * center is where the user finds it, and the workflow run event log is where an
 * investigation finds it attached to the run it affected.
 */

export type PlacementDegradeReason =
  /** The configured execution authority did not answer within its window. */
  | "authority_unreachable"
  /** The configured authority is a host this machine has never seen. */
  | "authority_unknown"

export interface PlacementDegradedEvent {
  reason: PlacementDegradeReason
  /** The authority that was configured and could not be used. */
  authorityHostId: string
  /** How long it had been unreachable, when known. */
  unreachableForMs?: number
  /** The run this affected, when the degrade happened inside one. */
  runId?: string
  at: number
}

export interface DegradedAuditDeps {
  notify?: (input: {
    source: "system"
    level: "warning"
    title: string
    body: string
    dedupeKey: string
    directed: true
  }) => Promise<unknown>
  appendRunEvent?: (runId: string, event: Record<string, unknown>) => Promise<unknown>
}

function describe(event: PlacementDegradedEvent): { title: string; body: string } {
  const suffix =
    event.reason === "authority_unknown"
      ? "this machine has never connected to it"
      : `it has not answered for ${Math.round((event.unreachableForMs ?? 0) / 60_000)} min`
  return {
    title: "Scheduled work ran here instead of the execution authority",
    body: `The configured authority host (${event.authorityHostId}) could not be used — ${suffix}. Work is running on this machine until it comes back.`,
  }
}

/**
 * Emit the degrade on both surfaces. Never throws: an audit failure must not be
 * the reason the work that was already degraded also fails.
 */
export async function recordPlacementDegraded(
  event: PlacementDegradedEvent,
  deps: DegradedAuditDeps = {}
): Promise<void> {
  const { title, body } = describe(event)

  const notify =
    deps.notify ??
    (async (input: Parameters<NonNullable<DegradedAuditDeps["notify"]>>[0]) => {
      const runtime = await import("@/lib/notifications/runtime")
      return runtime.notify(input)
    })

  try {
    await notify({
      source: "system",
      level: "warning",
      title,
      body,
      // One notice per authority per degrade episode, not one per cron tick —
      // an authority that is down for a day would otherwise bury the center.
      dedupeKey: `placement.degraded:${event.authorityHostId}:${event.reason}`,
      directed: true,
    })
  } catch {
    // Best-effort by contract.
  }

  if (!event.runId || !deps.appendRunEvent) return
  try {
    await deps.appendRunEvent(event.runId, {
      type: "placement.degraded",
      reason: event.reason,
      authorityHostId: event.authorityHostId,
      ...(event.unreachableForMs !== undefined ? { unreachableForMs: event.unreachableForMs } : {}),
      at: event.at,
    })
  } catch {
    // Same: the run already degraded; failing it over the audit is worse.
  }
}
