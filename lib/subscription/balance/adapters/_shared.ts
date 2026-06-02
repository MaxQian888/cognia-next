// Shared helpers for balance adapters. Pure — no I/O.

import type { BalanceSnapshot, BalanceQuery } from "@/types/subscription"

/** Bearer auth header every documented balance API uses. */
export function bearer(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, Accept: "application/json" }
}

/** Trim a trailing slash so `${baseUrl}/path` never doubles up. */
export function trimBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "")
}

/** Coerce a string|number field to a finite number, else `undefined`. */
export function toNum(v: unknown): number | undefined {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined
  if (typeof v === "string") {
    const n = Number(v.trim())
    return Number.isFinite(n) ? n : undefined
  }
  return undefined
}

/** Parse a JSON body into a record, or `null` when it isn't a JSON object. */
export function parseJsonObject(body: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(body)
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
    return null
  } catch {
    return null
  }
}

/** Build an error snapshot (non-2xx, unparsable body, or missing fields). */
export function errorSnapshot(
  q: BalanceQuery,
  kind: BalanceSnapshot["kind"],
  message: string,
  raw: Record<string, unknown> = {}
): BalanceSnapshot {
  return {
    fetchedAt: Date.now(),
    providerKey: q.providerKey,
    accountId: q.accountId,
    kind,
    raw,
    error: message,
  }
}
