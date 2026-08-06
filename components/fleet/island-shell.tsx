"use client"

/**
 * IslandShell — the Dynamic-Island interaction shell: a collapsed pill
 * summarizing the fleet ("3 agents · 1 waiting") that expands on hover/click
 * into the session list. On every layout change it reports its measured
 * content size to Rust (`island_resize`) so the frameless window hugs the
 * content and stays centered under the notch.
 *
 * Auto-hide (Apple-Dock style): when no session needs the user (nothing
 * waiting on permission/plan/input) and no pointer is over the window, the
 * pill tucks up out of the way after a grace delay, leaving a thin sliver at
 * the very top edge — merely idle or autonomously working sessions don't pin
 * the island on screen. The window keeps its full pill height while tucked —
 * the transparent area doubles as the hover target, so moving the mouse to
 * the top-center of the screen slides the island back out (same reveal
 * contract as the auto-hidden Dock/menu bar). The tuck/untuck is a pure
 * CSS transform animated with Apple's spring-ish ease curve; the window itself
 * never moves, so there is no cross-process jitter.
 *
 * A pending permission on any session force-expands the island so an approval
 * is never hidden behind the collapsed pill — derived straight from the
 * snapshot (the Rust registry sets `pendingPermission` and emits the update in
 * the same step a permission arrives), so no event/effect plumbing is needed.
 *
 * Notch handling: the window is anchored to the TRUE top edge of the display
 * (Space-independent — see `island_window.rs`) and spans the camera-housing
 * strip so slam-to-top hover always lands on it. The card's black body runs all
 * the way up to that top edge, so on a notched display it reads as one shape
 * with the camera housing (a real Dynamic Island) instead of a pill hanging a
 * notch-height below the screen edge; only its CONTENT is padded below the top
 * safe-area inset (returned by `island_resize`, pushed via
 * `fleet://island-geometry` on monitor changes) so nothing is ever hidden
 * behind the housing. The top corners square off while that inset is non-zero —
 * a rounded corner flush with the screen edge reads as a floating card, which
 * is exactly the look the notch merge is meant to replace.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { useFleetStream } from "@/hooks/fleet/use-fleet-stream"
import {
  attentionCount,
  attentionSeverity,
  fleetStatusSummary,
  normalizeIslandGeometry,
  sortForIsland,
} from "@/lib/fleet/format"
import {
  FLEET_ISLAND_GEOMETRY_EVENT,
  FLEET_ISLAND_HOVER_EVENT,
  type IslandGeometry,
  type IslandHover,
} from "@/lib/fleet/types"
import { isTauri } from "@/lib/tauri"
import { islandResize, islandSetTucked } from "@/lib/tauri/fleet"
import { safeUnlisten } from "@/lib/tauri/safe-unlisten"
import { IslandRow } from "./island-row"
import { cn } from "@/lib/utils"

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
 * full-screen Space. Not zero — a zero-sized window is a degenerate case for
 * the OS window layer, and Rust clamps it to 1 anyway.
 */
export const ISLAND_HIDDEN_HEIGHT = 1
/** Per-row entrance stagger step in the expanded list. */
export const ISLAND_ROW_STAGGER_MS = 30
/**
 * Session count from which rows switch to their compact shape.
 *
 * A row can render up to eight stacked blocks (meta chips, detail, last prompt,
 * error, permission controls, question card, plan preview, subagent chips), so
 * three busy sessions already fill the list's 420px cap and the rest scroll out
 * of sight. Past this threshold the rows keep only what the user must act on
 * and fold the rest behind their existing chevron — triage beats detail once
 * the fleet is big enough that you're scanning rather than reading.
 */
export const ISLAND_COMPACT_THRESHOLD = 4

export function IslandShell() {
  const t = useTranslations("fleet.island")
  const { snapshot } = useFleetStream()
  const [hovering, setHovering] = useState(false)
  const [pinnedOpen, setPinnedOpen] = useState(false)
  const [tucked, setTucked] = useState(false)
  const [topInset, setTopInset] = useState(0)
  const [fullscreen, setFullscreen] = useState(false)
  // Which rows have their detail panel expanded (keyed by agent:sessionId).
  // Owned here — not in the row — so the resize effect can key `contentKey` on
  // it: an expanded row is taller, and the frameless window must re-hug it.
  const [expandedKeys, setExpandedKeys] = useState<ReadonlySet<string>>(() => new Set())
  const toggleDetail = useCallback((key: string) => {
    setExpandedKeys((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])
  const cardRef = useRef<HTMLDivElement | null>(null)
  // Measured separately from the card: the card's height is the *animated*
  // value, so measuring it would feed the animation back into itself.
  const contentRef = useRef<HTMLDivElement | null>(null)
  const geometryRef = useRef<IslandGeometry>({ topInset: 0, fullscreen: false })

  // Display geometry for the island's screen.
  //
  // `topInset` is the notch height (logical px): the window spans the notch
  // strip (so slam-to-top hover still lands on the window) and the card is
  // padded below the inset so its content clears the camera housing.
  // `fullscreen` says the island should yield this display to a full-screen app
  // — the raw Space verdict AND the user's opt-in, already combined by Rust.
  //
  // Both arrive two ways: as the return of every `island_resize` (so the very
  // first layout already knows the regime) and as a `fleet://island-geometry`
  // push when Rust's watch loop notices a Space switch or monitor change.
  // Ref-guarded so an unchanged sample never schedules a state update — the
  // resize promise resolves outside React's act/event scope.
  const applyGeometry = useCallback((raw: unknown) => {
    const next = normalizeIslandGeometry(raw)
    const prev = geometryRef.current
    if (prev.topInset === next.topInset && prev.fullscreen === next.fullscreen) return
    geometryRef.current = next
    setTopInset(next.topInset)
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
        // Authoritative hover: while tucked the window is click-through, so
        // the DOM never sees mouseenter — Rust polls the global cursor and
        // pushes enter/leave transitions. It also self-heals a `hovering`
        // stuck true by a missed mouseleave (OS window resize under the
        // cursor), which used to pin the island expanded indefinitely.
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

  const sessions = sortForIsland(snapshot.sessions)
  const waiting = attentionCount(snapshot.sessions)
  // permission → red ring, plan/input → amber ring (a permission always wins).
  const severity = attentionSeverity(snapshot.sessions)
  const empty = sessions.length === 0

  // Per-status counts for the expanded triage legend. Buckets with a zero
  // count are dropped so the legend only ever shows what's actually present.
  const compactRows = sessions.length >= ISLAND_COMPACT_THRESHOLD
  const summary = fleetStatusSummary(sessions)
  const legendSegments = [
    { key: "needsYou", count: summary.attention, dot: "bg-amber-400" },
    { key: "working", count: summary.working, dot: "bg-emerald-400" },
    { key: "idle", count: summary.idle, dot: "bg-white/40" },
    { key: "detached", count: summary.detached, dot: "bg-slate-400/40" },
    { key: "done", count: summary.ended, dot: "bg-white/20" },
  ].filter((seg) => seg.count > 0)

  // Signature of everything that changes a row's rendered height (plan
  // preview, question block, subagent chips, prompt line, permission
  // controls). The resize effect keys on it so content growing inside an
  // already-expanded island still re-reports the window size.
  const contentKey = sessions
    .map((s) => {
      const key = `${s.agent}:${s.sessionId}`
      return (
        `${key}:${s.status}:${s.pendingPermission ? 1 : 0}:` +
        `${s.pendingPlan ? 1 : 0}:${s.pendingQuestions?.length ?? 0}:` +
        // An answerable question swaps the compact display chips for the taller
        // selectable card — a height change the display-only length misses.
        `${s.pendingQuestionRequest ? 1 : 0}:` +
        `${s.subagents?.length ?? 0}:${s.lastPrompt ? 1 : 0}:` +
        // Expand state + an error banner both change the row's height.
        `${expandedKeys.has(key) ? 1 : 0}:${s.lastError ? 1 : 0}`
      )
    })
    .join("|")

  // A pending permission — or an answerable AskUserQuestion — forces the island
  // open so its Approve/Deny controls (or the question's options + Submit) are
  // never hidden behind the collapsed pill. Derived during render from the
  // snapshot — no effect, no setState-to-mirror-a-prop.
  const forceExpanded = snapshot.sessions.some(
    (s) => s.pendingPermission !== null || s.pendingQuestionRequest != null
  )

  // A pin outlives its purpose once the fleet empties: the user pinned a list
  // that no longer exists, and a stale pin blocked auto-tuck forever (the
  // "island camps on screen" report). Render-time state adjustment, same
  // pattern as the tuck reset below.
  if (pinnedOpen && empty) {
    setPinnedOpen(false)
  }
  const expanded = ((hovering || pinnedOpen) && !empty) || forceExpanded

  // Auto-tuck: an un-hovered, un-pinned island with nothing that needs the
  // user (no waiting/permission/plan session) hides — idle or busy-but-
  // autonomous sessions alone don't keep it on screen. A session starting to
  // wait (or the pointer entering the window) cancels the pending tuck and
  // slides the pill back out immediately. The reset is a render-time state
  // adjustment (React's "adjusting state when props change" pattern — the
  // repo's accepted alternative to setState-in-effect); the effect only ever
  // arms/disarms the tuck timer.
  const shouldTuck = waiting === 0 && !hovering && !pinnedOpen && !forceExpanded
  if (tucked && !shouldTuck) {
    setTucked(false)
  }

  // Full-screen Space, and only when the user asked for this: `geometry
  // .fullscreen` arrives ALREADY gated by the "hide under full-screen apps"
  // preference (`island_set_hide_on_fullscreen`), which ships OFF — the
  // overlay's NSPanel floats over every Space by design, and withdrawing there
  // unconditionally made the island look like it only worked on Cognia's own
  // desktop. So this branch is opt-in, for people watching video or presenting.
  //
  // When it is on the island withdraws COMPLETELY — nothing painted, window
  // shrunk to a sliver and click-through — and materializes only when a session
  // actually needs the user. Hover reveal is deliberately not a way back in
  // here: slamming to the top of a full-screen app is how you reach that app's
  // own menu bar, and two overlays fighting for that gesture is worse than
  // neither. A pin the user placed before going full-screen still wins.
  const hiddenEntirely = fullscreen && waiting === 0 && !pinnedOpen && !forceExpanded
  useEffect(() => {
    if (!shouldTuck) return undefined
    const timer = setTimeout(() => setTucked(true), ISLAND_TUCK_DELAY_MS)
    return () => clearTimeout(timer)
  }, [shouldTuck])

  // Mirror the non-interactive state to the window layer: a tucked island's
  // window turns click-through (so the invisible pill strip under the notch
  // can't swallow clicks meant for the menu bar behind it), and a fully
  // withdrawn one must be click-through for the same reason with even less
  // excuse. Untucking restores interactivity. The reveal path stays alive via
  // `fleet://island-hover`.
  const clickThrough = tucked || hiddenEntirely
  // Mirrored into a ref (inside the effect — writing a ref during render is
  // blocked by `react-hooks/refs`) so the deferred-shrink path below can
  // restore the *current* interactivity when its timer fires, rather than the
  // value that was true when the timer was armed.
  const clickThroughRef = useRef(clickThrough)
  useEffect(() => {
    clickThroughRef.current = clickThrough
    void islandSetTucked(clickThrough)
  }, [clickThrough])

  // Measure the content, drive the card's animated height, and report the
  // window size — all in one layout effect, because they must agree.
  //
  // The card's height is written straight to the DOM node rather than held in
  // state: a measurement can only be taken in an effect, and this repo's
  // `react-hooks/set-state-in-effect` rule (rightly) blocks setState there.
  // Writing the animated property imperatively sidesteps the round-trip
  // entirely — the CSS transition animates it exactly the same way.
  //
  // The list stays mounted whenever there are sessions; `expanded` only chooses
  // between the pill height and the full content height. That is what gives the
  // collapse a real exit animation: the card's height eases down while the list
  // fades out and `overflow-hidden` wipes it, instead of the list vanishing in
  // one frame while an empty shell kept animating its width for 300ms.
  //
  // Grow-now / shrink-later: the card animates over 300ms but the OS window
  // resize is instant. Growing the window ahead of the animation is invisible
  // (the extra area is transparent); shrinking it instantly clips the
  // still-animating card at the window edge. So any dimension that grows is
  // applied immediately and the shrink is deferred until the transition settles.
  const width = expanded ? ISLAND_EXPANDED_WIDTH : ISLAND_COLLAPSED_WIDTH
  const lastSizeRef = useRef({ w: 0, h: 0 })
  const lastInsetRef = useRef(0)
  useLayoutEffect(() => {
    const card = cardRef.current
    // While withdrawn there is no card to measure — the window still has to be
    // told to shrink, so this path reports a fixed sliver instead of bailing.
    if (!card && !hiddenEntirely) return
    // Rust grows the window by the display's top inset and returns the full
    // geometry; `Promise.resolve` tolerates sloppy test doubles that return
    // undefined.
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
    // An inset change (monitor switch) must re-issue the same content size:
    // the window height is content + inset, so it changed even if we didn't.
    const insetChanged = lastInsetRef.current !== topInset
    if (growW !== prev.w || growH !== prev.h || insetChanged) {
      lastSizeRef.current = { w: growW, h: growH }
      lastInsetRef.current = topInset
      report(growW, growH)
    }
    if (width >= growW && height >= growH) return

    // A shrink is pending, so for the next ~320ms the window is larger than
    // what is painted in it. That surplus is transparent but still hit-tested,
    // and it sits at the top-center of the screen — it used to swallow clicks
    // aimed at whatever is behind. Make the window click-through for the
    // duration, but ONLY when the pointer isn't on the island: a session ending
    // while the user hovers the expanded list also shrinks it, and going
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
    sessions.length,
    contentKey,
    topInset,
    applyGeometry,
  ])

  const toggle = useCallback(() => setPinnedOpen((v) => !v), [])

  if (hiddenEntirely) {
    // Nothing painted at all — not the pill, not the tucked sliver, not the
    // hover zone. The window is a click-through sliver until something needs
    // the user, at which point `hiddenEntirely` flips and the normal shell
    // renders and re-reports its size.
    return <div data-testid="island-hidden" data-fullscreen="true" className="w-full" />
  }

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
       * Clip container: starts at the window's top edge — which IS the display's
       * top edge — and clips the tucked card's upward slide, so a tuck leaves
       * exactly `ISLAND_PEEK_HEIGHT` visible at the very top instead of a
       * notch-height black band hanging beside the camera housing.
       */}
      <div data-testid="island-clip" className="overflow-hidden">
        <div
          ref={cardRef}
          data-testid="island-shell"
          data-expanded={expanded ? "true" : "false"}
          data-tucked={tucked ? "true" : "false"}
          // Height joins transform and width in the transition: it is written
          // imperatively by the layout effect above, so expanding and
          // collapsing ease together instead of the width sliding while the
          // height jumps in one frame.
          className="relative mx-auto select-none overflow-hidden rounded-2xl border border-white/10 bg-black/85 text-white shadow-2xl backdrop-blur-xl transition-[transform,width,height] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] will-change-transform motion-reduce:transition-none"
          style={{
            width,
            // Seed the pill height (plus the notch strip the card covers) so the
            // first painted frame isn't zero-height — the layout effect takes
            // over immediately after.
            height: ISLAND_PILL_HEIGHT + topInset,
            // Only the CONTENT clears the camera housing; the body behind it
            // runs to the top edge so the card and the housing read as one
            // shape.
            paddingTop: topInset,
            // A rounded corner sitting flush against the screen edge looks like
            // a floating card, which defeats the merge — square the top two
            // while there is a notch to merge with. Inline so it beats the
            // `rounded-2xl` class regardless of utility ordering.
            borderTopLeftRadius: topInset > 0 ? 0 : undefined,
            borderTopRightRadius: topInset > 0 ? 0 : undefined,
            transform: tucked
              ? `translateY(${ISLAND_PEEK_HEIGHT - (ISLAND_PILL_HEIGHT + topInset)}px)`
              : "translateY(0px)",
          }}
        >
          {/*
           * Notch strip fill. The card's glass surface is `bg-black/85`, which
           * beside the camera housing means the menu bar's clock and status
           * icons show through at 15% — and leaves a seam where our surface
           * meets the housing's true black. This band paints that strip opaque
           * so the card and the housing read as one shape. Sized exactly to the
           * inset, so it is only ever the region level with the housing.
           */}
          {topInset > 0 ? (
            <div
              aria-hidden
              data-testid="island-notch-fill"
              className="absolute inset-x-0 top-0 bg-black"
              style={{ height: topInset }}
            />
          ) : null}

          <div ref={contentRef} data-testid="island-content">
            <button
              type="button"
              data-testid="island-pill"
              onClick={toggle}
              aria-expanded={expanded}
              aria-label={t("toggle")}
              className={cn(
                "flex h-11 w-full items-center justify-center gap-2 px-4 text-xs text-white/80 transition-opacity duration-200",
                tucked && "opacity-0"
              )}
            >
              <span
                aria-hidden
                className={cn(
                  "size-1.5 rounded-full transition-colors duration-300",
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

            {/*
             * The list stays mounted whenever there are sessions and only fades
             * with `expanded` — the card's animating height plus `overflow-hidden`
             * is what reveals and hides it. Unmounting on collapse is what made
             * the old close a hard cut: `animate-in` has no counterpart, so the
             * content disappeared in one frame while the shell kept easing.
             */}
            {sessions.length > 0 ? (
              <div
                data-testid="island-body"
                aria-hidden={!expanded}
                className={cn(
                  "transition-opacity duration-200 ease-out motion-reduce:transition-none",
                  expanded ? "opacity-100" : "pointer-events-none opacity-0"
                )}
              >
                {sessions.length >= 2 && legendSegments.length > 0 ? (
                  <div
                    data-testid="island-legend"
                    className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 pb-1.5 text-[10px] text-white/50"
                  >
                    {legendSegments.map((seg) => (
                      <span
                        key={seg.key}
                        data-testid={`island-legend-${seg.key}`}
                        className="inline-flex items-center gap-1 tabular-nums"
                      >
                        <span aria-hidden className={cn("size-1.5 rounded-full", seg.dot)} />
                        {t(`legend.${seg.key}`, { count: seg.count })}
                      </span>
                    ))}
                  </div>
                ) : null}
                <div
                  className="island-scroll flex max-h-[420px] flex-col gap-0.5 overflow-y-auto px-1 pb-2"
                  data-testid="island-list"
                >
                  {sessions.map((s, i) => {
                    const key = `${s.agent}:${s.sessionId}`
                    return (
                      <IslandRow
                        key={key}
                        session={s}
                        // Gentle stagger, capped so a long list doesn't feel sluggish.
                        enterDelayMs={Math.min(i, 6) * ISLAND_ROW_STAGGER_MS}
                        compact={compactRows}
                        detailExpanded={expandedKeys.has(key)}
                        onToggleDetail={() => toggleDetail(key)}
                      />
                    )
                  })}
                </div>
              </div>
            ) : null}
          </div>

          {/*
           * Attention ring: a breathing amber inset ring while any session
           * needs the user. A pointer-events-none overlay so it never blocks
           * the pill/list; painted last so it sits above the content edges.
           * Suppressed while tucked (the card is a bare sliver then). Offset
           * below the notch so it rings the content the user must act on —
           * ringing the housing strip too would draw a glowing bar across the
           * menu bar.
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
