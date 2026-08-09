import { createDiagnostic } from "@cognia/diagnostics"
import { pruneIntegrationRetention } from "@/lib/db/integrations"
import { dispatchDiagnostic } from "@/lib/diagnostics/bus"
import { drainIntegrationActionJobs } from "./action-runner"
import { installIntegrationIngressRuntime } from "./ingress-client"
import { registerGithubIntegrationAuthProviders } from "./github-auth"
import { reconcileGithubAppDeliveries } from "./github-delivery-recovery"

const ACTION_DRAIN_INTERVAL_MS = 30_000
const RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1000
const GITHUB_RECONCILIATION_INTERVAL_MS = 15 * 60 * 1000

function reportRecurringFailure(
  stage: "action-drain" | "retention-prune" | "github-delivery-reconciliation" | "ingress-install",
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

  return () => {
    globalThis.clearInterval(drainTimer)
    globalThis.clearInterval(retentionTimer)
    globalThis.clearInterval(githubReconciliationTimer)
    disposeIngress()
    disposeGithubAuth()
  }
}
