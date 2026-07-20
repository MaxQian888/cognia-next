/**
 * OAuth granted-scope tracking for platform connectors (ADR-0009).
 *
 * Slack/Lark OAuth handlers receive a granted `scope` string on every code
 * exchange but historically dropped it. We normalize + persist it onto the
 * adapter (`settings.connectedScopes`) so the Connections detail can show
 * exactly what the connector was granted, and — on a re-authorization whose
 * scope set differs from the prior grant — write one `oauth.scope_changed`
 * audit row so a silent scope escalation is visible after the fact. The OAuth
 * completion is a non-interactive deep-link callback, so a blocking prompt
 * isn't possible; the audit trail is the surface.
 */

import { append } from "@/lib/db/connector-audit"

export interface ConnectedScopes {
  /** Normalized, de-duplicated, sorted scope list. */
  scopes: string[]
  /** Wall-clock ms the scopes were granted. */
  grantedAtMs: number
}

/** Split a raw OAuth scope string (space- or comma-separated) into a normalized set. */
export function parseScopeString(raw: string | null | undefined): string[] {
  if (!raw) return []
  return Array.from(
    new Set(
      raw
        .split(/[\s,]+/)
        .map((s) => s.trim())
        .filter(Boolean)
    )
  ).sort()
}

export function diffScopes(
  previous: readonly string[],
  next: readonly string[]
): { added: string[]; removed: string[] } {
  const prev = new Set(previous)
  const now = new Set(next)
  return {
    added: next.filter((s) => !prev.has(s)),
    removed: previous.filter((s) => !now.has(s)),
  }
}

export interface RecordGrantedScopesInput {
  adapterId: string
  /** Raw scope string from the OAuth token response. */
  raw: string | null | undefined
  /** The adapter's previously-stored scopes, if any. */
  previous?: ConnectedScopes
  /** Wall-clock ms (injectable for tests). */
  now: number
}

export interface RecordGrantedScopesResult {
  connectedScopes: ConnectedScopes
  changed: boolean
  added: string[]
  removed: string[]
}

/**
 * Normalize the freshly-granted scopes and, when they differ from a prior
 * grant, append an `oauth.scope_changed` audit row. Returns the value the
 * caller should stamp onto `adapter.settings.connectedScopes`. The first grant
 * (no `previous`) is stored without an audit row — there is nothing to diff.
 */
export async function recordGrantedScopes(
  input: RecordGrantedScopesInput
): Promise<RecordGrantedScopesResult> {
  const scopes = parseScopeString(input.raw)
  const previousScopes = input.previous?.scopes ?? []
  const { added, removed } = diffScopes(previousScopes, scopes)
  const changed = input.previous !== undefined && (added.length > 0 || removed.length > 0)

  if (changed) {
    await append({
      adapterId: input.adapterId,
      kind: "oauth.scope_changed",
      at: input.now,
      fields: { added, removed, scopes },
    })
  }

  return {
    connectedScopes: { scopes, grantedAtMs: input.now },
    changed,
    added,
    removed,
  }
}
