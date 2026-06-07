// DeepInfra balance adapter.
//
// Verified endpoint (2026-06): GET https://api.deepinfra.com/v1/me with
// `Authorization: Bearer <token>` → account object whose
// `checklist.stripe_balance` (number) carries the balance. Per the spec the
// sign is inverted: NEGATIVE = funds ready to spend, POSITIVE = money owed —
// we surface `-stripe_balance` as the remaining credit.
// Docs: https://docs.deepinfra.com/api-reference/account/me

import type {
  BalanceAdapter,
  BalanceQuery,
  BalanceRequestDescriptor,
  BalanceSnapshot,
} from "@/types/subscription"

import { bearer, errorSnapshot, parseJsonObject, toNum } from "./_shared"

export const deepinfraBalanceAdapter: BalanceAdapter = {
  key: "deepinfra",

  matches(q) {
    if (q.providerKey === "deepinfra") return true
    return q.baseUrl?.includes("api.deepinfra.com") ?? false
  },

  request(q: BalanceQuery): BalanceRequestDescriptor {
    // /v1/me sits on the api host root, independent of the inference path
    // (/v1/openai) a preset usually points at.
    return { url: "https://api.deepinfra.com/v1/me", headers: bearer(q.token) }
  },

  parse(status: number, body: string, q: BalanceQuery): BalanceSnapshot {
    const obj = parseJsonObject(body)
    if (status < 200 || status >= 300 || !obj) {
      return errorSnapshot(q, "credit", `HTTP ${status}`, obj ?? {})
    }
    const checklist =
      obj.checklist && typeof obj.checklist === "object" && !Array.isArray(obj.checklist)
        ? (obj.checklist as Record<string, unknown>)
        : null
    const stripeBalance = checklist ? toNum(checklist.stripe_balance) : undefined
    if (stripeBalance === undefined) {
      return errorSnapshot(q, "credit", "no checklist.stripe_balance", obj)
    }
    return {
      fetchedAt: Date.now(),
      providerKey: q.providerKey,
      accountId: q.accountId,
      kind: "credit",
      currency: "USD",
      unit: "USD",
      // Sign inverted upstream: negative stripe_balance = spendable funds.
      remaining: -stripeBalance,
      raw: obj,
    }
  },
}
