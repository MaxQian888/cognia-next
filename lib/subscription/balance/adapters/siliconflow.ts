// SiliconFlow (硅基流动) balance adapter.
//
// Verified endpoint (2026-06): GET https://api.siliconflow.cn/v1/user/info with
// `Authorization: Bearer <token>` →
//   { code, status, data: { balance, totalBalance, chargeBalance, ... } }
// `balance` = current usable balance, `totalBalance` = balance+chargeBalance,
// all in CNY.
// Docs: https://docs.siliconflow.com/en/api-reference/userinfo/get-user-info
//
// The documented path is "{origin}/v1/user/info". We build from the baseUrl
// ORIGIN + the fixed "/v1/user/info" path so both the chat preset
// ("https://api.siliconflow.cn/v1") and the Anthropic relay preset
// ("https://api.siliconflow.cn") resolve correctly.

import type {
  BalanceAdapter,
  BalanceQuery,
  BalanceRequestDescriptor,
  BalanceSnapshot,
} from "@/types/subscription"

import { apiRootOf, bearer, errorSnapshot, parseJsonObject, toNum } from "./_shared"

export const siliconflowBalanceAdapter: BalanceAdapter = {
  key: "siliconflow",

  matches(q) {
    if (q.providerKey === "siliconflow") return true
    return q.baseUrl?.includes("siliconflow.") ?? false
  },

  request(q: BalanceQuery): BalanceRequestDescriptor {
    return { url: `${apiRootOf(q.baseUrl)}/v1/user/info`, headers: bearer(q.token) }
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
    const remaining = toNum(d.balance)
    const total = toNum(d.totalBalance)
    return {
      fetchedAt: Date.now(),
      providerKey: q.providerKey,
      accountId: q.accountId,
      kind: "credit",
      currency: "CNY",
      unit: "CNY",
      remaining,
      total,
      raw: obj,
    }
  },
}
