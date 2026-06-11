// Action handlers for the billing / subscription slash commands (/usage,
// /balance, /models, /login). Mirrors `actions/diagnostics.ts`:
// `(ctx: SlashContext) => Promise<void>`, output pushed as a markdown system
// message. Each probe is best-effort — a single failing read (e.g. no Dexie /
// keyring in web mode) degrades to an explanatory line, never throws.

import type { SlashContext } from "../builtin"
import { getDb } from "@/lib/db/schema"
import {
  summarizeCurrentWindow,
  splitCountdown,
  type WindowStatus,
} from "@/lib/subscription/anthropic/usage-analytics"
import { latestBalanceSnapshot } from "@/lib/subscription/balance/store"
import { listAccounts } from "@/lib/subscription/core/transport"
import { syncModelsDevCatalog } from "@/lib/ai/providers/models-dev-sync"
import { ALL_PROVIDER_IDS } from "@/types/subscription"
import type { AccountSummary, SubscriptionUsageRow } from "@/types/subscription"

/** Render one Anthropic quota window as a markdown bullet. */
function windowLine(label: string, w: WindowStatus | null): string {
  if (!w) return `- **${label}**: not reported`
  let reset = ""
  if (w.msUntilReset != null) {
    const c = splitCountdown(w.msUntilReset)
    reset = c.expired ? " (resetting…)" : ` (resets in ${c.hours}h ${c.minutes}m)`
  }
  return `- **${label}**: ${w.utilization.toFixed(0)}% used [${w.level}]${reset}`
}

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

  lines.push(windowLine("5-hour window", summary.fiveHour))
  lines.push(windowLine("7-day window", summary.sevenDay))
  if (summary.fallbackPercentage != null) {
    lines.push(`- **Fallback**: ${summary.fallbackPercentage}%`)
  }
  if (summary.overageDisabledReason) {
    lines.push(`- **Overage disabled**: ${summary.overageDisabledReason}`)
  }
  lines.push("", "_See Settings → Subscription → Usage for charts and history._")
  ctx.pushSystemMessage(lines.join("\n"))
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
