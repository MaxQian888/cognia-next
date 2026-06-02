// SiliconFlow (硅基流动) balance adapter.
//
// Verified endpoint (2026-06): GET https://api.siliconflow.cn/v1/user/info with
// `Authorization: Bearer <token>` →
//   { code, status, data: { balance, totalBalance, chargeBalance, ... } }
// `balance` = current usable balance, `totalBalance` = balance+chargeBalance,
// all in CNY.
// Docs: https://docs.siliconflow.com/en/api-reference/userinfo/get-user-info
//
// The preset baseUrl is "https://api.siliconflow.cn/v1", so `${baseUrl}/user/info`
// is the documented path.

import type {
  BalanceAdapter,
  BalanceQuery,
  BalanceRequestDescriptor,
  BalanceSnapshot,
} from "@/types/subscription"

import { bearer, errorSnapshot, parseJsonObject, toNum, trimBase } from "./_shared"

export const siliconflowBalanceAdapter: BalanceAdapter = {
  key: "siliconflow",

  matches(q) {
    if (q.providerKey === "siliconflow") return true
    return q.baseUrl?.includes("siliconflow.") ?? false
  },

  request(q: BalanceQuery): BalanceRequestDescriptor {
    return { url: `${trimBase(q.baseUrl)}/user/info`, headers: bearer(q.token) }
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
