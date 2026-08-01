import type { ObservabilityEventV1 } from "./observability-event"

export interface ClientPrivacyManifest {
  version: string
  blockedContentKeys: readonly string[]
  secretKeys: readonly string[]
  replacement: string
}

export const CLIENT_PRIVACY_MANIFEST_V1: ClientPrivacyManifest = {
  version: "privacy-v1-2026-08-01",
  blockedContentKeys: [
    "prompt",
    "prompts",
    "messages",
    "messageContent",
    "input",
    "output",
    "toolInput",
    "toolOutput",
    "fileBody",
    "fileContent",
    "requestBody",
    "responseBody",
  ],
  secretKeys: [
    "password",
    "passwd",
    "token",
    "accessToken",
    "refreshToken",
    "secret",
    "apiKey",
    "authorization",
    "cookie",
    "clientSecret",
    "privateKey",
  ],
  replacement: "[REDACTED]",
}

export interface LocalDebugCaptureSession {
  id: string
  startedAt: string
  expiresAt: string
  remoteAllowed: false
}

export interface PrivacyApplicationOptions {
  manifest?: ClientPrivacyManifest
  debugSession?: LocalDebugCaptureSession
  now?: Date
}

export type HighConfidenceCredentialKind =
  "aws-access-key" | "jwt" | "private-key" | "provider-secret"

export interface HighConfidenceCredentialFinding {
  kind: HighConfidenceCredentialKind
  occurrences: number
}

export interface CredentialScanResult {
  reject: boolean
  findings: HighConfidenceCredentialFinding[]
}

const CREDENTIAL_PATTERNS: ReadonlyArray<{
  kind: HighConfidenceCredentialKind
  pattern: RegExp
}> = [
  { kind: "aws-access-key", pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  {
    kind: "jwt",
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  },
  { kind: "private-key", pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g },
  { kind: "provider-secret", pattern: /\b(?:sk|rk)-[A-Za-z0-9_-]{24,}\b/g },
]

const TEXT_REDACTIONS: ReadonlyArray<{ pattern: RegExp; replacement: string }> = [
  { pattern: /Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, replacement: "[REDACTED]" },
  {
    pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
    replacement: "[REDACTED_EMAIL]",
  },
  {
    pattern: /(?:[A-Za-z]:\\|\/(?:Users|home|var|tmp|private|opt|etc)\/)[^\s"']+/g,
    replacement: "[REDACTED_PATH]",
  },
]

function normalizeKey(key: string): string {
  return key.replace(/[-_\s]/g, "").toLowerCase()
}

function keySet(keys: readonly string[]): Set<string> {
  return new Set(keys.map(normalizeKey))
}

function redactText(value: string): string {
  return TEXT_REDACTIONS.reduce(
    (current, rule) => current.replace(rule.pattern, rule.replacement),
    value
  )
}

function sanitizeValue(
  value: unknown,
  path: string,
  allowContent: boolean,
  blockedKeys: ReadonlySet<string>,
  secretKeys: ReadonlySet<string>,
  removedFields: Set<string>,
  keyHint?: string
): unknown {
  const normalizedKey = keyHint ? normalizeKey(keyHint) : undefined
  if (normalizedKey && blockedKeys.has(normalizedKey) && !allowContent) {
    removedFields.add(path)
    return undefined
  }

  if (normalizedKey && secretKeys.has(normalizedKey)) {
    return CLIENT_PRIVACY_MANIFEST_V1.replacement
  }

  if (typeof value === "string") {
    return redactText(value)
  }
  if (value === null || value === undefined || typeof value !== "object") {
    return value
  }
  if (Array.isArray(value)) {
    return value.map((item, index) =>
      sanitizeValue(item, `${path}[${index}]`, allowContent, blockedKeys, secretKeys, removedFields)
    )
  }

  const result: Record<string, unknown> = {}
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    const nestedPath = `${path}.${key}`
    const sanitized = sanitizeValue(
      nested,
      nestedPath,
      allowContent,
      blockedKeys,
      secretKeys,
      removedFields,
      key
    )
    if (sanitized !== undefined) {
      result[key] = sanitized
    }
  }
  return result
}

function isDebugSessionActive(session: LocalDebugCaptureSession | undefined, now: Date): boolean {
  if (!session || session.remoteAllowed !== false) {
    return false
  }
  const expiry = Date.parse(session.expiresAt)
  return Number.isFinite(expiry) && now.getTime() < expiry
}

export function createLocalDebugCaptureSession(now = new Date()): LocalDebugCaptureSession {
  const startedAt = now.getTime()
  const id =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `debug-${startedAt.toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  return {
    id,
    startedAt: new Date(startedAt).toISOString(),
    expiresAt: new Date(startedAt + 30 * 60_000).toISOString(),
    remoteAllowed: false,
  }
}

export function applyObservabilityPrivacy(
  event: ObservabilityEventV1,
  options: PrivacyApplicationOptions = {}
): ObservabilityEventV1 {
  const manifest = options.manifest ?? CLIENT_PRIVACY_MANIFEST_V1
  const now = options.now ?? new Date()
  const allowContent = isDebugSessionActive(options.debugSession, now)
  const removedFields = new Set(event.privacy.removedFields)
  const sanitizedPayload = sanitizeValue(
    event.payload,
    "payload",
    allowContent,
    keySet(manifest.blockedContentKeys),
    keySet(manifest.secretKeys),
    removedFields
  ) as ObservabilityEventV1["payload"]

  return {
    ...event,
    payload: sanitizedPayload,
    privacy: {
      redactionVersion: manifest.version,
      capturePolicy: allowContent ? "debug-session" : "metadata-only",
      contentCaptured: allowContent,
      removedFields: [...removedFields].sort(),
    },
  }
}

export function scanHighConfidenceCredentials(input: string | Uint8Array): CredentialScanResult {
  const text = typeof input === "string" ? input : new TextDecoder().decode(input)
  const findings = CREDENTIAL_PATTERNS.flatMap(({ kind, pattern }) => {
    pattern.lastIndex = 0
    const occurrences = [...text.matchAll(pattern)].length
    return occurrences > 0 ? [{ kind, occurrences }] : []
  }).sort((left, right) => left.kind.localeCompare(right.kind))

  return { reject: findings.length > 0, findings }
}
