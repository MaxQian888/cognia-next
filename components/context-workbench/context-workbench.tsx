"use client"

import {
  Activity,
  Component,
  createContext,
  useCallback,
  useContext,
  useMemo,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ErrorInfo,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react"
import { useTranslations } from "next-intl"
import {
  FocusIcon,
  PanelRightCloseIcon,
  PanelRightIcon,
  MoreHorizontalIcon,
  PinIcon,
  RotateCcwIcon,
  Rows3Icon,
  SlidersHorizontalIcon,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { cn } from "@/lib/utils"
import { ChatScopeProvider } from "@/components/chat/chat-scope-provider"
import { useResourceWorkbenchSession } from "@/hooks/chat/use-resource-workbench-session"
import { contextPanelRegistry } from "@/lib/context-workbench/panel-registry"
import {
  setActiveContextForHost,
  touchActiveContextHost,
} from "@/lib/context-workbench/active-context"
import { PluginExtensionSlot } from "@/components/plugins/plugin-extension-slot"
import {
  CONTEXT_WORKBENCH_DEFAULT_WIDTH,
  useContextWorkbenchStore,
  type ContextWorkbenchLayout,
} from "@/stores/context-workbench/context-workbench-store"
import {
  contextActivityRailIndex,
  getContextResourceKey,
  type ContextPanelDefinition,
  type ContextPanelMode,
  type ContextResource,
  type ContextWorkbenchMode,
  type ContextWorkbenchPlacement,
} from "@/types/context-workbench"

interface ContextWorkbenchValue {
  workbenchInstanceId: string
  resource: ContextResource
  scopeKey: string
  layout: ContextWorkbenchLayout
}

const ContextWorkbenchContext = createContext<ContextWorkbenchValue | null>(null)

const FALLBACK_CONTEXT_WORKBENCH_LAYOUT: ContextWorkbenchLayout = {
  mode: "narrow",
  width: 360,
  panelWidths: {},
  activePanelId: null,
  userPinned: false,
  activatedPanelIds: [],
  pendingPanelIds: [],
  lastUsedAt: 0,
}

const FOCUS_TAKEOVER_DURATION_MS = 200
/** Outlast the animation slightly so a slower motion preference isn't cut short. */
const FOCUS_TAKEOVER_SLACK_MS = 40

/**
 * Hold the focus takeover's layout for one animation after the mode leaves it.
 *
 * Entering focus zoomed and faded in; leaving it simply had the class taken
 * away, so a full-screen surface snapped back into a 34%-wide rail in a single
 * frame. Keeping the fixed layout mounted for the exit lets the same easing
 * contract run in reverse. Returns true only while that exit is playing.
 */
function useFocusExitAnimation(isFocus: boolean): boolean {
  // Only the timer writes this. Entering focus re-arms it *during render* —
  // React's sanctioned "adjust state when a prop changes" pattern, and what
  // `react-hooks/set-state-in-effect` steers you to: arming is derivable from
  // the new prop, so it must not cost a second render pass through an effect.
  const [exitDone, setExitDone] = useState(true)
  if (isFocus && exitDone) setExitDone(false)

  useEffect(() => {
    if (isFocus || exitDone) return
    const scale =
      Number(
        getComputedStyle(document.documentElement).getPropertyValue("--motion-duration-scale")
      ) || 1
    const timer = window.setTimeout(
      () => setExitDone(true),
      FOCUS_TAKEOVER_DURATION_MS * scale + FOCUS_TAKEOVER_SLACK_MS
    )
    return () => window.clearTimeout(timer)
  }, [exitDone, isFocus])

  return !isFocus && !exitDone
}

export function useContextWorkbench(): ContextWorkbenchValue {
  const value = useContext(ContextWorkbenchContext)
  if (!value) throw new Error("useContextWorkbench must be used inside ContextWorkbench")
  return value
}

interface PanelErrorBoundaryProps {
  children: ReactNode
  fallback: (retry: () => void) => ReactNode
}

class PanelErrorBoundary extends Component<PanelErrorBoundaryProps, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Context Workbench panel crashed", error, info)
  }

  private retry = () => this.setState({ failed: false })

  render() {
    return this.state.failed ? this.props.fallback(this.retry) : this.props.children
  }
}

export interface ContextWorkbenchProps {
  workbenchInstanceId: string
  resource: ContextResource
  panels?: ContextPanelDefinition[]
  placement?: ContextWorkbenchPlacement
  className?: string
  manageOwnWidth?: boolean
  onExitFocus?: () => void
  onCollapse?: () => void
  /**
   * Bring this host's container back on screen. The inverse of `onCollapse`,
   * called when something outside the workbench (today: a plugin `reveal()`)
   * asks for a panel while the surface is collapsed or closed. Hosts that are
   * always visible omit it.
   */
  onEnsureVisible?: () => void
  /**
   * A panel wants the host's shell at a given width. Hosts that own the
   * workbench width themselves (`manageOwnWidth={false}` — e.g. the chat dock,
   * whose width belongs to the outer resizable panel) use this to resize their
   * own shell. Without it the narrow/wide buttons render but do nothing.
   *
   * `panelId` distinguishes the two callers, and hosts are expected to treat
   * them differently:
   * - **present** — a panel activation. The mode is the panel's `preferredMode`,
   *   which is a preference, not an instruction; the chat dock applies it as a
   *   high-water mark so it never undoes a width the user dragged to.
   * - **absent** — the header's own narrow/wide buttons. That is an explicit
   *   user request and applies unconditionally.
   *
   * It also tells the host *which* panel is coming, which matters when the
   * host's width presets depend on the panel: the dock's sizing profile is
   * derived from the active panel in an effect, so a host reading its own
   * profile during activation would be a frame behind.
   */
  onModeWidthHint?: (mode: ContextPanelMode, panelId?: string) => void
  /**
   * Host content for the left of the panel header (the dock puts its open
   * artifact tabs here). When present the group tabs collapse into an overflow
   * menu rather than competing for the same row — in a ~34% wide dock there is
   * only room for one of them, and a second header band would cost the panels
   * content height they need more.
   */
  headerLeading?: ReactNode
  /**
   * Which width preset the host is *actually* sitting at, for hosts that own
   * their own width (`manageOwnWidth={false}`). Drives the narrow/wide button
   * highlight only — never navigation.
   *
   * Without it the highlight reads `layout.mode`, which a panel activation
   * writes from its `preferredMode`. The chat dock applies that mode as a
   * high-water mark (it may widen, never narrow), so moving from the workspace
   * back to the preview wrote `narrow`, lit the narrow button, and left the dock
   * at 65% — the highlight claimed a width the user was not looking at. Hosts
   * that size the workbench themselves omit this and keep reading `layout.mode`,
   * which for them *is* the width.
   */
  resolvedMode?: ContextPanelMode
  /**
   * The scope key standing in for "this conversation", for panels declared
   * `scope: "session"`. Supplying it keeps those panels mounted while the host
   * moves between resources — the chat dock passes its session surface's own
   * scope key, so the artifact and session surfaces share one browser and one
   * workspace instead of tearing them down on every tab switch. Hosts that omit
   * it treat every panel as resource-scoped, exactly as before.
   */
  sessionScopeKey?: string
  /**
   * Restore the host's own shell layout (width, collapsed state, sizing
   * profile) to its defaults. Surfaced in the header's layout menu.
   *
   * Every host that owns a resizable shell already had a `resetLayout` action
   * on its layout store and no way to reach it — a dock dragged to an unusable
   * width, or one whose persisted size predated a bounds change, had no escape
   * hatch short of clearing localStorage. Omitted by hosts with nothing to
   * reset, which hides the entry.
   */
  onResetLayout?: () => void
}

export interface ContextWorkbenchMobileSheetProps extends Omit<
  ContextWorkbenchProps,
  "placement" | "className" | "manageOwnWidth"
> {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function ContextWorkbenchMobileSheet({
  open,
  onOpenChange,
  ...workbenchProps
}: ContextWorkbenchMobileSheetProps) {
  const t = useTranslations("contextWorkbench")
  return (
    <Sheet open={open} onOpenChange={onOpenChange} modal={open}>
      {/* A bottom drawer, not a right-edge takeover: it keeps the grab-handle
          affordance and the swipe-to-dismiss gesture users already had on the
          Workspace sheet this replaced. Decelerate-in / quicker-out, scaled by
          the user's motion-speed preference. */}
      <SheetContent
        forceMount
        side="bottom"
        showCloseButton={false}
        className="h-[92dvh] max-h-[92dvh] gap-0 overflow-hidden rounded-t-2xl p-0 pb-[env(safe-area-inset-bottom)] data-[state=open]:[animation-duration:calc(300ms*var(--motion-duration-scale,1))] data-[state=closed]:[animation-duration:calc(200ms*var(--motion-duration-scale,1))]"
        inert={!open}
        aria-hidden={!open}
        data-testid="context-workbench-mobile-sheet"
      >
        <SheetHeader className="sr-only">
          <SheetTitle>{t("mobileTitle")}</SheetTitle>
          <SheetDescription>{t("mobileDescription")}</SheetDescription>
        </SheetHeader>
        <div
          aria-hidden
          className="mx-auto mt-2 mb-1 h-1 w-10 shrink-0 rounded-full bg-muted-foreground/30"
        />
        <Activity mode={open ? "visible" : "hidden"}>
          <ContextWorkbench
            {...workbenchProps}
            placement="mobile-sheet"
            manageOwnWidth={false}
            className="w-full flex-1"
          />
        </Activity>
      </SheetContent>
    </Sheet>
  )
}

function mergePanels(
  nativePanels: ContextPanelDefinition[],
  registeredPanels: ContextPanelDefinition[]
): ContextPanelDefinition[] {
  const panels = new Map(registeredPanels.map((panel) => [panel.id, panel]))
  nativePanels.forEach((panel) => panels.set(panel.id, panel))
  return [...panels.values()].sort((left, right) => {
    const order = (left.order ?? 100) - (right.order ?? 100)
    return order === 0 ? left.id.localeCompare(right.id) : order
  })
}

export function ContextWorkbench({
  workbenchInstanceId,
  resource,
  panels = [],
  placement = "adjacent-editor",
  className,
  manageOwnWidth = true,
  onExitFocus,
  onCollapse,
  onEnsureVisible,
  onModeWidthHint,
  headerLeading,
  resolvedMode,
  sessionScopeKey,
  onResetLayout,
}: ContextWorkbenchProps) {
  const sectionRef = useRef<HTMLElement | null>(null)
  const previousFocusRef = useRef<HTMLElement | null>(null)
  const lifecyclePanelsRef = useRef(new Map<string, Set<string>>())
  const lastActivePanelRef = useRef(new Map<string, string | null>())
  const t = useTranslations()
  useSyncExternalStore(
    contextPanelRegistry.subscribe,
    contextPanelRegistry.getRevision,
    contextPanelRegistry.getRevision
  )
  const scopeKey = `${workbenchInstanceId}::${getContextResourceKey(resource)}`
  const persistedLayout = useContextWorkbenchStore((state) => state.layouts[scopeKey])
  const layout = persistedLayout ?? FALLBACK_CONTEXT_WORKBENCH_LAYOUT
  const navigatePanel = useContextWorkbenchStore((state) => state.navigatePanel)
  const reconcilePanels = useContextWorkbenchStore((state) => state.reconcilePanels)
  const markPanelActivated = useContextWorkbenchStore((state) => state.markPanelActivated)
  // Which session-scoped panels have ever been opened in this conversation.
  // Held separately from `layout` so moving between resources cannot retract it.
  const sessionActivatedPanelIds = useContextWorkbenchStore((state) =>
    sessionScopeKey && sessionScopeKey !== scopeKey
      ? state.layouts[sessionScopeKey]?.activatedPanelIds
      : undefined
  )
  const setMode = useContextWorkbenchStore((state) => state.setMode)
  const setWidth = useContextWorkbenchStore((state) => state.setWidth)
  const setUserPinned = useContextWorkbenchStore((state) => state.setUserPinned)

  // Held in a ref so the host registration only churns on resource/scope
  // changes: a host passing an inline arrow would otherwise re-register on
  // every render, and one that memoised it would leave a stale closure behind.
  const ensureVisibleRef = useRef(onEnsureVisible)
  useEffect(() => {
    ensureVisibleRef.current = onEnsureVisible
  }, [onEnsureVisible])
  useEffect(
    () =>
      setActiveContextForHost(scopeKey, resource, {
        ensureVisible: () => ensureVisibleRef.current?.(),
      }),
    [resource, scopeKey]
  )

  useEffect(() => {
    let cancelled = false
    void import("@/lib/plugin/core/manager")
      .then(async ({ getPluginManager }) => {
        if (cancelled) return
        const manager = getPluginManager()
        await Promise.all([
          manager.handleActivationEvent("onView:context-workbench"),
          manager.handleActivationEvent(`onView:context-workbench:${resource.kind}`),
        ])
      })
      .catch(() => {
        // The plugin manager is optional in web/test profiles.
      })
    return () => {
      cancelled = true
    }
  }, [resource.kind])

  const getPanelLabel = useCallback(
    (panel: ContextPanelDefinition) => {
      if (!panel.pluginId) return t(panel.labelKey as never)
      const key = `plugin.${panel.pluginId}.${panel.labelKey}`
      const hasTranslation = (t as typeof t & { has?: (candidate: string) => boolean }).has
      return typeof hasTranslation === "function" && hasTranslation(key)
        ? t(key as never)
        : (panel.label ?? panel.labelKey)
    },
    [t]
  )

  useEffect(() => {
    if (layout.mode !== "focus") return
    const section = sectionRef.current
    if (!section) return
    previousFocusRef.current = document.activeElement as HTMLElement | null
    const restored: Array<{
      element: HTMLElement
      inert: boolean
      inertAttribute: boolean
      ariaHidden: string | null
    }> = []
    let branch: HTMLElement = section
    let parent = branch.parentElement
    while (parent) {
      for (const sibling of parent.children) {
        if (sibling === branch || !(sibling instanceof HTMLElement)) continue
        restored.push({
          element: sibling,
          inert: sibling.inert,
          inertAttribute: sibling.hasAttribute("inert"),
          ariaHidden: sibling.getAttribute("aria-hidden"),
        })
        sibling.inert = true
        sibling.setAttribute("inert", "")
        sibling.setAttribute("aria-hidden", "true")
      }
      branch = parent
      parent = parent.parentElement
    }
    section.focus()
    return () => {
      for (const item of restored) {
        item.element.inert = item.inert
        if (!item.inertAttribute) item.element.removeAttribute("inert")
        if (item.ariaHidden === null) item.element.removeAttribute("aria-hidden")
        else item.element.setAttribute("aria-hidden", item.ariaHidden)
      }
      onExitFocus?.()
      requestAnimationFrame(() => window.dispatchEvent(new Event("resize")))
      previousFocusRef.current?.focus()
    }
  }, [layout.mode, onExitFocus])

  useEffect(() => {
    if (layout.mode !== "focus") return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      event.preventDefault()
      setMode(scopeKey, "narrow")
    }
    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [layout.mode, scopeKey, setMode])

  const registeredPanels = contextPanelRegistry.resolve(resource)
  const resolvedPanels = useMemo(
    () =>
      mergePanels(
        panels.filter(
          (panel) =>
            panel.appliesTo(resource) &&
            (panel.requiredCapabilities?.every((capability) =>
              resource.capabilities.includes(capability)
            ) ??
              true) &&
            (panel.hasRequiredPermissions?.() ?? true)
        ),
        registeredPanels
      ),
    [panels, registeredPanels, resource]
  )
  const activityGroups = useMemo(() => {
    const groups = new Map<string, ContextPanelDefinition[]>()
    for (const panel of resolvedPanels) {
      const group = groups.get(panel.activity) ?? []
      group.push(panel)
      groups.set(panel.activity, group)
    }
    // The rail follows its own declared order (`panel.order` governs the group
    // alone). Deriving rail position from each group's lowest-ordered panel made
    // one number mean two things, so ordering panels within a group silently
    // reshuffled the rail — which is how the primary surface ended up third,
    // behind a chat panel that merely happened to sort first.
    return [...groups.entries()].sort(
      ([left], [right]) => contextActivityRailIndex(left) - contextActivityRailIndex(right)
    )
  }, [resolvedPanels])
  const activePanel = resolvedPanels.find((panel) => panel.id === layout.activePanelId)
  const activeGroup = activePanel
    ? (activityGroups.find(([activity]) => activity === activePanel.activity)?.[1] ?? [])
    : []
  const resourceSession = useResourceWorkbenchSession(
    resource,
    Boolean(activePanel?.requiresChatScope),
    workbenchInstanceId
  )
  const resolvedPanelKey = resolvedPanels.map((panel) => panel.id).join("\u0000")
  useEffect(() => {
    const panelIds = resolvedPanelKey ? resolvedPanelKey.split("\u0000") : []
    reconcilePanels(scopeKey, panelIds, panelIds[0])
  }, [reconcilePanels, resolvedPanelKey, scopeKey])

  const invokePanelLifecycle = useCallback(
    (panel: ContextPanelDefinition, phase: "first" | "restore") => {
      try {
        const result =
          phase === "first" ? panel.onFirstActivate?.(resource) : panel.onRestore?.(resource)
        if (result && typeof (result as Promise<void>).catch === "function") {
          void (result as Promise<void>).catch((error) => {
            console.error(`Context Workbench panel ${phase} callback failed`, error)
          })
        }
      } catch (error) {
        console.error(`Context Workbench panel ${phase} callback failed`, error)
      }
    },
    [resource]
  )

  useEffect(() => {
    const activeId = activePanel?.id ?? null
    if (lastActivePanelRef.current.get(scopeKey) === activeId) return
    lastActivePanelRef.current.set(scopeKey, activeId)
    if (!activePanel) return

    let seen = lifecyclePanelsRef.current.get(scopeKey)
    if (!seen) {
      seen = new Set(persistedLayout?.activatedPanelIds ?? [])
      lifecyclePanelsRef.current.set(scopeKey, seen)
    }
    const phase = seen.has(activePanel.id) ? "restore" : "first"
    seen.add(activePanel.id)
    invokePanelLifecycle(activePanel, phase)
    if (!persistedLayout?.activatedPanelIds.includes(activePanel.id)) {
      navigatePanel(scopeKey, activePanel.id, layout.mode === "collapsed" ? "narrow" : layout.mode)
    }
    // Catches the routes that never touch `handleActivate` — a one-shot reveal
    // published from outside the workbench, and a layout restored from disk.
    if (activePanel.scope === "session" && sessionScopeKey) {
      markPanelActivated(sessionScopeKey, activePanel.id)
    }
  }, [
    activePanel,
    invokePanelLifecycle,
    layout.mode,
    markPanelActivated,
    navigatePanel,
    persistedLayout?.activatedPanelIds,
    scopeKey,
    sessionScopeKey,
  ])

  const handleCollapse = () => {
    // Focus is a full-screen takeover that outlives the host's own collapse
    // (the dock shrinks to 0% underneath while the fixed overlay stays on
    // screen, and the mode persists — so re-opening the dock came back
    // full-screen). Drop out of it first; hosts without their own collapse
    // fall through to the collapsed mode as before.
    if (onCollapse) {
      if (layout.mode === "focus") setMode(scopeKey, "narrow")
      onCollapse()
      return
    }
    setMode(scopeKey, "collapsed")
  }

  const handleActivate = (panel: ContextPanelDefinition, source: "rail" | "tab" = "tab") => {
    touchActiveContextHost(scopeKey)
    if (layout.activePanelId === panel.id && layout.mode !== "collapsed") {
      // Activity-bar convention (VS Code): clicking the ALREADY-ACTIVE
      // activity toggles the surface closed. Only for the rail — re-clicking
      // the current header/group tab must stay inert.
      if (source === "rail") handleCollapse()
      return
    }
    let seen = lifecyclePanelsRef.current.get(scopeKey)
    if (!seen) {
      seen = new Set(persistedLayout?.activatedPanelIds ?? [])
      lifecyclePanelsRef.current.set(scopeKey, seen)
    }
    const phase = seen.has(panel.id) ? "restore" : "first"
    seen.add(panel.id)
    lastActivePanelRef.current.set(scopeKey, panel.id)
    const mode = panel.preferredMode ?? "narrow"
    navigatePanel(scopeKey, panel.id, mode)
    // Session-scoped panels record their activation against the conversation as
    // well, which is what keeps them mounted after the host moves on. Only the
    // activation is shared — `activePanelId` stays per-resource, so switching
    // artifact tabs still restores each artifact's own panel.
    if (panel.scope === "session" && sessionScopeKey) markPanelActivated(sessionScopeKey, panel.id)
    // `navigatePanel` writes the mode, which lights up the matching header
    // button — but only the host can act on it, and only if we tell it. Without
    // this every `preferredMode: "wide"` panel reached from the rail, a group
    // tab or the overflow menu claimed to be wide while leaving the dock at
    // whatever width it already had.
    onModeWidthHint?.(mode, panel.id)
    invokePanelLifecycle(panel, phase)
  }

  const selectMode = (mode: ContextPanelMode) => {
    setMode(scopeKey, mode)
    onModeWidthHint?.(mode)
  }

  const handleResizeStart = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    const startX = event.clientX
    const startWidth = layout.width
    // Attribute the drag to whatever is in front, so the width comes back with
    // that panel. Read once at pointer-down: the active panel cannot change
    // mid-drag (the pointer is captured by the separator), and re-reading per
    // move event would only risk writing the tail of one panel's drag onto the
    // next panel's memory.
    const draggedPanelId = layout.activePanelId ?? undefined
    const handleMove = (moveEvent: PointerEvent) => {
      setWidth(scopeKey, startWidth + startX - moveEvent.clientX, draggedPanelId)
    }
    const handleUp = () => {
      window.removeEventListener("pointermove", handleMove)
      window.removeEventListener("pointerup", handleUp)
    }
    window.addEventListener("pointermove", handleMove)
    window.addEventListener("pointerup", handleUp)
  }

  // The mobile Sheet lays the rail out horizontally, so the arrow keys that
  // walk it have to follow the visual axis rather than the vertical default.
  const railIsHorizontal = placement === "mobile-sheet"
  const handleActivityKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    const [nextKey, previousKey] = railIsHorizontal
      ? ["ArrowRight", "ArrowLeft"]
      : ["ArrowDown", "ArrowUp"]
    if (![nextKey, previousKey, "Home", "End"].includes(event.key)) return
    const buttons = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>("[data-workbench-activity-button]")
    )
    if (buttons.length === 0) return
    const currentIndex = Math.max(0, buttons.indexOf(event.target as HTMLButtonElement))
    const nextIndex =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? buttons.length - 1
          : event.key === nextKey
            ? (currentIndex + 1) % buttons.length
            : (currentIndex - 1 + buttons.length) % buttons.length
    event.preventDefault()
    // A single-activity rail wraps onto itself; clicking would toggle-collapse
    // the dock out from under the arrow key.
    if (nextIndex === currentIndex) return
    buttons[nextIndex]?.focus()
    buttons[nextIndex]?.click()
  }

  const handleGroupTabKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowRight", "ArrowLeft", "Home", "End"].includes(event.key)) return
    const tabs = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>("[data-workbench-group-tab]")
    )
    if (tabs.length === 0) return
    const currentIndex = Math.max(0, tabs.indexOf(event.target as HTMLButtonElement))
    const nextIndex =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? tabs.length - 1
          : event.key === "ArrowRight"
            ? (currentIndex + 1) % tabs.length
            : (currentIndex - 1 + tabs.length) % tabs.length
    event.preventDefault()
    tabs[nextIndex]?.focus()
    tabs[nextIndex]?.click()
  }

  const value = useMemo(
    () => ({ workbenchInstanceId, resource, scopeKey, layout }),
    [layout, resource, scopeKey, workbenchInstanceId]
  )

  // Focus is a takeover rather than a width, so it always wins the highlight —
  // a host's `resolvedMode` only ever speaks for narrow vs wide.
  const widthMode: ContextWorkbenchMode =
    layout.mode === "focus" ? "focus" : (resolvedMode ?? layout.mode)
  const isFocus = layout.mode === "focus"
  const focusExiting = useFocusExitAnimation(isFocus)
  // The takeover owns the viewport for the entrance, the whole time it is held,
  // and now the exit too.
  const focusTakeover = isFocus || focusExiting

  return (
    <ContextWorkbenchContext.Provider value={value}>
      <section
        ref={sectionRef}
        tabIndex={layout.mode === "focus" ? -1 : undefined}
        role={layout.mode === "focus" ? "dialog" : undefined}
        aria-modal={layout.mode === "focus" ? true : undefined}
        className={cn(
          "relative flex h-full min-h-0 overflow-hidden border-l bg-card/40",
          // A phone can't spare 48px of its width for a vertical rail, so the
          // sheet stacks: rail across the top, panel body beneath it.
          placement === "mobile-sheet" && "w-full flex-col border-l-0",
          layout.mode === "collapsed" && "w-12",
          className,
          // Focus used to snap straight to a full-screen takeover. Zooming it in
          // (same easing contract as Dialog) keeps the jump legible; the global
          // reduce-motion guard collapses the duration to 1ms.
          focusTakeover &&
            "fixed inset-0 z-50 w-screen border-l-0 bg-background [animation-duration:calc(200ms*var(--motion-duration-scale,1))]",
          isFocus && "animate-in fade-in-0 zoom-in-95",
          // Mirrored exit. The layout is held for exactly this animation by
          // `useFocusExitAnimation`; without it the class simply vanished and a
          // full-screen surface reappeared inside the rail in one frame.
          // Non-interactive on the way out — it is no longer a modal surface.
          focusExiting && "pointer-events-none animate-out fade-out-0 zoom-out-95"
        )}
        style={
          !manageOwnWidth ||
          layout.mode === "collapsed" ||
          focusTakeover ||
          placement === "mobile-sheet"
            ? undefined
            : { width: layout.mode === "wide" ? "clamp(640px, 50%, 960px)" : layout.width }
        }
        data-mode={layout.mode}
        data-placement={placement}
        // ContextWorkbench is the shared right-side panel host. Opt it into
        // the same wallpaper scope as the app's navigation sidebars so image
        // backgrounds, low-opacity scrims, and surface tonality stay aligned.
        data-bg-target="sidebar"
        data-testid="context-workbench"
        onFocusCapture={() => touchActiveContextHost(scopeKey)}
        onPointerDownCapture={() => touchActiveContextHost(scopeKey)}
      >
        {manageOwnWidth &&
        placement !== "mobile-sheet" &&
        layout.mode !== "collapsed" &&
        layout.mode !== "focus" ? (
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label={t("contextWorkbench.actions.resize")}
            className="absolute inset-y-0 left-0 z-10 w-1 cursor-col-resize touch-none"
            onPointerDown={handleResizeStart}
            // Editor-splitter convention: double-click restores the default
            // width — and, because it is attributed to the active panel like a
            // drag is, it is also how a user forgets a per-panel width they
            // regret. Without the attribution the panel's remembered width
            // would survive the reset and snap straight back on the next reveal.
            onDoubleClick={() =>
              setWidth(scopeKey, CONTEXT_WORKBENCH_DEFAULT_WIDTH, layout.activePanelId ?? undefined)
            }
          />
        ) : null}
        <TooltipProvider delayDuration={300}>
          <nav
            className={cn(
              "flex shrink-0 items-center gap-1 bg-muted/30",
              railIsHorizontal
                ? "h-12 w-full overflow-x-auto border-b px-2"
                : "w-12 flex-col border-r py-2"
            )}
            aria-label={t("contextWorkbench.activityRailLabel")}
            data-testid="context-workbench-activity-rail"
            onKeyDown={handleActivityKeyDown}
          >
            {activityGroups.map(([activity, group]) => {
              const panel =
                group.find((candidate) => candidate.id === layout.activePanelId) ?? group[0]
              const Icon = panel.icon
              const badge =
                group.reduce(
                  (total, candidate) => total + (candidate.getBadge?.(resource) ?? 0),
                  0
                ) +
                group.filter((candidate) => layout.pendingPanelIds.includes(candidate.id)).length
              const label = getPanelLabel(panel)
              return (
                <Tooltip key={activity}>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      size="icon-sm"
                      variant={activePanel?.activity === activity ? "secondary" : "ghost"}
                      aria-label={label}
                      aria-pressed={activePanel?.activity === activity}
                      data-workbench-activity-button
                      onClick={() => handleActivate(panel, "rail")}
                      className="relative"
                    >
                      {Icon ? <Icon className="size-4" /> : <Rows3Icon className="size-4" />}
                      {badge > 0 ? (
                        <Badge className="absolute -right-1 -top-1 h-4 min-w-4 px-1 text-[9px]">
                          {badge > 99 ? "99+" : badge}
                        </Badge>
                      ) : null}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="left">{label}</TooltipContent>
                </Tooltip>
              )
            })}
            {/* Pinning suppresses automatic reveals, which is impossible to
                guess from a bare pin glyph — these two were the only rail
                buttons without a tooltip to explain them. */}
            <div className={cn("flex gap-1", railIsHorizontal ? "ml-auto" : "mt-auto flex-col")}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    size="icon-sm"
                    variant={layout.userPinned ? "secondary" : "ghost"}
                    aria-label={
                      layout.userPinned
                        ? t("contextWorkbench.actions.unpin")
                        : t("contextWorkbench.actions.pin")
                    }
                    aria-pressed={layout.userPinned}
                    onClick={() => setUserPinned(scopeKey, !layout.userPinned)}
                  >
                    <PinIcon className={cn("size-4", layout.userPinned && "fill-current")} />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side={railIsHorizontal ? "bottom" : "left"}>
                  {t("contextWorkbench.actions.pinHint")}
                </TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost"
                    aria-label={t("contextWorkbench.actions.collapse")}
                    onClick={handleCollapse}
                  >
                    <PanelRightCloseIcon className="size-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side={railIsHorizontal ? "bottom" : "left"}>
                  {t("contextWorkbench.actions.collapse")}
                </TooltipContent>
              </Tooltip>
            </div>
          </nav>
        </TooltipProvider>

        {layout.mode !== "collapsed" ? (
          <div className="flex min-w-0 flex-1 flex-col" inert={false}>
            <PluginExtensionSlot
              point="sidebar.right.top"
              className="shrink-0 border-b p-2"
              context={{ resource, activePanelId: activePanel?.id ?? null }}
            />
            {/* A container query, not a viewport breakpoint: this header's width
                is whatever the user dragged the dock to. At the 24% preset on a
                1280px screen it is ~259px after the activity rail, and it has to
                hold the artifact tabs, the group overflow, plugin actions and
                the layout controls — so the controls fold into a menu on the
                narrow end rather than squashing everything. */}
            <header className="@container/wb-header flex h-10 shrink-0 items-center gap-1 border-b px-2">
              {headerLeading}
              {activeGroup.length > 1 && headerLeading ? (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    {/* Once the artifact tabs claim the header this is the only
                        route to the rest of the group, so a bare ⋯ glyph hid
                        both which panel is showing and that there were others
                        at all. Name the current panel, and count the siblings
                        behind it. `w-auto` because the shared icon size is
                        square and this now carries text. */}
                    <Button
                      type="button"
                      size="icon-sm"
                      variant="ghost"
                      data-testid="context-workbench-group-overflow"
                      className="w-auto max-w-32 shrink-0 gap-1 px-1.5"
                    >
                      <MoreHorizontalIcon className="size-4 shrink-0" />
                      <span className="truncate text-xs">
                        {activePanel ? getPanelLabel(activePanel) : null}
                      </span>
                      <Badge
                        variant="secondary"
                        className="h-4 min-w-4 shrink-0 px-1 text-[9px] tabular-nums"
                      >
                        {activeGroup.length - 1}
                      </Badge>
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start">
                    {activeGroup.map((panel) => (
                      <DropdownMenuItem
                        key={panel.id}
                        data-workbench-group-tab
                        onClick={() => handleActivate(panel)}
                      >
                        {getPanelLabel(panel)}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : null}
              {activeGroup.length > 1 && !headerLeading ? (
                <div
                  role="tablist"
                  className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto"
                  onKeyDown={handleGroupTabKeyDown}
                >
                  {activeGroup.map((panel) => (
                    <Button
                      key={panel.id}
                      type="button"
                      size="sm"
                      variant={layout.activePanelId === panel.id ? "secondary" : "ghost"}
                      data-workbench-group-tab
                      role="tab"
                      aria-selected={layout.activePanelId === panel.id}
                      aria-controls={`context-workbench-panel-${panel.id}`}
                      className={cn(
                        "min-w-0 overflow-hidden",
                        layout.activePanelId === panel.id ? "shrink-0" : "shrink"
                      )}
                      onClick={() => handleActivate(panel)}
                    >
                      <span className="truncate">{getPanelLabel(panel)}</span>
                    </Button>
                  ))}
                </div>
              ) : null}
              {headerLeading ? null : activeGroup.length > 1 ? null : <div className="flex-1" />}
              <PluginExtensionSlot
                point="panel.header"
                className="flex shrink-0 items-center gap-1"
                context={{ resource, activePanelId: activePanel?.id ?? null }}
              />
              {placement !== "mobile-sheet" ? (
                <>
                  {/* Inline above ~20rem of header; below that the same actions
                      live in the menu beside this, so neither form is ever the
                      only route to them. */}
                  <div className="hidden shrink-0 items-center gap-1 @[20rem]/wb-header:flex">
                    <Button
                      type="button"
                      size="icon-sm"
                      variant={widthMode === "narrow" ? "secondary" : "ghost"}
                      aria-label={t("contextWorkbench.actions.narrow")}
                      onClick={() => selectMode("narrow")}
                    >
                      <PanelRightIcon className="size-4" />
                    </Button>
                    <Button
                      type="button"
                      size="icon-sm"
                      variant={widthMode === "wide" ? "secondary" : "ghost"}
                      aria-label={t("contextWorkbench.actions.wide")}
                      onClick={() => selectMode("wide")}
                    >
                      <Rows3Icon className="size-4" />
                    </Button>
                    <Button
                      type="button"
                      size="icon-sm"
                      variant={layout.mode === "focus" ? "secondary" : "ghost"}
                      aria-label={t("contextWorkbench.actions.focus")}
                      onClick={() => selectMode("focus")}
                    >
                      <FocusIcon className="size-4" />
                    </Button>
                  </div>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        type="button"
                        size="icon-sm"
                        variant="ghost"
                        aria-label={t("contextWorkbench.actions.layoutMenu")}
                        data-testid="context-workbench-layout-menu"
                        className={cn(
                          "shrink-0",
                          // Reset alone does not justify a permanent button, so
                          // above the fold this menu only appears when there is
                          // something in it beyond the three inline controls.
                          onResetLayout ? "" : "@[20rem]/wb-header:hidden"
                        )}
                      >
                        <SlidersHorizontalIcon className="size-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem
                        className="@[20rem]/wb-header:hidden"
                        onSelect={() => selectMode("narrow")}
                      >
                        <PanelRightIcon className="size-4" />
                        {t("contextWorkbench.actions.narrow")}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        className="@[20rem]/wb-header:hidden"
                        onSelect={() => selectMode("wide")}
                      >
                        <Rows3Icon className="size-4" />
                        {t("contextWorkbench.actions.wide")}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        className="@[20rem]/wb-header:hidden"
                        onSelect={() => selectMode("focus")}
                      >
                        <FocusIcon className="size-4" />
                        {t("contextWorkbench.actions.focus")}
                      </DropdownMenuItem>
                      {onResetLayout ? (
                        <DropdownMenuItem
                          data-testid="context-workbench-reset-layout"
                          onSelect={onResetLayout}
                        >
                          <RotateCcwIcon className="size-4" />
                          {t("contextWorkbench.actions.resetLayout")}
                        </DropdownMenuItem>
                      ) : null}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </>
              ) : null}
            </header>
            <div className="relative min-h-0 flex-1 overflow-hidden">
              {resolvedPanels.map((panel) => {
                // A session-scoped panel keeps its mount for as long as the
                // conversation lasts, so moving between artifact tabs no longer
                // tears down the embedded browser (releasing a process-wide
                // webview lease) or the workspace's Monaco buffers.
                const activatedIn =
                  panel.scope === "session" && sessionActivatedPanelIds
                    ? sessionActivatedPanelIds
                    : layout.activatedPanelIds
                const active = layout.activePanelId === panel.id
                // The panel on screen always mounts, even before its activation
                // is recorded: a fresh scope gets its default panel from
                // `reconcilePanels`, which deliberately leaves `activatedPanelIds`
                // alone so the first activation still counts as a *first*. Hosts
                // used to paper over this with a second "open on the default
                // panel" effect that raced the reconcile.
                if (!active && !activatedIn.includes(panel.id)) return null
                const Renderer = panel.renderer
                const waitingForChatScope = panel.requiresChatScope && !resourceSession
                const content = (
                  <div
                    id={`context-workbench-panel-${panel.id}`}
                    role="tabpanel"
                    // Scope root for a plugin panel's `manifest.styles` sheet,
                    // which is injected as `@scope ([data-plugin-root="<id>"])`.
                    // Absent for host-owned panels so their markup stays
                    // outside any plugin's bound. Panels read their width from
                    // `getWorkbenchState()` rather than a container query — a
                    // `container-type` here would also apply `contain: layout`
                    // and re-anchor absolutely-positioned panel content.
                    data-plugin-root={panel.pluginId}
                    className={cn(
                      "h-full",
                      !active && "pointer-events-none",
                      // Panels stay mounted behind `<Activity>`, so switching one
                      // in is a display flip with no transition to hook. A CSS
                      // *animation* restarts on re-display, which gives the
                      // incoming panel a soft entrance; the outgoing one cannot
                      // be animated at all, because a cross-fade needs both
                      // painted at once and Activity deliberately prevents that.
                      //
                      // A fade with no translate, deliberately: the outgoing
                      // panel disappears in a single frame, so sliding the
                      // incoming one up from 4px below read as an empty gap
                      // followed by a jump. Dissolving in place is the only
                      // shape that stays honest about a swap we cannot tween.
                      // The reduce-motion guard in globals.css collapses this
                      // to 1ms.
                      active &&
                        "animate-in fade-in-0 [animation-duration:calc(120ms*var(--motion-duration-scale,1))]"
                    )}
                    inert={!active}
                    aria-hidden={!active}
                  >
                    <PanelErrorBoundary
                      fallback={(retry) => (
                        <div className="flex h-full flex-col items-center justify-center gap-1 p-6 text-center">
                          <p className="text-sm font-medium">{t("contextWorkbench.panelError")}</p>
                          <p className="text-xs text-muted-foreground">
                            {t("contextWorkbench.panelErrorDescription")}
                          </p>
                          <Button type="button" size="sm" variant="outline" onClick={retry}>
                            <RotateCcwIcon className="size-4" />
                            {t("contextWorkbench.actions.retry")}
                          </Button>
                        </div>
                      )}
                    >
                      {waitingForChatScope ? (
                        <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">
                          {t("contextWorkbench.aiLoading")}
                        </div>
                      ) : resourceSession ? (
                        <ChatScopeProvider sessionId={resourceSession.id}>
                          <Renderer
                            workbenchInstanceId={workbenchInstanceId}
                            resource={resource}
                            active={active}
                          />
                        </ChatScopeProvider>
                      ) : (
                        <Renderer
                          workbenchInstanceId={workbenchInstanceId}
                          resource={resource}
                          active={active}
                        />
                      )}
                    </PanelErrorBoundary>
                  </div>
                )
                return panel.retention === "ephemeral" ? (
                  active ? (
                    <div key={panel.id} className="absolute inset-0">
                      {content}
                    </div>
                  ) : null
                ) : (
                  <Activity key={panel.id} mode={active ? "visible" : "hidden"}>
                    <div className="absolute inset-0">{content}</div>
                  </Activity>
                )
              })}
            </div>
            <PluginExtensionSlot
              point="panel.footer"
              className="shrink-0 border-t p-2"
              context={{ resource, activePanelId: activePanel?.id ?? null }}
            />
            <PluginExtensionSlot
              point="sidebar.right.bottom"
              className="shrink-0 border-t p-2"
              context={{ resource, activePanelId: activePanel?.id ?? null }}
            />
          </div>
        ) : null}
      </section>
    </ContextWorkbenchContext.Provider>
  )
}
