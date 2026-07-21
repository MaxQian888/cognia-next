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
  PinIcon,
  RotateCcwIcon,
  Rows3Icon,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
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
  useContextWorkbenchStore,
  type ContextWorkbenchLayout,
} from "@/stores/context-workbench/context-workbench-store"
import {
  getContextResourceKey,
  type ContextPanelDefinition,
  type ContextPanelMode,
  type ContextResource,
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
  activePanelId: null,
  userPinned: false,
  activatedPanelIds: [],
  pendingPanelIds: [],
  lastUsedAt: 0,
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
  grantedPermissions?: ReadonlySet<string>
  placement?: ContextWorkbenchPlacement
  className?: string
  manageOwnWidth?: boolean
  onExitFocus?: () => void
  onCollapse?: () => void
  /**
   * Called when the user picks a mode from the header. Hosts that own the
   * workbench width themselves (`manageOwnWidth={false}` — e.g. the chat dock,
   * whose width belongs to the outer resizable panel) use this to resize their
   * own shell. Without it the narrow/wide buttons render but do nothing.
   */
  onModeWidthHint?: (mode: ContextPanelMode) => void
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
  grantedPermissions = new Set(),
  placement = "adjacent-editor",
  className,
  manageOwnWidth = true,
  onExitFocus,
  onCollapse,
  onModeWidthHint,
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
  const setMode = useContextWorkbenchStore((state) => state.setMode)
  const setWidth = useContextWorkbenchStore((state) => state.setWidth)
  const setUserPinned = useContextWorkbenchStore((state) => state.setUserPinned)

  useEffect(() => setActiveContextForHost(scopeKey, resource), [resource, scopeKey])

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

  const registeredPanels = contextPanelRegistry.resolve(resource, grantedPermissions)
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
            (panel.requiredPermissions?.every((permission) => grantedPermissions.has(permission)) ??
              true)
        ),
        registeredPanels
      ),
    [grantedPermissions, panels, registeredPanels, resource]
  )
  const activityGroups = useMemo(() => {
    const groups = new Map<string, ContextPanelDefinition[]>()
    for (const panel of resolvedPanels) {
      const group = groups.get(panel.activity) ?? []
      group.push(panel)
      groups.set(panel.activity, group)
    }
    return [...groups.entries()]
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
  }, [
    activePanel,
    invokePanelLifecycle,
    layout.mode,
    navigatePanel,
    persistedLayout?.activatedPanelIds,
    scopeKey,
  ])

  const handleActivate = (panel: ContextPanelDefinition) => {
    touchActiveContextHost(scopeKey)
    if (layout.activePanelId === panel.id && layout.mode !== "collapsed") return
    let seen = lifecyclePanelsRef.current.get(scopeKey)
    if (!seen) {
      seen = new Set(persistedLayout?.activatedPanelIds ?? [])
      lifecyclePanelsRef.current.set(scopeKey, seen)
    }
    const phase = seen.has(panel.id) ? "restore" : "first"
    seen.add(panel.id)
    lastActivePanelRef.current.set(scopeKey, panel.id)
    navigatePanel(scopeKey, panel.id, panel.preferredMode ?? "narrow")
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
    const handleMove = (moveEvent: PointerEvent) => {
      setWidth(scopeKey, startWidth + startX - moveEvent.clientX)
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
          layout.mode === "focus" &&
            "fixed inset-0 z-50 w-screen border-l-0 bg-background animate-in fade-in-0 zoom-in-95 [animation-duration:calc(200ms*var(--motion-duration-scale,1))]"
        )}
        style={
          !manageOwnWidth ||
          layout.mode === "collapsed" ||
          layout.mode === "focus" ||
          placement === "mobile-sheet"
            ? undefined
            : { width: layout.mode === "wide" ? "clamp(640px, 50%, 960px)" : layout.width }
        }
        data-mode={layout.mode}
        data-placement={placement}
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
                      onClick={() => handleActivate(panel)}
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
                    onClick={() => (onCollapse ? onCollapse() : setMode(scopeKey, "collapsed"))}
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
            <header className="flex h-10 shrink-0 items-center gap-1 border-b px-2">
              {activeGroup.length > 1 ? (
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
              ) : (
                <div className="flex-1" />
              )}
              <PluginExtensionSlot
                point="panel.header"
                className="flex shrink-0 items-center gap-1"
                context={{ resource, activePanelId: activePanel?.id ?? null }}
              />
              {placement !== "mobile-sheet" ? (
                <>
                  <Button
                    type="button"
                    size="icon-sm"
                    variant={layout.mode === "narrow" ? "secondary" : "ghost"}
                    aria-label={t("contextWorkbench.actions.narrow")}
                    onClick={() => selectMode("narrow")}
                  >
                    <PanelRightIcon className="size-4" />
                  </Button>
                  <Button
                    type="button"
                    size="icon-sm"
                    variant={layout.mode === "wide" ? "secondary" : "ghost"}
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
                </>
              ) : null}
            </header>
            <div className="relative min-h-0 flex-1 overflow-hidden">
              {resolvedPanels.map((panel) => {
                if (!layout.activatedPanelIds.includes(panel.id)) return null
                const active = layout.activePanelId === panel.id
                const Renderer = panel.renderer
                const waitingForChatScope = panel.requiresChatScope && !resourceSession
                const content = (
                  <div
                    id={`context-workbench-panel-${panel.id}`}
                    role="tabpanel"
                    className={cn(
                      "h-full",
                      !active && "pointer-events-none",
                      // Panels stay mounted behind `<Activity>`, so switching one
                      // in is a display flip with no transition to hook. A CSS
                      // *animation* restarts on re-display, which gives the
                      // incoming panel a soft entrance; the outgoing one is left
                      // alone because a cross-fade would need both painted at
                      // once, which Activity deliberately prevents. The global
                      // reduce-motion guard in globals.css collapses this to 1ms.
                      active &&
                        "animate-in fade-in-0 slide-in-from-bottom-1 [animation-duration:calc(150ms*var(--motion-duration-scale,1))]"
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
