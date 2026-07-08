"use client"

/**
 * IslandShell — the Dynamic-Island interaction shell: a collapsed pill
 * summarizing the fleet ("3 agents · 1 waiting") that expands on hover/click
 * into the session list. On every layout change it reports its measured
 * content size to Rust (`island_resize`) so the frameless window hugs the
 * content and stays centered under the notch.
 *
 * A pending permission on any session force-expands the island so an approval
 * is never hidden behind the collapsed pill — derived straight from the
 * snapshot (the Rust registry sets `pendingPermission` and emits the update in
 * the same step a permission arrives), so no event/effect plumbing is needed.
 */

import { useCallback, useLayoutEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { useFleetStream } from "@/hooks/fleet/use-fleet-stream"
import { attentionCount, sortForIsland } from "@/lib/fleet/format"
import { islandResize } from "@/lib/tauri/fleet"
import { IslandRow } from "./island-row"
import { cn } from "@/lib/utils"

/** Logical widths for the two shapes (heights are measured). */
export const ISLAND_COLLAPSED_WIDTH = 420
export const ISLAND_EXPANDED_WIDTH = 560

export function IslandShell() {
  const t = useTranslations("fleet.island")
  const { snapshot } = useFleetStream()
  const [hoverExpanded, setHoverExpanded] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)

  const sessions = sortForIsland(snapshot.sessions)
  const waiting = attentionCount(snapshot.sessions)

  // A pending permission forces the island open so its Approve/Deny controls
  // are never hidden behind the collapsed pill. Derived during render from the
  // snapshot — no effect, no setState-to-mirror-a-prop.
  const forceExpanded = snapshot.sessions.some((s) => s.pendingPermission !== null)
  const expanded = hoverExpanded || forceExpanded

  // Report the measured content size to the window layer after every paint
  // where shape/content changed. useLayoutEffect: resize before the frame is
  // shown, so expand/collapse doesn't flash a clipped island.
  const width = expanded ? ISLAND_EXPANDED_WIDTH : ISLAND_COLLAPSED_WIDTH
  useLayoutEffect(() => {
    const el = rootRef.current
    if (!el) return
    void islandResize(width, Math.max(44, Math.ceil(el.getBoundingClientRect().height)))
  }, [width, expanded, sessions.length])

  const toggle = useCallback(() => setHoverExpanded((v) => !v), [])

  return (
    <div
      ref={rootRef}
      data-testid="island-shell"
      data-expanded={expanded ? "true" : "false"}
      className="select-none overflow-hidden rounded-2xl border border-white/10 bg-black/85 text-white shadow-2xl backdrop-blur-xl"
      style={{ width }}
      onMouseEnter={() => setHoverExpanded(true)}
      onMouseLeave={() => setHoverExpanded(false)}
    >
      <button
        type="button"
        data-testid="island-pill"
        onClick={toggle}
        aria-expanded={expanded}
        aria-label={t("toggle")}
        className="flex h-11 w-full items-center justify-center gap-2 px-4 text-xs text-white/80"
      >
        <span
          aria-hidden
          className={cn(
            "size-1.5 rounded-full",
            waiting > 0
              ? "animate-pulse bg-amber-400"
              : sessions.length > 0
                ? "bg-emerald-400"
                : "bg-white/30"
          )}
        />
        <span data-testid="island-summary">
          {sessions.length === 0
            ? t("empty")
            : waiting > 0
              ? t("summaryWaiting", { count: sessions.length, waiting })
              : t("summary", { count: sessions.length })}
        </span>
      </button>

      {expanded && sessions.length > 0 ? (
        <div
          className="flex max-h-[420px] flex-col gap-0.5 overflow-y-auto px-1 pb-2"
          data-testid="island-list"
        >
          {sessions.map((s) => (
            <IslandRow key={`${s.agent}:${s.sessionId}`} session={s} />
          ))}
        </div>
      ) : null}
    </div>
  )
}

export default IslandShell
