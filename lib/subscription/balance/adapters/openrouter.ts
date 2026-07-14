// OpenRouter balance adapter.
//
// Verified endpoint (2026-06): GET https://openrouter.ai/api/v1/key with
// `Authorization: Bearer <token>` →
//   { data: { usage, limit, limit_remaining, is_free_tier, ... } }  (USD credits)
// Docs: https://openrouter.ai/docs/api/reference/limits
//
// We deliberately use `/key`, NOT `/credits`: the `/credits` endpoint requires a
// *management/provisioning* key, so it 401s for the ordinary inference key our
// presets store. `/key` is the per-key endpoint that works with the inference
// key and reports that key's `usage` (spent) + `limit` / `limit_remaining`.
// `limit` and `limit_remaining` are `null` when the key has no cap (then we can
// only surface `used`).
//
// The per-key endpoint lives at "https://openrouter.ai/api/v1/key". We build
// from the baseUrl ORIGIN + the fixed "/api/v1/key" path so both the chat preset
// ("https://openrouter.ai/api/v1") and the Anthropic relay preset
// ("https://openrouter.ai/api") resolve correctly.

import type {
  BalanceAdapter,
  BalanceQuery,
  BalanceRequestDescriptor,
  BalanceSnapshot,
} from "@/types/subscription"

import { apiRootOf, bearer, errorSnapshot, parseJsonObject, toNum } from "./_shared"

export const openrouterBalanceAdapter: BalanceAdapter = {
  key: "openrouter",

  matches(q) {
    if (q.providerKey === "openrouter") return true
    return q.baseUrl?.includes("openrouter.ai") ?? false
  },

  request(q: BalanceQuery): BalanceRequestDescriptor {
    return { url: `${apiRootOf(q.baseUrl)}/api/v1/key`, headers: bearer(q.token) }
  },

  parse(status: number, body: string, q: BalanceQuery): BalanceSnapshot {
    const obj = parseJsonObject(body)
    if (status < 200 || status >= 300 || !obj) {
      return errorSnapshot(q, "credit", `HTTP ${status}`, obj ?? {})
    }
    const data = obj.data
    if (!data || typeof data !== "object") {
      return errorSnapshot(q, "credit", "no data", obj)
    }
    const d = data as Record<string, unknown>
    // `usage` = credits spent; `limit` = cap (null/absent = uncapped);
    // `limit_remaining` = remaining under the cap (null/absent = uncapped).
    const used = toNum(d.usage)
    const total = toNum(d.limit)
    const remaining = toNum(d.limit_remaining)
    return {
      fetchedAt: Date.now(),
      providerKey: q.providerKey,
      accountId: q.accountId,
      kind: "credit",
      currency: "USD",
      unit: "USD",
      total,
      used,
      remaining,
      raw: obj,
    }
  },
}
