/**
 * Demo balance adapter (ADR-0025) — reference implementation of the
 * `balance-adapter` capability. Resolves a fictional "example-credits" provider
 * whose JSON balance endpoint returns `{ balance, currency }`. Pure, like every
 * real adapter in `lib/subscription/balance/adapters/*`: it only describes the
 * authed GET and parses the body — the Tauri host performs the HTTP.
 *
 * Registered declaratively via `manifest.balanceAdapters`; the plugin manager's
 * `OVERLAY_REGISTRY_CAPABILITIES` dispatch loop adds it to the balance-adapter
 * overlay registry, which `findBalanceAdapter` consults before the built-ins.
 */

import type { PluginBalanceAdapterDef } from "@/types/plugin/plugin-balance-adapter"

export const demoBalanceAdapter: PluginBalanceAdapterDef = {
  id: "cognia-agent-team-examples:demo-balance",
  key: "example-credits",
  name: "Example Credits (demo)",
  matches: (q) =>
    q.providerKey === "example-credits" || Boolean(q.baseUrl?.includes("credits.example.com")),
  request: (q) => ({
    url: `${q.baseUrl.replace(/\/+$/, "")}/v1/balance`,
    headers: { authorization: `Bearer ${q.token}` },
  }),
  parse: (status, body, q) => {
    if (status !== 200) {
      return {
        fetchedAt: Date.now(),
        providerKey: q.providerKey,
        accountId: q.accountId,
        kind: "credit",
        raw: { status },
        error: `HTTP ${status}`,
      }
    }
    let parsed: { balance?: number; currency?: string } = {}
    try {
      parsed = JSON.parse(body) as typeof parsed
    } catch {
      return {
        fetchedAt: Date.now(),
        providerKey: q.providerKey,
        accountId: q.accountId,
        kind: "credit",
        raw: { body },
        error: "Unparseable balance response",
      }
    }
    return {
      fetchedAt: Date.now(),
      providerKey: q.providerKey,
      accountId: q.accountId,
      kind: "credit",
      remaining: parsed.balance,
      currency: parsed.currency,
      unit: parsed.currency,
      raw: parsed as Record<string, unknown>,
    }
  },
}
