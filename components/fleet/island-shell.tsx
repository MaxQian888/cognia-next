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
 * strip so slam-to-top hover always lands on it; the card itself is padded
 * below the display's top safe-area inset (returned by `island_resize`,
 * pushed via `fleet://island-geometry` on monitor changes) and its tuck slide
 * is clipped at the notch line.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { useFleetStream } from "@/hooks/fleet/use-fleet-stream"
import { attentionCount, sortForIsland } from "@/lib/fleet/format"
import { FLEET_ISLAND_GEOMETRY_EVENT, type IslandGeometry } from "@/lib/fleet/types"
import { isTauri } from "@/lib/tauri"
import { islandResize } from "@/lib/tauri/fleet"
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

export function IslandShell() {
  const t = useTranslations("fleet.island")
  const { snapshot } = useFleetStream()
  const [hovering, setHovering] = useState(false)
  const [pinnedOpen, setPinnedOpen] = useState(false)
  const [tucked, setTucked] = useState(false)
  const [topInset, setTopInset] = useState(0)
  const cardRef = useRef<HTMLDivElement | null>(null)
  const insetRef = useRef(0)

  // Top safe-area inset (notch height, logical px) of the island's display.
  // The window spans the notch strip (so slam-to-top hover still lands on the
  // window); the card is padded below the inset so its content clears the
  // camera housing. The value comes back from every `island_resize`, and Rust
  // pushes `fleet://island-geometry` when a monitor change may have altered it.
  // Ref-guarded so an unchanged inset never schedules a state update (the
  // resize promise resolves outside React's act/event scope).
  const applyInset = useCallback((raw: unknown) => {
    const next = typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? raw : 0
    if (insetRef.current === next) return
    insetRef.current = next
    setTopInset(next)
  }, [])

  useEffect(() => {
    if (!isTauri()) return undefined
    let alive = true
    let unlisten: (() => void) | undefined
    void (async () => {
      // Dynamic import keeps the Tauri event module out of web bundles.
      const { listen } = await import("@tauri-apps/api/event")
      if (!alive) return
      const un = await listen<IslandGeometry>(FLEET_ISLAND_GEOMETRY_EVENT, (e) => {
        if (alive) applyInset(e.payload?.topInset)
      })
      if (!alive) {
        safeUnlisten(un)
        return
      }
      unlisten = un
    })()
    return () => {
      alive = false
      safeUnlisten(unlisten)
    }
  }, [applyInset])

  const sessions = sortForIsland(snapshot.sessions)
  const waiting = attentionCount(snapshot.sessions)
  const empty = sessions.length === 0

  // A pending permission forces the island open so its Approve/Deny controls
  // are never hidden behind the collapsed pill. Derived during render from the
  // snapshot — no effect, no setState-to-mirror-a-prop.
  const forceExpanded = snapshot.sessions.some((s) => s.pendingPermission !== null)
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
  useEffect(() => {
    if (!shouldTuck) return undefined
    const timer = setTimeout(() => setTucked(true), ISLAND_TUCK_DELAY_MS)
    return () => clearTimeout(timer)
  }, [shouldTuck])

  // Report the measured content size to the window layer after every paint
  // where shape/content changed. useLayoutEffect: resize before the frame is
  // shown, so expand/collapse doesn't flash a clipped island. While tucked the
  // card is pill-only (tucking requires no hover/pin/force-expand, so
  // `expanded` is false), and the window stays at the pill footprint and
  // keeps catching hover.
  //
  // Grow-now / shrink-later: the card's width animates over 300ms, but the OS
  // window resize is instant. Growing the window ahead of the animation is
  // invisible (the extra area is transparent); shrinking it instantly clips
  // the still-animating card at the window edge. So any dimension that grows
  // is applied immediately, and the shrink to the final size is deferred until
  // the CSS transition has settled.
  const width = expanded ? ISLAND_EXPANDED_WIDTH : ISLAND_COLLAPSED_WIDTH
  const lastSizeRef = useRef({ w: 0, h: 0 })
  const lastInsetRef = useRef(0)
  useLayoutEffect(() => {
    const el = cardRef.current
    if (!el) return
    // Rust grows the window by the display's top inset and returns that inset;
    // `Promise.resolve` tolerates sloppy test doubles that return undefined.
    const report = (w: number, h: number) => {
      void Promise.resolve(islandResize(w, h)).then(applyInset)
    }
    const height = Math.max(ISLAND_PILL_HEIGHT, Math.ceil(el.getBoundingClientRect().height))
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
    const timer = setTimeout(() => {
      lastSizeRef.current = { w: width, h: height }
      report(width, height)
    }, ISLAND_SHRINK_SETTLE_MS)
    return () => clearTimeout(timer)
  }, [width, expanded, sessions.length, topInset, applyInset])

  const toggle = useCallback(() => setPinnedOpen((v) => !v), [])

  return (
    <div
      data-testid="island-hover-zone"
      className="w-full"
      style={{ minHeight: ISLAND_PILL_HEIGHT + topInset }}
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
    >
      {/*
       * Clip container: starts at the notch line (marginTop = inset; the
       * window itself spans the notch strip so slam-to-top hover works) and
       * clips the tucked card's upward slide — without it the tucked card
       * would paint over the menu-bar strip beside the camera housing. On
       * inset-0 displays the clip edge coincides with the window edge, which
       * is what already clipped the slide before.
       */}
      <div data-testid="island-clip" className="overflow-hidden" style={{ marginTop: topInset }}>
        <div
          ref={cardRef}
          data-testid="island-shell"
          data-expanded={expanded ? "true" : "false"}
          data-tucked={tucked ? "true" : "false"}
          className="mx-auto select-none overflow-hidden rounded-2xl border border-white/10 bg-black/85 text-white shadow-2xl backdrop-blur-xl transition-[transform,width] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] will-change-transform motion-reduce:transition-none"
          style={{
            width,
            transform: tucked
              ? `translateY(${ISLAND_PEEK_HEIGHT - ISLAND_PILL_HEIGHT}px)`
              : "translateY(0px)",
          }}
        >
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
      </div>
    </div>
  )
}

export default IslandShell
