import type { SiteAuthoringPolicy } from "@/types/sites"

export type SiteAuthoringCapability = "view" | "edit" | "deploy" | "manage"

export function canAuthorSite(
  policy: SiteAuthoringPolicy,
  accountId: string,
  capability: SiteAuthoringCapability
): boolean {
  if (policy.ownerAccountId === accountId) return true
  if (capability === "view") {
    return (
      policy.editorAccountIds.includes(accountId) || policy.deployerAccountIds.includes(accountId)
    )
  }
  if (capability === "edit") return policy.editorAccountIds.includes(accountId)
  if (capability === "deploy") return policy.deployerAccountIds.includes(accountId)
  return false
}

export function assertSiteAuthoringCapability(
  policy: SiteAuthoringPolicy,
  accountId: string,
  capability: SiteAuthoringCapability
): void {
  if (!canAuthorSite(policy, accountId, capability)) {
    throw new Error(`Site authoring policy denies ${capability} access`)
  }
}
