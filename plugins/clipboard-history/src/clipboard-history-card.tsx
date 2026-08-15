"use client"

/**
 * Rich chat card for the clipboard-history plugin's `clipboard_history_list`
 * tool (ADR-0127: first-party registration for the plugin tool-result
 * registry). Renders the entries as a compact list — newest first, each with
 * a locale-aware relative timestamp and a copy button — instead of the raw
 * JSON the generic tool body would show. Returns `null` for a payload without
 * an `entries` array so the host falls back.
 */

import { useState } from "react"
import { useFormatter, useTranslations } from "next-intl"
import { ClipboardListIcon } from "lucide-react"

import type { ToolResultRendererProps } from "@/lib/plugin/api/tool-result-renderers"
import { McpCardShell, useParsedOutput } from "@/components/chat/message-parts/mcp-renderers/common"
import { Button } from "@/components/ui/button"
import { CopyFeedbackIcon } from "@/components/shared/animated-action-icon"
import { useCopy } from "@/hooks/ui/use-copy"

interface ClipboardEntry {
  text: string
  capturedAt: number
}

interface ClipboardListOutput {
  ok?: boolean
  error?: string
  entries?: ClipboardEntry[]
}

/** Entries shown before the "show all" toggle. */
export const CLIPBOARD_PREVIEW_ENTRIES = 5

export function ClipboardHistoryCard({ part }: ToolResultRendererProps) {
  const t = useTranslations("chat.toolCards.clipboardHistory")
  const format = useFormatter()
  const parsed = useParsedOutput<ClipboardListOutput>((part as { output?: unknown }).output)
  const [showAll, setShowAll] = useState(false)
  const { copied, copy } = useCopy()
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null)
  if (!parsed || !Array.isArray(parsed.entries)) return null

  const entries = [...parsed.entries]
    .filter((e): e is ClipboardEntry => Boolean(e) && typeof e.text === "string")
    .sort((a, b) => (b.capturedAt ?? 0) - (a.capturedAt ?? 0))
  const visible = showAll ? entries : entries.slice(0, CLIPBOARD_PREVIEW_ENTRIES)

  return (
    <McpCardShell
      title={t("title")}
      badge={t("count", { count: entries.length })}
      testId="clipboard-history-card"
    >
      <div className="flex items-start gap-2">
        <ClipboardListIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <div className="min-w-0 flex-1 space-y-1">
          {entries.length === 0 ? (
            <p className="text-muted-foreground">{t("empty")}</p>
          ) : (
            <ul className="space-y-1" data-testid="clipboard-history-entries">
              {visible.map((entry, index) => (
                <li
                  key={`${entry.capturedAt}-${index}`}
                  className="flex items-start gap-2 rounded-md bg-muted/40 px-2 py-1"
                >
                  <div className="min-w-0 flex-1">
                    <p className="line-clamp-2 break-words text-[11px]">{entry.text}</p>
                    {Number.isFinite(entry.capturedAt) && (
                      <time
                        dateTime={new Date(entry.capturedAt).toISOString()}
                        className="text-[10px] text-muted-foreground"
                      >
                        {format.relativeTime(new Date(entry.capturedAt))}
                      </time>
                    )}
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-6 shrink-0"
                    aria-label={t("copy")}
                    onClick={() => {
                      setCopiedIndex(index)
                      void copy(entry.text)
                    }}
                  >
                    <CopyFeedbackIcon copied={copied && copiedIndex === index} size={12} />
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
              className="h-6 px-2 text-[11px]"
              aria-expanded={showAll}
              onClick={() => setShowAll((v) => !v)}
              data-testid="clipboard-history-toggle"
            >
              {showAll ? t("showLess") : t("showAll", { count: entries.length })}
            </Button>
          )}
        </div>
      </div>
    </McpCardShell>
  )
}
