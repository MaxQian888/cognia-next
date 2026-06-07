// PPIO (PPInfra) balance adapter.
//
// Verified endpoint (2026-06): GET
// https://api.ppio.com/openapi/v1/billing/balance/detail with
// `Authorization: Bearer <token>` → same shape as Novita (shared lineage):
//   { availableBalance, cashBalance, creditLimit, ... }
// Values are STRINGS in 1/10000 CNY (10000 = ¥1).
// Docs: https://ppio.com/docs/management/reference-billing-get-balance-detail
// Note: ppinfra.com 301-redirects to ppio.com; we match both hosts.

import type {
  BalanceAdapter,
  BalanceQuery,
  BalanceRequestDescriptor,
  BalanceSnapshot,
} from "@/types/subscription"

import { bearer, errorSnapshot, parseJsonObject, toNum } from "./_shared"

function tenThousandthsToUnits(v: unknown): number | undefined {
  const n = toNum(v)
  return n === undefined ? undefined : n / 10_000
}

export const ppioBalanceAdapter: BalanceAdapter = {
  key: "ppio",

  matches(q) {
    if (q.providerKey === "ppio" || q.providerKey === "ppinfra") return true
    const url = q.baseUrl ?? ""
    return url.includes("api.ppio.com") || url.includes("api.ppinfra.com")
  },

  request(q: BalanceQuery): BalanceRequestDescriptor {
    return {
      url: "https://api.ppio.com/openapi/v1/billing/balance/detail",
      headers: bearer(q.token),
    }
  },

  parse(status: number, body: string, q: BalanceQuery): BalanceSnapshot {
    const obj = parseJsonObject(body)
    if (status < 200 || status >= 300 || !obj) {
      return errorSnapshot(q, "credit", `HTTP ${status}`, obj ?? {})
    }
    const remaining = tenThousandthsToUnits(obj.availableBalance)
    if (remaining === undefined) {
      return errorSnapshot(q, "credit", "no availableBalance", obj)
    }
    return {
      fetchedAt: Date.now(),
      providerKey: q.providerKey,
      accountId: q.accountId,
      kind: "credit",
      currency: "CNY",
      unit: "CNY",
      remaining,
      raw: obj,
    }
  },
}
