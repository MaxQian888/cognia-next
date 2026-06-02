// OpenRouter balance adapter.
//
// Verified endpoint (2026-06): GET https://openrouter.ai/api/v1/credits with
// `Authorization: Bearer <token>` →
//   { data: { total_credits, total_usage } }   (both in USD)
// Remaining = total_credits - total_usage.
// Docs: https://openrouter.ai/docs/api/api-reference/credits/get-credits
//
// The configured preset baseUrl is already "https://openrouter.ai/api/v1", so
// `${baseUrl}/credits` is the documented path.

import type {
  BalanceAdapter,
  BalanceQuery,
  BalanceRequestDescriptor,
  BalanceSnapshot,
} from "@/types/subscription"

import { bearer, errorSnapshot, parseJsonObject, toNum, trimBase } from "./_shared"

export const openrouterBalanceAdapter: BalanceAdapter = {
  key: "openrouter",

  matches(q) {
    if (q.providerKey === "openrouter") return true
    return q.baseUrl?.includes("openrouter.ai") ?? false
  },

  request(q: BalanceQuery): BalanceRequestDescriptor {
    return { url: `${trimBase(q.baseUrl)}/credits`, headers: bearer(q.token) }
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
    const total = toNum(d.total_credits)
    const used = toNum(d.total_usage)
    const remaining = total != null && used != null ? total - used : undefined
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
