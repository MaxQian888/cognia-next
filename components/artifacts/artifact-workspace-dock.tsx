"use client"

/**
 * ArtifactWorkspaceDock — wraps the chat workspace so a docked, resizable
 * artifacts panel can sit in the right rail on desktop. On tablet/mobile it
 * renders the children plus a single workbench Sheet fallback, which hosts the
 * same panels — and the same resources — as the desktop dock.
 *
 * Desktop layout (Codex / Claude-artifacts style):
 *   ┌───────────────────────────┬──────────────┐
 *   │ Chat (children)           │ Artifacts    │
 *   │            ◀ resize ▶     │ dock         │
 *   └───────────────────────────┴──────────────┘
 *
 * The dock auto-expands when a new artifact becomes active, collapses to 0
 * width otherwise, and its size survives reloads via `useArtifactDockLayoutStore`.
 * Cmd/Ctrl+J toggles it (see `useArtifactDockShortcuts`).
 */

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react"
import type { PanelImperativeHandle } from "react-resizable-panels"
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable"
import { onBrowserUrlReveal } from "@/lib/browser/open-url-request"
import { isProIdePanePinnedWithin } from "@/lib/codeserver/pane-manager"
import {
  SHELL_DOCK_CLEANUP_SLACK_MS,
  SHELL_DOCK_DURATION_MS,
  SHELL_DOCK_EASE,
} from "@/lib/ui/shell-dock-motion"
import { magnetAsPercent, snapPanelSize } from "@/lib/ui/panel-snap"
import { cn } from "@/lib/utils"
import { WORKBENCH_RAIL_WIDTH_PX } from "@/types/shell/workbench-rail"
import { useWorkbenchRailPersistent } from "@/components/shell/use-workbench-rail-layout"
import { useReportShellColumn } from "@/hooks/shell/use-report-shell-column"
import { useBreakpoint } from "@/hooks/ui"
import { useArtifactStore } from "@/stores/artifact/artifact-store"
import { useActiveArtifactId } from "@/hooks/artifacts/use-session-artifacts"
import {
  ARTIFACT_DOCK_BOUNDS,
  CHAT_MIN_PERCENT,
  CHAT_MIN_PX,
  DOCK_MODE_WIDTH_PERCENT,
  WORKSPACE_DOCK_BOUNDS,
  useArtifactDockLayoutStore,
} from "@/stores/artifact/artifact-dock-layout-store"
import { useArtifactDockShortcuts } from "@/hooks/artifacts/use-artifact-dock-shortcuts"
import { ArtifactPanel } from "./artifact-panel"
import { ArtifactDock } from "./artifact-dock"
import { WorkspaceRevealOpener } from "./workspace-mode/workspace-reveal-opener"

/**
 * Duration and curve both come from `lib/ui/shell-dock-motion.ts`, the one
 * clock every shell edge panel opens and collapses on — this dock, the
 * conversation sidebar and the terminal dock in either slot.
 *
 * The View Transition CSS and divider below carry the same pair as literals —
 * an arbitrary value cannot be interpolated from a constant and still be
 * compiled into CSS. `artifact-workspace-dock.test.tsx` pins all three together.
 */
export const DOCK_RESIZE_DURATION_MS = SHELL_DOCK_DURATION_MS
export const DOCK_RESIZE_EASE = SHELL_DOCK_EASE
/** Cleanup runs a beat past the animation so a slower preference isn't cut short. */
const DOCK_RESIZE_CLEANUP_SLACK_MS = SHELL_DOCK_CLEANUP_SLACK_MS
/**
 * Below this a release-snap is "already there": the layout callback reports
 * pixel measurements converted to a percent, so a preset the drag landed on
 * exactly can still differ from it in the far decimals.
 */
const RELEASE_SNAP_EPSILON_PERCENT = 0.01

/**
 * Commit the final panel layout once and let the browser animate old/new
 * snapshots on the compositor. A live flex-grow tween makes the conversation
 * and dock reflow every frame; that is the page shake this boundary must avoid.
 *
 * View Transitions are progressive enhancement. Unsupported engines resize in
 * one stable frame, and a native Pro IDE child webview always takes that path
 * because a DOM snapshot cannot capture or clip it.
 */
function animateDockResize(panel: HTMLDivElement, apply: () => void): () => void {
  const startViewTransition = document.startViewTransition?.bind(document)
  if (isProIdePanePinnedWithin(panel) || !startViewTransition) {
    apply()
    return () => {}
  }

  const group = panel.parentElement
  const siblings = group ? Array.from(group.children) : []
  const chat = siblings.find(
    (element): element is HTMLElement =>
      element instanceof HTMLElement && element !== panel && element.hasAttribute("data-panel")
  )
  const divider = siblings.find(
    (element): element is HTMLElement =>
      element instanceof HTMLElement && element.hasAttribute("data-separator")
  )
  if (!chat || !divider) {
    apply()
    return () => {}
  }

  const root = document.documentElement
  const previousNames = {
    root: root.style.viewTransitionName,
    chat: chat.style.viewTransitionName,
    divider: divider.style.viewTransitionName,
    panel: panel.style.viewTransitionName,
  }
  root.style.viewTransitionName = "none"
  chat.style.viewTransitionName = "cognia-dock-chat"
  divider.style.viewTransitionName = "cognia-dock-divider"
  panel.style.viewTransitionName = "cognia-dock-panel"

  const reset = () => {
    root.style.viewTransitionName = previousNames.root
    chat.style.viewTransitionName = previousNames.chat
    divider.style.viewTransitionName = previousNames.divider
    panel.style.viewTransitionName = previousNames.panel
  }

  let applied = false
  const applyOnce = () => {
    if (applied) return
    applied = true
    apply()
  }
  let transition: ViewTransition
  try {
    transition = startViewTransition(applyOnce)
  } catch {
    reset()
    applyOnce()
    return () => {}
  }

  let active = true
  void transition.finished
    .catch(() => undefined)
    .finally(() => {
      if (!active) return
      active = false
      reset()
    })
  return () => {
    if (!active) return
    active = false
    transition.skipTransition()
    reset()
  }
}

/**
 * The narrowest width the dock is allowed to settle at, as a percent of the
 * group — the same bound the `ResizablePanel` enforces at render time.
 *
 * The workspace profile's floor is an absolute `480px` (a percentage floor
 * leaves the file tree + Monaco + diff unusable on a small laptop), so it only
 * becomes a percentage once the group's width is known. Falls back to the
 * artifact floor when it isn't — jsdom reports every width as 0, and so does
 * the very first layout callback.
 */
function dockFloorPercent(panel: HTMLElement | null, workspaceProfile: boolean): number {
  if (!workspaceProfile) return ARTIFACT_DOCK_BOUNDS.min
  const groupWidth = panel?.parentElement?.offsetWidth ?? 0
  if (groupWidth <= 0) return ARTIFACT_DOCK_BOUNDS.min
  return (Number.parseFloat(WORKSPACE_DOCK_BOUNDS.minPx) / groupWidth) * 100
}

/**
 * The widest the dock may be while the conversation still clears
 * `CHAT_MIN_PX`, as a percent of the group.
 *
 * The mirror of {@link dockFloorPercent}, and for the same reason: a percentage
 * of a group that something *outside* the group has already narrowed is not a
 * usable width. Expressed as a cap on the dock rather than a floor on the chat
 * because the panel library takes one unit per bound — and a cap covers every
 * entry point at once (drag, the narrow/wide presets, double-click, a restored
 * width), where clamping each caller would not.
 *
 * `100` — no clamp — until the group has measured. jsdom reports every width as
 * 0, and so does the first layout callback; a cap derived from that would
 * collapse the dock on mount.
 */
export function dockCapForChatFloor(groupWidthPx: number): number {
  if (!Number.isFinite(groupWidthPx) || groupWidthPx <= 0) return 100
  return Math.max(0, ((groupWidthPx - CHAT_MIN_PX) / groupWidthPx) * 100)
}

/**
 * Raise the dock when something new wants attention inside it — a freshly
 * active artifact, or an AI revision proposal that just arrived.
 *
 * Mounted on the shared layer so the desktop dock and the mobile Sheet obey the
 * same rule. It used to live in the desktop branch alone while the Sheet was
 * force-opened straight from `artifact-store`, which cannot see `userDismissed`
 * — so the two platforms disagreed: the desktop honoured a dismissal and the
 * phone re-threw a full-height modal over the conversation regardless.
 * `notifyNewArtifact` is the one place that decides, and when the user has
 * dismissed the dock it only flags the toggle unread.
 */
function useDockAttentionSignal(): void {
  const notifyNewArtifact = useArtifactDockLayoutStore((s) => s.notifyNewArtifact)
  // Scoped to the conversation on screen: an artifact landing in a *background*
  // session must not raise the dock over the one the user is reading.
  const activeArtifactId = useActiveArtifactId()
  const pendingReviewCount = useArtifactStore((s) => Object.keys(s.pendingReviews).length)
  const previousRef = useRef({ activeArtifactId, pendingReviewCount })

  useEffect(() => {
    const previous = previousRef.current
    previousRef.current = { activeArtifactId, pendingReviewCount }
    // Keyed on the id so it only reacts to a *new* artifact, not every render.
    const freshArtifact =
      Boolean(activeArtifactId) && activeArtifactId !== previous.activeArtifactId
    const freshReview = pendingReviewCount > previous.pendingReviewCount
    if (freshArtifact || freshReview) notifyNewArtifact()
  }, [activeArtifactId, notifyNewArtifact, pendingReviewCount])
}

/**
 * Keep the dock's contents mounted while it is open, and for exactly one
 * collapse animation after it closes.
 *
 * A collapsed dock used to stay fully mounted at zero width — Monaco, the
 * resource chat pane and the embedded browser all still running behind a panel
 * nobody could see. The browser pane is the sharpest case: it holds a
 * *process-wide* embedded-webview lease that is only released on unmount, so an
 * invisible zero-width dock could lock every other surface out of the webview
 * and leave them retrying on a backoff.
 *
 * The delay is not cosmetic. `animateDockResize` captures the open and collapsed
 * layouts as compositor snapshots; unmounting on the same frame would capture
 * an empty panel instead of letting the old body move cleanly into the rail.
 *
 * **With a persistent rail this never retracts** — callers pass `false`. The
 * workbench stays mounted so its activity rail can keep drawing, and it drops
 * the panel *body* itself via `railOnly`. The lease invariant above is
 * untouched: rail-only unmounts every panel, exactly as a zero-width dock did.
 */
function useDockContentMounted(
  dockCollapsed: boolean,
  panelElementRef: { current: HTMLElement | null }
): boolean {
  // Only the timer writes this. Expanding clears it *during render* — React's
  // sanctioned "adjust state when a prop changes" pattern, and what
  // `react-hooks/set-state-in-effect` steers you to: re-opening is immediate
  // and must not wait a second render pass to put the dock back.
  const [retracted, setRetracted] = useState(dockCollapsed)
  if (!dockCollapsed && retracted) setRetracted(false)

  useEffect(() => {
    if (!dockCollapsed || retracted) return
    const element = panelElementRef.current
    const timer = window.setTimeout(
      () => setRetracted(true),
      DOCK_RESIZE_DURATION_MS *
        (element
          ? Number(getComputedStyle(element).getPropertyValue("--motion-duration-scale")) || 1
          : 1) +
        DOCK_RESIZE_CLEANUP_SLACK_MS
    )
    return () => window.clearTimeout(timer)
  }, [dockCollapsed, panelElementRef, retracted])

  return !retracted
}

/**
 * Answer "open this link beside the conversation" for the whole chat surface.
 *
 * It has to live out here, on the host that is mounted for as long as the chat
 * is, rather than inside the panel catalogue. A collapsed dock with no
 * persistent rail does not mount `<ArtifactDock />` at all, and the browser
 * panel is `retention: "stateful"`, so it does not exist until it has been
 * activated once. Either way the very first link a user clicks in a
 * conversation finds nothing subscribed, which is precisely the click that most
 * needs to work.
 *
 * `openBrowser` already knows how to put that panel on screen from outside the
 * workbench (it is what the Views menu uses); carrying the address with it is
 * all this adds. A pane that is already visible answers the earlier round in
 * `requestBrowserUrl` and this never runs.
 */
function useSideBrowserReveal(): void {
  const openBrowser = useArtifactDockLayoutStore((state) => state.openBrowser)
  useEffect(
    () =>
      onBrowserUrlReveal((url) => {
        openBrowser(url)
        return true
      }),
    [openBrowser]
  )
}

export function ArtifactWorkspaceDock({ children }: { children: ReactNode }) {
  useArtifactDockShortcuts()
  useDockAttentionSignal()
  useSideBrowserReveal()
  const breakpoint = useBreakpoint()

  // Tablet takes the Sheet, not a side-by-side dock, and that is deliberate
  // rather than an oversight in the breakpoint table.
  //
  // A dock is only worth its column if both columns stay usable. At the 24%
  // narrow preset an 820px-wide tablet gives the dock ~197px — too narrow for
  // the preview, let alone the activity rail beside it — and the workspace
  // profile's floor is an absolute 480px, which would claim 59% of the screen
  // and leave the conversation in the remaining 41%.
  //
  // Nothing is lost by the Sheet: it hosts the *same* `ContextWorkbench`, over
  // the same resource, with the same panel set (see `ArtifactPanel` →
  // `ArtifactContextWorkbench`), so this is a different shape rather than a
  // reduced one. Pinned by "renders the narrow host at the tablet breakpoint"
  // in the test beside this file.
  if (breakpoint !== "desktop") {
    return <ArtifactWorkspaceDockNarrow>{children}</ArtifactWorkspaceDockNarrow>
  }

  return <ArtifactWorkspaceDockDesktop>{children}</ArtifactWorkspaceDockDesktop>
}

function ArtifactWorkspaceDockNarrow({ children }: { children: ReactNode }) {
  // No effects here on purpose. A reveal from outside (terminal link,
  // Edit/Write review, the browser button) raises `mobileSheetOpen`, and
  // `<ArtifactPanel />` reads exactly that — so the Sheet follows without a
  // relay. The two effects this replaced mirrored `mobileSheetOpen` and
  // `panelOpen` into each other behind *identical* guards, so every reveal fired
  // both in the same commit: one opened the panel while the other recorded a
  // dismissal and cleared the pending workspace reveal, losing the very file the
  // reveal was pointing at.
  return (
    <div data-testid="artifact-workspace-dock-mobile" className="flex min-h-0 flex-1 flex-col">
      <WorkspaceRevealOpener />
      {children}
      <ArtifactPanel />
    </div>
  )
}

function ArtifactWorkspaceDockDesktop({ children }: { children: ReactNode }) {
  const dockSize = useArtifactDockLayoutStore((s) => s.dockSize)
  const dockCollapsed = useArtifactDockLayoutStore((s) => s.dockCollapsed)
  const dockProfile = useArtifactDockLayoutStore((s) => s.dockProfile)
  const layoutVersion = useArtifactDockLayoutStore((s) => s.layoutVersion)
  const dockSizeRequest = useArtifactDockLayoutStore((s) => s.dockSizeRequest)
  const setDockSize = useArtifactDockLayoutStore((s) => s.setDockSize)
  const requestDockSize = useArtifactDockLayoutStore((s) => s.requestDockSize)
  const setDockCollapsed = useArtifactDockLayoutStore((s) => s.setDockCollapsed)
  const railPersistent = useWorkbenchRailPersistent()
  const dockPanelRef = useRef<PanelImperativeHandle | null>(null)
  const dockPanelElementRef = useRef<HTMLDivElement | null>(null)
  // The title bar hosts this dock's header and sizes its end outlet to the
  // dock's rendered width (`title-bar-outlets.tsx`), including mid-resize and
  // mid-collapse — so the panel reports what it measures rather than the
  // percentage the layout store holds.
  useReportShellColumn("dock", dockPanelElementRef)
  const previousDockCollapsedRef = useRef(dockCollapsed)
  const previousDockSizeRequestRef = useRef(dockSizeRequest)
  /**
   * The width the animation effects below should resize *to*, held in a ref so
   * it is not a dependency of theirs.
   *
   * `onLayoutChanged` writes the settled percentage straight back through
   * `setDockSize`, and the value it reports is a pixel measurement converted to
   * a percent — so it practically never matches the requested number exactly.
   * With `dockSize` in the dependency arrays that echo landed *mid-animation*
   * and re-ran both effects: React fired their cleanup, skipped the active view
   * transition and removed its temporary capture names. The re-run then bailed
   * on the unchanged request token, so nothing restarted the motion. The dock
   * snapped to its new width while responsive content changed geometry in the
   * live page — a reflow flash that showed up as a scrollbar blinking in and out
   * of the panel body on every panel switch.
   *
   * A layout effect, so the ref is current before the passive effects below run
   * in the same commit.
   */
  const dockSizeRef = useRef(dockSize)
  useLayoutEffect(() => {
    dockSizeRef.current = dockSize
  }, [dockSize])
  /**
   * Whether the panel *body* is still on screen. Retracts one animation after a
   * collapse, so the old snapshot contains real content instead of an empty box.
   *
   * Two consumers now read this one delay: whether `<ArtifactDock />` mounts at
   * all (only when the rail is not persistent — otherwise the rail has to keep
   * drawing), and `railOnly`, which is what actually drops the body. Deriving
   * `railOnly` from the raw `dockCollapsed` instead would flip it before the
   * transition captured the outgoing panel and make the body blink away.
   */
  const dockBodyMounted = useDockContentMounted(dockCollapsed, dockPanelElementRef)
  const dockContentMounted = railPersistent || dockBodyMounted
  /**
   * What the panel shrinks to. `0%` is the pre-minibar behaviour; with the rail
   * persistent it is the rail's own width, so the collapsed dock still shows a
   * column of activity icons. `react-resizable-panels` also uses this as the
   * drag target: dragging below `minSize` snaps here on its own.
   */
  const collapsedSize = railPersistent ? `${WORKBENCH_RAIL_WIDTH_PX}px` : "0%"

  /**
   * The dock's live width as the drag reports it, plus whether that drag began
   * from the rail. Both are read once on release to decide where the panel
   * settles — see `handleResizeRelease`. Refs rather than state: a drag writes
   * per tick, and re-rendering the whole workspace on every tick to hold a
   * number nobody displays would be pure cost.
   */
  const latestDockPercentRef = useRef(dockSize)
  const dragStartCollapsedRef = useRef(dockCollapsed)
  /**
   * The dock cap that keeps the conversation above `CHAT_MIN_PX`, refreshed
   * from the group's measured width on every layout.
   *
   * State rather than a ref because it feeds `maxSize`, which the panel library
   * reads at render. `onLayoutChanged` is the measurement seam — it already
   * fires on mount and on every resize, so no observer is needed — and the
   * write is equality-guarded so a settled layout cannot loop.
   */
  const [chatFloorCap, setChatFloorCap] = useState(100)

  /**
   * Release-snap. Runs on the divider's `pointerup`, never during the drag, so
   * the pointer is never fought — see `lib/ui/panel-snap.ts`.
   */
  const handleResizeRelease = () => {
    const element = dockPanelElementRef.current
    const groupWidthPx = element?.parentElement?.offsetWidth ?? 0
    const wasCollapsed = dragStartCollapsedRef.current
    const presets = DOCK_MODE_WIDTH_PERCENT[dockProfile]
    const snapped = snapPanelSize(latestDockPercentRef.current, {
      presets: [presets.narrow, presets.wide],
      floor: dockFloorPercent(element, workspaceProfile),
      // Opening out of the rail returns to the width the dock was left at,
      // which is exactly what `dockSize` still holds — a collapse never
      // overwrites it.
      expandTo: dockSize,
      wasCollapsed,
      magnet: magnetAsPercent(groupWidthPx),
    })
    if (snapped.kind === "collapsed") {
      setDockCollapsed(true)
      return
    }
    if (wasCollapsed) {
      // Re-opening is the store's job: `setDockCollapsed(false)` also clears the
      // dismissal and the unread flag, and its effect animates back to
      // `dockSize`. Only ask for a different width if the snap picked one.
      setDockCollapsed(false)
      if (snapped.size !== dockSize) requestDockSize(snapped.size)
      return
    }
    // A drop that no magnet moved is already where the pointer left it — the
    // per-tick `setDockSize` above recorded it. Asking for that same width
    // would still bump the request token and run a full snapshot transition
    // over an unchanged layout, so every ordinary drag ended with a 280ms
    // crossfade of the panels against themselves. Only a snap that actually
    // moves the divider is worth animating.
    if (Math.abs(snapped.size - latestDockPercentRef.current) < RELEASE_SNAP_EPSILON_PERCENT) {
      return
    }
    // Deliberately NOT routed through `setDockCollapsed(false)`: that also
    // raises `mobileSheetOpen`, and an ordinary desktop resize must not arm a
    // full-height Sheet for whenever the window is next narrowed to a phone.
    requestDockSize(snapped.size)
  }

  // Match the conversation sidebar: animate only collapse/expand, then remove
  // the transition so manual divider dragging remains immediate.
  useEffect(() => {
    if (previousDockCollapsedRef.current === dockCollapsed) return
    previousDockCollapsedRef.current = dockCollapsed

    const panel = dockPanelRef.current
    const element = dockPanelElementRef.current
    if (!panel || !element) return

    const target = dockSizeRef.current
    return animateDockResize(element, () => {
      if (dockCollapsed) panel.collapse()
      else panel.resize(`${target}%`)
    })
  }, [dockCollapsed])

  // A width preset (the workbench narrow/wide buttons) asked for a specific
  // size. Keyed on the request token rather than `dockSize`, because a drag
  // rewrites `dockSize` on every tick and would otherwise re-enter here and
  // fight the pointer.
  useEffect(() => {
    if (previousDockSizeRequestRef.current === dockSizeRequest) return
    previousDockSizeRequestRef.current = dockSizeRequest

    const panel = dockPanelRef.current
    const element = dockPanelElementRef.current
    if (!panel || !element || dockCollapsed) return

    const target = dockSizeRef.current
    return animateDockResize(element, () => panel.resize(`${target}%`))
  }, [dockCollapsed, dockSizeRequest])

  // Auto-expanding on a fresh artifact lives in `useDockAttentionSignal` on the
  // shared layer, so the mobile Sheet gets the identical rule.

  const workspaceProfile = dockProfile === "workspace"
  /**
   * The cap the panel is actually given: the profile's own cap, or the width
   * something just asked for — whichever is wider.
   *
   * `dockProfile` is written by `useDockPanelSync` in an effect that runs after
   * the activation which requested the width, so on the frame a workspace panel
   * asks for 65% the profile still reads `compact`, whose cap is 50%.
   * `react-resizable-panels` clamped the request to that stale cap and echoed
   * the clamped value back through `onLayoutChanged` — so the workspace panel
   * settled at the artifact width, and the clamp landed as a second,
   * untransitioned layout pass immediately after the first.
   *
   * Widening it costs nothing: `clampDockSize` already holds every stored width
   * under the workspace cap, so this can never exceed 65%. Leaving the workspace
   * profile still animates the dock back down — `setDockProfile` routes that
   * clamp through the request token.
   */
  const effectiveDockMax = Math.min(
    Math.max(workspaceProfile ? WORKSPACE_DOCK_BOUNDS.max : ARTIFACT_DOCK_BOUNDS.max, dockSize),
    // A physical limit, so it wins over the widening above — including over a
    // `dockSize` restored from a session on a wider window, which is the case
    // that arrives already too big rather than being dragged there.
    chatFloorCap
  )
  // The chat floor has to yield by the same amount, or it re-imposes the clamp
  // from the other side of the group.
  const chatMinSize = `${Math.min(
    workspaceProfile ? CHAT_MIN_PERCENT.workspace : CHAT_MIN_PERCENT.default,
    100 - effectiveDockMax
  )}%`
  const dockMinSize = workspaceProfile
    ? WORKSPACE_DOCK_BOUNDS.minPx
    : `${ARTIFACT_DOCK_BOUNDS.min}%`
  const dockMaxSize = `${effectiveDockMax}%`

  return (
    <div
      className="flex w-full flex-1 min-h-0 overflow-hidden"
      data-testid="artifact-workspace-dock"
    >
      <WorkspaceRevealOpener />
      <ResizablePanelGroup
        key={layoutVersion}
        orientation="horizontal"
        resizeTargetMinimumSize={{ coarse: 28, fine: 20 }}
        className="flex-1 min-h-0"
        onLayoutChanged={(layout) => {
          // Ahead of every early-out below: the cap has to track the window even
          // while the dock is collapsed, or re-opening applies a stale one.
          const nextCap = dockCapForChatFloor(
            dockPanelElementRef.current?.parentElement?.offsetWidth ?? 0
          )
          setChatFloorCap((previous) => (Math.abs(previous - nextCap) < 0.01 ? previous : nextCap))
          const dock = layout["artifact-dock"]
          if (typeof dock !== "number") return
          // Tracked before the collapsed early-out: dragging *out* of the rail
          // only produces layouts while the store still says collapsed, and the
          // release-snap has to know where the pointer actually left it.
          latestDockPercentRef.current = dock
          if (dockCollapsed) return
          // `react-resizable-panels` collapses a `collapsible` panel on its own
          // once a drag goes below `minSize`. Nothing used to tell the store, so
          // the dock sat visually shut while `dockCollapsed` stayed false — and
          // the next ⌘J (or header toggle, or Views menu) spent itself calling
          // `collapse()` on an already-collapsed panel and appeared dead.
          // Mirroring it here is what keeps those five entry points honest.
          //
          // Asked of the panel rather than inferred from the percentage: the
          // panel is the authority on its own collapsed state, and a percentage
          // test would also fire on the 0% every layout reports before the group
          // has measured.
          if (dockPanelRef.current?.isCollapsed()) {
            setDockCollapsed(true)
            return
          }
          // Reject only the collapse itself, not a legitimately narrow drag.
          // This used to gate on the *artifact* floor (24%) regardless of
          // profile, while the workspace profile's real floor is 480px — on a
          // 2560px screen that is ~18.75%, so dragging the workspace dock down
          // to its own minimum silently failed to persist and the next
          // collapse/expand snapped it back to the stale wider value.
          if (dock >= dockFloorPercent(dockPanelElementRef.current, workspaceProfile)) {
            setDockSize(dock)
          }
        }}
      >
        <ResizablePanel id="artifact-chat" minSize={chatMinSize}>
          <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden">{children}</div>
        </ResizablePanel>

        {/* Fades and narrows in lockstep with the panel. A hard `hidden` made
            the divider pop in over a zero-width dock on expand, and vanish
            before the dock had finished retracting on collapse.

            It stays live over a *persistent* rail, though: dragging this edge is
            how the minibar is opened, so the old unconditional `disabled` would
            have made "拖动开" impossible. Only a dock collapsed all the way to
            zero has nothing left to grab. */}
        <ResizableHandle
          withHandle
          aria-hidden={(dockCollapsed && !railPersistent) || undefined}
          className={cn(
            // Literal twin of DOCK_RESIZE_DURATION_MS / DOCK_RESIZE_EASE — see
            // their declaration for why this cannot read them directly.
            // Keep a real 20px hit target above the workbench border. The
            // library's default proximity target is only about 10px total, so
            // grabbing the visible edge a few pixels inside the panel missed.
            "z-20 after:w-5 transition-[width,opacity] duration-[calc(280ms*var(--motion-duration-scale,1))] ease-[cubic-bezier(0.32,0.72,0,1)]",
            dockCollapsed && !railPersistent && "w-0 opacity-0 [&>div]:opacity-0"
          )}
          disabled={dockCollapsed && !railPersistent}
          onPointerDown={() => {
            dragStartCollapsedRef.current = dockCollapsed
          }}
          onPointerUp={handleResizeRelease}
          // Editor-splitter convention: double-click restores the current
          // profile's preset width. Routed through the request token so the
          // change animates like the narrow/wide buttons instead of snapping.
          onDoubleClick={() => {
            if (dockCollapsed) return
            requestDockSize(DOCK_MODE_WIDTH_PERCENT[dockProfile].narrow)
          }}
        />

        <ResizablePanel
          id="artifact-dock"
          panelRef={dockPanelRef}
          elementRef={dockPanelElementRef}
          defaultSize={dockCollapsed ? collapsedSize : `${dockSize}%`}
          minSize={dockMinSize}
          maxSize={dockMaxSize}
          collapsible
          collapsedSize={collapsedSize}
        >
          <div data-testid="artifact-dock-wrapper" className="h-full min-w-0 overflow-hidden">
            {dockContentMounted ? <ArtifactDock railOnly={!dockBodyMounted} /> : null}
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  )
}

export default ArtifactWorkspaceDock
