"use client"

/**
 * One compact, auto-collapsing status chip for a terminal pane.
 *
 * Replaces the permanent badge cluster that used to sit across the top of every
 * terminal. The worst offender was "Full host", which showed on essentially
 * every session (sandboxing is opt-in) and therefore covered the first row of
 * output forever. No information is lost — every state is still listed, in the
 * chip's popover — it just stops renting the terminal's first line.
 *
 * Session facts come through `useSyncExternalStore(subscribeLiveSessions, …)`.
 * The old cluster read `getLiveSession(id)?.info` *during render*, so a session
 * that gained a controller (or lost shell integration) after mount kept showing
 * the stale answer until something unrelated re-rendered the pane.
 *
 * The chip is also the home for the control lease: "Take control" for a viewer
 * and — new — "Release control" for the controller, which every session class
 * has implemented since ADR-0031 but no UI ever called.
 */

import * as React from "react"
import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { getLiveSession, subscribeLiveSessions } from "@/lib/terminal/session-registry"
import type { TerminalControlState, TerminalReplayGap } from "@/lib/terminal/types"
import { cn } from "@/lib/utils"

/** How long the chip stays expanded before collapsing to its dot. */
export const CHIP_AUTOHIDE_MS = 4000

export type TerminalChipSeverity = "info" | "warn" | "danger"

const SEVERITY_RANK: Record<TerminalChipSeverity, number> = { info: 0, warn: 1, danger: 2 }

const SEVERITY_DOT: Record<TerminalChipSeverity, string> = {
  info: "bg-muted-foreground/60",
  warn: "bg-amber-500",
  danger: "bg-red-500",
}

export interface TerminalSessionChipProps {
  sessionId: string
  controlState: TerminalControlState
  replayGap: TerminalReplayGap | null
  /** Renderer backpressure is holding this session's output back. */
  throttled?: boolean
  /** True when the transport can actually pause the producer (Tauri channel). */
  flowControlSupported?: boolean
}

interface ChipState {
  key: string
  label: string
  severity: TerminalChipSeverity
}

/** The subset of a live session's info this chip renders. */
interface SessionFacts {
  sandboxed: boolean
  currentController: string | null
  degradedReason: string | null
}

const FACTS_CACHE = new Map<string, { key: string; facts: SessionFacts }>()

/** Identity-stable snapshot of the session facts the chip reads. */
function sessionFactsSnapshot(sessionId: string): SessionFacts | null {
  const info = getLiveSession(sessionId)?.info
  if (!info) {
    FACTS_CACHE.delete(sessionId)
    return null
  }
  const facts: SessionFacts = {
    sandboxed: info.sandboxed === true,
    currentController: info.currentController ?? null,
    degradedReason: info.integrationCapabilities?.degradedReason ?? null,
  }
  const key = `${facts.sandboxed}|${facts.currentController}|${facts.degradedReason}`
  const cached = FACTS_CACHE.get(sessionId)
  if (cached && cached.key === key) return cached.facts
  const frozen = Object.freeze(facts)
  FACTS_CACHE.set(sessionId, { key, facts: frozen })
  return frozen
}

export function TerminalSessionChip({
  sessionId,
  controlState,
  replayGap,
  throttled = false,
  flowControlSupported = false,
}: TerminalSessionChipProps) {
  const t = useTranslations("terminal.sessionState")
  const [open, setOpen] = React.useState(false)
  const [collapsed, setCollapsed] = React.useState(false)
  const [hovered, setHovered] = React.useState(false)

  // Live session facts, reactively.
  //
  // `useSyncExternalStore` demands a snapshot whose *identity* only changes when
  // the value does, so this cannot just hand back `getLiveSession(id)?.info` —
  // any registry (or test double) that rebuilds the object per call would spin
  // React forever. `sessionFactsSnapshot` caches per session id and only mints a
  // new object when one of the fields this chip reads actually changes.
  const getSnapshot = React.useCallback(() => sessionFactsSnapshot(sessionId), [sessionId])
  const info = React.useSyncExternalStore(subscribeLiveSessions, getSnapshot, () => null)

  const states: ChipState[] = []
  if (controlState.role === "viewer") {
    states.push({ key: "readOnly", label: t("readOnly"), severity: "warn" })
  }
  if (replayGap) {
    states.push({
      key: "replayGap",
      label: t("replayGap", {
        first: replayGap.firstAvailable,
        last: replayGap.lastAvailable,
      }),
      severity: "warn",
    })
  }
  if (info?.sandboxed) {
    states.push({ key: "sandboxed", label: t("sandboxed"), severity: "info" })
  } else if (info) {
    states.push({ key: "fullHost", label: t("fullHost"), severity: "danger" })
  }
  if (info?.degradedReason) {
    states.push({ key: "degraded", label: t("integrationDegraded"), severity: "warn" })
  }
  if (throttled) {
    states.push({
      key: "throttled",
      // Be honest about which kind of throttling this is: only the local
      // channel can stop the producer; the rest buffer in the renderer.
      label: flowControlSupported ? t("outputThrottled") : t("outputThrottledBuffered"),
      severity: "warn",
    })
  }

  const severity = states.reduce<TerminalChipSeverity>(
    (worst, state) =>
      SEVERITY_RANK[state.severity] > SEVERITY_RANK[worst] ? state.severity : worst,
    "info"
  )
  const headline = states.find((state) => state.severity === severity) ?? states[0]

  // Re-expand whenever the severity rises — a session going from "sandboxed" to
  // "read-only" is exactly when the user should see the chip again.
  const severityRef = React.useRef(severity)
  React.useEffect(() => {
    if (SEVERITY_RANK[severity] > SEVERITY_RANK[severityRef.current]) {
      setCollapsed(false)
    }
    severityRef.current = severity
  }, [severity])

  React.useEffect(() => {
    if (collapsed || open || hovered) return
    const timer = setTimeout(() => setCollapsed(true), CHIP_AUTOHIDE_MS)
    return () => clearTimeout(timer)
  }, [collapsed, open, hovered, severity])

  if (!headline) return null

  const showLabel = !collapsed || hovered || open
  const summary = t("chipLabel", { state: headline.label })

  const canRelease = controlState.role === "controller" && info?.currentController != null

  return (
    <div className="pointer-events-none absolute right-2 top-1 z-30 flex justify-end">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            data-testid="terminal-session-chip"
            data-severity={severity}
            data-collapsed={collapsed && !hovered && !open ? "true" : "false"}
            aria-label={summary}
            title={summary}
            onMouseEnter={() => setHovered(true)}
            onMouseLeave={() => setHovered(false)}
            onFocus={() => setHovered(true)}
            onBlur={() => setHovered(false)}
            className={cn(
              "pointer-events-auto flex max-w-[13rem] items-center gap-1.5 rounded-full border",
              "bg-background/90 px-2 py-0.5 text-[11px] shadow-sm backdrop-blur transition-all",
              "hover:bg-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              showLabel ? "pr-2" : "px-1.5"
            )}
          >
            <span
              aria-hidden
              className={cn(
                "inline-block h-1.5 w-1.5 shrink-0 rounded-full",
                SEVERITY_DOT[severity]
              )}
            />
            {showLabel ? <span className="truncate">{headline.label}</span> : null}
          </button>
        </PopoverTrigger>
        <PopoverContent
          align="end"
          className="w-72 space-y-2 text-xs"
          data-testid="terminal-session-chip-details"
        >
          <p className="font-medium">{t("chipDetails")}</p>
          <ul className="space-y-1">
            {states.map((state) => (
              <li key={state.key} className="flex items-start gap-2" data-state-key={state.key}>
                <span
                  aria-hidden
                  className={cn(
                    "mt-1 inline-block h-1.5 w-1.5 shrink-0 rounded-full",
                    SEVERITY_DOT[state.severity]
                  )}
                />
                <span className="text-muted-foreground">{state.label}</span>
              </li>
            ))}
          </ul>
          {controlState.role === "viewer" ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 w-full text-[11px]"
              data-testid="terminal-chip-take-control"
              onClick={() => {
                if (!window.confirm(t("takeoverConfirm"))) return
                void getLiveSession(sessionId)?.takeControl()
              }}
            >
              {t("takeControl")}
            </Button>
          ) : null}
          {canRelease ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 w-full text-[11px]"
              data-testid="terminal-chip-release-control"
              onClick={() => {
                if (!window.confirm(t("releaseConfirm"))) return
                void getLiveSession(sessionId)?.releaseControl()
              }}
            >
              {t("releaseControl")}
            </Button>
          ) : null}
        </PopoverContent>
      </Popover>
    </div>
  )
}

export default TerminalSessionChip
