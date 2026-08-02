/**
 * Versioned session manifest — the index record beside the append-only event
 * log.
 *
 * The LOG is the authority for content; the manifest is a derived header that
 * makes `list` / `--continue` / `tree` answerable without replaying every
 * session's events. Anything the log cannot cheaply answer (workspace, runtime
 * binding, execution fingerprint, lineage, legacy-import provenance) lives here
 * and only here.
 *
 * A manifest that fails validation is NEVER silently repaired: the store
 * surfaces it as an unreadable session, because a manifest that disagrees with
 * its log is exactly the case where guessing loses user data.
 */

import type { SessionFidelity } from "@cognia/agent-config-types/canonical-session"
import type { AgentRunUsage } from "@cognia/agent-config-types/agent-run-result"

export const MANIFEST_VERSION = 1

export type SessionForkKind = "fork" | "clone"

export interface SessionLineage {
  parentSessionId: string
  /** The turn the fork was taken AT. Absent for a `clone` (head fork). */
  parentTurnId?: string
  kind: SessionForkKind
}

/** Runtime handle for native resume. A BINDING, never authority over content. */
export interface SessionRuntimeBinding {
  /** Selected backend id (`builtin` or a registered external preset id). */
  backend: string
  /** The runtime's own session id, when it exposes one. */
  nativeSessionId?: string
  model?: string
  provider?: string
  runtimeAdapter?: string
}

export interface SessionLegacyImport {
  /** Absolute path of the flat JSONL the canonical store was seeded from. */
  sourcePath: string
  /** Lines that failed to parse. Reported in the loss report, never swallowed. */
  invalidLines: number
  fidelity: SessionFidelity
  importedAt: string
}

export interface SessionManifest {
  manifestVersion: 1
  sessionId: string
  name?: string
  createdAt: string
  updatedAt: string
  /** Canonical workspace key (see `workspaceKey`) `--continue` matches on. */
  workspace: string
  runtimeBinding?: SessionRuntimeBinding
  /** Fingerprint of the frozen execution spec that produced the latest turns. */
  executionFingerprint?: string
  /** Assembled-context version, so a resume can detect a stale context build. */
  contextVersion?: string
  turnCount: number
  /** Digest over the canonical turn sequence (fork detection). */
  sequenceDigest: string
  /** Cumulative usage across every turn. */
  usage?: AgentRunUsage
  lineage?: SessionLineage
  legacy?: SessionLegacyImport
  /** Cheap `getLastAssistantText` without replaying the log. */
  lastAssistantText?: string
  /** Number of envelopes in `events.jsonl` when the manifest was last written. */
  eventCount: number
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0
}

/** Validate a manifest. Returns violations (empty = valid). */
export function validateManifest(value: unknown): string[] {
  const errors: string[] = []
  if (!isRecord(value)) return ["manifest must be an object"]
  if (value.manifestVersion !== MANIFEST_VERSION) {
    errors.push(`manifestVersion must be ${MANIFEST_VERSION}`)
  }
  for (const key of [
    "sessionId",
    "createdAt",
    "updatedAt",
    "workspace",
    "sequenceDigest",
  ] as const) {
    if (!isNonEmptyString(value[key])) errors.push(`${key} must be a non-empty string`)
  }
  for (const key of ["turnCount", "eventCount"] as const) {
    const n = value[key]
    if (typeof n !== "number" || !Number.isInteger(n) || n < 0) {
      errors.push(`${key} must be a non-negative integer`)
    }
  }
  if (value.lineage !== undefined) {
    const lineage = value.lineage
    if (
      !isRecord(lineage) ||
      !isNonEmptyString(lineage.parentSessionId) ||
      (lineage.kind !== "fork" && lineage.kind !== "clone")
    ) {
      errors.push("lineage must carry parentSessionId and kind fork|clone")
    }
  }
  if (value.runtimeBinding !== undefined) {
    const binding = value.runtimeBinding
    if (!isRecord(binding) || !isNonEmptyString(binding.backend)) {
      errors.push("runtimeBinding.backend must be a non-empty string")
    }
  }
  return errors
}

export function isSessionManifest(value: unknown): value is SessionManifest {
  return validateManifest(value).length === 0
}

/** Parse a manifest file body. Returns null when missing, malformed or invalid. */
export function parseManifest(raw: string | null): SessionManifest | null {
  if (raw === null) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  return isSessionManifest(parsed) ? parsed : null
}

export function serializeManifest(manifest: SessionManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`
}

/** Build a fresh manifest for a brand-new session. */
export function createManifest(params: {
  sessionId: string
  workspace: string
  at: string
  name?: string
  lineage?: SessionLineage
  runtimeBinding?: SessionRuntimeBinding
  legacy?: SessionLegacyImport
  sequenceDigest: string
  turnCount?: number
  eventCount?: number
}): SessionManifest {
  return {
    manifestVersion: MANIFEST_VERSION,
    sessionId: params.sessionId,
    ...(params.name ? { name: params.name } : {}),
    createdAt: params.at,
    updatedAt: params.at,
    workspace: params.workspace,
    ...(params.runtimeBinding ? { runtimeBinding: params.runtimeBinding } : {}),
    ...(params.lineage ? { lineage: params.lineage } : {}),
    ...(params.legacy ? { legacy: params.legacy } : {}),
    turnCount: params.turnCount ?? 0,
    sequenceDigest: params.sequenceDigest,
    eventCount: params.eventCount ?? 0,
  }
}

/** Merge cumulative token/cost usage. Absent counters on either side are kept. */
export function mergeUsage(
  base: AgentRunUsage | undefined,
  next: AgentRunUsage | undefined
): AgentRunUsage | undefined {
  if (!base) return next
  if (!next) return base
  const keys = [
    "inputTokens",
    "outputTokens",
    "cacheReadTokens",
    "cacheCreationTokens",
    "costUsd",
  ] as const
  const out: AgentRunUsage = {}
  for (const key of keys) {
    const a = base[key]
    const b = next[key]
    if (a === undefined && b === undefined) continue
    out[key] = (a ?? 0) + (b ?? 0)
  }
  return out
}
