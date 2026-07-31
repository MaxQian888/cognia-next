// Action handlers for the billing / subscription slash commands (/usage,
// /balance, /models, /login). Mirrors `actions/diagnostics.ts`:
// `(ctx: SlashContext) => Promise<void>`, output pushed as a markdown system
// message. Each probe is best-effort — a single failing read (e.g. no Dexie /
// keyring in web mode) degrades to an explanatory line, never throws.

import type { SlashContext } from "../builtin"
import { getDb } from "@/lib/db/schema"
import { summarizeCurrentWindow } from "@/lib/subscription/anthropic/usage-analytics"
import { latestBalanceSnapshot } from "@/lib/subscription/balance/store"
import { listAccounts } from "@/lib/subscription/core/transport"
import { syncModelsDevCatalog } from "@/lib/ai/providers/models-dev-sync"
import { ALL_PROVIDER_IDS } from "@/types/subscription"
import type { AccountSummary, SubscriptionUsageRow } from "@/types/subscription"

/**
 * `/usage` — Anthropic subscription quota windows (5h / 7d) from the newest
 * `subscriptionUsage` snapshot. Reuses the same pure analytics
 * (`summarizeCurrentWindow`) that drives the Settings → Subscription Usage tab.
 */
export async function handleUsage(ctx: SlashContext): Promise<void> {
  const lines: string[] = ["**Subscription usage**", ""]
  let latest: SubscriptionUsageRow | null = null
  try {
    const rows = await getDb().subscriptionUsage.orderBy("fetchedAt").reverse().limit(1).toArray()
    latest = rows[0] ?? null
  } catch {
    // Dexie unavailable — fall through to the empty-state hint.
  }

  const summary = summarizeCurrentWindow(latest)
  if (!summary) {
    lines.push(
      "- No Anthropic usage captured yet. Usage is read from API rate-limit " +
        "headers — send a turn on a Claude Pro/Max subscription account first."
    )
    ctx.pushSystemMessage(lines.join("\n"))
    return
  }

  ctx.pushSystemMessage({
    kind: "usage",
    windows: [
      {
        key: "fiveHour",
        utilization: summary.fiveHour?.utilization ?? null,
        level: summary.fiveHour?.level ?? null,
        msUntilReset: summary.fiveHour?.msUntilReset ?? null,
      },
      {
        key: "sevenDay",
        utilization: summary.sevenDay?.utilization ?? null,
        level: summary.sevenDay?.level ?? null,
        msUntilReset: summary.sevenDay?.msUntilReset ?? null,
      },
    ],
    fallbackPercentage: summary.fallbackPercentage,
    overageDisabledReason: summary.overageDisabledReason,
  })
}

/**
 * `/balance` — latest stored balance snapshot for every subscription account
 * across providers. Reuses `latestBalanceSnapshot` (the same store the
 * BalanceCard reads); only providers with a public balance API ever have one.
 */
export async function handleBalance(ctx: SlashContext): Promise<void> {
  const lines: string[] = ["**Provider balances**", ""]
  const entries: string[] = []

  for (const provider of ALL_PROVIDER_IDS) {
    let accounts: AccountSummary[] = []
    try {
      accounts = await listAccounts(provider)
    } catch {
      // Keyring/IPC unavailable (web mode) — skip this provider.
      continue
    }
    for (const acc of accounts) {
      const snap = await latestBalanceSnapshot(acc.id).catch(() => null)
      if (!snap) continue
      const label = acc.label || acc.id.slice(0, 8)
      if (snap.error) {
        entries.push(`- **${label}** (${snap.providerKey}): ⚠ ${snap.error}`)
        continue
      }
      const remaining =
        snap.remaining != null ? `${snap.remaining}${snap.unit ? ` ${snap.unit}` : ""}` : "—"
      const total = snap.total != null ? ` / ${snap.total}` : ""
      entries.push(`- **${label}** (${snap.providerKey}): ${remaining}${total} remaining`)
    }
  }

  if (entries.length === 0) {
    lines.push(
      "- No balance snapshots yet. Open Settings → Subscription and refresh a " +
        "provider's balance card (only providers with a public balance API are supported)."
    )
  } else {
    lines.push(...entries)
  }
  ctx.pushSystemMessage(lines.join("\n"))
}

/**
 * `/models` — refresh the models.dev catalog and report counts. Gives the
 * catalog sync a chat entry point now that the provider settings card is
 * non-resident. Reuses `syncModelsDevCatalog` verbatim.
 */
export async function handleModels(ctx: SlashContext): Promise<void> {
  ctx.pushSystemMessage("Syncing the models.dev catalog…")
  try {
    const row = await syncModelsDevCatalog()
    const providerCount = Object.keys(row.providers).length
    const modelCount = Object.values(row.providers).reduce((n, p) => n + p.models.length, 0)
    ctx.pushSystemMessage(
      [
        "**models.dev catalog synced**",
        "",
        `- **Source**: ${row.source === "remote" ? "Live (models.dev)" : "Bundled snapshot"}`,
        `- **Providers**: ${providerCount}`,
        `- **Models**: ${modelCount}`,
        `- **Fetched**: ${new Date(row.fetchedAt).toLocaleString()}`,
      ].join("\n")
    )
  } catch (err) {
    ctx.pushSystemMessage(
      `Failed to sync the models.dev catalog: ${err instanceof Error ? err.message : String(err)}`
    )
  }
}

/**
 * `/login` — open Settings → Subscription so the user can sign in to a
 * provider (Claude Pro/Max, Codex, OpenCode). Mirrors Claude Code's `/login`.
 */
export function handleLogin(ctx: SlashContext): void {
  ctx.openSettings("subscription")
  ctx.pushSystemMessage(
    "Opened Settings → Subscription. Sign in to Claude (Pro/Max), Codex, or OpenCode there."
  )
}
