import { createDiagnostic } from "@cognia/diagnostics"
import { pruneIntegrationRetention } from "@/lib/db/integrations"
import { dispatchDiagnostic } from "@/lib/diagnostics/bus"
import { drainIntegrationActionJobs } from "./action-runner"
import { installIntegrationIngressRuntime } from "./ingress-client"

const ACTION_DRAIN_INTERVAL_MS = 30_000
const RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1000

function reportRecurringFailure(stage: "action-drain" | "retention-prune", error: unknown): void {
  dispatchDiagnostic(
    createDiagnostic("serverError", {
      source: "connector",
      message: error instanceof Error ? error.message : String(error),
      meta: { extra: { stage } },
    }),
    { kind: "background" }
  )
}

export async function startIntegrationRuntime(): Promise<() => void> {
  await Promise.all([drainIntegrationActionJobs(), pruneIntegrationRetention()])
  const disposeIngress = await installIntegrationIngressRuntime()
  const drainTimer = globalThis.setInterval(() => {
    void drainIntegrationActionJobs().catch((error) =>
      reportRecurringFailure("action-drain", error)
    )
  }, ACTION_DRAIN_INTERVAL_MS)
  const retentionTimer = globalThis.setInterval(() => {
    void pruneIntegrationRetention().catch((error) =>
      reportRecurringFailure("retention-prune", error)
    )
  }, RETENTION_INTERVAL_MS)

  return () => {
    globalThis.clearInterval(drainTimer)
    globalThis.clearInterval(retentionTimer)
    disposeIngress()
  }
}
