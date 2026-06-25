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
 */
export function BrowserAgentIndicator({
  driver,
  lastAction,
}: {
  driver: BrowserDriver
  lastAction: string | null
}) {
  const t = useTranslations("browser")
  const isAgent = driver === "agent"
  return (
    <div
      className={cn(
        "flex items-center gap-1 rounded-md px-2 py-1 text-xs",
        isAgent ? "bg-primary/15 text-primary" : "text-muted-foreground"
      )}
      data-driver={driver}
    >
      {isAgent ? <BotIcon className="size-3.5" /> : <MousePointerIcon className="size-3.5" />}
      <span className="font-medium">{isAgent ? t("agent.driving") : t("agent.human")}</span>
      {lastAction && (
        <span className="truncate text-muted-foreground">
          {" · "}
          {t("agent.lastAction", { action: lastAction })}
        </span>
      )}
    </div>
  )
}
