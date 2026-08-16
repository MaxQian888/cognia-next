export type PluginRealmId = "global" | `project:${string}` | `session:${string}`

export interface PluginRealmContext {
  realmId: PluginRealmId
  /** Required to include a project parent in a session lookup chain. */
  projectId?: string
}

export interface PluginPolicyOverlay {
  permissions: string[]
  networkAllowlist: string[]
  quotas: Record<string, number>
  consent: string[]
  configKeys: string[]
  secretKeys: string[]
}

export function validatePluginRealmId(realmId: string): PluginRealmId {
  if (
    realmId === "global" ||
    (/^(project|session):[^:\s]+$/.test(realmId) &&
      (realmId.startsWith("project:") || realmId.startsWith("session:")))
  ) {
    return realmId as PluginRealmId
  }
  throw new Error(`Unsupported plugin realm: ${realmId}`)
}

export function realmLookupOrder(context: PluginRealmContext): PluginRealmId[] {
  const realmId = validatePluginRealmId(context.realmId)
  if (realmId === "global") return ["global"]
  if (realmId.startsWith("project:")) return [realmId, "global"]
  return [
    realmId,
    ...(context.projectId
      ? ([validatePluginRealmId(`project:${context.projectId}`)] as PluginRealmId[])
      : []),
    "global",
  ]
}

function intersectValues(parent: readonly string[], child: readonly string[]): string[] {
  const allowed = new Set(parent)
  return child.filter((value) => allowed.has(value))
}

export function intersectPluginPolicyOverlay(
  parent: PluginPolicyOverlay,
  child: PluginPolicyOverlay
): PluginPolicyOverlay {
  const quotaKeys = new Set([...Object.keys(parent.quotas), ...Object.keys(child.quotas)])
  const quotas = Object.fromEntries(
    Array.from(quotaKeys, (key) => [
      key,
      Math.min(
        parent.quotas[key] ?? Number.POSITIVE_INFINITY,
        child.quotas[key] ?? Number.POSITIVE_INFINITY
      ),
    ]).filter(([, value]) => Number.isFinite(value as number))
  ) as Record<string, number>
  return {
    permissions: intersectValues(parent.permissions, child.permissions),
    networkAllowlist: intersectValues(parent.networkAllowlist, child.networkAllowlist),
    quotas,
    consent: intersectValues(parent.consent, child.consent),
    configKeys: intersectValues(parent.configKeys, child.configKeys),
    secretKeys: intersectValues(parent.secretKeys, child.secretKeys),
  }
}
