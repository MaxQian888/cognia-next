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
  type CSSProperties,
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
  PanelRightOpenIcon,
  MoreHorizontalIcon,
  PinIcon,
  RotateCcwIcon,
  Rows3Icon,
  SlidersHorizontalIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  Rows2Icon,
  XIcon,
} from "lucide-react"
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core"
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
  horizontalListSortingStrategy,
} from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHandle,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer"
import { useBackDismiss } from "@/hooks/ui/use-back-dismiss"
import { useKeyboardInsets } from "@/hooks/ui/use-keyboard-insets"
import { cn } from "@/lib/utils"
import { MotionSelectionIndicator } from "@/components/chat/motion/motion-reveal"
import { ChatScopeProvider } from "@/components/chat/chat-scope-provider"
import { useResourceWorkbenchSession } from "@/hooks/chat/use-resource-workbench-session"
import { contextPanelRegistry } from "@/lib/context-workbench/panel-registry"
import {
  notifyActiveContextHostVisibility,
  publishActiveContextPanels,
  setActiveContextForHost,
  touchActiveContextHost,
} from "@/lib/context-workbench/active-context"
import { pushPanelHistory, usePanelHistory } from "@/hooks/context-workbench/use-panel-history"
import { createPortal } from "react-dom"
import { PluginExtensionSlot } from "@/components/plugins/plugin-extension-slot"
import { PluginSurface } from "@/components/plugins/plugin-surface"
import {
  CONTEXT_WORKBENCH_DEFAULT_WIDTH,
  CONTEXT_WORKBENCH_MIN_WIDTH,
  CONTEXT_WORKBENCH_SPLIT_DEFAULT_RATIO,
  CONTEXT_WORKBENCH_SPLIT_MAX_RATIO,
  CONTEXT_WORKBENCH_SPLIT_MIN_RATIO,
  CONTEXT_WORKBENCH_SPLIT_MIN_WIDTH,
  isSplitEligibleMode,
  useContextWorkbenchStore,
  type ContextWorkbenchLayout,
} from "@/stores/context-workbench/context-workbench-store"
import { useElementWidth } from "@/hooks/use-element-width"
import { useSettingsStore } from "@/stores/settings/settings-store"
import { workbenchRailLayoutOf } from "@/components/shell/use-workbench-rail-layout"
import { isWorkbenchActivityHidden, workbenchRailIndex } from "@/lib/shell/workbench-rail"
import {
  isWorkbenchPanelHidden,
  workbenchPanelIndex,
  workbenchPanelLayoutOf,
} from "@/lib/shell/workbench-panels"
import { applyDragReorder } from "@/lib/shell/sidebar-nav"
import {
  CONTEXT_WORKBENCH_DRAWER_DEFAULT_SNAP,
  CONTEXT_WORKBENCH_DRAWER_SNAP_POINTS,
  getContextResourceKey,
  type ContextActivity,
  type ContextPanelDefinition,
  type ContextPanelMode,
  type ContextResource,
  type ContextWorkbenchMode,
  type ContextWorkbenchPlacement,
} from "@/types/context-workbench"
import { WORKBENCH_RAIL_WIDTH_PX } from "@/types/shell/workbench-rail"
import { PANEL_SNAP_MAGNET_PX, snapPanelSize } from "@/lib/ui/panel-snap"
import { ShellLayoutDialog } from "@/components/shell/shell-layout-dialog"

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
  splitPanelId: null,
  splitRatio: 50,
}

/**
 * Height of the bar between the two panes, as a CSS length.
 *
 * Shared by the bar's own class and by the secondary lane's `top` offset, so the
 * two cannot drift apart and overlap. `1.75rem` is Tailwind's `h-7`.
 */
const SPLIT_BAR_HEIGHT = "1.75rem"

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
   * The host's container is shrunk to the activity rail: draw the rail, drop the
   * panel body. The persistent-minibar state.
   *
   * Host-driven rather than read from `layout.mode`, because "is the right rail
   * open" is one global fact per host while `layout` is keyed per *resource* —
   * routing it through the store would make the dock re-open and re-close as the
   * user moved between artifact tabs. Hosts that have no container of their own
   * to shrink (the project editor) omit this and keep using the per-scope
   * `mode: "collapsed"`, which this merges with rather than replaces.
   *
   * The body is unmounted, not hidden: the embedded browser holds a
   * process-wide webview lease released only on unmount, so a rail that kept its
   * panels alive would lock every other surface out of the webview.
   */
  railOnly?: boolean
  /**
   * Where to render the header row instead of drawing it above the panel body.
   * The chat dock passes the title bar's end outlet
   * (`components/shell/title-bar-outlets.tsx`) so the dock sits under the
   * shell's single 40px bar; every other host (Canvas, the workflow editor,
   * the project editor, the mobile drawer) leaves this unset and keeps the
   * header where it is. The projected row keeps its `@container/wb-header`
   * name, so the narrow-header folds still key off the width it actually gets.
   */
  headerOutlet?: HTMLElement | null
  /**
   * Activity whose rail button should carry an unread dot. Hosts pass the
   * activity owning whatever they would have revealed — the chat dock's fresh
   * artifact lands on `preview-run`. Taken as a prop so the shared workbench
   * never has to import a host's store to learn it has something to announce.
   */
  attentionActivity?: ContextActivity
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

export interface ContextWorkbenchMobileDrawerProps extends Omit<
  ContextWorkbenchProps,
  // `railOnly`: a drawer has no container to shrink, and a rail-only drawer
  // would be a full-height modal showing nothing but six icons.
  //
  // `onCollapse`: the drawer supplies its own (close), and a host that omitted
  // it fell through to `setMode("collapsed")` — which hides the body *inside*
  // the open drawer and persists, so it reopened showing nothing but its icon
  // strip. `project-context-workbench.tsx` was in exactly that state. Taking it
  // away from callers is what makes that unreachable rather than merely fixed.
  //
  // Both are compile errors rather than runtime surprises.
  "placement" | "className" | "manageOwnWidth" | "railOnly" | "onCollapse"
> {
  open: boolean
  onOpenChange: (open: boolean) => void
  /**
   * Which snap point the drawer sits at. Hoisted to the host because closing
   * unmounts the drawer, so local state could not survive a close/reopen.
   * Omit for uncontrolled — it then opens at the tallest snap every time.
   */
  snapPoint?: number | string | null
  onSnapPointChange?: (snapPoint: number | string | null) => void
}

export function ContextWorkbenchMobileDrawer({
  open,
  onOpenChange,
  snapPoint,
  onSnapPointChange,
  ...workbenchProps
}: ContextWorkbenchMobileDrawerProps) {
  const t = useTranslations("contextWorkbench")
  // Android hardware back / browser back closes the drawer instead of letting
  // the navigation rip the route out from under it — the same contract the
  // other twenty-odd mobile sheets in this app already honour.
  useBackDismiss(open, () => onOpenChange(false))
  /**
   * Under Capacitor's shipped `Keyboard.resize: "native"` the OS resizes the
   * whole WebView frame, so `dvh` has already shrunk and this reads 0 — exactly
   * as `use-keyboard-insets` documents. It is the mobile-web / PWA path that
   * needs the lift: the drawer is portalled *outside* the mobile shell's
   * layout, so `mobile-shell-wrapper`'s own bottom reserve never reaches it and
   * the composer inside the AI and comments panels sat under the keyboard.
   */
  const { keyboardHeight } = useKeyboardInsets()

  const [uncontrolledSnap, setUncontrolledSnap] = useState<number | string | null>(
    CONTEXT_WORKBENCH_DRAWER_DEFAULT_SNAP
  )
  const activeSnapPoint = snapPoint === undefined ? uncontrolledSnap : snapPoint
  const setActiveSnapPoint = onSnapPointChange ?? setUncontrolledSnap

  return (
    <Drawer
      open={open}
      onOpenChange={onOpenChange}
      snapPoints={[...CONTEXT_WORKBENCH_DRAWER_SNAP_POINTS]}
      // Only the tallest snap dims the conversation behind it. At the half-open
      // snap the whole point is to keep reading it.
      fadeFromIndex={CONTEXT_WORKBENCH_DRAWER_SNAP_POINTS.length - 1}
      activeSnapPoint={activeSnapPoint}
      setActiveSnapPoint={setActiveSnapPoint}
      // The body hosts Monaco, a scrollable file tree and an embedded browser
      // pane; a drag-anywhere surface would fight all three. The handle is the
      // only drag target, and vaul gives it a 2.75rem hit area for free.
      handleOnly
      // Capacitor already resizes the frame (see `keyboardHeight` above), and
      // letting vaul reposition on top of that moves an input twice. The
      // padding below covers the browsers that don't resize.
      repositionInputs={false}
      // Radix's Sheet moved focus into the surface on open; vaul defaults the
      // other way, which would leave focus on the trigger behind a modal.
      autoFocus
    >
      <DrawerContent
        // The caller draws its own real `DrawerHandle` below — the built-in bar
        // is decorative markup with no drag behaviour, which is precisely the
        // affordance this migration exists to stop faking.
        showHandle={false}
        // vaul hardcodes `transition: transform .5s` on `[data-vaul-drawer]`,
        // which ignores the app's motion-speed preference — the Sheet this
        // replaced carried the same override for the same reason. `!` because
        // vaul injects its rule from JS at module load, so equal-specificity
        // source order is not something to leave to chance; the reduce-motion
        // guards in `globals.css` are more specific still and continue to win.
        className="gap-0 overflow-hidden p-0 pb-[env(safe-area-inset-bottom)] [transition-duration:calc(300ms*var(--motion-duration-scale,1))]! data-[vaul-drawer-direction=bottom]:max-h-[92dvh] data-[vaul-drawer-direction=bottom]:rounded-t-2xl"
        style={{
          height: "92dvh",
          // Overrides the safe-area class above only while a keyboard is
          // actually overlapping; `0` falls through to the inset.
          paddingBottom: keyboardHeight || undefined,
        }}
        data-testid="context-workbench-mobile-sheet"
      >
        <DrawerHeader className="sr-only">
          <DrawerTitle>{t("mobileTitle")}</DrawerTitle>
          <DrawerDescription>{t("mobileDescription")}</DrawerDescription>
        </DrawerHeader>
        <DrawerHandle data-testid="context-workbench-drawer-handle" />
        <ContextWorkbench
          {...workbenchProps}
          placement="mobile-sheet"
          manageOwnWidth={false}
          className="w-full flex-1"
          onCollapse={() => onOpenChange(false)}
        />
      </DrawerContent>
    </Drawer>
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

// --- Sortable Activity Button (Phase 1.4) ---
// Extracted so each activity button can participate in @dnd-kit's sortable
// context. The `useSortable` hook requires a unique id per item and paints
// the transform/transition during drag. A grip indicator appears on hover to
// hint that reordering is possible without an extra dialog.

interface SortableActivityButtonProps {
  activity: string
  group: ContextPanelDefinition[]
  activePanelId: string | null
  resource: ContextResource
  pendingPanelIds: string[]
  activeActivity: string | undefined
  attentionActivity: string | undefined
  scopeKey: string
  /**
   * Pad the button out to the 44pt iOS HIG floor. The shared `icon-sm` glyph is
   * 32px, which is below the bar this repo sets for itself in `globals.css`,
   * and the horizontal rail is the one placement a finger ever hits.
   */
  touchTarget?: boolean
  onActivate: (panel: ContextPanelDefinition, source: "rail") => void
  getPanelLabel: (panel: ContextPanelDefinition) => string
}

function SortableActivityButton({
  activity,
  group,
  activePanelId,
  resource,
  pendingPanelIds,
  activeActivity,
  attentionActivity,
  scopeKey,
  touchTarget,
  onActivate,
  getPanelLabel,
}: SortableActivityButtonProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: activity,
  })
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : undefined,
  }

  const panel = group.find((candidate) => candidate.id === activePanelId) ?? group[0]
  const Icon = panel.icon
  const badge =
    group.reduce((total, candidate) => total + (candidate.getBadge?.(resource) ?? 0), 0) +
    group.filter((candidate) => pendingPanelIds.includes(candidate.id)).length
  const label = getPanelLabel(panel)
  const isActive = activeActivity === activity

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          ref={setNodeRef}
          type="button"
          size="icon-sm"
          variant="ghost"
          {...attributes}
          aria-label={label}
          aria-pressed={isActive}
          data-workbench-activity-button
          data-testid={`workbench-activity-${activity}`}
          onClick={() => onActivate(panel, "rail")}
          className={cn(
            "relative cursor-grab active:cursor-grabbing",
            touchTarget && "touch-target",
            isActive && "text-foreground"
          )}
          style={style}
          {...listeners}
        >
          <MotionSelectionIndicator
            groupId={`workbench-activity-${scopeKey}`}
            active={isActive}
            className="absolute inset-0 rounded-md bg-secondary"
          />
          <span className="relative flex items-center justify-center">
            {Icon ? <Icon className="size-4" /> : <Rows3Icon className="size-4" />}
          </span>
          {badge > 0 ? (
            <Badge className="absolute -right-1 -top-1 z-10 h-4 min-w-4 px-1 text-[9px]">
              {badge > 99 ? "99+" : badge}
            </Badge>
          ) : attentionActivity === activity ? (
            <span
              data-testid="context-workbench-activity-attention"
              aria-hidden
              className="absolute -right-0.5 -top-0.5 z-10 size-2 rounded-full bg-primary"
            />
          ) : null}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="left">{label}</TooltipContent>
    </Tooltip>
  )
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
  railOnly = false,
  headerOutlet = null,
  attentionActivity,
  onModeWidthHint,
  headerLeading,
  resolvedMode,
  sessionScopeKey,
  onResetLayout,
}: ContextWorkbenchProps) {
  const sectionRef = useRef<HTMLElement | null>(null)
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const previousFocusRef = useRef<HTMLElement | null>(null)
  const lifecyclePanelsRef = useRef(new Map<string, Set<string>>())
  /**
   * The panel last in *front*, per scope. Answers "is this a navigation?" — so
   * it drives the back/forward history and the activation self-heal.
   */
  const lastActivePanelRef = useRef(new Map<string, string | null>())
  /**
   * The *set* of panels last on screen, per scope. Answers the different
   * question "did anything appear or disappear?" — so it drives
   * `onFirstActivate` / `onRestore`.
   *
   * A set rather than the panel in front is the whole point: swapping the two
   * panes is a navigation (the front panel changed) but must fire no lifecycle
   * at all, because nothing entered or left the screen. Dragging the separator
   * moves neither.
   */
  const lastVisiblePanelsRef = useRef(new Map<string, Set<string>>())
  /** The JSON form of the above, so the lifecycle effect has a primitive dep. */
  const lastVisibleKeyRef = useRef(new Map<string, string>())
  const t = useTranslations()
  const [customizeRailOpen, setCustomizeRailOpen] = useState(false)
  useSyncExternalStore(
    contextPanelRegistry.subscribe,
    contextPanelRegistry.getRevision,
    contextPanelRegistry.getRevision
  )
  // The mobile drawer lays the rail out horizontally. That one flag also stands
  // for "a finger is driving this": it decides the arrow-key axis, the 44pt
  // touch targets, whether the trailing button reads as Close or Collapse, and
  // whether re-tapping the active activity dismisses the surface. Declared up
  // here because handlers defined above the rail markup read it.
  const railIsHorizontal = placement === "mobile-sheet"
  const scopeKey = `${workbenchInstanceId}::${getContextResourceKey(resource)}`
  const panelHistory = usePanelHistory(scopeKey)
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
  const activateSplit = useContextWorkbenchStore((state) => state.activateSplit)
  const closeSplit = useContextWorkbenchStore((state) => state.closeSplit)
  const setSplitRatio = useContextWorkbenchStore((state) => state.setSplitRatio)
  // Selected off the single settings field, not through `useWorkbenchRailLayout`
  // — that hook reads the whole `settings` object, and this component is
  // mounted in four hosts and re-renders on every panel switch.
  const storedRailLayout = useSettingsStore((state) => state.settings?.workbenchRail)
  const storedPanelLayout = useSettingsStore((state) => state.settings?.workbenchPanels)
  const saveSettings = useSettingsStore((state) => state.save)
  const railLayout = useMemo(() => workbenchRailLayoutOf(storedRailLayout), [storedRailLayout])
  const panelLayout = useMemo(() => workbenchPanelLayoutOf(storedPanelLayout), [storedPanelLayout])

  // --- Activity rail inline drag-to-reorder (Phase 1.4) ---
  // Distance threshold = 8px to cleanly distinguish click from drag. Higher
  // than customizer-list's 4px because the rail buttons sit closer together
  // and are often target-tapped quickly on hover.
  const railDragSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } })
  )

  /**
   * The rail is showing but the panel body is not — from either of the two
   * routes into that state:
   *
   * - `railOnly`, the host shrinking its own container to the rail (the chat
   *   dock, Canvas, the workflow editor). One global fact per host.
   * - `layout.mode === "collapsed"`, the per-scope mode used by hosts that have
   *   no container of their own to shrink (the project editor).
   *
   * Everything downstream — whether the body renders, what the rail's bottom
   * button does, whether re-clicking the active activity closes or opens —
   * asks this rather than either source, so the two can never disagree.
   */
  const bodyHidden = railOnly || layout.mode === "collapsed"

  // Held in a ref so the host registration only churns on resource/scope
  // changes: a host passing an inline arrow would otherwise re-register on
  // every render, and one that memoised it would leave a stale closure behind.
  const ensureVisibleRef = useRef(onEnsureVisible)
  const collapseRef = useRef(onCollapse)
  // `bodyHidden` too: the registration below hands out a closure that has to
  // report the *current* value, and re-registering to refresh it would restamp
  // this host as the active one — a collapse is the opposite of claiming focus.
  const bodyHiddenRef = useRef(bodyHidden)
  // Same reasoning again for the visible set: the plugin layer has to read the
  // set this host is *drawing*, which the layout cannot supply on its own
  // because mobile and sub-480px bodies narrow a split away without writing
  // back. Kept behind a ref so a pane change does not restamp this host active.
  const visiblePanelIdsRef = useRef<string[]>([])
  useEffect(() => {
    ensureVisibleRef.current = onEnsureVisible
    collapseRef.current = onCollapse
    bodyHiddenRef.current = bodyHidden
  }, [bodyHidden, onCollapse, onEnsureVisible])
  useEffect(
    () =>
      setActiveContextForHost(scopeKey, resource, {
        ensureVisible: () => ensureVisibleRef.current?.(),
        // Only hosts that own a container advertise a collapse; the rest let
        // `setActiveWorkbenchMode` fall through to the per-scope mode.
        collapse: onCollapse ? () => collapseRef.current?.() : undefined,
        isVisible: () => !bodyHiddenRef.current,
        visiblePanelIds: () => visiblePanelIdsRef.current,
      }),
    // `onCollapse` by identity only decides whether the capability exists at
    // all — the call itself goes through the ref, so an inline arrow does not
    // churn the registration.
    [resource, scopeKey, Boolean(onCollapse)] // eslint-disable-line react-hooks/exhaustive-deps
  )

  // Visibility is read through a ref, so a flip has to be announced explicitly.
  // A narrow notify rather than a re-registration: see the note on
  // `notifyActiveContextHostVisibility`.
  useEffect(() => {
    notifyActiveContextHostVisibility(scopeKey)
  }, [bodyHidden, scopeKey])

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
    // Apply the user's panel-tab customization *inside* each group. Deliberately
    // not applied to `resolvedPanels` itself: a hidden panel keeps its mount and
    // stays in the published set, so the command palette, `ctrl+shift+e` and
    // `ctrl+1..7` still reach it. That fallback is the whole reason hiding a
    // panel is safe to offer, exactly as it is for hiding an activity.
    for (const [activity, group] of groups) {
      groups.set(
        activity,
        group
          .filter((panel) => !isWorkbenchPanelHidden(panel.id, panelLayout))
          .sort((left, right) => {
            const stored =
              workbenchPanelIndex(left.id, panelLayout) - workbenchPanelIndex(right.id, panelLayout)
            // Ties are every pair the user never reordered, which is all of them
            // on a default layout — so the shipped `order:` numbers keep
            // deciding until the user says otherwise.
            if (stored !== 0) return stored
            const declared = (left.order ?? 100) - (right.order ?? 100)
            return declared === 0 ? left.id.localeCompare(right.id) : declared
          })
      )
    }
    // A group whose every panel the user hid has no tab left to show; dropping
    // the rail button too keeps the icon from opening an empty body.
    for (const [activity, group] of groups) {
      if (group.length === 0) groups.delete(activity)
    }
    // The rail follows its own declared order (`panel.order` governs the group
    // alone). Deriving rail position from each group's lowest-ordered panel made
    // one number mean two things, so ordering panels within a group silently
    // reshuffled the rail — which is how the primary surface ended up third,
    // behind a chat panel that merely happened to sort first.
    //
    // The user's stored order wins over the shipped one; hidden activities lose
    // their rail *button* only. Their panels stay in `resolvedPanels`, so the
    // command palette and `ctrl+1..7` still reach them — which is the whole
    // reason hiding is safe to offer.
    return [...groups.entries()]
      .filter(([activity]) => !isWorkbenchActivityHidden(activity, railLayout))
      .sort(
        ([left], [right]) =>
          workbenchRailIndex(left, railLayout) - workbenchRailIndex(right, railLayout)
      )
  }, [panelLayout, railLayout, resolvedPanels])

  const handleRailDragEnd = useCallback(
    (event: DragEndEvent) => {
      const currentIds = activityGroups.map(([activity]) => activity)
      const next = applyDragReorder(
        currentIds,
        String(event.active.id),
        event.over ? String(event.over.id) : null
      )
      if (!next) return
      // Persist the reordered activity ids. Non-catalog ids (from plugins) are
      // preserved at the tail so they aren't accidentally dropped.
      const untouched = railLayout.order.filter((id) => !next.includes(id))
      void saveSettings({ workbenchRail: { ...railLayout, order: [...next, ...untouched] } })
    },
    [activityGroups, railLayout, saveSettings]
  )

  const activePanel = resolvedPanels.find((panel) => panel.id === layout.activePanelId)
  const activeGroup = activePanel
    ? (activityGroups.find(([activity]) => activity === activePanel.activity)?.[1] ?? [])
    : []

  // --- Vertical split ---
  //
  // Both narrowings below are *projections*: they change what this render shows
  // without writing to the store, so a phone — or a drag below the threshold and
  // back — cannot destroy a desktop layout the user set up deliberately.
  //
  // The mode check reads `layout.mode` rather than `widthMode`: `resolvedMode`
  // speaks for the host's real pixels and exists precisely because `layout.mode`
  // can lie for `manageOwnWidth={false}` hosts. Mode states the intent; the
  // measurement below decides whether there is room to honour it.
  const bodyWidth = useElementWidth(bodyRef)
  const splitEligible = placement !== "mobile-sheet" && isSplitEligibleMode(layout.mode)
  const splitPanel = splitEligible
    ? resolvedPanels.find(
        (panel) => panel.id === layout.splitPanelId && panel.id !== layout.activePanelId
      )
    : undefined
  // `useElementWidth` returns 0 until the ref is attached, and its own docs ask
  // callers to read that as "not yet measured". Treating it as eligible keeps the
  // first paint from showing one pane and snapping to two; the hook measures in
  // a layout effect, so the correction lands before the browser paints.
  const splitFitsWidth = bodyWidth === 0 || bodyWidth >= CONTEXT_WORKBENCH_SPLIT_MIN_WIDTH
  const splitActive = Boolean(splitPanel) && splitFitsWidth
  const secondaryPanelId = splitActive && splitPanel ? splitPanel.id : null
  // Not manually memoised: the React Compiler cannot preserve a memo whose deps
  // it believes may be mutated, and this is a filter over at most a dozen
  // panels — cheap enough to let the compiler decide.
  const visiblePanels = resolvedPanels.filter(
    (panel) => panel.id === layout.activePanelId || panel.id === secondaryPanelId
  )
  // Sorted and JSON-encoded, so the key is order-insensitive and unambiguous
  // whatever a panel id contains. It exists only as the change detector and
  // effect dep for the lifecycle effect below: swapping the two panes leaves it
  // untouched, which is exactly what makes a swap fire no lifecycle.
  const visiblePanelsKey = JSON.stringify(visiblePanels.map((panel) => panel.id).sort())
  // `resolvedPanels` is already filtered by `appliesTo`, capability and
  // permission, so "resolved and permitted" is free here; only the user's own
  // hide list still has to be applied (it governs tabs, not resolution).
  const splitCandidates = useMemo(
    () =>
      resolvedPanels.filter(
        (panel) =>
          panel.id !== layout.activePanelId && !isWorkbenchPanelHidden(panel.id, panelLayout)
      ),
    [layout.activePanelId, panelLayout, resolvedPanels]
  )
  const canOfferSplit = splitEligible && splitFitsWidth && splitCandidates.length > 0
  // Publish the drawn set, then announce it. A store-driven change (opening or
  // closing a split) already reaches plugins through the store subscription;
  // the render-time projections do not touch the store, so without this a
  // plugin panel narrowed away on a phone would keep reporting itself visible.
  useEffect(() => {
    visiblePanelIdsRef.current = JSON.parse(visiblePanelsKey) as string[]
    notifyActiveContextHostVisibility(scopeKey)
  }, [scopeKey, visiblePanelsKey])
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

  // Publish the resolved set so surfaces outside the workbench can name a panel
  // — the command palette and the activity shortcuts both need it, and native
  // panels are declared inline by each host rather than in a registry they could
  // read. Keyed on the panel ids: activity and label are fixed per id, so a
  // re-publish is only warranted when the set itself changes.
  useEffect(() => {
    publishActiveContextPanels(
      scopeKey,
      resolvedPanels.map((panel) => ({
        id: panel.id,
        activity: panel.activity,
        labelKey: panel.labelKey,
        label: panel.label,
        pluginId: panel.pluginId,
        preferredMode: panel.preferredMode,
      }))
    )
    // `resolvedPanels` is derived from `resolvedPanelKey`; depending on the
    // array itself would republish on every render that re-memoises it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolvedPanelKey, scopeKey])

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

  // Navigation: keyed on the panel in *front*, because that is the question a
  // back/forward stack asks. Swapping the two panes is a navigation even though
  // it is a no-op for the lifecycle effect below.
  useEffect(() => {
    const activeId = activePanel?.id ?? null
    if (lastActivePanelRef.current.get(scopeKey) === activeId) return
    lastActivePanelRef.current.set(scopeKey, activeId)
    if (!activePanel) return

    // Record this navigation for the back/forward history.
    pushPanelHistory(scopeKey, activePanel.id)

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
    layout.mode,
    markPanelActivated,
    navigatePanel,
    persistedLayout?.activatedPanelIds,
    scopeKey,
    sessionScopeKey,
  ])

  // Lifecycle: keyed on the *set* of panels on screen, not on the one in front.
  //
  // Only a panel that just appeared gets a callback. One that stayed on screen
  // gets nothing, which is what makes a pane swap silent (the set is unchanged)
  // and a separator drag silent (neither the set nor the key moves). One that
  // left gets nothing either — `<Activity>` already tore its effects down.
  useEffect(() => {
    const previousKey = lastVisibleKeyRef.current.get(scopeKey)
    if (previousKey === visiblePanelsKey) return
    lastVisibleKeyRef.current.set(scopeKey, visiblePanelsKey)
    const previous = lastVisiblePanelsRef.current.get(scopeKey)
    lastVisiblePanelsRef.current.set(scopeKey, new Set(visiblePanels.map((p) => p.id)))

    let seen = lifecyclePanelsRef.current.get(scopeKey)
    if (!seen) {
      // Seeded from what was persisted, so a panel restored from disk gets a
      // `restore` rather than a spurious `first`. The imperative routes
      // (`handleActivate`, `handleSplitBelow`) deliberately seed this *before*
      // writing to the store, or the write would make every first activation
      // look like a restore.
      seen = new Set(persistedLayout?.activatedPanelIds ?? [])
      lifecyclePanelsRef.current.set(scopeKey, seen)
    }
    for (const panel of visiblePanels) {
      if (previous?.has(panel.id)) continue
      const phase = seen.has(panel.id) ? "restore" : "first"
      seen.add(panel.id)
      invokePanelLifecycle(panel, phase)
    }
    // `visiblePanels` is derived from `visiblePanelsKey`; depending on the array
    // itself would re-run this on every render that re-memoises it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [invokePanelLifecycle, persistedLayout?.activatedPanelIds, scopeKey, visiblePanelsKey])

  const handleHistoryBack = useCallback(() => {
    const panelId = panelHistory.goBack()
    if (panelId)
      navigatePanel(scopeKey, panelId, layout.mode === "collapsed" ? "narrow" : layout.mode)
  }, [panelHistory, navigatePanel, scopeKey, layout.mode])

  const handleHistoryForward = useCallback(() => {
    const panelId = panelHistory.goForward()
    if (panelId)
      navigatePanel(scopeKey, panelId, layout.mode === "collapsed" ? "narrow" : layout.mode)
  }, [panelHistory, navigatePanel, scopeKey, layout.mode])

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

  /**
   * The inverse of {@link handleCollapse}: put the body back.
   *
   * Hosts that shrink their own container own the width, so ask them; the rest
   * come out of the per-scope collapsed mode. Reaching for `layout.mode` alone
   * would have left the rail-only hosts stuck — their mode was never `collapsed`
   * to begin with.
   */
  const handleExpand = () => {
    if (onEnsureVisible) onEnsureVisible()
    // Back to wide when a split is waiting: narrow has no room for two panes, so
    // expanding into it would silently destroy a layout the collapse preserved.
    if (layout.mode === "collapsed") {
      setMode(scopeKey, layout.splitPanelId ? "wide" : "narrow")
    }
  }

  /** Open `panel` in the second pane, below whatever is in front. */
  const handleSplitBelow = (panel: ContextPanelDefinition) => {
    touchActiveContextHost(scopeKey)
    // Seed the lifecycle bookkeeping *before* the store write, exactly as
    // `handleActivate` does: `activateSplit` records the panel as activated, and
    // a `seen` set seeded after that would read the very first activation as a
    // restore.
    let seen = lifecyclePanelsRef.current.get(scopeKey)
    if (!seen) {
      seen = new Set(persistedLayout?.activatedPanelIds ?? [])
      lifecyclePanelsRef.current.set(scopeKey, seen)
    }
    const phase = seen.has(panel.id) ? "restore" : "first"
    if (!activateSplit(scopeKey, panel.id)) return
    seen.add(panel.id)
    // Claim the new visible set so the lifecycle effect sees no change and does
    // not fire a second time for the panel we are about to announce here.
    const nextVisible = [layout.activePanelId, panel.id].filter(Boolean) as string[]
    lastVisiblePanelsRef.current.set(scopeKey, new Set(nextVisible))
    lastVisibleKeyRef.current.set(scopeKey, JSON.stringify([...nextVisible].sort()))
    if (panel.scope === "session" && sessionScopeKey) markPanelActivated(sessionScopeKey, panel.id)
    invokePanelLifecycle(panel, phase)
  }

  const handleCloseSplit = () => {
    closeSplit(scopeKey)
    const remaining = layout.activePanelId ? [layout.activePanelId] : []
    lastVisiblePanelsRef.current.set(scopeKey, new Set(remaining))
    lastVisibleKeyRef.current.set(scopeKey, JSON.stringify(remaining))
  }

  const handleActivate = (panel: ContextPanelDefinition, source: "rail" | "tab" = "tab") => {
    touchActiveContextHost(scopeKey)
    if (source === "rail" && bodyHidden) {
      // From the rail there is nothing to toggle shut — every click opens,
      // including a click on whatever was last in front. It then falls through
      // to the normal activation below rather than returning early: the body is
      // unmounted while rail-only, so re-opening really is a remount and the
      // panel's `onRestore` has to fire for it.
      handleExpand()
    } else if (layout.activePanelId === panel.id && !bodyHidden) {
      // Activity-bar convention (VS Code): clicking the ALREADY-ACTIVE
      // activity toggles the surface closed. Only for the rail — re-clicking
      // the current header/group tab must stay inert.
      //
      // And only on a pointer. In the mobile drawer "collapse" is a *close*, so
      // this convention turns a mistimed second tap on the icon you are already
      // looking at into dismissing the whole surface. The drawer has an
      // explicit Close button, the handle and the scrim; it does not need a
      // fourth exit hidden inside navigation.
      if (source === "rail" && !railIsHorizontal) handleCollapse()
      return
    } else if (splitActive && secondaryPanelId === panel.id) {
      // Already on screen, in the second pane. `reveal` turns this into a swap,
      // so the visible set is unchanged: no lifecycle, no width hint, no mode
      // hint — only the navigation. Claiming `lastActivePanelRef` silences the
      // navigation effect, so the history entry has to be recorded here.
      lastActivePanelRef.current.set(scopeKey, panel.id)
      pushPanelHistory(scopeKey, panel.id)
      navigatePanel(scopeKey, panel.id, panel.preferredMode ?? "narrow")
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
    // The claim above keeps the navigation effect quiet, so it will not record
    // this navigation either — push the history entry imperatively. The push
    // is a no-op when the panel is already the current entry (a rail re-open of
    // the panel that was last in front), so the stack does not fill with
    // duplicates.
    pushPanelHistory(scopeKey, panel.id)
    // Claim the visible set this navigation will produce, for the same reason
    // `lastActivePanelRef` is claimed above: the callback fires imperatively
    // here, so the effect must see no change and stay quiet. A second pane that
    // is not being replaced stays in the set.
    const nextVisible =
      secondaryPanelId && secondaryPanelId !== panel.id ? [panel.id, secondaryPanelId] : [panel.id]
    lastVisiblePanelsRef.current.set(scopeKey, new Set(nextVisible))
    lastVisibleKeyRef.current.set(scopeKey, JSON.stringify([...nextVisible].sort()))
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
    // Dragging out of the rail starts from the rail's own width, not from the
    // remembered `layout.width` — otherwise the first pixel of the gesture
    // teleports the edge out to wherever the panel was last left.
    const startWidth = bodyHidden ? WORKBENCH_RAIL_WIDTH_PX : layout.width
    const wasCollapsed = bodyHidden
    // Attribute the drag to whatever is in front, so the width comes back with
    // that panel. Read once at pointer-down: the active panel cannot change
    // mid-drag (the pointer is captured by the separator), and re-reading per
    // move event would only risk writing the tail of one panel's drag onto the
    // next panel's memory.
    const draggedPanelId = layout.activePanelId ?? undefined
    // The remembered width to restore when the drag opens the rail. Read at
    // pointer-down because the moves below overwrite `layout.width` as they go.
    const expandTo = layout.panelWidths[draggedPanelId ?? ""] ?? layout.width
    let lastWidth = startWidth
    const handleMove = (moveEvent: PointerEvent) => {
      lastWidth = startWidth + startX - moveEvent.clientX
      // Only track the pointer once the drag has actually opened the panel;
      // while it is still inside the rail there is no body to size, and writing
      // sub-rail widths would clamp them straight back to the minimum.
      if (!wasCollapsed || lastWidth >= CONTEXT_WORKBENCH_MIN_WIDTH) {
        setWidth(scopeKey, lastWidth, draggedPanelId)
      }
    }
    const handleUp = () => {
      window.removeEventListener("pointermove", handleMove)
      window.removeEventListener("pointerup", handleUp)
      // Snap in px: this host sizes the workbench itself, so the magnet radius
      // is already a physical distance and needs no conversion.
      const snapped = snapPanelSize(lastWidth, {
        presets: [CONTEXT_WORKBENCH_DEFAULT_WIDTH],
        floor: CONTEXT_WORKBENCH_MIN_WIDTH,
        expandTo,
        wasCollapsed,
        magnet: PANEL_SNAP_MAGNET_PX,
      })
      if (snapped.kind === "collapsed") {
        if (!wasCollapsed) handleCollapse()
        return
      }
      setWidth(scopeKey, snapped.size, draggedPanelId)
      if (wasCollapsed) handleExpand()
    }
    window.addEventListener("pointermove", handleMove)
    window.addEventListener("pointerup", handleUp)
  }

  /** Clamp to the store's own bounds so the preview can never show a ratio it would reject. */
  const clampSplitRatio = (ratio: number) =>
    Math.max(CONTEXT_WORKBENCH_SPLIT_MIN_RATIO, Math.min(CONTEXT_WORKBENCH_SPLIT_MAX_RATIO, ratio))

  /**
   * Drag the divider between the two panes.
   *
   * Unlike {@link handleResizeStart}, which writes the width on every move, this
   * only mutates the `--wb-split` custom property while the pointer is down and
   * commits to the store once on release. A store write per move would re-render
   * the whole workbench mid-gesture — and with it a Monaco buffer, an embedded
   * browser and a terminal — for a number nothing else reads until the drag ends.
   */
  const handleSplitResizeStart = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    const body = bodyRef.current
    if (!body) return
    const bounds = body.getBoundingClientRect()
    if (bounds.height <= 0) return
    let lastRatio = layout.splitRatio
    const handleMove = (moveEvent: PointerEvent) => {
      lastRatio = clampSplitRatio(((moveEvent.clientY - bounds.top) / bounds.height) * 100)
      body.style.setProperty("--wb-split", `${lastRatio}%`)
    }
    const handleUp = () => {
      window.removeEventListener("pointermove", handleMove)
      window.removeEventListener("pointerup", handleUp)
      setSplitRatio(scopeKey, lastRatio)
    }
    window.addEventListener("pointermove", handleMove)
    window.addEventListener("pointerup", handleUp)
  }

  /**
   * Keyboard resize, so the divider is not a pointer-only control.
   *
   * Commits immediately — a key press is already a discrete, finished gesture,
   * so there is no drag to keep out of the store.
   */
  const handleSplitResizeKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 10 : 2
    const next =
      event.key === "ArrowUp"
        ? layout.splitRatio - step
        : event.key === "ArrowDown"
          ? layout.splitRatio + step
          : event.key === "Home"
            ? CONTEXT_WORKBENCH_SPLIT_MIN_RATIO
            : event.key === "End"
              ? CONTEXT_WORKBENCH_SPLIT_MAX_RATIO
              : null
    if (next === null) return
    event.preventDefault()
    setSplitRatio(scopeKey, clampSplitRatio(next))
  }

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

  // The header row — either drawn above the panel body or, when the host hands
  // over `headerOutlet`, rendered into the shell's title bar so the workbench
  // sits under a single 40px row (`components/shell/title-bar-outlets.tsx`).
  const headerContent = (
    <>
      {/* Panel history back/forward — hidden on mobile and when
                the header is very narrow (<12rem) to not crowd the tabs.
                Also not drawn at all until there is somewhere to go: a
                disabled pair on a fresh panel is a second set of chevrons
                beside the title bar's route history, same glyphs with a
                different meaning, on every idle screen. */}
      {panelHistory.canGoBack || panelHistory.canGoForward ? (
        <div
          className="hidden shrink-0 items-center @[12rem]/wb-header:flex"
          data-testid="panel-history-nav"
        >
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            disabled={!panelHistory.canGoBack}
            aria-label={t("contextWorkbench.actions.historyBack")}
            title={t("contextWorkbench.actions.historyBack")}
            onClick={handleHistoryBack}
            data-testid="panel-history-back"
          >
            <ChevronLeftIcon className="size-4" />
          </Button>
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            disabled={!panelHistory.canGoForward}
            aria-label={t("contextWorkbench.actions.historyForward")}
            title={t("contextWorkbench.actions.historyForward")}
            onClick={handleHistoryForward}
            data-testid="panel-history-forward"
          >
            <ChevronRightIcon className="size-4" />
          </Button>
        </div>
      ) : null}
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
          // A `role="tab"` outside a tablist is invalid, and a tablist
          // cannot describe two visible panes with one selection — so
          // while split the group degrades to a plain button group whose
          // buttons report `aria-pressed` instead. Keyboard navigation is
          // unaffected: `handleGroupTabKeyDown` queries the data
          // attribute, not the role.
          role={splitActive ? "group" : "tablist"}
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
              data-split-secondary={secondaryPanelId === panel.id || undefined}
              role={splitActive ? undefined : "tab"}
              aria-selected={splitActive ? undefined : layout.activePanelId === panel.id}
              aria-pressed={
                splitActive
                  ? layout.activePanelId === panel.id || secondaryPanelId === panel.id
                  : undefined
              }
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
                // Reset alone did not justify a permanent button, so this
                // used to hide above the fold unless `onResetLayout` was
                // supplied. It no longer can: the menu is the only place
                // split view is named as unavailable, and a host without
                // a reset action would otherwise never show that at all —
                // which is the dormancy being silent again, just at one
                // breakpoint instead of everywhere.
                className="shrink-0"
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
              {/* `Rows2Icon`, not `Columns2Icon`: the split stacks, and
                        `Rows3Icon` is already the Wide glyph, so the two read
                        as a family. */}
              {splitActive ? (
                <DropdownMenuItem
                  data-testid="context-workbench-close-split-menu"
                  onSelect={handleCloseSplit}
                >
                  <Rows2Icon className="size-4" />
                  {t("contextWorkbench.actions.closeSplit")}
                </DropdownMenuItem>
              ) : canOfferSplit ? (
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger data-testid="context-workbench-split-below">
                    <Rows2Icon className="size-4" />
                    {t("contextWorkbench.actions.splitBelow")}
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent
                    aria-label={t("contextWorkbench.actions.splitBelowPanel")}
                  >
                    {splitCandidates.map((panel) => (
                      <DropdownMenuItem
                        key={panel.id}
                        data-testid={`context-workbench-split-candidate-${panel.id}`}
                        onSelect={() => handleSplitBelow(panel)}
                      >
                        {getPanelLabel(panel)}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
              ) : (
                <DropdownMenuItem
                  disabled
                  data-testid="context-workbench-split-unavailable"
                  onSelect={(event) => event.preventDefault()}
                >
                  <Rows2Icon className="size-4" />
                  {t("contextWorkbench.actions.splitNeedsWide")}
                </DropdownMenuItem>
              )}
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
    </>
  )
  const headerRow = headerOutlet ? (
    createPortal(
      <div
        data-testid="context-workbench-header"
        className="@container/wb-header flex h-full min-w-0 flex-1 items-center gap-1 px-2"
        // The activity rail keeps its column inside the dock, so the projected
        // row starts where the header used to: past it.
        style={{ paddingLeft: WORKBENCH_RAIL_WIDTH_PX + 8 }}
      >
        {headerContent}
      </div>,
      headerOutlet
    )
  ) : (
    <header
      data-testid="context-workbench-header"
      className="@container/wb-header flex h-10 shrink-0 items-center gap-1 border-b px-2"
    >
      {headerContent}
    </header>
  )

  return (
    <ContextWorkbenchContext.Provider value={value}>
      <section
        ref={sectionRef}
        tabIndex={layout.mode === "focus" ? -1 : undefined}
        role={layout.mode === "focus" ? "dialog" : undefined}
        aria-modal={layout.mode === "focus" ? true : undefined}
        className={cn(
          "relative flex h-full min-h-0 min-w-0 max-w-full overflow-hidden border-l bg-card/40",
          // A phone can't spare 48px of its width for a vertical rail, so the
          // sheet stacks: rail across the top, panel body beneath it.
          placement === "mobile-sheet" && "w-full flex-col border-l-0",
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
        // Rail-only used to be a `w-12` class beside the width style — a second
        // copy of the rail's measurement that could drift from the one the host
        // hands its panel as `collapsedSize`. Both now read the constant.
        // `manageOwnWidth={false}` hosts still get no width at all: theirs is
        // the outer resizable panel's to set.
        style={
          !manageOwnWidth || focusTakeover || placement === "mobile-sheet"
            ? undefined
            : bodyHidden
              ? { width: WORKBENCH_RAIL_WIDTH_PX }
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
        {/* Kept mounted while rail-only: dragging the edge outward is how the
            minibar is opened, so disabling the separator there would leave the
            rail with no drag affordance at all. Focus is still exempt — that
            surface has no edge to grab. */}
        {manageOwnWidth && placement !== "mobile-sheet" && layout.mode !== "focus" ? (
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label={t("contextWorkbench.actions.resize")}
            className="absolute inset-y-0 left-0 z-20 w-5 -translate-x-1/2 cursor-col-resize touch-none"
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
                ? // Tall enough to hold a 44px touch target with breathing room;
                  // `h-12` clipped the padded buttons.
                  "h-14 w-full overflow-x-auto border-b px-2"
                : "flex-col border-r py-2"
            )}
            // Inline width rather than `w-12`: the rail is now also what a
            // collapsed host shrinks *to*, so its width has to be the same
            // number the host hands its panel as `collapsedSize`. A Tailwind
            // class and a JS constant would be two sources for one measurement.
            style={railIsHorizontal ? undefined : { width: WORKBENCH_RAIL_WIDTH_PX }}
            aria-label={t("contextWorkbench.activityRailLabel")}
            data-rail-only={bodyHidden || undefined}
            data-testid="context-workbench-activity-rail"
            onKeyDown={handleActivityKeyDown}
          >
            <DndContext
              sensors={railDragSensors}
              collisionDetection={closestCenter}
              onDragEnd={handleRailDragEnd}
            >
              <SortableContext
                items={activityGroups.map(([activity]) => activity)}
                strategy={
                  railIsHorizontal ? horizontalListSortingStrategy : verticalListSortingStrategy
                }
              >
                {activityGroups.map(([activity, group]) => (
                  <SortableActivityButton
                    key={activity}
                    activity={activity}
                    group={group}
                    activePanelId={layout.activePanelId}
                    resource={resource}
                    pendingPanelIds={layout.pendingPanelIds}
                    activeActivity={activePanel?.activity}
                    attentionActivity={attentionActivity}
                    scopeKey={scopeKey}
                    touchTarget={railIsHorizontal}
                    onActivate={handleActivate}
                    getPanelLabel={getPanelLabel}
                  />
                ))}
              </SortableContext>
            </DndContext>
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
                    className={cn(railIsHorizontal && "touch-target")}
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
                    aria-label={t("desktop.shellLayout.title")}
                    data-testid="context-workbench-customize-rail"
                    className={cn(railIsHorizontal && "touch-target")}
                    onClick={() => setCustomizeRailOpen(true)}
                  >
                    <SlidersHorizontalIcon className="size-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side={railIsHorizontal ? "bottom" : "left"}>
                  {t("desktop.shellLayout.title")}
                </TooltipContent>
              </Tooltip>
              {/* Flips with the surface. On a persistent rail the panel body is
                  already shut, so a second "collapse" would be inert — the one
                  action left is to put it back.

                  In the mobile drawer it is neither: the host's `onCollapse`
                  closes the whole surface, so this is a plain Close. It used to
                  claim "Collapse workbench" over a right-edge panel glyph, on a
                  sheet that has no right edge and does not collapse — the only
                  exit affordance on the platform, describing something else. */}
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost"
                    aria-label={t(
                      railIsHorizontal
                        ? "contextWorkbench.actions.close"
                        : bodyHidden
                          ? "contextWorkbench.actions.expand"
                          : "contextWorkbench.actions.collapse"
                    )}
                    data-testid="context-workbench-collapse-toggle"
                    className={cn(railIsHorizontal && "touch-target")}
                    onClick={bodyHidden ? handleExpand : handleCollapse}
                  >
                    {railIsHorizontal ? (
                      <XIcon className="size-4" />
                    ) : bodyHidden ? (
                      <PanelRightOpenIcon className="size-4" />
                    ) : (
                      <PanelRightCloseIcon className="size-4" />
                    )}
                  </Button>
                </TooltipTrigger>
                <TooltipContent side={railIsHorizontal ? "bottom" : "left"}>
                  {t(
                    railIsHorizontal
                      ? "contextWorkbench.actions.close"
                      : bodyHidden
                        ? "contextWorkbench.actions.expand"
                        : "contextWorkbench.actions.collapse"
                  )}
                </TooltipContent>
              </Tooltip>
            </div>
          </nav>
        </TooltipProvider>

        {!bodyHidden ? (
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
            {headerRow}
            <div
              ref={bodyRef}
              className="relative min-h-0 flex-1 overflow-hidden"
              data-split={splitActive || undefined}
              // The live ratio rides a custom property so a drag can move both
              // lanes and the bar by mutating one node — no React render per
              // pointermove, which is what keeps a Monaco buffer and an embedded
              // webview out of the gesture.
              style={{ "--wb-split": `${layout.splitRatio}%` } as CSSProperties}
            >
              {resolvedPanels.map((panel) => {
                // A session-scoped panel keeps its mount for as long as the
                // conversation lasts, so moving between artifact tabs no longer
                // tears down the embedded browser (releasing a process-wide
                // webview lease) or the workspace's Monaco buffers.
                const activatedIn =
                  panel.scope === "session" && sessionActivatedPanelIds
                    ? sessionActivatedPanelIds
                    : layout.activatedPanelIds
                const isPrimary = layout.activePanelId === panel.id
                const isSecondary = secondaryPanelId === panel.id
                // `active` means "in a visible pane" — true for BOTH panels while
                // split, not just the one the rail highlights. It drives `inert`,
                // `aria-hidden`, the `<Activity>` mode and the renderer's own
                // prop, so a second pane that reported inactive would be mounted
                // but unfocusable and would tell its plugin it was hidden.
                const active = isPrimary || isSecondary
                // The panel on screen always mounts, even before its activation
                // is recorded: a fresh scope gets its default panel from
                // `reconcilePanels`, which deliberately leaves `activatedPanelIds`
                // alone so the first activation still counts as a *first*. Hosts
                // used to paper over this with a second "open on the default
                // panel" effect that raced the reconcile.
                if (!active && !activatedIn.includes(panel.id)) return null
                const Renderer = panel.renderer
                const waitingForChatScope = panel.requiresChatScope && !resourceSession
                const rendererContent = waitingForChatScope ? (
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
                )
                const guardedContent = panel.pluginId ? (
                  <PluginContextPanelSurface pluginId={panel.pluginId} panelId={panel.id}>
                    {rendererContent}
                  </PluginContextPanelSurface>
                ) : (
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
                    {rendererContent}
                  </PanelErrorBoundary>
                )
                const content = (
                  <div
                    id={`context-workbench-panel-${panel.id}`}
                    // Two visible tabpanels under one selected tab is not a tabs
                    // widget, so while split both panes become plain regions. The
                    // secondary borrows the visible title in the split bar;
                    // the primary has no visible title of its own and takes a
                    // label directly.
                    role={splitActive ? "region" : "tabpanel"}
                    aria-labelledby={
                      splitActive && isSecondary
                        ? `context-workbench-split-title-${panel.id}`
                        : undefined
                    }
                    aria-label={splitActive && isPrimary ? getPanelLabel(panel) : undefined}
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
                    {guardedContent}
                  </div>
                )
                // The load-bearing line of the whole split. `absolute inset-0`
                // used to be a class; it is now an inline box so the split can
                // move it. In the single-pane case the computed box is identical
                // to before, and in every case this is the SAME element in the
                // SAME position with the SAME parent — React updates attributes
                // rather than reconciling a new subtree, so no panel remounts
                // when the split opens, closes, swaps or resizes.
                //
                // That is also why this is not a `ResizablePanelGroup`: moving a
                // panel into a `<ResizablePanel>` changes its parent chain, and a
                // swap changes both panes' chains at once — either one tears down
                // an embedded webview holding a process-wide lease.
                const lane: CSSProperties = !splitActive
                  ? { top: 0, bottom: 0 }
                  : isSecondary
                    ? { top: `calc(var(--wb-split) + ${SPLIT_BAR_HEIGHT})`, bottom: 0 }
                    : isPrimary
                      ? { top: 0, height: "var(--wb-split)" }
                      : // Hidden panels park in the primary lane; `<Activity>`
                        // keeps them out of layout anyway.
                        { top: 0, bottom: 0 }
                return panel.retention === "ephemeral" ? (
                  active ? (
                    <div key={panel.id} className="absolute inset-x-0" style={lane}>
                      {content}
                    </div>
                  ) : null
                ) : (
                  <Activity key={panel.id} mode={active ? "visible" : "hidden"}>
                    <div className="absolute inset-x-0" style={lane}>
                      {content}
                    </div>
                  </Activity>
                )
              })}
              {/* One bar, rendered *outside* the panel map so no panel ever gains
                  or loses a DOM parent when it appears. React treats the array
                  and this conditional as two independent child slots. It is the
                  second pane's title strip, its drag handle and its close button
                  at once — the same three jobs a VS Code split editor header
                  does. */}
              {splitActive && splitPanel ? (
                <div
                  className="absolute inset-x-0 z-20 flex items-center gap-1 border-y bg-muted/40 px-2"
                  style={{ top: "var(--wb-split)", height: SPLIT_BAR_HEIGHT }}
                  data-testid="context-workbench-split-bar"
                >
                  <div
                    role="separator"
                    aria-orientation="horizontal"
                    tabIndex={0}
                    aria-label={t("contextWorkbench.actions.resizeSplit")}
                    aria-controls={`context-workbench-panel-${layout.activePanelId}`}
                    aria-valuenow={Math.round(layout.splitRatio)}
                    aria-valuemin={CONTEXT_WORKBENCH_SPLIT_MIN_RATIO}
                    aria-valuemax={CONTEXT_WORKBENCH_SPLIT_MAX_RATIO}
                    data-testid="context-workbench-split-separator"
                    className="absolute inset-x-0 -top-1 h-3 cursor-row-resize touch-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none"
                    onPointerDown={handleSplitResizeStart}
                    onKeyDown={handleSplitResizeKeyDown}
                    onDoubleClick={() =>
                      setSplitRatio(scopeKey, CONTEXT_WORKBENCH_SPLIT_DEFAULT_RATIO)
                    }
                  />
                  <span
                    id={`context-workbench-split-title-${splitPanel.id}`}
                    className="pointer-events-none truncate text-xs font-medium text-muted-foreground"
                  >
                    {getPanelLabel(splitPanel)}
                  </span>
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost"
                    className="ml-auto size-5"
                    aria-label={t("contextWorkbench.actions.closeSplit")}
                    data-testid="context-workbench-close-split"
                    onClick={handleCloseSplit}
                  >
                    <XIcon className="size-3.5" />
                  </Button>
                </div>
              ) : null}
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
      <ShellLayoutDialog
        open={customizeRailOpen}
        onOpenChange={setCustomizeRailOpen}
        surface="workbench"
      />
    </ContextWorkbenchContext.Provider>
  )
}
export function PluginContextPanelSurface({
  pluginId,
  panelId,
  children,
}: {
  pluginId: string
  panelId: string
  children: React.ReactNode
}) {
  return (
    <PluginSurface
      pluginId={pluginId}
      surfaceId={`context-panel:${panelId}`}
      formFactor="panel"
      container={false}
    >
      {children}
    </PluginSurface>
  )
}
