export type ConnectorVerificationState = "verified" | "pending"

export interface ConnectorPreflightResult {
  verification: ConnectorVerificationState
  missingOptionalScopes: string[]
}

/**
 * Validate a candidate connection before its durable row or credentials are
 * replaced. Probe-capable platforms must prove the candidate first; reverse
 * connections remain pending until a real handshake updates Health/readiness.
 */
export async function preflightConnectorConfig(input: {
  requiredScopes?: readonly string[]
  optionalScopes?: readonly string[]
  grantedScopes?: readonly string[]
  probe?: () => Promise<{ ok: boolean; error?: string }>
}): Promise<ConnectorPreflightResult> {
  const granted = new Set(input.grantedScopes ?? [])
  const missingRequired = (input.requiredScopes ?? []).filter((scope) => !granted.has(scope))
  if (input.grantedScopes && missingRequired.length > 0) {
    throw new Error(`Missing required connector scopes: ${missingRequired.join(", ")}`)
  }
  const missingOptionalScopes = input.grantedScopes
    ? (input.optionalScopes ?? []).filter((scope) => !granted.has(scope))
    : []
  if (!input.probe) return { verification: "pending", missingOptionalScopes }
  const result = await input.probe()
  if (!result.ok) throw new Error(result.error ?? "Connector credential verification failed")
  return { verification: "verified", missingOptionalScopes }
}
