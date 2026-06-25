// Moonshot AI (月之暗面 / Kimi) balance adapter.
//
// Verified endpoint (2026-06): GET {baseUrl}/users/me/balance with
// `Authorization: Bearer <token>` →
//   { code, status, data: { available_balance, voucher_balance, cash_balance } }
// `available_balance` = combined usable balance (cash + voucher).
// Docs: https://platform.moonshot.ai/docs/api/balance
//
// The configured preset baseUrl is "https://api.moonshot.cn/v1" (the CN
// console, denominated in CNY), so `${baseUrl}/users/me/balance` is the path.
// The international `.ai` host (now `platform.kimi.ai` after the Kimi rebrand)
// reports the same shape but bills in USD — so we derive the currency from the
// host rather than hard-coding it.

import type {
  BalanceAdapter,
  BalanceQuery,
  BalanceRequestDescriptor,
  BalanceSnapshot,
} from "@/types/subscription"

import { bearer, errorSnapshot, parseJsonObject, toNum, trimBase } from "./_shared"

/**
 * Moonshot bills the CN console (`.cn`) in CNY and the international host
 * (`moonshot.ai` / `kimi.ai`) in USD. Default to CNY for the catalog default
 * and any unknown relay, which is the safer assumption for the `.cn` preset.
 */
function moonshotCurrency(baseUrl?: string): string {
  const b = baseUrl ?? ""
  if (b.includes("moonshot.ai") || b.includes("kimi.ai")) return "USD"
  return "CNY"
}

export const moonshotBalanceAdapter: BalanceAdapter = {
  key: "moonshot",

  matches(q) {
    if (q.providerKey === "moonshot") return true
    return q.baseUrl?.includes("moonshot.") ?? false
  },

  request(q: BalanceQuery): BalanceRequestDescriptor {
    return { url: `${trimBase(q.baseUrl)}/users/me/balance`, headers: bearer(q.token) }
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
    const remaining = toNum(d.available_balance)
    const currency = moonshotCurrency(q.baseUrl)
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
