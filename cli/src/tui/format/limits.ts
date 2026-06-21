/**
 * Pure formatting helpers for the `/limits` panel — the CLI analog of Claude
 * Code's `/usage` screen. The panel itself (`overlays/LimitsPanel.tsx`) renders
 * one Claude-Code-style bar per `LimitsMeter`: a label, a full-width colored bar,
 * a right-aligned "% used" / "credit left" figure, and a reset countdown. These
 * helpers stay pure (clock injected) so the rendering is deterministic + tested.
 *
 * Reuses the desktop's `splitCountdown` so the reset math matches the app, and a
 * small English label map for the built-in meter ids (the Ink TUI is English;
 * the i18n keys on each meter are for the desktop renderer).
 */
import { splitCountdown } from "@/lib/subscription/anthropic/usage-analytics"
import { CUSTOM_SOURCE_PRESETS } from "@/lib/subscription/limits/custom/presets"

import type { CustomLimitsSource, LimitsMeter, LimitsMeterStatus } from "@/types/subscription"

/** Theme palette token (by name) a meter's bar fill should use. */
export type MeterColorToken = "success" | "warning" | "danger" | "muted"

/** English labels for the built-in meter ids. Falls back to `label` / `id`. */
const METER_LABELS: Record<string, string> = {
  session: "Current session",
  weekly: "Current week (all models)",
  weekly_sonnet: "Current week (Sonnet only)",
  credit: "Credit balance",
}

export function meterLabel(m: LimitsMeter): string {
  return METER_LABELS[m.id] ?? m.label ?? m.id
}

/** Map a meter status to a theme palette token for the bar fill. */
export function meterColor(status: LimitsMeterStatus): MeterColorToken {
  switch (status) {
    case "warn":
      return "warning"
    case "crit":
    case "exceeded":
      return "danger"
    case "unknown":
      return "muted"
    default:
      return "success"
  }
}

/** How many of `width` cells are filled for a given percent (null → 0). */
export function meterFill(pct: number | null, width: number): number {
  if (pct == null || !Number.isFinite(pct)) return 0
  const clamped = Math.max(0, Math.min(100, Math.round(pct)))
  return Math.round((clamped / 100) * width)
}

function currencySymbol(currency?: string): string {
  if (currency === "CNY") return "¥"
  if (currency === "USD") return "$"
  return ""
}

function trimAmount(n: number): string {
  // Two decimals, dropping a trailing ".00".
  const s = n.toFixed(2)
  return s.endsWith(".00") ? s.slice(0, -3) : s
}

/** The right-aligned figure: "21% used" for windows, "¥88.50 left" for credit. */
export function meterRightLabel(m: LimitsMeter): string {
  if (m.kind === "window") {
    return `${m.usedPct ?? 0}% used`
  }
  if (typeof m.remaining === "number") {
    // A non-positive credit balance is depleted — showing "¥-0.01 left" reads
    // like a render bug. Surface the depleted state plainly instead.
    if (m.remaining <= 0) return "depleted"
    const sym = currencySymbol(m.currency ?? m.unit)
    const unit = sym ? "" : m.unit ? ` ${m.unit}` : ""
    return `${sym}${trimAmount(m.remaining)}${unit} left`
  }
  if (m.usedPct != null) return `${m.usedPct}% used`
  return "—"
}

/**
 * The subtitle for a provider block that produced no usable meter. OpenCode
 * Zen/Go plans bill from a real credit balance but expose NO usage API (it's
 * console-only), so a bare "no data" is misleading — point at the console.
 * Every other provider just has nothing to report.
 */
export function noDataHint(provider: string): string {
  if (provider.startsWith("opencode")) {
    return "OpenCode plans report usage in the web console (opencode.ai) — no usage API to query."
  }
  return "No limit data for this provider."
}

/**
 * Markdown for `/limits presets` — the CLI analog of the desktop preset
 * dropdown. The CLI authors custom sources by hand in config.json, so we print
 * each built-in preset as a copy-paste `customLimitsSources` entry (the user
 * fills baseUrl + token + any placeholder paths). Reuses the shared
 * `CUSTOM_SOURCE_PRESETS` so the two surfaces never drift.
 */
export function formatPresetSnippets(): string {
  const out: string[] = [
    "# Custom limits-source presets",
    "",
    "Add one of these to `customLimitsSources` in your config.json, then fill",
    "`baseUrl` + `token` (and any `New-Api-User` / placeholder paths):",
    "",
  ]
  for (const preset of CUSTOM_SOURCE_PRESETS) {
    if (preset.id === "custom") continue
    const sample: CustomLimitsSource = preset.apply({
      id: `my-${preset.id}`,
      name: preset.id,
      baseUrl: "https://provider.example.com",
      token: "<token>",
      request: { path: "" },
      extract: { kind: "balance", remainingPath: "" },
    })
    out.push(`## ${preset.id}`, "```json", JSON.stringify(sample, null, 2), "```", "")
  }
  return out.join("\n").trimEnd()
}

/** The reset subtitle for a window meter, or `null` when there's no reset. */
export function meterResetText(m: LimitsMeter, now: number): string | null {
  if (m.resetAt == null) return null
  const c = splitCountdown(m.resetAt - now)
  if (c.expired) return "Resets shortly"
  if (c.hours > 0) return `Resets in ${c.hours}h ${c.minutes}m`
  return `Resets in ${c.minutes}m`
}
