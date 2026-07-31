export const REMOTE_EXECUTION_ERROR_CODES = [
  "REMOTE_FEATURE_UNSUPPORTED",
  "REMOTE_CONSENT_REQUIRED",
  "REMOTE_PROXY_DISCONNECTED",
  "REMOTE_RESPONSE_STALE",
  "REMOTE_SCOPE_DENIED",
] as const

export type RemoteExecutionErrorCode = (typeof REMOTE_EXECUTION_ERROR_CODES)[number]

export interface RemoteExecutionContext {
  hostId: string
  originDeviceId: string
  sessionId: string
  generation: number
  requestId: string
  issuedAt: number
  expiresAt: number
}

export function isRemoteExecutionContext(value: unknown): value is RemoteExecutionContext {
  if (!value || typeof value !== "object") return false
  const context = value as Partial<RemoteExecutionContext>
  return (
    typeof context.hostId === "string" &&
    typeof context.originDeviceId === "string" &&
    typeof context.sessionId === "string" &&
    typeof context.generation === "number" &&
    Number.isSafeInteger(context.generation) &&
    context.generation > 0 &&
    typeof context.requestId === "string" &&
    typeof context.issuedAt === "number" &&
    typeof context.expiresAt === "number" &&
    context.expiresAt >= context.issuedAt
  )
}
