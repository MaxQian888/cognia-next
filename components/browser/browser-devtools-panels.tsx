"use client"

/**
 * Console and Network readouts for the embedded browser (ADR-0127), fed by the
 * overlay's push channels (`browser://console`, `browser://network`) through
 * `useBrowserDevtools`. Pull-mode `readConsole` / `readNetwork` stay the
 * agent's path — this is the human's.
 *
 * These are bodies only: the surrounding strip, its tabs and its collapse state
 * belong to {@link BrowserToolsDock}, so the pane pays for one row of chrome
 * rather than one per readout.
 */

import { useTranslations } from "next-intl"
import { Eraser } from "lucide-react"

import type { ConsoleEntry, NetworkEntry } from "@/lib/browser/protocol"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { cn } from "@/lib/utils"

const LEVEL_CLASS: Record<ConsoleEntry["level"], string> = {
  log: "text-foreground",
  info: "text-foreground",
  debug: "text-muted-foreground",
  warn: "text-amber-600 dark:text-amber-400",
  error: "text-destructive",
}

function ClearButton({ onClear }: { onClear: () => void }) {
  const t = useTranslations("browser.devtools")
  return (
    <Button
      size="sm"
      variant="ghost"
      className="ml-auto h-7 gap-1 px-2 text-xs"
      onClick={onClear}
      data-testid="browser-devtools-clear"
    >
      <Eraser className="size-3.5" aria-hidden />
      {t("clear")}
    </Button>
  )
}

export interface BrowserConsolePanelProps {
  entries: ConsoleEntry[]
  onClear: () => void
}

export function BrowserConsolePanel({ entries, onClear }: BrowserConsolePanelProps) {
  const t = useTranslations("browser.devtools")
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center">
        <ClearButton onClear={onClear} />
      </div>
      {entries.length === 0 ? (
        <p className="py-4 text-center text-xs text-muted-foreground">{t("consoleEmpty")}</p>
      ) : (
        <ScrollArea className="max-h-48">
          <ol
            className="flex flex-col gap-0.5 font-mono text-[11px]"
            data-testid="browser-devtools-console"
          >
            {entries.map((entry, index) => (
              <li
                key={`${entry.ts}-${index}`}
                className={cn(
                  "flex items-start gap-2 whitespace-pre-wrap break-words",
                  LEVEL_CLASS[entry.level] ?? ""
                )}
                data-level={entry.level}
              >
                <span className="w-10 shrink-0 text-[10px] uppercase text-muted-foreground">
                  {entry.level}
                </span>
                <span className="min-w-0 flex-1">{entry.text}</span>
              </li>
            ))}
          </ol>
        </ScrollArea>
      )}
    </div>
  )
}

export interface BrowserNetworkPanelProps {
  entries: NetworkEntry[]
  onClear: () => void
}

export function BrowserNetworkPanel({ entries, onClear }: BrowserNetworkPanelProps) {
  const t = useTranslations("browser.devtools")
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center">
        <ClearButton onClear={onClear} />
      </div>
      {entries.length === 0 ? (
        <p className="py-4 text-center text-xs text-muted-foreground">{t("networkEmpty")}</p>
      ) : (
        <ScrollArea className="max-h-48">
          <ol
            className="flex flex-col gap-0.5 font-mono text-[11px]"
            data-testid="browser-devtools-network"
          >
            {entries.map((entry, index) => (
              <li
                key={`${entry.url}-${index}`}
                className={cn(
                  "flex items-center gap-2",
                  entry.ok === false ? "text-destructive" : "text-foreground"
                )}
                data-ok={String(entry.ok)}
              >
                <span className="w-12 shrink-0 text-[10px] text-muted-foreground">
                  {entry.method}
                </span>
                <span className="w-9 shrink-0 tabular-nums">{entry.status}</span>
                <span className="min-w-0 flex-1 truncate" title={entry.url}>
                  {entry.url}
                </span>
                {typeof entry.durationMs === "number" && (
                  <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
                    {t("durationMs", { ms: entry.durationMs })}
                  </span>
                )}
              </li>
            ))}
          </ol>
        </ScrollArea>
      )}
    </div>
  )
}
