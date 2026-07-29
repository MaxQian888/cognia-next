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

import { useEffect, useRef, useState, type ReactNode } from "react"
import type { PanelImperativeHandle } from "react-resizable-panels"
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable"
import { isProIdePanePinnedWithin } from "@/lib/codeserver/pane-manager"
import { MOBILE_DURATION, MOBILE_EASE } from "@/lib/ui/motion"
import { cn } from "@/lib/utils"
import { useBreakpoint } from "@/hooks/ui"
import { useArtifactStore } from "@/stores/artifact/artifact-store"
import { useActiveArtifactId } from "@/hooks/artifacts/use-session-artifacts"
import {
  ARTIFACT_DOCK_BOUNDS,
  CHAT_MIN_PERCENT,
  DOCK_MODE_WIDTH_PERCENT,
  WORKSPACE_DOCK_BOUNDS,
  useArtifactDockLayoutStore,
} from "@/stores/artifact/artifact-dock-layout-store"
import { useArtifactDockShortcuts } from "@/hooks/artifacts/use-artifact-dock-shortcuts"
import { ArtifactPanel } from "./artifact-panel"
import { ArtifactDock } from "./artifact-dock"
import { WorkspaceRevealOpener } from "./workspace-mode/workspace-reveal-opener"

/**
 * Apply a dock size change under a short flex-grow transition, then strip the
 * transition again so manual divider dragging stays immediate.
 *
 * The panel's content is pinned to the width it will occupy when the animation
 * settles, so the shrinking shell *wipes* it instead of reflowing it. Without
 * that pin the dock squashed for the whole transition — the activity rail is `shrink-0` while
 * the panel body is not, so the body alone got crushed on the way out and
 * stretched on the way in.
 *
 * Uses inline styles (not Tailwind classes) so the duration can consume the
 * user's `--motion-duration-scale` preference — a runtime `classList.add` of an
 * arbitrary Tailwind class would never be JIT-compiled into the CSS. The
 * cleanup delay is scaled by the same multiplier so a slower (1.5×) preference
 * isn't cut short; reduce-motion collapses it via the global CSS guard.
 *
 * **Skipped entirely while a Pro IDE pane is pinned inside this dock.** That
 * pane is a native child webview floating above the DOM: CSS neither clips nor
 * tweens it, and its bounds are re-pushed over IPC once per frame. Animating
 * around it costs a full VS Code relayout every frame — and, worse, the frozen
 * content width below would hold the reserved rect at full size for the whole
 * transition, so a collapse left a full-width VS Code hanging over the chat before
 * snapping away. `app/globals.css` states this policy for the shell transitions
 * it can reach; inline styles are out of the stylesheet's reach, so the same
 * policy is enforced here instead.
 */
/**
 * Duration and curve both come from the shared motion tokens, so the dock
 * moves on the same clock as the terminal dock, the mobile sheets and every
 * other surface built from them. They used to be a local `200ms ease-in-out`,
 * which was a third curve competing with `MOBILE_EASE` and `MotionCollapse`.
 *
 * The divider below carries the same pair as a literal Tailwind class — an
 * arbitrary value cannot be interpolated from a constant and still be
 * JIT-compiled. `artifact-workspace-dock.test.tsx` pins the two together.
 */
export const DOCK_RESIZE_DURATION_MS = MOBILE_DURATION.normal * 1000
export const DOCK_RESIZE_EASE = `cubic-bezier(${MOBILE_EASE.join(",")})`
/** Cleanup runs a beat past the animation so a slower preference isn't cut short. */
const DOCK_RESIZE_CLEANUP_SLACK_MS = 40

/**
 * The user's motion-speed preference, as published by `motion-applier`.
 * jsdom reports no custom properties, so this falls back to 1× in tests.
 */
function motionDurationScale(element: HTMLElement): number {
  return Number(getComputedStyle(element).getPropertyValue("--motion-duration-scale")) || 1
}

function animateDockResize(
  panel: HTMLDivElement,
  content: HTMLDivElement | null,
  /** Target width as a percent of the group, or null when collapsing to zero. */
  targetPercent: number | null,
  apply: () => void
): () => void {
  if (isProIdePanePinnedWithin(panel)) {
    apply()
    return () => {}
  }

  // Collapsing: hold what is on screen. Expanding: the panel is at ~0, so hold
  // the width it is heading for — the content is then laid out correctly from
  // the first frame and the widening panel reveals it.
  const frozenWidth =
    targetPercent === null
      ? (content?.offsetWidth ?? 0)
      : ((panel.parentElement?.offsetWidth ?? 0) * targetPercent) / 100

  const reset = () => {
    panel.style.transitionProperty = ""
    panel.style.transitionDuration = ""
    panel.style.transitionTimingFunction = ""
    if (content) content.style.width = ""
  }

  if (content && frozenWidth > 0) content.style.width = `${frozenWidth}px`
  panel.style.transitionProperty = "flex-grow"
  panel.style.transitionDuration = `calc(${DOCK_RESIZE_DURATION_MS}ms * var(--motion-duration-scale, 1))`
  panel.style.transitionTimingFunction = DOCK_RESIZE_EASE
  // Commit the transition style before react-resizable-panels updates flex-grow.
  void panel.offsetWidth
  apply()

  const timer = window.setTimeout(
    reset,
    DOCK_RESIZE_DURATION_MS * motionDurationScale(panel) + DOCK_RESIZE_CLEANUP_SLACK_MS
  )
  return () => {
    window.clearTimeout(timer)
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
 * The delay is not cosmetic. `animateDockResize` freezes the content's width so
 * the shrinking shell wipes it rather than reflowing it; unmounting on the same
 * frame would leave that animation wiping an empty box.
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
      DOCK_RESIZE_DURATION_MS * (element ? motionDurationScale(element) : 1) +
        DOCK_RESIZE_CLEANUP_SLACK_MS
    )
    return () => window.clearTimeout(timer)
  }, [dockCollapsed, panelElementRef, retracted])

  return !retracted
}

export function ArtifactWorkspaceDock({ children }: { children: ReactNode }) {
  useArtifactDockShortcuts()
  useDockAttentionSignal()
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
  const dockPanelRef = useRef<PanelImperativeHandle | null>(null)
  const dockPanelElementRef = useRef<HTMLDivElement | null>(null)
  const dockContentElementRef = useRef<HTMLDivElement | null>(null)
  const previousDockCollapsedRef = useRef(dockCollapsed)
  const previousDockSizeRequestRef = useRef(dockSizeRequest)
  const dockContentMounted = useDockContentMounted(dockCollapsed, dockPanelElementRef)

  // Match the conversation sidebar: animate only collapse/expand, then remove
  // the transition so manual divider dragging remains immediate.
  useEffect(() => {
    if (previousDockCollapsedRef.current === dockCollapsed) return
    previousDockCollapsedRef.current = dockCollapsed

    const panel = dockPanelRef.current
    const element = dockPanelElementRef.current
    if (!panel || !element) return

    return animateDockResize(
      element,
      dockContentElementRef.current,
      dockCollapsed ? null : dockSize,
      () => {
        if (dockCollapsed) panel.collapse()
        else panel.resize(`${dockSize}%`)
      }
    )
  }, [dockCollapsed, dockSize])

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

    return animateDockResize(element, dockContentElementRef.current, dockSize, () =>
      panel.resize(`${dockSize}%`)
    )
  }, [dockCollapsed, dockSize, dockSizeRequest])

  // Auto-expanding on a fresh artifact lives in `useDockAttentionSignal` on the
  // shared layer, so the mobile Sheet gets the identical rule.

  const workspaceProfile = dockProfile === "workspace"
  const chatMinSize = workspaceProfile
    ? `${CHAT_MIN_PERCENT.workspace}%`
    : `${CHAT_MIN_PERCENT.default}%`
  const dockMinSize = workspaceProfile
    ? WORKSPACE_DOCK_BOUNDS.minPx
    : `${ARTIFACT_DOCK_BOUNDS.min}%`
  const dockMaxSize = workspaceProfile
    ? `${WORKSPACE_DOCK_BOUNDS.max}%`
    : `${ARTIFACT_DOCK_BOUNDS.max}%`

  return (
    <div
      className="flex w-full flex-1 min-h-0 overflow-hidden"
      data-testid="artifact-workspace-dock"
    >
      <WorkspaceRevealOpener />
      <ResizablePanelGroup
        key={layoutVersion}
        orientation="horizontal"
        className="flex-1 min-h-0"
        onLayoutChanged={(layout) => {
          const dock = layout["artifact-dock"]
          if (dockCollapsed || typeof dock !== "number") return
          // Reject only the collapse itself (0%), not a legitimately narrow
          // drag. This used to gate on the *artifact* floor (24%) regardless of
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
            before the dock had finished retracting on collapse. */}
        <ResizableHandle
          withHandle
          aria-hidden={dockCollapsed || undefined}
          className={cn(
            // Literal twin of DOCK_RESIZE_DURATION_MS / DOCK_RESIZE_EASE — see
            // their declaration for why this cannot read them directly.
            "transition-[width,opacity] duration-[calc(280ms*var(--motion-duration-scale,1))] ease-[cubic-bezier(0.32,0.72,0,1)]",
            dockCollapsed && "w-0 opacity-0 [&>div]:opacity-0"
          )}
          disabled={dockCollapsed}
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
          defaultSize={dockCollapsed ? "0%" : `${dockSize}%`}
          minSize={dockMinSize}
          maxSize={dockMaxSize}
          collapsible
          collapsedSize="0%"
        >
          <div
            ref={dockContentElementRef}
            data-testid="artifact-dock-wrapper"
            className="h-full min-w-0 overflow-hidden"
          >
            {dockContentMounted ? <ArtifactDock /> : null}
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  )
}

export default ArtifactWorkspaceDock
