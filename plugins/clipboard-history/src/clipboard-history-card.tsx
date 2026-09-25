"use client"

/**
 * Rich chat card for the clipboard-history plugin's `clipboard_history_list`
 * tool (ADR-0127: first-party registration for the plugin tool-result
 * registry). Renders the entries as a compact list — newest first, each with
 * a locale-aware relative timestamp and a copy button — instead of the raw
 * JSON the generic tool body would show. Returns `null` for a payload without
 * an `entries` array so the host falls back.
 *
 * Strings come from the plugin's own `manifest.i18n` bundle through
 * `usePluginTranslations`, the same lookup `ctx.i18n.t` uses.
 */

import { useState } from "react"
import { ClipboardListIcon } from "lucide-react"

import { usePluginTranslations } from "@cognia/plugin-sdk/api/i18n"
import type { ToolResultRendererProps } from "@cognia/plugin-sdk/api/tool-renderer"
import { Button, CopyFeedbackIcon, ToolCard, useCopy, useParsedToolOutput } from "@cognia/plugin-ui"

export const PLUGIN_ID = "cognia-clipboard-history"

interface ClipboardEntry {
  text: string
  capturedAt: number
}

interface ClipboardListOutput {
  ok?: boolean
  error?: string
  privacyMode?: boolean
  entries?: ClipboardEntry[]
}

/** Entries shown before the "show all" toggle. */
export const CLIPBOARD_PREVIEW_ENTRIES = 5

const RELATIVE_UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ["year", 365 * 24 * 60 * 60 * 1000],
  ["month", 30 * 24 * 60 * 60 * 1000],
  ["week", 7 * 24 * 60 * 60 * 1000],
  ["day", 24 * 60 * 60 * 1000],
  ["hour", 60 * 60 * 1000],
  ["minute", 60 * 1000],
  ["second", 1000],
]

/**
 * The bundle's `format.locale` tag, validated. Before the plugin's bundle
 * registers (or after it unregisters while a card is still mounted) the
 * translator hands back the raw key, which `Intl` rejects — fall back to
 * English rather than crash the transcript.
 */
export function safeLocale(tag: string): string {
  try {
    return Intl.getCanonicalLocales(tag)[0] ?? "en"
  } catch {
    return "en"
  }
}

/** "3 minutes ago" / "3 分钟前" for `timestamp`, measured against `now`. */
export function formatRelative(locale: string, timestamp: number, now: number): string {
  const delta = timestamp - now
  const formatter = new Intl.RelativeTimeFormat(safeLocale(locale), { numeric: "auto" })
  for (const [unit, ms] of RELATIVE_UNITS) {
    if (Math.abs(delta) >= ms || unit === "second") {
      return formatter.format(Math.round(delta / ms), unit)
    }
  }
  return formatter.format(0, "second")
}

export function ClipboardHistoryCard({ part }: ToolResultRendererProps) {
  const t = usePluginTranslations(PLUGIN_ID)
  const parsed = useParsedToolOutput<ClipboardListOutput>((part as { output?: unknown }).output)
  const [showAll, setShowAll] = useState(false)
  // Captured once per mount: the card is a snapshot of the tool result, so
  // its "x minutes ago" is anchored to when it was first drawn.
  const [now] = useState(() => Date.now())
  const { copied, copy } = useCopy()
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null)
  if (!parsed || !Array.isArray(parsed.entries)) return null

  const locale = t("format.locale")
  const entries = [...parsed.entries]
    .filter((e): e is ClipboardEntry => Boolean(e) && typeof e.text === "string")
    .sort((a, b) => (b.capturedAt ?? 0) - (a.capturedAt ?? 0))
  const visible = showAll ? entries : entries.slice(0, CLIPBOARD_PREVIEW_ENTRIES)
  const badge =
    entries.length === 1 ? t("card.countOne") : t("card.countOther", { count: entries.length })

  return (
    <ToolCard title={t("card.title")} badge={badge} testId="clipboard-history-card">
      <div className="flex items-start gap-2">
        <ClipboardListIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <div className="min-w-0 flex-1 space-y-1">
          {parsed.privacyMode === true && (
            <p
              className="text-[11px] text-muted-foreground"
              data-testid="clipboard-history-privacy"
            >
              {t("card.privacyMode")}
            </p>
          )}
          {entries.length === 0 ? (
            <p className="text-muted-foreground">{t("card.empty")}</p>
          ) : (
            <ul className="space-y-1" data-testid="clipboard-history-entries">
              {visible.map((entry, index) => (
                <li
                  key={`${entry.capturedAt}-${index}`}
                  className="flex items-center gap-2 rounded-md bg-muted/40 px-2 py-1"
                >
                  <div className="min-w-0 flex-1">
                    <p className="line-clamp-2 break-words text-xs">{entry.text}</p>
                    {Number.isFinite(entry.capturedAt) && (
                      <time
                        dateTime={new Date(entry.capturedAt).toISOString()}
                        className="text-[11px] text-muted-foreground"
                      >
                        {formatRelative(locale, entry.capturedAt, now)}
                      </time>
                    )}
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-9 shrink-0 sm:size-7"
                    aria-label={t("card.copy")}
                    onClick={() => {
                      setCopiedIndex(index)
                      void copy(entry.text)
                    }}
                  >
                    <CopyFeedbackIcon copied={copied && copiedIndex === index} size={14} />
                  </Button>
                </li>
              ))}
            </ul>
          )}
          {entries.length > CLIPBOARD_PREVIEW_ENTRIES && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-9 px-2 text-xs sm:h-7"
              aria-expanded={showAll}
              onClick={() => setShowAll((v) => !v)}
              data-testid="clipboard-history-toggle"
            >
              {showAll ? t("card.showLess") : t("card.showAll", { count: entries.length })}
            </Button>
          )}
        </div>
      </div>
    </ToolCard>
  )
}
