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

import {
  Activity,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react"
import { useTranslations } from "next-intl"
import type { PanelImperativeHandle } from "react-resizable-panels"
import { FocusScope } from "radix-ui/internal"
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable"
import { onBrowserUrlReveal } from "@/lib/browser/open-url-request"
import { runShellViewTransition } from "@/lib/ui/shell-view-transition"
import { useShellColumnsStore } from "@/stores/ui/shell-columns-store"
import {
  SHELL_DOCK_CLEANUP_SLACK_MS,
  SHELL_DOCK_DURATION_MS,
  SHELL_DOCK_EASE,
} from "@/lib/ui/shell-dock-motion"
import { magnetAsPercent, snapPanelSize } from "@/lib/ui/panel-snap"
import { cn } from "@/lib/utils"
import { WORKBENCH_RAIL_WIDTH_PX } from "@/types/shell/workbench-rail"
import { useEffectiveWorkbenchRailPersistent as useWorkbenchRailPersistent } from "@/components/shell/use-workbench-rail-layout"
import { useReportShellColumn } from "@/hooks/shell/use-report-shell-column"
import { useChatRowBudget } from "@/hooks/shell/use-chat-row-budget"
import { dockOverlayWidthPx, type ChatRowDockFloor } from "@/lib/shell/chat-row-budget"
import {
  TitleBarProjectionScope,
  useTitleBarProjectionScope,
} from "@/components/shell/title-bar-outlets"
import { useBreakpoint } from "@/hooks/ui"
import { useArtifactStore } from "@/stores/artifact/artifact-store"
import { useActiveArtifactId, useArtifactSessionId } from "@/hooks/artifacts/use-session-artifacts"
import {
  ARTIFACT_DOCK_BOUNDS,
  CHAT_MIN_PERCENT,
  CHAT_MIN_PX,
  DOCK_MODE_WIDTH_PERCENT,
  WORKSPACE_DOCK_BOUNDS,
  useArtifactDockLayoutStore,
} from "@/stores/artifact/artifact-dock-layout-store"
import { useArtifactDockShortcuts } from "@/hooks/artifacts/use-artifact-dock-shortcuts"
import { useAppShortcut } from "@/hooks/shortcuts/use-app-shortcut"
import { useContextWorkbenchInstanceId } from "@/hooks/context-workbench/use-context-workbench-instance-id"
import {
  ARTIFACT_DOCK_WORKBENCH_HOST_KEY,
  sessionWorkbenchScopeKey,
} from "@/lib/artifacts/session-workbench-scope-key"
import { useChatStore } from "@/stores/chat"
import { openDockNewTab, openDockPage } from "@/lib/artifacts/dock-pages"
import { agentPageOwner } from "@/lib/browser/agent-engine"
import { chatSessionOfOwner } from "@/lib/browser/shared-local-browser"
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
 * The title bar's center and end outlets sit directly above this row and are
 * captured with it — they are live elements that would otherwise snap to the
 * post-commit geometry on the first frame while the panels below still slid.
 * The outlets' DOM already reads the gesture's resting width because `apply`
 * publishes it through `useShellColumnsStore`'s `targets` before the new
 * snapshot is taken; `onDone` clears that target when the motion settles.
 *
 * View Transitions are progressive enhancement. Unsupported engines resize in
 * one stable frame, and a native Pro IDE child webview always takes that path
 * because a DOM snapshot cannot capture or clip it.
 */
function animateDockResize(panel: HTMLDivElement, apply: () => void): () => void {
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

  return runShellViewTransition({
    scope: panel,
    captures: [
      { element: chat, name: "cognia-dock-chat" },
      { element: divider, name: "cognia-dock-divider" },
      { element: panel, name: "cognia-dock-panel" },
      {
        element: document.querySelector<HTMLElement>('[data-title-bar-outlet="center"]'),
        name: "cognia-dock-outlet-center",
      },
      {
        element: document.querySelector<HTMLElement>('[data-title-bar-outlet="end"]'),
        name: "cognia-dock-outlet-end",
      },
    ],
    apply,
    onDone: () => useShellColumnsStore.getState().setColumnTarget("dock", null),
  })
}

/**
 * The dock column's resting width once this gesture lands, published inside
 * the transition's DOM update so the title bar's end outlet reaches the same
 * final width in the new snapshot.
 *
 * A plain store write, not `flushSync`: this runs inside a passive effect on
 * the bail-out path, where `flushSync` is illegal. It still lands before the
 * browser's new-state capture — `useSyncExternalStore` commits external-store
 * writes before the next paint, and a View Transition captures no earlier
 * than the first rendering step after the update callback returns.
 */
function publishDockColumnTarget(panel: HTMLElement): void {
  useShellColumnsStore.getState().setColumnTarget("dock", panel.getBoundingClientRect().width)
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

/** The dock's floor in the row budget's terms (`lib/shell/chat-row-budget.ts`). */
export function dockFloorForProfile(workspaceProfile: boolean): ChatRowDockFloor {
  return workspaceProfile
    ? { minPx: Number.parseFloat(WORKSPACE_DOCK_BOUNDS.minPx), minPercent: 0 }
    : { minPx: 0, minPercent: ARTIFACT_DOCK_BOUNDS.min }
}

/**
 * Below this a cap change is noise: the group's width converts to a percent
 * through a division, so a settled layout reports the same cap a few decimals
 * apart.
 */
const CAP_EPSILON_PERCENT = 0.5

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
function useDockAttentionSignal({
  raiseOnConversationChange,
}: {
  raiseOnConversationChange: boolean
}): void {
  const notifyNewArtifact = useArtifactDockLayoutStore((s) => s.notifyNewArtifact)
  // Scoped to the conversation on screen: an artifact landing in a *background*
  // session must not raise the dock over the one the user is reading.
  const sessionId = useArtifactSessionId()
  const activeArtifactId = useActiveArtifactId()
  const pendingReviewCount = useArtifactStore((s) => Object.keys(s.pendingReviews).length)
  const previousRef = useRef({ sessionId, activeArtifactId, pendingReviewCount })

  useEffect(() => {
    const previous = previousRef.current
    previousRef.current = { sessionId, activeArtifactId, pendingReviewCount }
    // A different conversation coming on screen is not a new artifact: its
    // parked one (`activeArtifactIdBySession` is persisted) merely became
    // visible. That includes app launch, where the restored session moves
    // `activeSessionId` off `null` after this host has mounted — on a phone
    // that read as "fresh artifact" and threw the Sheet over the conversation
    // on every single launch. The desktop dock keeps its long-standing
    // behaviour of following the conversation; its open state is a persisted
    // preference there, where the Sheet's is deliberately runtime-only.
    if (sessionId !== previous.sessionId && !raiseOnConversationChange) return
    // Keyed on the id so it only reacts to a *new* artifact, not every render.
    const freshArtifact =
      Boolean(activeArtifactId) && activeArtifactId !== previous.activeArtifactId
    const freshReview = pendingReviewCount > previous.pendingReviewCount
    if (freshArtifact || freshReview) notifyNewArtifact()
  }, [
    activeArtifactId,
    notifyNewArtifact,
    pendingReviewCount,
    raiseOnConversationChange,
    sessionId,
  ])
}

/**
 * How long a collapsed dock's body stays parked behind `<Activity>` before it
 * is unmounted for real. Re-opening within it is a reveal, not a rebuild: the
 * project editor keeps its tabs, tree and documents, the side chat its
 * transcript, and nothing re-reads the disk. Long enough to cover the
 * ⌘J-to-peek-and-back rhythm; short enough that an abandoned dock does not hold
 * its DOM for the rest of the session.
 */
export const DOCK_BODY_PARK_MS = 5 * 60_000

/**
 * Where a collapsed dock's body is in its retreat:
 *
 * - `shown` — on screen, and for exactly one collapse animation after it closes;
 * - `parked` — behind `<Activity mode="hidden">`: DOM and React state kept,
 *   every effect torn down;
 * - `gone` — unmounted.
 *
 * A collapsed dock used to stay fully mounted at zero width — Monaco, the
 * resource chat pane and the embedded browser all still running behind a panel
 * nobody could see. The browser pane is the sharpest case: it holds a
 * *process-wide* embedded-webview lease, so an invisible dock could lock every
 * other surface out of the webview. The fix was to unmount the body once the
 * collapse finished — which made every re-open a cold mount: the project
 * editor re-listed its tree, re-read its open files and rebuilt its editors
 * while the dock was trying to animate open.
 *
 * Parking keeps the first fix without the second cost. `<Activity>` hidden runs
 * every effect's cleanup — the browser releases its lease, the project editor
 * unregisters its opener (so a reveal still routes through the dock and opens
 * it), the title-bar projection stands down — while the state and DOM survive
 * for a cheap reveal. It is the state the workbench already parks inactive
 * panels in. Only after {@link DOCK_BODY_PARK_MS} does the body go.
 *
 * The first delay is not cosmetic. `animateDockResize` captures the open and
 * collapsed layouts as compositor snapshots; hiding the body on the same frame
 * would capture an empty panel instead of letting it move cleanly into the
 * edge.
 *
 * A dock that mounts already collapsed starts `gone`: app launch must not build
 * a body nobody has asked to see.
 *
 * **With a persistent rail** the shell never parks or goes — the workbench has
 * to keep drawing its activity rail — and `shown` alone decides `railOnly`,
 * which drops the panel body inside the workbench instead. The lease invariant
 * holds there too: rail-only unmounts every panel.
 */
type DockBodyPhase = "shown" | "parked" | "gone"

function useDockBodyPhase(
  dockCollapsed: boolean,
  panelElementRef: { current: HTMLElement | null }
): DockBodyPhase {
  // Only the timers move it forward. Expanding resets it *during render* —
  // React's sanctioned "adjust state when a prop changes" pattern, and what
  // `react-hooks/set-state-in-effect` steers you to: re-opening is immediate
  // and must not wait a second render pass to put the body back.
  const [phase, setPhase] = useState<DockBodyPhase>(dockCollapsed ? "gone" : "shown")
  if (!dockCollapsed && phase !== "shown") setPhase("shown")

  useEffect(() => {
    if (!dockCollapsed || phase === "gone") return
    const element = panelElementRef.current
    const timer =
      phase === "shown"
        ? window.setTimeout(
            () => setPhase("parked"),
            DOCK_RESIZE_DURATION_MS *
              (element
                ? Number(getComputedStyle(element).getPropertyValue("--motion-duration-scale")) || 1
                : 1) +
              DOCK_RESIZE_CLEANUP_SLACK_MS
          )
        : window.setTimeout(() => setPhase("gone"), DOCK_BODY_PARK_MS)
    return () => window.clearTimeout(timer)
  }, [dockCollapsed, panelElementRef, phase])

  return phase
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
 * On the phone Sheet, `openBrowser` puts the one browser panel on screen from
 * outside the workbench and carries the address with it. On the desktop dock
 * an address becomes a page tab instead (`openDockPage`); the docked browser
 * never claims the first round, so every link comes through here. Elsewhere a
 * visible pane answers the earlier round in `requestBrowserUrl` and this never
 * runs.
 */
function useSideBrowserReveal({ pageTabs }: { pageTabs: boolean }): void {
  const openBrowser = useArtifactDockLayoutStore((state) => state.openBrowser)
  useEffect(
    () =>
      onBrowserUrlReveal((url, request) => {
        if (!pageTabs) {
          openBrowser(url)
          return true
        }
        // The desktop dock shows pages as tabs of the conversation they belong
        // to (ADR-0214): an agent's request goes to its own conversation — an
        // External Bridge client's to the one it was pinned to — and only the
        // conversation on screen is brought forward.
        const active = useChatStore.getState().activeSessionId
        const target =
          request.source === "agent"
            ? (chatSessionOfOwner(agentPageOwner(request.chatSessionId)) ?? active)
            : active
        if (!target) return false
        openDockPage(target, url, {
          ...(request.source ? { source: request.source } : {}),
          ...(request.backend ? { backend: request.backend } : {}),
          reveal: target === active,
        })
        return true
      }),
    [openBrowser, pageTabs]
  )
}

export function ArtifactWorkspaceDock({ children }: { children: ReactNode }) {
  const breakpoint = useBreakpoint()
  useArtifactDockShortcuts()
  useDockAttentionSignal({ raiseOnConversationChange: breakpoint === "desktop" })
  useSideBrowserReveal({ pageTabs: breakpoint === "desktop" })

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
  const workbenchInstanceId = useContextWorkbenchInstanceId(ARTIFACT_DOCK_WORKBENCH_HOST_KEY)
  const activeSessionId = useChatStore((s) => s.activeSessionId)
  // ⌘T (ADR-0214, D7) — here rather than on the strip, which only exists while
  // the dock is open; a shut dock opens on the New Tab page.
  useAppShortcut(
    "dock.newTab",
    () =>
      openDockNewTab(
        activeSessionId,
        sessionWorkbenchScopeKey(workbenchInstanceId, activeSessionId)
      ),
    { allowInEditable: true, preventDefault: true }
  )
  const dockSize = useArtifactDockLayoutStore((s) => s.dockSize)
  const dockCollapsed = useArtifactDockLayoutStore((s) => s.dockCollapsed)
  const dockProfile = useArtifactDockLayoutStore((s) => s.dockProfile)
  const layoutVersion = useArtifactDockLayoutStore((s) => s.layoutVersion)
  const dockSizeRequest = useArtifactDockLayoutStore((s) => s.dockSizeRequest)
  const setDockSize = useArtifactDockLayoutStore((s) => s.setDockSize)
  const requestDockSize = useArtifactDockLayoutStore((s) => s.requestDockSize)
  const setDockCollapsed = useArtifactDockLayoutStore((s) => s.setDockCollapsed)
  const railPreference = useWorkbenchRailPersistent()
  const railPersistent = railPreference
  const t = useTranslations("artifacts.dock")
  const projectionScope = useTitleBarProjectionScope()

  /**
   * The chat row's width budget (ADR-0214, D5): when the window cannot hold
   * the chat's minimum beside the dock's floor, the sidebar folds first and
   * the dock floats over the chat last. The row is this host's parent — the
   * element the conversation sidebar shares with it.
   */
  const [row, setRow] = useState<HTMLElement | null>(null)
  const bindRoot = useCallback((element: HTMLDivElement | null) => {
    setRow(element?.parentElement ?? null)
  }, [])
  const dockFloor = dockFloorForProfile(dockProfile === "workspace")
  const budget = useChatRowBudget({
    row,
    dockOpen: !dockCollapsed,
    dockFloor,
    chatMinPx: CHAT_MIN_PX,
  })
  /** The dock floats over the chat; only ever true while it is open. */
  const overlayOpen = budget?.overlay ?? false
  const overlayWidthPx = budget ? dockOverlayWidthPx(budget.groupPx, dockSize, dockFloor) : 0
  /**
   * Read by the effects and the layout callback below, which must not treat
   * the column the overlay shut as the user's collapse. A layout effect so it
   * is current before the passive effects of the same commit.
   */
  const overlayRef = useRef(overlayOpen)
  useLayoutEffect(() => {
    overlayRef.current = overlayOpen
  }, [overlayOpen])
  const overlayElementRef = useRef<HTMLDivElement | null>(null)
  const overlayReturnFocusRef = useRef<HTMLElement | null>(null)
  const previousOverlayRef = useRef(overlayOpen)
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
   * Where the panel *body* is in its retreat (see `useDockBodyPhase`). It leaves
   * the screen one animation after a collapse, so the old snapshot contains real
   * content instead of an empty box.
   *
   * Three consumers read this one clock: whether `<ArtifactDock />` renders at
   * all, whether it is parked behind `<Activity>` (only when the rail is not
   * persistent), and — with a persistent rail — `railOnly`, which drops the body
   * inside the workbench. Deriving any of them from the raw `dockCollapsed`
   * would flip it before the transition captured the outgoing panel and make the
   * body blink away.
   */
  const dockBodyPhase = useDockBodyPhase(dockCollapsed, dockPanelElementRef)
  const dockBodyMounted = dockBodyPhase === "shown"
  /** Rendered at all — on screen, rail-only, or parked behind `<Activity>`. */
  const dockContentMounted = railPersistent || dockBodyPhase !== "gone"
  /** Parked: kept for a cheap reveal, every effect torn down. Never with a rail. */
  const dockBodyParked = !railPersistent && dockBodyPhase === "parked"
  /**
   * What the panel shrinks to. `0%` is the pre-minibar behaviour; with the rail
   * persistent it is the rail's own width, so the collapsed dock still shows a
   * column of activity icons. `react-resizable-panels` also uses this as the
   * drag target: dragging below `minSize` snaps here on its own.
   */
  const collapsedSize = railPersistent ? `${WORKBENCH_RAIL_WIDTH_PX}px` : "0%"
  /** Overlaid, the column shuts all the way: the rail floats with the dock. */
  const panelCollapsedSize = overlayOpen ? "0%" : collapsedSize

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
  const previousChatFloorCapRef = useRef(chatFloorCap)

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
    // Opening into the overlay: the column stays shut and the dock floats.
    if (!dockCollapsed && overlayRef.current) return

    const panel = dockPanelRef.current
    const element = dockPanelElementRef.current
    if (!panel || !element) return

    const target = dockSizeRef.current
    return animateDockResize(element, () => {
      if (dockCollapsed) panel.collapse()
      else panel.resize(`${target}%`)
      publishDockColumnTarget(element)
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
    if (!panel || !element || dockCollapsed || overlayRef.current) return

    const target = dockSizeRef.current
    return animateDockResize(element, () => {
      panel.resize(`${target}%`)
      publishDockColumnTarget(element)
    })
  }, [dockCollapsed, dockSizeRequest])

  // Into and out of the overlay. Entering shuts the column (the content floats
  // instead) and takes focus into the dock, which is modal while it covers the
  // chat; leaving because the window widened puts the dock back at its width,
  // and leaving because it closed returns focus to where it came from.
  useEffect(() => {
    if (previousOverlayRef.current === overlayOpen) return
    previousOverlayRef.current = overlayOpen
    const panel = dockPanelRef.current
    if (overlayOpen) {
      panel?.collapse()
      const active = document.activeElement
      overlayReturnFocusRef.current = active instanceof HTMLElement ? active : null
      overlayElementRef.current?.focus()
      return
    }
    const returnTo = overlayReturnFocusRef.current
    overlayReturnFocusRef.current = null
    if (!useArtifactDockLayoutStore.getState().dockCollapsed) {
      panel?.resize(`${dockSizeRef.current}%`)
      return
    }
    const active = document.activeElement
    const focusLeftBehind =
      active === null ||
      active === document.body ||
      Boolean(overlayElementRef.current?.contains(active))
    if (focusLeftBehind && returnTo?.isConnected) returnTo.focus()
  }, [overlayOpen])

  // The window widened under a dock its cap had been holding below the width
  // the user gave it: grow back toward that width. The cap is the window's
  // limit, not a choice, so it never overwrote `dockSize` (see the layout
  // callback) and the user's width is still there to return to.
  useEffect(() => {
    const previous = previousChatFloorCapRef.current
    previousChatFloorCapRef.current = chatFloorCap
    if (chatFloorCap <= previous + CAP_EPSILON_PERCENT) return
    const state = useArtifactDockLayoutStore.getState()
    const panel = dockPanelRef.current
    if (!panel || state.dockCollapsed || overlayRef.current) return
    if (previous + CAP_EPSILON_PERCENT >= state.dockSize) return
    panel.resize(`${Math.min(state.dockSize, chatFloorCap)}%`)
  }, [chatFloorCap])

  const closeOverlay = () => setDockCollapsed(true)
  const handleOverlayKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // A menu or dialog inside the dock dismisses itself first and marks the
    // event handled; only an Escape nothing else claimed closes the overlay.
    if (event.key !== "Escape" || event.defaultPrevented) return
    event.preventDefault()
    closeOverlay()
  }

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
      ref={bindRoot}
      // `relative`: the overlaid dock and its scrim position against this box,
      // which the panel group and panels (none of them positioned) do not clip.
      className="relative flex w-full flex-1 min-h-0 overflow-hidden"
      data-testid="artifact-workspace-dock"
      data-dock-overlay={overlayOpen || undefined}
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
          // The overlay shut the column on purpose: neither a collapse to
          // mirror nor a width to keep.
          if (overlayRef.current) return
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
          //
          // Nor a dock that is merely sitting on the chat-floor cap below the
          // width it was given: the window narrowed under it, and that width is
          // the window's, not the user's — the cap effect grows it back.
          // The cap it sits on may be the one this very layout just lifted:
          // a widening window first reports the dock still at the old cap.
          const heldByCap = [nextCap, chatFloorCap].some(
            (cap) =>
              cap + CAP_EPSILON_PERCENT < dockSizeRef.current &&
              Math.abs(dock - cap) < CAP_EPSILON_PERCENT
          )
          if (
            !heldByCap &&
            dock >= dockFloorPercent(dockPanelElementRef.current, workspaceProfile)
          ) {
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
          aria-hidden={(dockCollapsed && !railPersistent) || overlayOpen || undefined}
          className={cn(
            // Literal twin of DOCK_RESIZE_DURATION_MS / DOCK_RESIZE_EASE — see
            // their declaration for why this cannot read them directly.
            // Keep a real 20px hit target above the workbench border. The
            // library's default proximity target is only about 10px total, so
            // grabbing the visible edge a few pixels inside the panel missed.
            "z-20 after:w-5 transition-[width,opacity] duration-[calc(280ms*var(--motion-duration-scale,1))] ease-[cubic-bezier(0.32,0.72,0,1)]",
            ((dockCollapsed && !railPersistent) || overlayOpen) && "w-0 opacity-0 [&>div]:opacity-0"
          )}
          disabled={(dockCollapsed && !railPersistent) || overlayOpen}
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
          defaultSize={dockCollapsed || overlayOpen ? panelCollapsedSize : `${dockSize}%`}
          minSize={dockMinSize}
          maxSize={dockMaxSize}
          collapsible
          collapsedSize={panelCollapsedSize}
        >
          {/* One element in both shapes, so the dock's content (a live browser
              page, open editors) never remounts when the window crosses into
              the overlay. Overlaid, it leaves the shut column by absolute
              positioning against the host, and is a modal dialog: focus is
              trapped inside, Escape or the scrim closes it. Its header draws
              inline there — the title bar's end zone is sized to the column,
              which the overlay shut. */}
          <FocusScope.FocusScope
            asChild
            trapped={overlayOpen}
            loop
            onMountAutoFocus={(event) => event.preventDefault()}
            onUnmountAutoFocus={(event) => event.preventDefault()}
          >
            <div
              ref={overlayElementRef}
              data-testid="artifact-dock-wrapper"
              role={overlayOpen ? "dialog" : undefined}
              aria-modal={overlayOpen || undefined}
              aria-label={overlayOpen ? t("overlayLabel") : undefined}
              onKeyDown={overlayOpen ? handleOverlayKeyDown : undefined}
              className={cn(
                "h-full min-w-0 overflow-hidden outline-none",
                overlayOpen &&
                  "absolute inset-y-0 right-0 z-40 border-l bg-background shadow-(--elevation-3) animate-in fade-in-0 slide-in-from-right-4"
              )}
              style={overlayOpen ? { width: overlayWidthPx } : undefined}
            >
              <TitleBarProjectionScope enabled={projectionScope && !overlayOpen}>
                {dockContentMounted ? (
                  // One `<Activity>` in every shape, so parking and revealing
                  // flip its mode rather than changing the tree — a changed
                  // parent would remount the very body parking exists to keep.
                  <Activity mode={dockBodyParked ? "hidden" : "visible"}>
                    <ArtifactDock railOnly={railPersistent && !dockBodyMounted} />
                  </Activity>
                ) : null}
              </TitleBarProjectionScope>
            </div>
          </FocusScope.FocusScope>
        </ResizablePanel>
      </ResizablePanelGroup>
      {overlayOpen ? (
        // Pointer-only: the keyboard closes the overlay with Escape, so the
        // scrim stays out of the tab order and the accessibility tree.
        <div
          aria-hidden
          data-testid="artifact-dock-scrim"
          className="absolute inset-0 z-30 bg-black/30 animate-in fade-in-0"
          onClick={closeOverlay}
        />
      ) : null}
    </div>
  )
}

export default ArtifactWorkspaceDock
