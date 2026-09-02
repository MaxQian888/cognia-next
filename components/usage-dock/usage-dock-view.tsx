"use client"

/**
 * Root view of the Capacity Dock, rendered by `app/usage-dock/page.tsx` inside
 * the frameless, always-on-top `usage-dock` Tauri window (ADR-0165 Phase 2).
 *
 * The window owns no Dexie and no app stores. It renders a projection the main
 * window pushes over `usage-dock://state`, exactly like the tray quick panel,
 * which is what keeps this webview least-privilege (see
 * `src-tauri/capabilities/usage-dock.json`).
 *
 * Interaction contract, shared with every other edge rail worth using:
 *   - collapsed shows the preferred provider only,
 *   - hover expands to the selected providers,
 *   - hovering a row shows its detail, clicking a row pins that detail,
 *   - clicking outside or pressing Escape collapses,
 *   - dragging moves the rail, and releasing near an edge snaps to it.
 *
 * Hover comes from Rust, not from the DOM. A collapsed rail is click-through
 * so it cannot swallow clicks aimed at whatever sits behind it, and a
 * click-through window never receives DOM mouseenter.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useTranslations } from "next-intl"

import {
  onUsageDockGeometry,
  onUsageDockHover,
  onUsageDockState,
  requestUsageDockOpenFull,
  requestUsageDockState,
  resizeUsageDock,
  revealUsageDock,
  setUsageDockClickThrough,
  snapUsageDock,
} from "@/lib/usage-dock/client"
import { buildDockRows, collapsedRow } from "@/lib/usage-dock/rows"
import {
  DEFAULT_USAGE_DOCK_PREFERENCES,
  isVerticalEdge,
  type DockEdge,
  type UsageDockRow,
  type UsageDockState,
} from "@/lib/usage-dock/types"
import { formatGlanceMetric } from "@/lib/usage/usage-glance-format"
import { cn } from "@/lib/utils"

/** Gauge fill per severity. Same vocabulary as the tray badge colours. */
const SEVERITY_FILL: Record<UsageDockRow["severity"], string> = {
  ok: "bg-emerald-500",
  warn: "bg-amber-500",
  crit: "bg-rose-500",
  exceeded: "bg-rose-500",
  unknown: "bg-muted-foreground/40",
}

/** Extra px around the measured rail so its shadow is not clipped. */
const SHADOW_MARGIN = 12

export function UsageDockView() {
  const t = useTranslations("usageDock")
  const railRef = useRef<HTMLDivElement>(null)

  const [state, setState] = useState<UsageDockState>({
    glance: null,
    preferences: DEFAULT_USAGE_DOCK_PREFERENCES,
  })
  const [hovering, setHovering] = useState(false)
  // Two sources agree on the edge: the preference the main window pushes, and
  // the geometry Rust emits after it actually places the window. The native
  // answer wins once it arrives, because a drag-snap changes the edge without
  // the preference having been rewritten yet.
  const [nativeEdge, setNativeEdge] = useState<DockEdge | null>(null)
  const [pinnedRow, setPinnedRow] = useState<string | null>(null)
  const [detailRow, setDetailRow] = useState<string | null>(null)

  // Transparent page. The class is what `globals.css` keys the transparent
  // background off, the same seam the pet overlay and tray panel use.
  useEffect(() => {
    document.documentElement.setAttribute("data-pet-overlay", "true")
    return () => document.documentElement.removeAttribute("data-pet-overlay")
  }, [])

  // Seed + subscribe. The request is what makes a re-opened dock repaint
  // immediately rather than waiting for the next turn to push state.
  useEffect(() => {
    let disposed = false
    const offs: Array<() => void> = []
    void onUsageDockState((next) => {
      if (!disposed && next) setState(next)
    }).then((off) => (disposed ? off() : offs.push(off)))
    void onUsageDockHover((next) => {
      if (!disposed) setHovering(next)
    }).then((off) => (disposed ? off() : offs.push(off)))
    void onUsageDockGeometry((geometry) => {
      if (!disposed) setNativeEdge(geometry.edge)
    }).then((off) => (disposed ? off() : offs.push(off)))
    void requestUsageDockState()
    return () => {
      disposed = true
      offs.forEach((off) => off())
    }
  }, [])

  // Reveal after first paint. Windows renders a transparent window as a black
  // rectangle until the webview has painted once.
  useEffect(() => {
    void revealUsageDock()
  }, [])

  const edge: DockEdge = nativeEdge ?? state.preferences.edge

  const rows = useMemo(
    () =>
      state.glance
        ? buildDockRows({
            snapshot: state.glance,
            providerIds: state.preferences.providerIds,
            gaugeMode: state.preferences.gaugeMode,
          })
        : [],
    [state.glance, state.preferences.providerIds, state.preferences.gaugeMode]
  )

  const expanded = hovering || state.preferences.startExpanded || pinnedRow !== null
  const collapsed = collapsedRow(rows, state.preferences.preferredProviderId)
  const visible = expanded ? rows : collapsed ? [collapsed] : []
  const vertical = isVerticalEdge(edge)

  // Collapsed means click-through, so the rail cannot swallow a click aimed at
  // whatever is behind it. Expanded means interactive again.
  useEffect(() => {
    void setUsageDockClickThrough(!expanded)
  }, [expanded])

  // Measure and hand Rust the size. It re-places the rail against its edge,
  // which is what keeps a growing rail hugging the screen instead of drifting
  // inward and leaving a gap.
  useEffect(() => {
    const node = railRef.current
    if (!node) return
    const push = () => {
      const rect = node.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) return
      void resizeUsageDock(
        Math.ceil(rect.width) + SHADOW_MARGIN,
        Math.ceil(rect.height) + SHADOW_MARGIN
      )
    }
    push()
    const observer = new ResizeObserver(push)
    observer.observe(node)
    return () => observer.disconnect()
  }, [visible.length, vertical])

  // Escape collapses a pinned detail, the same way it dismisses any transient
  // surface. Without it a pinned row is only dismissible by clicking exactly
  // the right place, on a window with no chrome.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setPinnedRow(null)
        setDetailRow(null)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  const onDragEnd = useCallback((event: React.MouseEvent) => {
    // `screenX/Y` is the global point Rust's snap math expects. `clientX/Y`
    // would be relative to this window, which is exactly the frame being moved.
    void snapUsageDock(event.screenX, event.screenY).then((next) => {
      if (next) setNativeEdge(next)
    })
  }, [])

  const headline = state.glance ? formatGlanceMetric(state.glance) : null
  const active = pinnedRow ?? detailRow
  const activeRow = active ? rows.find((r) => r.providerId === active) : null

  return (
    <div
      className="flex min-h-screen w-screen items-center justify-center bg-transparent p-1"
      onClick={(event) => {
        // A click on the backdrop, not on a row, releases the pin.
        if (event.target === event.currentTarget) setPinnedRow(null)
      }}
    >
      <div
        ref={railRef}
        data-testid="usage-dock-rail"
        data-edge={edge}
        data-expanded={expanded ? "true" : "false"}
        className={cn(
          "flex items-stretch gap-1 rounded-xl border bg-popover/95 p-1.5 text-popover-foreground shadow-lg backdrop-blur",
          vertical ? "flex-col" : "flex-row"
        )}
        aria-label={t("title")}
      >
        {/*
          The drag handle is a real target rather than the whole rail: dragging
          from anywhere would make it impossible to click a row without the
          smallest pointer movement turning into a window move.
        */}
        <button
          type="button"
          data-tauri-drag-region
          data-testid="usage-dock-handle"
          aria-label={t("drag")}
          onMouseUp={onDragEnd}
          className={cn(
            "shrink-0 rounded-md bg-muted-foreground/20 transition-colors hover:bg-muted-foreground/35",
            vertical ? "h-1 w-full" : "h-full w-1"
          )}
        />

        {visible.length === 0 ? (
          <span
            className="px-1 py-0.5 text-[10px] text-muted-foreground"
            data-testid="usage-dock-empty"
          >
            {state.glance ? t("empty") : t("loading")}
          </span>
        ) : (
          visible.map((row) => (
            <button
              key={row.providerId}
              type="button"
              data-testid={`usage-dock-row-${row.providerId}`}
              aria-label={t("row", { provider: row.providerId, amount: row.label })}
              aria-pressed={pinnedRow === row.providerId}
              onMouseEnter={() => setDetailRow(row.providerId)}
              onMouseLeave={() => setDetailRow((cur) => (cur === row.providerId ? null : cur))}
              onClick={() =>
                setPinnedRow((cur) => (cur === row.providerId ? null : row.providerId))
              }
              className={cn(
                "flex min-w-0 items-center gap-1 rounded-md px-1 py-0.5 text-left transition-colors hover:bg-muted/60",
                pinnedRow === row.providerId && "bg-muted",
                vertical ? "flex-col" : "flex-row"
              )}
            >
              <span
                role="meter"
                aria-valuenow={row.ratio == null ? undefined : Math.round(row.ratio * 100)}
                aria-valuemin={0}
                aria-valuemax={100}
                className={cn(
                  "overflow-hidden rounded-full bg-muted",
                  vertical ? "h-1 w-8" : "h-8 w-1"
                )}
              >
                <span
                  className={cn("block rounded-full", SEVERITY_FILL[row.severity])}
                  style={
                    vertical
                      ? { width: `${Math.round((row.ratio ?? 0) * 100)}%`, height: "100%" }
                      : { height: `${Math.round((row.ratio ?? 0) * 100)}%`, width: "100%" }
                  }
                />
              </span>
              <span className="truncate text-[10px] tabular-nums">{row.label}</span>
            </button>
          ))
        )}

        {expanded && headline && (
          <button
            type="button"
            data-testid="usage-dock-total"
            onClick={() => void requestUsageDockOpenFull()}
            className="shrink-0 rounded-md px-1 py-0.5 text-[10px] font-semibold tabular-nums hover:bg-muted/60"
            aria-label={t("openFull")}
          >
            {headline}
          </button>
        )}
      </div>

      {activeRow && expanded && (
        <div
          data-testid="usage-dock-detail"
          role="status"
          className="pointer-events-none absolute bottom-1 left-1 right-1 truncate rounded-md bg-popover px-1.5 py-1 text-[10px] text-muted-foreground shadow"
        >
          {activeRow.unpricedTurns > 0
            ? t("detailPartial", {
                provider: activeRow.providerId,
                amount: activeRow.label,
                count: activeRow.unpricedTurns,
              })
            : t("detail", { provider: activeRow.providerId, amount: activeRow.label })}
        </div>
      )}
    </div>
  )
}
