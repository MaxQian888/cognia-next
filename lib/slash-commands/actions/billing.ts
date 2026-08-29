// Action handlers for the billing / subscription slash commands (/usage,
// /balance, /models, /login). Mirrors `actions/diagnostics.ts`:
// `(ctx: SlashContext) => Promise<void>`, output pushed as a markdown system
// message. Each probe is best-effort — a single failing read (e.g. no Dexie /
// keyring in web mode) degrades to an explanatory line, never throws.

import type { SlashContext } from "../builtin"
import { getDb } from "@/lib/db/schema"
import { isLocalSpend } from "@/lib/db/session-usage"
import {
  resolveUsageWindows,
  usageStatusFor,
  usageWindowsStale,
} from "@/lib/subscription/anthropic/overview-windows"
import { latestBalanceSnapshot } from "@/lib/subscription/balance/store"
import { getActiveAccount, listAccounts } from "@/lib/subscription/core/transport"
import { queryAccountLimitsCoalesced } from "@/lib/subscription/limits/coalesce"
import { isLimitsQueryEnabled } from "@/lib/subscription/limits/policy"
import { latestLimitsSnapshot, recordLimitsSnapshot } from "@/lib/subscription/limits/store"
import { syncModelsDevCatalog } from "@/lib/ai/providers/models-dev-sync"
import { buildUsageScopes, type UsageNote } from "@/lib/usage/usage-report"
import { filterByRange } from "@/lib/usage/session-analytics"
import { useSettingsStore } from "@/stores/settings"
import { isTauri } from "@/lib/tauri"
import { ALL_PROVIDER_IDS, DEFAULT_ANTHROPIC_SUBSCRIPTION_SETTINGS } from "@/types/subscription"
import type { AccountSummary, ProviderLimitsRow, SubscriptionUsageRow } from "@/types/subscription"
import type { SessionUsageRow } from "@/lib/db/session-usage"

/** Widest scope the card can attribute over — 7 local days. */
const LOCAL_SPEND_RANGE_DAYS = 7

/**
 * Newest passive rate-limit header sample, or `null` when Dexie has none / is
 * unavailable (web mode without a database, a fresh install).
 */
async function readLatestHeaderSample(): Promise<SubscriptionUsageRow | null> {
  try {
    const rows = await getDb().subscriptionUsage.orderBy("fetchedAt").reverse().limit(1).toArray()
    return rows[0] ?? null
  } catch {
    return null
  }
}

/**
 * Resolve the quota-endpoint snapshot for the active Anthropic account,
 * refreshing it first when it is missing or stale AND that exact account has
 * opted into outbound quota queries.
 *
 * The refresh is deliberate: the OAuth usage endpoint is free, `/usage` is
 * always user-invoked, and the per-account opt-in (`limitsQueryEnabledAccounts`)
 * is the same gate the Subscription tab honours. Nothing is sent for an account
 * that has not granted it — the command reports that as a note instead.
 */
async function readQuotaSnapshot(
  notes: UsageNote[],
  now: number
): Promise<ProviderLimitsRow | null> {
  if (!isTauri()) {
    notes.push({ id: "web-mode" })
    return null
  }
  let accountId: string | null = null
  try {
    accountId = (await getActiveAccount("anthropic")).activeAccountId ?? null
  } catch {
    // Keyring/IPC unavailable — indistinguishable from "no account" here.
  }
  if (!accountId) {
    notes.push({ id: "no-account" })
    return null
  }

  let snapshot: ProviderLimitsRow | null = null
  try {
    snapshot = await latestLimitsSnapshot("anthropic", accountId)
  } catch {
    // Dexie read failed; a refresh below may still produce a snapshot.
  }

  const enabledAccounts = useSettingsStore.getState().settings?.limitsQueryEnabledAccounts
  const queryEnabled = isLimitsQueryEnabled(enabledAccounts, "anthropic", accountId)
  const stale = usageWindowsStale({ fetchedAt: snapshot?.fetchedAt ?? null }, now)

  if (!queryEnabled) {
    if (!snapshot) notes.push({ id: "query-disabled" })
    return snapshot
  }
  if (!stale) return snapshot

  try {
    const fresh = await queryAccountLimitsCoalesced("anthropic", accountId)
    if (fresh) snapshot = await recordLimitsSnapshot(fresh)
  } catch (err) {
    notes.push({ id: "quota-error", detail: err instanceof Error ? err.message : String(err) })
  }
  return snapshot
}

/**
 * Local `sessionUsage` rows for the widest attribution scope. Imported rows are
 * dropped: that spend was paid on another machine (often by another account),
 * and blending it in would present someone else's tokens as this plan's usage.
 */
async function readLocalSpend(
  notes: UsageNote[],
  now: number,
  sessionId: string | null
): Promise<{ calendar: SessionUsageRow[]; session: SessionUsageRow[] } | null> {
  try {
    const all = (await getDb().sessionUsage.toArray()).filter(isLocalSpend)
    return {
      calendar: filterByRange(all, LOCAL_SPEND_RANGE_DAYS, now),
      // Deliberately NOT date-filtered: a chat older than the calendar window is
      // still the session the user is looking at, and its own tab reporting
      // "no recorded turns" would be a lie about a conversation on screen.
      session: sessionId ? all.filter((r) => r.sessionId === sessionId) : [],
    }
  } catch {
    notes.push({ id: "local-spend-unavailable" })
    return null
  }
}

/**
 * `/usage` — the plan's quota windows plus the local spend that explains them.
 *
 * Quota comes from `resolveUsageWindows`, the same fuse the Subscription
 * Overview uses: the free OAuth usage endpoint (session / weekly / weekly_opus /
 * weekly_sonnet + the pay-as-you-go meter) when it is the newer reading, and the
 * passive `anthropic-ratelimit-*` header sample otherwise. Attribution comes
 * from this machine's `sessionUsage` rows, precomputed for every scope the card
 * offers so switching scope never re-reads a database that has moved on.
 *
 * The command never fails: each plane degrades to a note explaining exactly what
 * is missing, and a card with only one plane is still worth rendering.
 */
export async function handleUsage(ctx: SlashContext): Promise<void> {
  const now = Date.now()
  const notes: UsageNote[] = []

  const [quota, headers, localRows] = await Promise.all([
    readQuotaSnapshot(notes, now),
    readLatestHeaderSample(),
    readLocalSpend(notes, now, ctx.activeSessionId),
  ])

  if (quota?.error) notes.push({ id: "quota-error", detail: quota.error })

  const warnThresholdPct =
    useSettingsStore.getState().settings?.subscriptionSettings?.warnThresholdPct ??
    DEFAULT_ANTHROPIC_SUBSCRIPTION_SETTINGS.warnThresholdPct
  const resolved = resolveUsageWindows(quota, headers, { warnThresholdPct })

  if (resolved.source !== null && usageWindowsStale(resolved, now)) {
    notes.push({ id: "stale" })
  }

  const scopes =
    localRows === null
      ? undefined
      : buildUsageScopes({
          rows: localRows.calendar,
          sessionRows: localRows.session,
          sessionId: ctx.activeSessionId,
          now,
        })
  if (localRows !== null && localRows.calendar.length === 0 && localRows.session.length === 0) {
    notes.push({ id: "no-local-spend" })
  }

  ctx.pushSystemMessage({
    kind: "usage",
    meters: resolved.windows,
    extras: resolved.extras,
    source: resolved.source,
    fetchedAt: resolved.fetchedAt,
    // A status is always resolvable: `usageStatusFor` returns the header
    // sample's own unified status when headers won the fuse, and otherwise
    // derives one from the worst meter. Passing `resolved.headerStatus`
    // straight through would have left the pill permanently blank for anyone
    // with the (free, actively refreshed) usage endpoint enabled — i.e. for
    // exactly the configuration this command steers people into.
    status: resolved.source === null ? null : usageStatusFor(resolved),
    // The next three are things ONLY the rate-limit headers report — the usage
    // endpoint has no field for any of them. `resolveUsageWindows` nulls them
    // whenever the endpoint wins, which is correct for *window* metadata (a
    // stale claim beside a fresh meter misleads) but would mean these three can
    // never be shown at all. They are read from the newest header sample
    // directly, so "the endpoint had fresher windows" does not silently become
    // "your org has no overage restriction".
    representativeClaim: headers?.representativeClaim ?? null,
    fallbackPercentage: headers?.fallbackPercentage ?? null,
    overageDisabledReason: headers?.overageDisabledReason ?? null,
    scopes,
    hasSession: !!ctx.activeSessionId,
    notes,
    generatedAt: now,
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
