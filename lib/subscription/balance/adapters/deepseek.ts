// DeepSeek balance adapter.
//
// Verified endpoint (2026-06): GET https://api.deepseek.com/user/balance with
// `Authorization: Bearer <token>` →
//   { is_available, balance_infos: [
//       { currency, total_balance, granted_balance, topped_up_balance } ] }
// Docs: https://api-docs.deepseek.com/api/get-user-balance
//
// Note: `/user/balance` sits at the API root, NOT under the `/v1` chat prefix.
// We build from the baseUrl ORIGIN so both the chat preset
// ("https://api.deepseek.com/v1") and the Anthropic relay preset
// ("https://api.deepseek.com/anthropic") resolve the correct root path.

import type {
  BalanceAdapter,
  BalanceQuery,
  BalanceRequestDescriptor,
  BalanceSnapshot,
} from "@/types/subscription"

import { apiRootOf, bearer, errorSnapshot, parseJsonObject, toNum } from "./_shared"

export const deepseekBalanceAdapter: BalanceAdapter = {
  key: "deepseek",

  matches(q) {
    if (q.providerKey === "deepseek") return true
    return q.baseUrl?.includes("api.deepseek.com") ?? false
  },

  request(q: BalanceQuery): BalanceRequestDescriptor {
    return { url: `${apiRootOf(q.baseUrl)}/user/balance`, headers: bearer(q.token) }
  },

  parse(status: number, body: string, q: BalanceQuery): BalanceSnapshot {
    const obj = parseJsonObject(body)
    if (status < 200 || status >= 300 || !obj) {
      return errorSnapshot(q, "credit", `HTTP ${status}`, obj ?? {})
    }
    const infos = obj.balance_infos
    const first =
      Array.isArray(infos) && infos.length > 0 ? (infos[0] as Record<string, unknown>) : null
    if (!first) {
      return errorSnapshot(q, "credit", "no balance_infos", obj)
    }
    const currency = typeof first.currency === "string" ? first.currency : undefined
    const remaining = toNum(first.total_balance)
    return {
      fetchedAt: Date.now(),
      providerKey: q.providerKey,
      accountId: q.accountId,
      kind: "credit",
      currency,
      unit: currency,
      remaining,
      raw: obj,
    }
  },
}
