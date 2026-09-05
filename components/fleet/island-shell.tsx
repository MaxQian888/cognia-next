"use client"

/**
 * The Dynamic-Island interaction shell for the unified task control island.
 *
 * Three presentations, following Apple's Live Activities vocabulary:
 *   - Minimal: a thin strip at the very top edge carrying only a count, shown
 *     while the island is tucked away.
 *   - Compact: the pill, carrying the single highest-priority task (its source,
 *     its name, its state and its safe summary).
 *   - Expanded: the full list of tasks and pending items with the actions that
 *     are genuinely available for each.
 *
 * The window renders a projection the main window pushes over `island://state`
 * and nothing else. It reads no store, no Dexie and no business control plane,
 * and every button emits a typed intent the main window re-validates. That is
 * what keeps this webview least-privilege (see `src-tauri/capabilities`).
 *
 * On every layout change it reports its measured content size to Rust
 * (`island_resize`) so the frameless window hugs the content and stays centered
 * under the notch.
 *
 * Auto-hide (Apple-Dock style): when nothing needs the user and no pointer is
 * over the window, the pill tucks up after a grace delay, leaving a thin sliver
 * at the very top edge. The window keeps its full height while tucked, so the
 * transparent area doubles as the hover target and moving the mouse to the top
 * centre of the screen slides the island back out. The tuck is a pure CSS
 * transform, so the window itself never moves and there is no cross-process
 * jitter.
 *
 * A pending item that the user can actually answer force-expands the island so
 * an approval is never hidden behind the collapsed pill. Derived straight from
 * the projection, so no event or effect plumbing is needed.
 *
 * Notch handling: the window is anchored to the TRUE top edge of the display
 * (Space-independent, see `island_window.rs`) and spans the camera-housing
 * strip so slam-to-top hover always lands on it. Inside that strip only a
 * column as wide as the housing itself is painted (`notchWidth`, from the
 * auxiliary areas macOS reports beside the housing), so the card grows out of
 * the housing like a Dynamic Island while the menu bar's titles and status
 * items beside it stay visible. The card's surface starts below the top
 * safe-area inset (both returned by `island_resize` and pushed via
 * `fleet://island-geometry`), so nothing is ever hidden behind the housing.
 * When the OS reports no housing width the whole strip is painted, the
 * pre-`notchWidth` look.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { useTranslations } from "next-intl"

import { useIslandActions } from "@/hooks/island/use-island-actions"
import { useIslandDetail } from "@/hooks/island/use-island-detail"
import { useIslandState } from "@/hooks/island/use-island-state"
import { normalizeIslandGeometry } from "@/lib/fleet/format"
import {
  FLEET_ISLAND_GEOMETRY_EVENT,
  FLEET_ISLAND_HOVER_EVENT,
  type IslandGeometry,
  type IslandHover,
} from "@/lib/fleet/types"
import type { IslandRowProjection } from "@/lib/island/types"
import { isTauri } from "@/lib/tauri"
import { islandResize, islandSetTucked } from "@/lib/tauri/fleet"
import { safeUnlisten } from "@/lib/tauri/safe-unlisten"
import { cn } from "@/lib/utils"
import { IslandTaskRow } from "./island-task-row"

/** Logical widths for the two shapes (heights are measured). */
export const ISLAND_COLLAPSED_WIDTH = 420
export const ISLAND_EXPANDED_WIDTH = 560
/** Collapsed pill height (kept in lockstep with the `h-11` pill button). */
export const ISLAND_PILL_HEIGHT = 44
/** Sliver left visible at the top edge while the island is tucked away. */
export const ISLAND_PEEK_HEIGHT = 6
/** Grace delay before an idle, empty island tucks itself away. */
export const ISLAND_TUCK_DELAY_MS = 1500
/** Window-shrink deferral: the 300ms width transition plus a settle margin. */
export const ISLAND_SHRINK_SETTLE_MS = 320
/**
 * Window height (logical px) while the island is fully withdrawn on a
 * full-screen Space. Not zero, because a zero-sized window is a degenerate
 * case for the OS window layer and Rust clamps it to 1 anyway.
 */
export const ISLAND_HIDDEN_HEIGHT = 1
/** Per-row entrance stagger step in the expanded list. */
export const ISLAND_ROW_STAGGER_MS = 30
/**
 * Row count from which rows switch to their compact shape.
 *
 * A row can render several stacked blocks, so three busy tasks already fill the
 * list's 420px cap and the rest scroll out of sight. Past this threshold the
 * rows keep only what the user must act on and fold the rest behind their pin.
 */
export const ISLAND_COMPACT_THRESHOLD = 4

/** A row the user can answer from here, which is what force-expands the island. */
function isActionable(row: IslandRowProjection): boolean {
  return (
    row.status === "blocked" &&
    (row.capabilities.permissionDecision || row.capabilities.questionResponse)
  )
}

export function IslandShell() {
  const t = useTranslations("fleet.island")
  const state = useIslandState()
  const { statusOf, dispatch } = useIslandActions()
  const [hovering, setHovering] = useState(false)
  const [pinnedOpen, setPinnedOpen] = useState(false)
  const [tucked, setTucked] = useState(false)
  const [topInset, setTopInset] = useState(0)
  const [notchWidth, setNotchWidth] = useState(0)
  const [fullscreen, setFullscreen] = useState(false)
  // At most one row is pinned. Pinning is what authorizes a detail request
  // under the default `click-to-reveal` policy.
  const [pinnedRowId, setPinnedRowId] = useState<string | null>(null)
  const cardRef = useRef<HTMLDivElement | null>(null)
  // Measured separately from the card: the card's height is the animated
  // value, so measuring it would feed the animation back into itself.
  const contentRef = useRef<HTMLDivElement | null>(null)
  const geometryRef = useRef<IslandGeometry>({ topInset: 0, notchWidth: 0, fullscreen: false })

  const rows = state.rows
  const waiting = state.attentionCount
  const empty = rows.length === 0
  const top = rows[0]

  // Display geometry for the island's screen. `topInset` is the notch height
  // and `fullscreen` says the island should yield this display to a full-screen
  // app (the raw Space verdict AND the user's opt-in, already combined by Rust).
  // Both arrive two ways: as the return of every `island_resize` and as a
  // `fleet://island-geometry` push when Rust notices a Space or monitor change.
  // Ref-guarded so an unchanged sample never schedules a state update.
  const applyGeometry = useCallback((raw: unknown) => {
    const next = normalizeIslandGeometry(raw)
    const prev = geometryRef.current
    if (
      prev.topInset === next.topInset &&
      prev.notchWidth === next.notchWidth &&
      prev.fullscreen === next.fullscreen
    )
      return
    geometryRef.current = next
    setTopInset(next.topInset)
    setNotchWidth(next.notchWidth)
    setFullscreen(next.fullscreen)
  }, [])

  useEffect(() => {
    if (!isTauri()) return undefined
    let alive = true
    const unlistens: (() => void)[] = []
    void (async () => {
      // Dynamic import keeps the Tauri event module out of web bundles.
      const { listen } = await import("@tauri-apps/api/event")
      if (!alive) return
      const uns = await Promise.all([
        listen<IslandGeometry>(FLEET_ISLAND_GEOMETRY_EVENT, (e) => {
          if (alive) applyGeometry(e.payload)
        }),
        // Authoritative hover: while tucked the window is click-through, so the
        // DOM never sees mouseenter. Rust polls the global cursor and pushes
        // enter and leave transitions, which also self-heals a `hovering` stuck
        // true by a missed mouseleave.
        listen<IslandHover>(FLEET_ISLAND_HOVER_EVENT, (e) => {
          if (alive) setHovering(e.payload?.hovering === true)
        }),
      ])
      if (!alive) {
        uns.forEach(safeUnlisten)
        return
      }
      unlistens.push(...uns)
    })()
    return () => {
      alive = false
      unlistens.forEach(safeUnlisten)
    }
  }, [applyGeometry])

  const compactRows = rows.length >= ISLAND_COMPACT_THRESHOLD
  const legendSegments = useMemo(() => {
    const counts = { blocked: 0, failed: 0, working: 0, done: 0, idle: 0, stale: 0 }
    for (const row of rows) counts[row.status] += 1
    return [
      { key: "blocked", count: counts.blocked, dot: "bg-amber-400" },
      { key: "failed", count: counts.failed, dot: "bg-red-400" },
      { key: "working", count: counts.working, dot: "bg-emerald-400" },
      { key: "done", count: counts.done, dot: "bg-white/25" },
      { key: "idle", count: counts.idle, dot: "bg-white/40" },
      { key: "stale", count: counts.stale, dot: "bg-slate-400/40" },
    ].filter((segment) => segment.count > 0)
  }, [rows])

  // An answerable pending item forces the island open so its controls are never
  // hidden behind the collapsed pill. Derived during render from the pushed
  // projection: no effect, no setState-to-mirror-a-prop.
  const forceExpanded = rows.some(isActionable)

  // A pin outlives its purpose once the list empties: the user pinned something
  // that no longer exists, and a stale pin blocked auto-tuck forever.
  if (pinnedOpen && empty) {
    setPinnedOpen(false)
  }
  // Same for a pinned ROW that left the projection. Dropping the id is also what
  // clears its detail, so a revealed detail cannot outlive its target.
  if (pinnedRowId && !rows.some((row) => row.id === pinnedRowId)) {
    setPinnedRowId(null)
  }
  const expanded = ((hovering || pinnedOpen) && !empty) || forceExpanded

  // Which row, if any, may receive detail right now. `click-to-reveal` needs an
  // explicit pin. `hover` lets an expanded island reveal its top row. Under
  // `summary-only` the answer is always "none", and the main window refuses the
  // request as well, so the policy holds on both sides of the bridge.
  const detailRowId =
    state.detailVisibility === "summary-only"
      ? null
      : (pinnedRowId ?? (state.detailVisibility === "hover" && expanded ? (top?.id ?? null) : null))
  const detailRow = detailRowId ? rows.find((row) => row.id === detailRowId) : undefined
  const detailSlot = useIslandDetail(
    expanded ? detailRowId : null,
    state.revision,
    detailRow?.updatedAt ?? 0
  )

  // Signature of everything that changes a row's rendered height. The resize
  // effect keys on it so content growing inside an already-expanded island
  // still re-reports the window size. The detail answer lands asynchronously
  // AFTER the pin flipped, so its presence is part of the signature too.
  const contentKey = rows
    .map(
      (row) =>
        `${row.id}:${row.status}:${row.permission ? 1 : 0}:${row.question ? 1 : 0}:` +
        `${row.summary ? 1 : 0}:${pinnedRowId === row.id ? 1 : 0}:` +
        `${detailSlot.rowId === row.id && (detailSlot.detail || detailSlot.error) ? 1 : 0}`
    )
    .join("|")

  const togglePin = useCallback((rowId: string) => {
    setPinnedRowId((prev) => (prev === rowId ? null : rowId))
  }, [])

  // Auto-tuck: an un-hovered, un-pinned island with nothing that needs the user
  // hides. A task that starts waiting (or the pointer entering the window)
  // cancels the pending tuck and slides the pill back out immediately. The reset
  // is a render-time state adjustment, React's "adjusting state when props
  // change" pattern. The effect only ever arms and disarms the tuck timer.
  const shouldTuck = waiting === 0 && !hovering && !pinnedOpen && !forceExpanded
  if (tucked && !shouldTuck) {
    setTucked(false)
  }

  // Full-screen Space, and only when the user asked for this: `fullscreen`
  // arrives ALREADY gated by the "hide under full-screen apps" preference,
  // which ships off. When it is on the island withdraws completely and
  // materializes only when a task actually needs the user. Hover reveal is
  // deliberately not a way back in here, because slamming to the top of a
  // full-screen app is how you reach that app's own menu bar. A pin the user
  // placed before going full-screen still wins.
  const hiddenEntirely = fullscreen && waiting === 0 && !pinnedOpen && !forceExpanded
  useEffect(() => {
    if (!shouldTuck) return undefined
    const timer = setTimeout(() => setTucked(true), ISLAND_TUCK_DELAY_MS)
    return () => clearTimeout(timer)
  }, [shouldTuck])

  // Mirror the non-interactive state to the window layer: a tucked island's
  // window turns click-through so the invisible strip under the notch cannot
  // swallow clicks meant for the menu bar behind it. Untucking restores
  // interactivity, and the reveal path stays alive via `fleet://island-hover`.
  const clickThrough = tucked || hiddenEntirely
  // Mirrored into a ref inside the effect (writing a ref during render is
  // blocked by `react-hooks/refs`) so the deferred-shrink path below restores
  // the CURRENT interactivity when its timer fires.
  const clickThroughRef = useRef(clickThrough)
  useEffect(() => {
    clickThroughRef.current = clickThrough
    void islandSetTucked(clickThrough)
  }, [clickThrough])

  // Escape collapses the island and drops any pinned detail. Keyboard parity
  // with the click-outside gesture a frameless overlay cannot receive.
  useEffect(() => {
    if (!expanded) return undefined
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      setPinnedRowId(null)
      setPinnedOpen(false)
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [expanded])

  // Measure the content, drive the card's animated height, and report the
  // window size, all in one layout effect because they must agree.
  //
  // The card's height is written straight to the DOM node rather than held in
  // state: a measurement can only be taken in an effect, and this repo's
  // `react-hooks/set-state-in-effect` rule blocks setState there. Writing the
  // animated property imperatively sidesteps the round-trip entirely and the
  // CSS transition animates it exactly the same way.
  //
  // Grow-now, shrink-later: the card animates over 300ms but the OS window
  // resize is instant. Growing ahead of the animation is invisible, because the
  // extra area is transparent. Shrinking instantly would clip the still
  // animating card at the window edge, so a shrink is deferred.
  const width = expanded ? ISLAND_EXPANDED_WIDTH : ISLAND_COLLAPSED_WIDTH

  // Growth the signature cannot see (an action-error line, a wrapped detail
  // body) is caught by observing the content node itself; the tick joins the
  // resize effect's deps. jsdom has no ResizeObserver, so the signature above
  // remains the tested path.
  const [contentTick, setContentTick] = useState(0)
  useEffect(() => {
    const node = contentRef.current
    if (!node || typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(() => setContentTick((tick) => tick + 1))
    observer.observe(node)
    return () => observer.disconnect()
  }, [hiddenEntirely])

  const lastSizeRef = useRef({ w: 0, h: 0 })
  const lastInsetRef = useRef(0)
  useLayoutEffect(() => {
    const card = cardRef.current
    // While withdrawn there is no card to measure. The window still has to be
    // told to shrink, so this path reports a fixed sliver instead of bailing.
    if (!card && !hiddenEntirely) return
    // Rust grows the window by the display's top inset and returns the full
    // geometry. `Promise.resolve` tolerates test doubles that return undefined.
    const report = (w: number, h: number) => {
      void Promise.resolve(islandResize(w, h)).then(applyGeometry)
    }

    const content = contentRef.current
    const measured = content ? Math.ceil(content.getBoundingClientRect().height) : 0
    const height = hiddenEntirely
      ? ISLAND_HIDDEN_HEIGHT
      : expanded
        ? Math.max(ISLAND_PILL_HEIGHT, measured)
        : ISLAND_PILL_HEIGHT
    // `height` is the CONTENT height Rust is told about (it grows the window by
    // the inset itself). The card also covers the notch strip above that
    // content, so its own box is taller by exactly the inset.
    if (card) card.style.height = `${height + topInset}px`

    const prev = lastSizeRef.current
    const growW = Math.max(width, prev.w)
    const growH = Math.max(height, prev.h)
    // An inset change (monitor switch) must re-issue the same content size: the
    // window height is content plus inset, so it changed even if we did not.
    const insetChanged = lastInsetRef.current !== topInset
    if (growW !== prev.w || growH !== prev.h || insetChanged) {
      lastSizeRef.current = { w: growW, h: growH }
      lastInsetRef.current = topInset
      report(growW, growH)
    }
    if (width >= growW && height >= growH) return

    // A shrink is pending, so for the next ~320ms the window is larger than
    // what is painted in it. That surplus is transparent but still hit-tested
    // and sits at the top-centre of the screen. Make the window click-through
    // for the duration, but ONLY when the pointer is not on the island: a task
    // ending while the user hovers the list also shrinks it, and going
    // click-through there would eat the click they are about to make.
    const surplusIsDead = !hovering && !pinnedOpen
    if (surplusIsDead) void islandSetTucked(true)
    const restore = () => {
      if (surplusIsDead) void islandSetTucked(clickThroughRef.current)
    }
    const timer = setTimeout(() => {
      lastSizeRef.current = { w: width, h: height }
      report(width, height)
      restore()
    }, ISLAND_SHRINK_SETTLE_MS)
    return () => {
      clearTimeout(timer)
      restore()
    }
  }, [
    width,
    expanded,
    hiddenEntirely,
    hovering,
    pinnedOpen,
    rows.length,
    contentKey,
    contentTick,
    topInset,
    applyGeometry,
  ])

  const toggle = useCallback(() => setPinnedOpen((v) => !v), [])

  if (hiddenEntirely) {
    // Nothing painted at all. The window is a click-through sliver until
    // something needs the user, at which point `hiddenEntirely` flips and the
    // normal shell renders and re-reports its size.
    return <div data-testid="island-hidden" data-fullscreen="true" className="w-full" />
  }

  const severity = rows.some((row) => row.permission) ? "permission" : "input"

  return (
    <div
      data-testid="island-hover-zone"
      className="w-full"
      data-fullscreen={fullscreen ? "true" : "false"}
      style={{ minHeight: ISLAND_PILL_HEIGHT + topInset }}
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
    >
      {/*
       * Clip container: starts at the window's top edge, which IS the display's
       * top edge, and clips the tucked card's upward slide so a tuck leaves
       * exactly `ISLAND_PEEK_HEIGHT` visible instead of a notch-height black
       * band beside the camera housing.
       */}
      <div data-testid="island-clip" className="overflow-hidden">
        <div
          ref={cardRef}
          data-testid="island-shell"
          data-expanded={expanded ? "true" : "false"}
          data-tucked={tucked ? "true" : "false"}
          data-presentation={tucked ? "minimal" : expanded ? "expanded" : "compact"}
          // Height joins transform and width in the transition: it is written
          // imperatively by the layout effect above, so expanding and
          // collapsing ease together instead of the width sliding while the
          // height jumps in one frame.
          // The card box itself paints nothing: its surface is the child below,
          // which starts under the notch strip, so the strip stays transparent
          // beside the housing and the menu bar there remains visible.
          className="relative mx-auto select-none overflow-hidden rounded-2xl text-white transition-[transform,width,height] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] will-change-transform motion-reduce:transition-none"
          style={{
            width,
            // Seed the pill height (plus the notch strip the card covers) so the
            // first painted frame is not zero-height. The layout effect takes
            // over immediately after.
            height: ISLAND_PILL_HEIGHT + topInset,
            // Only the CONTENT clears the camera housing; the housing column
            // above it is what joins the surface to the notch.
            paddingTop: topInset,
            transform: tucked
              ? `translateY(${ISLAND_PEEK_HEIGHT - (ISLAND_PILL_HEIGHT + topInset)}px)`
              : "translateY(0px)",
          }}
        >
          {/*
           * The painted surface. Below the notch strip on a notched display,
           * the whole card elsewhere. Beside a housing it is the housing's true
           * black so column and card read as one shape; without one it is the
           * glass. Behind the content (negative z inside the card's stacking
           * context), so the rows and the pill sit on it.
           */}
          <div
            aria-hidden
            data-testid="island-surface"
            className={cn(
              "absolute inset-x-0 bottom-0 -z-10 rounded-2xl border border-white/10 shadow-2xl",
              topInset > 0 ? "bg-black" : "bg-black/85 backdrop-blur-xl"
            )}
            style={{ top: topInset }}
          />

          {/*
           * Housing column: the one part of the notch strip that is painted.
           * Exactly as wide as the camera housing (never wider than the card),
           * one pixel into the surface so the join has no seam. With no
           * reported housing width the whole strip is painted, as before.
           */}
          {topInset > 0 ? (
            <div
              aria-hidden
              data-testid="island-notch-fill"
              className="absolute top-0 left-1/2 -translate-x-1/2 bg-black"
              style={{
                width: notchWidth > 0 ? Math.min(notchWidth, width) : width,
                height: topInset + 1,
              }}
            />
          ) : null}

          {/*
           * Screen-reader announcement of the one number that matters. Polite,
           * so a progress update never interrupts what the user is doing.
           */}
          <p
            data-testid="island-announce"
            aria-live="polite"
            aria-atomic="true"
            className="sr-only"
          >
            {waiting > 0
              ? t("announceWaiting", { count: rows.length, waiting })
              : t("announceActive", { count: state.activeCount })}
          </p>

          <div ref={contentRef} data-testid="island-content">
            <button
              type="button"
              data-testid="island-pill"
              onClick={toggle}
              aria-expanded={expanded}
              aria-label={t("toggle")}
              className={cn(
                "flex h-11 w-full items-center gap-2 px-4 text-xs text-white/80 transition-opacity duration-200",
                top && !tucked ? "justify-start" : "justify-center",
                tucked && "opacity-0"
              )}
            >
              <span
                aria-hidden
                className={cn(
                  "size-1.5 shrink-0 rounded-full transition-colors duration-300",
                  waiting > 0
                    ? "animate-pulse bg-amber-400"
                    : rows.length > 0
                      ? "bg-emerald-400"
                      : "bg-white/30"
                )}
              />
              {/*
               * Compact: the single highest-priority task, named. A count alone
               * makes the user open the island to learn anything at all.
               */}
              {top && !tucked ? (
                <>
                  <span
                    data-testid="island-compact-source"
                    className="shrink-0 rounded bg-white/10 px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-white/60"
                  >
                    {t(`source.${top.source}`)}
                  </span>
                  <span
                    data-testid="island-compact-title"
                    className="min-w-0 shrink truncate font-medium text-white/90"
                  >
                    {top.title}
                  </span>
                  <span
                    data-testid="island-compact-summary"
                    className="min-w-0 shrink truncate text-white/50"
                  >
                    {top.summary || t(`state.${top.statusKey ?? top.status}`)}
                  </span>
                  {rows.length > 1 ? (
                    <span
                      data-testid="island-compact-more"
                      className="ml-auto shrink-0 tabular-nums text-white/40"
                    >
                      {t("more", { count: rows.length - 1 })}
                    </span>
                  ) : null}
                </>
              ) : (
                <span data-testid="island-summary">
                  {rows.length === 0
                    ? t("empty")
                    : waiting > 0
                      ? t("summaryWaiting", { count: rows.length, waiting })
                      : t("summary", { count: rows.length })}
                </span>
              )}
            </button>

            {/*
             * The list stays mounted whenever there are rows and only fades with
             * `expanded`. The card's animating height plus `overflow-hidden` is
             * what reveals and hides it. Unmounting on collapse is what made the
             * old close a hard cut.
             */}
            {rows.length > 0 ? (
              <div
                data-testid="island-body"
                aria-hidden={!expanded}
                className={cn(
                  "transition-opacity duration-200 ease-out motion-reduce:transition-none",
                  expanded ? "opacity-100" : "pointer-events-none opacity-0"
                )}
              >
                {rows.length >= 2 && legendSegments.length > 0 ? (
                  <div
                    data-testid="island-legend"
                    className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 pb-1.5 text-[10px] text-white/50"
                  >
                    {legendSegments.map((segment) => (
                      <span
                        key={segment.key}
                        data-testid={`island-legend-${segment.key}`}
                        className="inline-flex items-center gap-1 tabular-nums"
                      >
                        <span aria-hidden className={cn("size-1.5 rounded-full", segment.dot)} />
                        {t(`legend.${segment.key}`, { count: segment.count })}
                      </span>
                    ))}
                  </div>
                ) : null}
                <ul
                  className="island-scroll flex max-h-[420px] list-none flex-col gap-0.5 overflow-y-auto px-1 pb-2"
                  data-testid="island-list"
                  aria-label={t("listLabel")}
                >
                  {rows.map((row, index) => (
                    <li key={row.id}>
                      <IslandTaskRow
                        row={row}
                        revision={state.revision}
                        pinned={detailRowId === row.id}
                        onTogglePin={() => togglePin(row.id)}
                        detail={detailSlot.rowId === row.id ? detailSlot.detail : null}
                        detailError={detailSlot.rowId === row.id ? detailSlot.error : null}
                        dispatch={dispatch}
                        statusOf={(kind) => statusOf(row.id, kind)}
                        compact={compactRows}
                        // Gentle stagger, capped so a long list stays snappy.
                        enterDelayMs={Math.min(index, 6) * ISLAND_ROW_STAGGER_MS}
                      />
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>

          {/*
           * Minimal presentation: while tucked the card is a bare sliver, and
           * this is the only thing painted in it. A count, nothing else. The
           * tuck slides the card UP by everything but `ISLAND_PEEK_HEIGHT`, so
           * the strip left on screen is the card's BOTTOM edge: the count is
           * anchored there, not below the notch, or it would sit above the
           * clip and the sliver would paint blank.
           */}
          {tucked && (waiting > 0 || state.activeCount > 0) ? (
            <span
              data-testid="island-minimal"
              aria-hidden
              className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center justify-center text-[8px] font-semibold leading-none tabular-nums text-white/70"
              style={{ height: ISLAND_PEEK_HEIGHT }}
            >
              {waiting > 0 ? waiting : state.activeCount}
            </span>
          ) : null}

          {/*
           * Attention ring: a breathing amber (or red) inset ring while a task
           * needs the user. A pointer-events-none overlay so it never blocks the
           * pill or list, painted last so it sits above the content edges, and
           * offset below the notch so it rings the content rather than drawing a
           * glowing bar across the menu bar.
           */}
          {waiting > 0 && !tucked ? (
            <span
              aria-hidden
              data-testid="island-attention-ring"
              data-severity={severity}
              style={{ top: topInset }}
              className={cn(
                "pointer-events-none absolute inset-0 rounded-2xl",
                severity === "permission"
                  ? "island-attention-ring--danger"
                  : "island-attention-ring"
              )}
            />
          ) : null}
        </div>
      </div>
    </div>
  )
}

export default IslandShell
