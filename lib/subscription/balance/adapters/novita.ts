// Novita AI balance adapter.
//
// Verified endpoint (2026-06): GET
// https://api.novita.ai/openapi/v1/billing/balance/detail with
// `Authorization: Bearer <token>` →
//   { availableBalance, cashBalance, creditLimit, pendingCharges,
//     outstandingInvoices }
// Values are STRINGS in 1/10000 USD (10000 = $1.00).
// Docs: https://novita.ai/docs/api-reference/basic-get-user-balance

import type {
  BalanceAdapter,
  BalanceQuery,
  BalanceRequestDescriptor,
  BalanceSnapshot,
} from "@/types/subscription"

import { bearer, errorSnapshot, parseJsonObject, toNum } from "./_shared"

/** Convert the 1/10000-USD integer representation to dollars. */
function tenThousandthsToUnits(v: unknown): number | undefined {
  const n = toNum(v)
  return n === undefined ? undefined : n / 10_000
}

export const novitaBalanceAdapter: BalanceAdapter = {
  key: "novita",

  matches(q) {
    if (q.providerKey === "novita") return true
    return q.baseUrl?.includes("api.novita.ai") ?? false
  },

  request(q: BalanceQuery): BalanceRequestDescriptor {
    // The billing API lives under /openapi on the api host, independent of
    // the inference baseUrl path (/v3/openai) a preset usually points at.
    return {
      url: "https://api.novita.ai/openapi/v1/billing/balance/detail",
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
      currency: "USD",
      unit: "USD",
      remaining,
      raw: obj,
    }
  },
}
