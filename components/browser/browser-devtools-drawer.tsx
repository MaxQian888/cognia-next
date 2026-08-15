"use client"

/**
 * DevTools drawer for the embedded browser (ADR-0127): a live Console and
 * Network view fed by the overlay's push channels (`browser://console`,
 * `browser://network`) through `useBrowserDevtools`. Sits under the preview
 * pane like the recorder panel; collapsed by default so the pane's height
 * budget is untouched until the user opens it. Each stream keeps a bounded
 * ring and can be cleared independently.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { ChevronDown, ChevronUp, Eraser, TerminalSquare } from "lucide-react"

import type { ConsoleEntry, NetworkEntry } from "@/lib/browser/protocol"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { cn } from "@/lib/utils"

export interface BrowserDevtoolsDrawerProps {
  console: ConsoleEntry[]
  network: NetworkEntry[]
  problemCount: number
  failedRequests: number
  onClearConsole: () => void
  onClearNetwork: () => void
  /** Called after expand / collapse so the pane can re-measure the webview bounds. */
  onLayoutChange?: () => void
  className?: string
}

const LEVEL_CLASS: Record<ConsoleEntry["level"], string> = {
  log: "text-foreground",
  info: "text-foreground",
  debug: "text-muted-foreground",
  warn: "text-amber-600 dark:text-amber-400",
  error: "text-destructive",
}

export function BrowserDevtoolsDrawer({
  console: consoleEntries,
  network,
  problemCount,
  failedRequests,
  onClearConsole,
  onClearNetwork,
  onLayoutChange,
  className,
}: BrowserDevtoolsDrawerProps) {
  const t = useTranslations("browser.devtools")
  const [expanded, setExpanded] = useState(false)
  const [tab, setTab] = useState<"console" | "network">("console")

  const toggle = () => {
    setExpanded((value) => !value)
    // Let the DOM settle before the pane re-measures the native webview.
    if (onLayoutChange) setTimeout(onLayoutChange, 0)
  }

  return (
    <section
      className={cn("flex flex-col gap-2 border-t p-3", className)}
      aria-label={t("title")}
      data-testid="browser-devtools-drawer"
      data-expanded={expanded}
    >
      <header className="flex items-center gap-2">
        <TerminalSquare className="size-4 text-muted-foreground" aria-hidden />
        <h2 className="text-sm font-medium">{t("title")}</h2>
        {problemCount > 0 && (
          <Badge variant="destructive" data-testid="browser-devtools-problems">
            {t("problems", { count: problemCount })}
          </Badge>
        )}
        {failedRequests > 0 && (
          <Badge variant="outline" data-testid="browser-devtools-failed">
            {t("failedRequests", { count: failedRequests })}
          </Badge>
        )}
        <div className="ml-auto flex items-center gap-1">
          <Button
            size="icon"
            variant="ghost"
            className="size-7"
            aria-label={expanded ? t("collapse") : t("expand")}
            aria-expanded={expanded}
            onClick={toggle}
            data-testid="browser-devtools-toggle"
          >
            {expanded ? <ChevronDown aria-hidden /> : <ChevronUp aria-hidden />}
          </Button>
        </div>
      </header>

      {expanded && (
        <Tabs value={tab} onValueChange={(v) => setTab(v as "console" | "network")}>
          <div className="flex items-center gap-2">
            <TabsList className="h-8">
              <TabsTrigger value="console" className="text-xs">
                {t("consoleTab", { count: consoleEntries.length })}
              </TabsTrigger>
              <TabsTrigger value="network" className="text-xs">
                {t("networkTab", { count: network.length })}
              </TabsTrigger>
            </TabsList>
            <Button
              size="sm"
              variant="ghost"
              className="ml-auto h-7 gap-1 px-2 text-xs"
              onClick={tab === "console" ? onClearConsole : onClearNetwork}
              data-testid="browser-devtools-clear"
            >
              <Eraser className="size-3.5" aria-hidden />
              {t("clear")}
            </Button>
          </div>
          <TabsContent value="console" className="mt-2">
            {consoleEntries.length === 0 ? (
              <p className="py-4 text-center text-xs text-muted-foreground">{t("consoleEmpty")}</p>
            ) : (
              <ScrollArea className="max-h-48">
                <ol
                  className="flex flex-col gap-0.5 font-mono text-[11px]"
                  data-testid="browser-devtools-console"
                >
                  {consoleEntries.map((entry, index) => (
                    <li
                      key={`${entry.ts}-${index}`}
                      className={cn(
                        "flex items-start gap-2 whitespace-pre-wrap break-words",
                        LEVEL_CLASS[entry.level] ?? ""
                      )}
                      data-level={entry.level}
                    >
                      <span className="w-10 shrink-0 uppercase text-[10px] text-muted-foreground">
                        {entry.level}
                      </span>
                      <span className="min-w-0 flex-1">{entry.text}</span>
                    </li>
                  ))}
                </ol>
              </ScrollArea>
            )}
          </TabsContent>
          <TabsContent value="network" className="mt-2">
            {network.length === 0 ? (
              <p className="py-4 text-center text-xs text-muted-foreground">{t("networkEmpty")}</p>
            ) : (
              <ScrollArea className="max-h-48">
                <ol
                  className="flex flex-col gap-0.5 font-mono text-[11px]"
                  data-testid="browser-devtools-network"
                >
                  {network.map((entry, index) => (
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
                        <span className="shrink-0 tabular-nums text-[10px] text-muted-foreground">
                          {t("durationMs", { ms: entry.durationMs })}
                        </span>
                      )}
                    </li>
                  ))}
                </ol>
              </ScrollArea>
            )}
          </TabsContent>
        </Tabs>
      )}
    </section>
  )
}
