"use client"

import { BotIcon, MousePointerIcon } from "lucide-react"
import { useTranslations } from "next-intl"
import { useEffect, useRef, useState } from "react"

import { onAgentActivity } from "@/lib/browser/agent-activity"
import { cn } from "@/lib/utils"

export type BrowserDriver = "human" | "agent"

/** How long the indicator stays in "agent driving" after the last action (ms). */
const AGENT_IDLE_MS = 4000

/**
 * Live driver state for the `/browser` pane: flips to `agent` whenever the
 * browser-tools engine emits an activity event, then relaxes back to `human`
 * after a short idle window. Pure subscription — no polling.
 */
export function useBrowserAgentActivity(): { driver: BrowserDriver; lastAction: string | null } {
  const [driver, setDriver] = useState<BrowserDriver>("human")
  const [lastAction, setLastAction] = useState<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const off = onAgentActivity(({ action }) => {
      setDriver("agent")
      setLastAction(action)
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => setDriver("human"), AGENT_IDLE_MS)
    })
    return () => {
      off()
      if (timer.current) clearTimeout(timer.current)
    }
  }, [])

  return { driver, lastAction }
}

/**
 * Presentational badge showing who is currently driving the preview. The
 * `lastAction` value is raw agent data (e.g. "click e3"), rendered inside the
 * localized "last action" label.
 *
 * `compact` drops to the icon alone — same element, same driver state, the
 * labels move into the hover title. A narrow right-rail toolbar cannot afford
 * ~90px for a line that reads "You're driving" 99% of the time, but the
 * agent-took-over signal still has to be visible there.
 */
export function BrowserAgentIndicator({
  driver,
  lastAction,
  compact = false,
}: {
  driver: BrowserDriver
  lastAction: string | null
  compact?: boolean
}) {
  const t = useTranslations("browser")
  const isAgent = driver === "agent"
  const label = isAgent ? t("agent.driving") : t("agent.human")
  const action = lastAction ? t("agent.lastAction", { action: lastAction }) : null
  return (
    <div
      className={cn(
        "flex min-w-0 shrink-0 items-center gap-1 rounded-md py-1 text-xs",
        compact ? "px-1" : "px-2",
        isAgent ? "bg-primary/15 text-primary" : "text-muted-foreground"
      )}
      data-driver={driver}
      {...(compact
        ? { role: "img", "aria-label": [label, action].filter(Boolean).join(" · ") }
        : {})}
    >
      {isAgent ? <BotIcon className="size-3.5" /> : <MousePointerIcon className="size-3.5" />}
      {!compact && (
        <>
          <span className="font-medium">{label}</span>
          {action && (
            <span className="truncate text-muted-foreground">
              {" · "}
              {action}
            </span>
          )}
        </>
      )}
    </div>
  )
}
