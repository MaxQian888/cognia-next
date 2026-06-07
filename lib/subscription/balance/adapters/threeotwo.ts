// 302.AI balance adapter.
//
// Verified endpoint (2026-06): GET https://api.302.ai/dashboard/balance with
// `Authorization: Bearer <token>` (same key as inference) →
//   { data: { balance: "12.34" } }
// Currency is USD (pay-as-you-go model; schema declares no currency field).
// Docs: https://doc-en.302.ai/api-263735171

import type {
  BalanceAdapter,
  BalanceQuery,
  BalanceRequestDescriptor,
  BalanceSnapshot,
} from "@/types/subscription"

import { bearer, errorSnapshot, parseJsonObject, toNum } from "./_shared"

export const threeOTwoBalanceAdapter: BalanceAdapter = {
  key: "302ai",

  matches(q) {
    if (q.providerKey === "302ai") return true
    return q.baseUrl?.includes("api.302.ai") ?? false
  },

  request(q: BalanceQuery): BalanceRequestDescriptor {
    return { url: "https://api.302.ai/dashboard/balance", headers: bearer(q.token) }
  },

  parse(status: number, body: string, q: BalanceQuery): BalanceSnapshot {
    const obj = parseJsonObject(body)
    if (status < 200 || status >= 300 || !obj) {
      return errorSnapshot(q, "credit", `HTTP ${status}`, obj ?? {})
    }
    const data =
      obj.data && typeof obj.data === "object" && !Array.isArray(obj.data)
        ? (obj.data as Record<string, unknown>)
        : null
    const remaining = data ? toNum(data.balance) : undefined
    if (remaining === undefined) {
      return errorSnapshot(q, "credit", "no data.balance", obj)
    }
    return {
      fetchedAt: Date.now(),
      providerKey: q.providerKey,
      accountId: q.accountId,
      kind: "credit",
      currency: "USD",
      unit: "USD",
      remaining,
      raw: obj,
    }
  },
}
