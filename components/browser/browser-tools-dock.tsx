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
 */

import { type ReactNode, useState } from "react"
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
  recordingSteps?: number
  /**
   * Ask the dock to expand at a tab. `nonce` is what makes a repeat request
   * land: the toolbar's developer button asks for the same tab every time, so
   * comparing the tab alone would only ever work once.
   */
  openRequest?: { tab: BrowserToolsTab; nonce: number } | null
  /** Re-measure the sibling native webview after this strip changes height. */
  onLayoutChange?: () => void
  className?: string
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
  recordingSteps,
  openRequest = null,
  onLayoutChange,
  className,
}: BrowserToolsDockProps) {
  const t = useTranslations("browser")
  const [expanded, setExpanded] = useState(false)
  const [tab, setTab] = useState<BrowserToolsTab>("recorder")

  // A request from outside (the toolbar's developer button) both expands the
  // dock and selects its tab. Adjust-state-on-prop-change rather than an
  // effect, so the dock never paints one frame in the wrong state.
  const [seenNonce, setSeenNonce] = useState(0)
  if (openRequest && openRequest.nonce !== seenNonce) {
    setSeenNonce(openRequest.nonce)
    setTab(openRequest.tab)
    setExpanded(true)
  }

  // Let the DOM settle before the pane re-measures the native webview.
  const settleLayout = () => {
    if (onLayoutChange) setTimeout(onLayoutChange, 0)
  }

  const selectTab = (next: string) => {
    setTab(next as BrowserToolsTab)
    settleLayout()
  }

  const toggle = () => {
    setExpanded((value) => !value)
    settleLayout()
  }

  return (
    <section
      className={cn("flex flex-col gap-2 border-t px-3 py-2", className)}
      aria-label={t("tools.label")}
      data-testid="browser-tools-dock"
      data-expanded={expanded}
      data-tab={tab}
    >
      <Tabs value={tab} onValueChange={selectTab}>
        <div className="flex items-center gap-2">
          <TerminalSquare className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <TabsList className="h-7">
            <TabsTrigger value="recorder" className="text-xs">
              {t("tools.tabs.recorder")}
            </TabsTrigger>
            <TabsTrigger value="console" className="text-xs">
              {t("devtools.consoleTab", { count: consoleCount })}
            </TabsTrigger>
            <TabsTrigger value="network" className="text-xs">
              {t("devtools.networkTab", { count: networkCount })}
            </TabsTrigger>
            {developer && (
              <TabsTrigger value="developer" className="text-xs">
                {t("tools.tabs.developer")}
              </TabsTrigger>
            )}
          </TabsList>
          {/* Badges live outside the tabs so a collapsed dock still says why it
              is worth opening. */}
          {typeof recordingSteps === "number" && (
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
          <Button
            size="icon"
            variant="ghost"
            className="ml-auto size-7 shrink-0"
            aria-label={expanded ? t("tools.collapse") : t("tools.expand")}
            aria-expanded={expanded}
            onClick={toggle}
            data-testid="browser-tools-toggle"
          >
            {expanded ? <ChevronDown aria-hidden /> : <ChevronUp aria-hidden />}
          </Button>
        </div>

        {expanded && (
          <>
            <TabsContent value="recorder" className="mt-2">
              {recorder}
            </TabsContent>
            <TabsContent value="console" className="mt-2">
              {consolePanel}
            </TabsContent>
            <TabsContent value="network" className="mt-2">
              {network}
            </TabsContent>
            {developer && (
              <TabsContent value="developer" className="mt-2">
                {developer}
              </TabsContent>
            )}
          </>
        )}
      </Tabs>
    </section>
  )
}
