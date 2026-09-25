"use client"

/**
 * The preview pane's single bottom strip.
 *
 * The recorder and the DevTools readouts each used to own a permanently
 * mounted `border-t` section of their own, stacked, and the recorder started
 * expanded — so an empty pane spent roughly 100px on chrome for a page that
 * had not been loaded yet. The pane's narrowest host is the chat rail at 24%
 * of the window, where that is most of the vertical budget.
 *
 * One collapsed strip carries all of them, and the pane only mounts it once a
 * page is committed. Expanding, collapsing and switching tabs all report
 * `onLayoutChange`: the native webview floats above React and is positioned
 * from a measured rect, so it has to be re-measured whenever this strip
 * changes height.
 *
 * The recorder and developer bodies are stateful — a take in progress, a live
 * CDP grant — so they stay mounted while hidden. Unmounting them on collapse
 * or on a tab switch cancelled the take and revoked the grant the moment the
 * user glanced at the console. The console and network bodies are pure views
 * over the pane's rings and are only rendered while on screen.
 */

import { type ReactNode, useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { ChevronDown, ChevronUp, TerminalSquare } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { cn } from "@/lib/utils"

export type BrowserToolsTab = "recorder" | "console" | "network" | "developer"

export interface BrowserToolsDockProps {
  recorder: ReactNode
  console: ReactNode
  network: ReactNode
  /** Absent when the pane has no chat session to attach a grant to. */
  developer?: ReactNode
  consoleCount: number
  networkCount: number
  problemCount: number
  failedRequests: number
  /** Steps captured in the live take, if one is running. */
  recordingSteps?: number | null
  /**
   * Ask the dock to expand at a tab. `nonce` is what makes a repeat request
   * land: the toolbar's developer button asks for the same tab every time, so
   * comparing the tab alone would only ever work once.
   */
  openRequest?: { tab: BrowserToolsTab; nonce: number } | null
  /** Re-measure the sibling native webview after this strip changes height. */
  onLayoutChange?: () => void
  /**
   * Whether the readouts are on screen. A host that has to poll for them (the
   * remote engine has no push channel) can slow down while they are not.
   */
  onExpandedChange?: (expanded: boolean) => void
  className?: string
}

/** A status mark on a tab, for widths where the badges no longer fit. */
function TriggerDot({ tone, pulse = false }: { tone: "destructive" | "muted"; pulse?: boolean }) {
  return (
    <span
      aria-hidden
      data-testid="browser-tools-dot"
      className={cn(
        "size-1.5 shrink-0 rounded-full @md/browser-tools:hidden",
        tone === "destructive" ? "bg-destructive" : "bg-muted-foreground",
        pulse && "animate-pulse"
      )}
    />
  )
}

export function BrowserToolsDock({
  recorder,
  console: consolePanel,
  network,
  developer,
  consoleCount,
  networkCount,
  problemCount,
  failedRequests,
  recordingSteps = null,
  openRequest = null,
  onLayoutChange,
  onExpandedChange,
  className,
}: BrowserToolsDockProps) {
  const t = useTranslations("browser")
  const [expanded, setExpanded] = useState(false)
  const [tab, setTab] = useState<BrowserToolsTab>("recorder")
  const recording = typeof recordingSteps === "number"

  // A request from outside (the toolbar's developer button) both expands the
  // dock and selects its tab. Adjust-state-on-prop-change rather than an
  // effect, so the dock never paints one frame in the wrong state.
  const [seenNonce, setSeenNonce] = useState(0)
  if (openRequest && openRequest.nonce !== seenNonce) {
    setSeenNonce(openRequest.nonce)
    setTab(openRequest.tab)
    setExpanded(true)
  }

  const onExpandedChangeRef = useRef(onExpandedChange)
  useEffect(() => {
    onExpandedChangeRef.current = onExpandedChange
  }, [onExpandedChange])
  useEffect(() => {
    onExpandedChangeRef.current?.(expanded)
  }, [expanded])

  // Let the DOM settle before the pane re-measures the native webview.
  const settleLayout = () => {
    if (onLayoutChange) setTimeout(onLayoutChange, 0)
  }

  const selectTab = (next: string) => {
    setTab(next as BrowserToolsTab)
    if (!expanded) setExpanded(true)
    settleLayout()
  }

  // Radix fires no value change for the tab that is already selected, so the
  // collapsed strip's active tab needs its own way to open the dock.
  const openActiveTab = (value: BrowserToolsTab) => {
    if (expanded || value !== tab) return
    setExpanded(true)
    settleLayout()
  }

  const toggle = () => {
    setExpanded((value) => !value)
    settleLayout()
  }

  const showing = (value: BrowserToolsTab) => expanded && tab === value
  const bodyMotion = "animate-in fade-in-0 duration-150 ease-out"

  return (
    <section
      className={cn("@container/browser-tools flex flex-col border-t px-2 py-1.5", className)}
      aria-label={t("tools.label")}
      data-testid="browser-tools-dock"
      data-expanded={expanded}
      data-tab={tab}
    >
      <Tabs value={tab} onValueChange={selectTab} className="gap-0">
        <div className="flex min-w-0 items-center gap-2">
          <TerminalSquare
            className="hidden size-4 shrink-0 text-muted-foreground @sm/browser-tools:block"
            aria-hidden
          />
          {/* The list scrolls sideways rather than wrapping or pushing the
              toggle out of the pane — the chat rail can be ~300px wide. */}
          <div className="min-w-0 flex-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            <TabsList className="h-7 w-max">
              <TabsTrigger
                value="recorder"
                className="text-xs"
                onClick={() => openActiveTab("recorder")}
              >
                {t("tools.tabs.recorder")}
                {recording && <TriggerDot tone="destructive" pulse />}
              </TabsTrigger>
              <TabsTrigger
                value="console"
                className="text-xs"
                onClick={() => openActiveTab("console")}
              >
                {t("devtools.consoleTab", { count: consoleCount })}
                {problemCount > 0 && <TriggerDot tone="destructive" />}
              </TabsTrigger>
              <TabsTrigger
                value="network"
                className="text-xs"
                onClick={() => openActiveTab("network")}
              >
                {t("devtools.networkTab", { count: networkCount })}
                {failedRequests > 0 && <TriggerDot tone="muted" />}
              </TabsTrigger>
              {developer && (
                <TabsTrigger
                  value="developer"
                  className="text-xs"
                  onClick={() => openActiveTab("developer")}
                >
                  {t("tools.tabs.developer")}
                </TabsTrigger>
              )}
            </TabsList>
          </div>
          {/* Badges live outside the tabs so a collapsed dock still says why it
              is worth opening. Below the container breakpoint they give way to
              the dots on the tabs, but stay readable to a screen reader. */}
          <div className="sr-only @md/browser-tools:not-sr-only @md/browser-tools:flex @md/browser-tools:shrink-0 @md/browser-tools:items-center @md/browser-tools:gap-1.5">
            {recording && (
              <Badge variant="destructive" data-testid="browser-tools-recording">
                {t("record.recording", { count: recordingSteps })}
              </Badge>
            )}
            {problemCount > 0 && (
              <Badge variant="destructive" data-testid="browser-devtools-problems">
                {t("devtools.problems", { count: problemCount })}
              </Badge>
            )}
            {failedRequests > 0 && (
              <Badge variant="outline" data-testid="browser-devtools-failed">
                {t("devtools.failedRequests", { count: failedRequests })}
              </Badge>
            )}
          </div>
          <Button
            size="icon"
            variant="ghost"
            className="size-7 shrink-0"
            aria-label={expanded ? t("tools.collapse") : t("tools.expand")}
            aria-expanded={expanded}
            onClick={toggle}
            data-testid="browser-tools-toggle"
          >
            {expanded ? <ChevronDown aria-hidden /> : <ChevronUp aria-hidden />}
          </Button>
        </div>

        {/* Always mounted: it hosts the stateful bodies. Capped so an expanded
            dock cannot squeeze the page out of a short pane. */}
        <div
          hidden={!expanded}
          data-testid="browser-tools-body"
          className={cn(
            "mt-2 max-h-[min(45vh,24rem)] overflow-y-auto overscroll-contain px-1 pb-1",
            bodyMotion,
            "slide-in-from-bottom-1"
          )}
        >
          <TabsContent
            value="recorder"
            forceMount
            hidden={tab !== "recorder"}
            className={bodyMotion}
          >
            {recorder}
          </TabsContent>
          {showing("console") && (
            <TabsContent value="console" className={bodyMotion}>
              {consolePanel}
            </TabsContent>
          )}
          {showing("network") && (
            <TabsContent value="network" className={bodyMotion}>
              {network}
            </TabsContent>
          )}
          {developer && (
            <TabsContent
              value="developer"
              forceMount
              hidden={tab !== "developer"}
              className={bodyMotion}
            >
              {developer}
            </TabsContent>
          )}
        </div>
      </Tabs>
    </section>
  )
}
