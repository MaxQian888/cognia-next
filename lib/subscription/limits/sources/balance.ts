// Generic credit-balance limits source.
//
// Any provider account whose resolved preset matches a built-in or
// plugin-contributed `BalanceAdapter` (Kimi/Moonshot, OpenCodeGo, DeepSeek,
// OpenRouter, SiliconFlow, Novita, DeepInfra, ppIO, 3oz, …) gets a single
// `credit` meter for free. This is the runner's fallthrough when no windowed
// source applies, so credit-based subscriptions surface in the same panel as
// the Claude/Codex windows.
//
// Mirrors the resolution in `lib/subscription/balance/runner.ts:queryAccountBalance`
// but reuses the already-resolved account/preset/token from the limits runner
// (no second account lookup) and projects the result into a `LimitsMeter`.

import { findBalanceAdapter } from "@/lib/subscription/balance/registry"

import { balanceMeter, errorLimits } from "../meters"

import type { LimitsSource, LimitsSourceContext, ProviderLimits } from "@/types/subscription"

export const balanceLimitsSource: LimitsSource = {
  key: "balance",

  matches(q) {
    return Boolean(findBalanceAdapter({ providerKey: q.providerKey, baseUrl: q.baseUrl }))
  },

  async fetch(ctx: LimitsSourceContext): Promise<ProviderLimits | null> {
    if (!ctx.token || !ctx.baseUrl) return null
    const adapter = findBalanceAdapter({ providerKey: ctx.providerKey, baseUrl: ctx.baseUrl })
    if (!adapter) return null

    const providerKey = ctx.providerKey ?? adapter.key
    const query = {
      accountId: ctx.accountId,
      providerKey,
      baseUrl: ctx.baseUrl,
      token: ctx.token,
    }
    const descriptor = adapter.request(query)

    let body: string
    try {
      body = await ctx.authedGet(descriptor.url, descriptor.headers)
    } catch (err) {
      return errorLimits(ctx, providerKey, err instanceof Error ? err.message : String(err))
    }

    // The Tauri passthrough returns the raw body but not the status code; the
    // adapters treat a parseable JSON body as 200 and surface their own `error`.
    const bal = adapter.parse(200, body, query)
    if (bal.error) {
      return errorLimits(ctx, providerKey, bal.error)
    }

    return {
      provider: providerKey,
      accountId: ctx.accountId,
      accountLabel: ctx.accountLabel,
      fetchedAt: ctx.now,
      meters: [balanceMeter(bal)],
    }
  },
}
