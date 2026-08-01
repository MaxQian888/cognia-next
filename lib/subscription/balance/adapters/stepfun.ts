import type {
  BalanceAdapter,
  BalanceQuery,
  BalanceRequestDescriptor,
  BalanceSnapshot,
} from "@/types/subscription"

import { apiRootOf, bearer, errorSnapshot, parseJsonObject, toNum } from "./_shared"

/** Official StepFun account balance API documented at /v1/accounts. */
export const stepfunBalanceAdapter: BalanceAdapter = {
  key: "stepfun",

  matches(query) {
    if (query.providerKey === "stepfun") return true
    return query.baseUrl?.includes("api.stepfun.com") ?? false
  },

  request(query: BalanceQuery): BalanceRequestDescriptor {
    return {
      url: `${apiRootOf(query.baseUrl)}/v1/accounts`,
      headers: bearer(query.token),
    }
  },

  parse(status: number, body: string, query: BalanceQuery): BalanceSnapshot {
    const payload = parseJsonObject(body)
    if (status < 200 || status >= 300) {
      return errorSnapshot(query, "credit", `HTTP ${status}`, payload ?? {})
    }
    if (!payload) return errorSnapshot(query, "credit", "invalid response")

    const remaining = toNum(payload.balance)
    if (remaining === undefined) {
      return errorSnapshot(query, "credit", "no balance", payload)
    }
    const cash = toNum(payload.total_cash_balance)
    const voucher = toNum(payload.total_voucher_balance)
    const total =
      cash === undefined && voucher === undefined ? undefined : (cash ?? 0) + (voucher ?? 0)

    return {
      fetchedAt: Date.now(),
      providerKey: query.providerKey,
      accountId: query.accountId,
      kind: "credit",
      currency: "CNY",
      unit: "CNY",
      remaining,
      total,
      raw: payload,
    }
  },
}
