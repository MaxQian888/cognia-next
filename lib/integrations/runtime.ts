import { createDiagnostic } from "@cognia/diagnostics"
import { pruneIntegrationRetention } from "@/lib/db/integrations"
import { dispatchDiagnostic } from "@/lib/diagnostics/bus"
import { drainIntegrationActionJobs } from "./action-runner"
import { installIntegrationIngressRuntime } from "./ingress-client"
import { registerGithubIntegrationAuthProviders } from "./github-auth"
import { reconcileGithubAppDeliveries } from "./github-delivery-recovery"
import { recoverIntegrationEventProjections } from "./events"

const ACTION_DRAIN_INTERVAL_MS = 30_000
const RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1000
const GITHUB_RECONCILIATION_INTERVAL_MS = 15 * 60 * 1000
const PROJECTION_RECOVERY_INTERVAL_MS = 30_000

function reportRecurringFailure(
  stage:
    | "action-drain"
    | "retention-prune"
    | "github-delivery-reconciliation"
    | "ingress-install"
    | "projection-recovery",
  error: unknown
): void {
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
  const disposeGithubAuth = registerGithubIntegrationAuthProviders()
  await Promise.all([
    drainIntegrationActionJobs().catch((error) => reportRecurringFailure("action-drain", error)),
    pruneIntegrationRetention().catch((error) => reportRecurringFailure("retention-prune", error)),
    reconcileGithubAppDeliveries().catch((error) =>
      reportRecurringFailure("github-delivery-reconciliation", error)
    ),
  ])
  const disposeIngress = await installIntegrationIngressRuntime().catch((error) => {
    reportRecurringFailure("ingress-install", error)
    return () => undefined
  })
  // After ingress is installed, so the plugins that own the events have had
  // their chance to register; an event whose projections a crash or a throwing
  // consumer left unfinished is picked up here rather than lost.
  await recoverIntegrationEventProjections().catch((error) =>
    reportRecurringFailure("projection-recovery", error)
  )
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
  const githubReconciliationTimer = globalThis.setInterval(() => {
    void reconcileGithubAppDeliveries().catch((error) =>
      reportRecurringFailure("github-delivery-reconciliation", error)
    )
  }, GITHUB_RECONCILIATION_INTERVAL_MS)

  const projectionRecoveryTimer = globalThis.setInterval(() => {
    void recoverIntegrationEventProjections().catch((error) =>
      reportRecurringFailure("projection-recovery", error)
    )
  }, PROJECTION_RECOVERY_INTERVAL_MS)

  return () => {
    globalThis.clearInterval(projectionRecoveryTimer)
    globalThis.clearInterval(drainTimer)
    globalThis.clearInterval(retentionTimer)
    globalThis.clearInterval(githubReconciliationTimer)
    disposeIngress()
    disposeGithubAuth()
  }
}
