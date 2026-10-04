"use client"

/**
 * DockTabStrip — the chat dock's one tab strip (ADR-0214, D6).
 *
 * The dock used to stack two navigations: the open-artifact tabs
 * (`ArtifactTabStrip`) and, beside them, the workbench's own panel tabs or
 * activity rail. A conversation's side chat, its workspace, its browser and its
 * artifacts are all "things open in this task", so they share one strip here,
 * in the order the user arranged them.
 *
 * It owns no tabs. Each kind keeps its existing owner (see
 * `stores/artifact/dock-tabs-store.ts`): panel tabs are the session scope's
 * activated panels, artifact tabs the conversation's open artifacts, page tabs
 * the conversation's open addresses. The strip reads them, lays them out in
 * the remembered order, and drives the owners — `navigatePanel` /
 * `closePanelTab` for a panel, `setActiveArtifact` / `closeArtifact` for an
 * artifact, `lib/artifacts/dock-pages` for a page. Activating a panel or page
 * tab parks the active artifact (`setActiveArtifact(null)` keeps its tab),
 * which is what brings the dock from the artifact surface back to the session
 * surface.
 *
 * The `browser` panel never shows as a tab of its own: it is what renders the
 * page tab in front, so the pages stand in for it.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import {
  ChevronDownIcon,
  CornerUpLeftIcon,
  ExternalLinkIcon,
  FeatherIcon,
  GlobeIcon,
  MessageSquarePlusIcon,
  PanelRightIcon,
  PlusIcon,
  XIcon,
} from "lucide-react"

import { SourceFavicon } from "@/components/chat/message-parts/mcp-renderers/common"
import { MotionSelectionIndicator } from "@/components/chat/motion/motion-reveal"
import { Button } from "@/components/ui/button"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useActiveArtifactId, useOpenArtifactIds } from "@/hooks/artifacts/use-session-artifacts"
import {
  DOCK_BROWSER_PANEL_ID,
  activateDockPageTab,
  closeDockPageTab,
  openDockNewTab,
  setDockPageEngine,
} from "@/lib/artifacts/dock-pages"
import { wholeArtifactSelection } from "@/lib/artifacts/format-selection-context"
import { isLocalChromiumInstalled } from "@/lib/browser/agent-engine"
import { contextPanelRegistry } from "@/lib/context-workbench/panel-registry"
import { resolveWorkbenchPanelLabel } from "@/lib/context-workbench/panel-label"
import { openExternal } from "@/lib/tauri/opener"
import { cn } from "@/lib/utils"
import { useArtifactDockLayoutStore } from "@/stores/artifact/artifact-dock-layout-store"
import { selectOpenArtifactIds, useArtifactStore } from "@/stores/artifact/artifact-store"
import {
  artifactTabKey,
  orderDockTabs,
  pageTabKey,
  panelTabKey,
  parseDockTabKey,
  selectPageTabs,
  useDockTabsStore,
  type DockPageTab,
  type DockTabKey,
} from "@/stores/artifact/dock-tabs-store"
import { useChatStore } from "@/stores/chat"
import { useChatViewportStore } from "@/stores/chat/chat-viewport-store"
import { useContextWorkbenchStore } from "@/stores/context-workbench/context-workbench-store"
import type { ContextPanelMode } from "@/types/context-workbench"

import { getArtifactTypeIcon } from "./artifact-icons"
import { DOCK_SESSION_PANEL_META } from "./dock-panel-meta"

const EMPTY_IDS: string[] = []
const EMPTY_PAGES: DockPageTab[] = []

/**
 * The tabs the strip has to show before ordering: the session scope's panels
 * (the one in front included, even before the workbench records it), the
 * conversation's open artifacts that still exist, and — when `pageTabIds` is
 * given — its page tabs, which then stand in for the `browser` panel. Shared
 * with the New Tab page, which needs the strip as drawn to put a tool in its
 * own place.
 */
export function presentDockTabs({
  activatedPanelIds,
  activePanelId,
  openArtifactIds,
  artifactExists,
  isKnownPanel,
  pageTabIds,
}: {
  activatedPanelIds: readonly string[]
  activePanelId: string | null
  openArtifactIds: readonly string[]
  artifactExists: (artifactId: string) => boolean
  isKnownPanel: (panelId: string) => boolean
  pageTabIds?: readonly string[]
}): DockTabKey[] {
  const panelIds =
    activePanelId && !activatedPanelIds.includes(activePanelId)
      ? [...activatedPanelIds, activePanelId]
      : activatedPanelIds
  return [
    ...panelIds
      .filter((id) => isKnownPanel(id) && !(pageTabIds && id === DOCK_BROWSER_PANEL_ID))
      .map(panelTabKey),
    ...openArtifactIds.filter(artifactExists).map(artifactTabKey),
    ...(pageTabIds ?? []).map(pageTabKey),
  ]
}

/** The strip for `sessionId` as it is drawn, read outside React. */
export function drawnDockTabs(sessionId: string, sessionScopeKey: string): DockTabKey[] {
  const layout = useContextWorkbenchStore.getState().layouts[sessionScopeKey]
  const artifacts = useArtifactStore.getState()
  const tabs = useDockTabsStore.getState()
  return orderDockTabs(
    tabs.bySession[sessionId]?.order,
    presentDockTabs({
      activatedPanelIds: layout?.activatedPanelIds ?? [],
      activePanelId: layout?.activePanelId ?? null,
      openArtifactIds: selectOpenArtifactIds(artifacts, sessionId),
      artifactExists: (id) => Boolean(artifacts.artifacts[id]),
      isKnownPanel: isKnownDockPanel,
      pageTabIds: selectPageTabs(tabs, sessionId).map((tab) => tab.id),
    })
  )
}

/** A page tab's label: its title, else its host, else its address. */
export function pageTabLabel(tab: Pick<DockPageTab, "title" | "url">): string {
  if (tab.title) return tab.title
  try {
    return new URL(tab.url).host || tab.url
  } catch {
    return tab.url
  }
}

/** Where a page's icon would be, for addresses that have one. */
function faviconFor(url: string): { src?: string; host: string } {
  try {
    const parsed = new URL(url)
    return /^https?:$/.test(parsed.protocol)
      ? { src: `${parsed.origin}/favicon.ico`, host: parsed.hostname }
      : { host: parsed.hostname || url }
  } catch {
    return { host: url }
  }
}

/** First-party session panels, and whatever plugins have registered. */
export function isKnownDockPanel(panelId: string): boolean {
  return panelId in DOCK_SESSION_PANEL_META || contextPanelRegistry.get(panelId) !== undefined
}

export interface DockTabStripProps {
  sessionId: string | null
  /** The session surface's workbench scope — where panel tabs live. */
  sessionScopeKey: string
  /** The dock's width hint, so a panel that wants room gets it from the strip too. */
  onWidthHint: (mode: ContextPanelMode, panelId?: string) => void
  /** Whether `+` can open the New Tab page here. */
  canOpenNewTab?: boolean
  className?: string
}

interface PanelInfo {
  label: string
  icon: React.ComponentType<{ className?: string }>
  preferredMode: ContextPanelMode
}

/** A panel's label, icon and width, whether first-party or from a plugin. */
function usePanelInfo(): (panelId: string) => PanelInfo | null {
  const t = useTranslations()
  return useCallback(
    (panelId: string) => {
      const meta = DOCK_SESSION_PANEL_META[panelId]
      if (meta) {
        return {
          label: resolveWorkbenchPanelLabel(t, { labelKey: meta.labelKey }, meta.labelKey),
          icon: meta.icon,
          preferredMode: meta.preferredMode ?? "narrow",
        }
      }
      const registered = contextPanelRegistry.get(panelId)
      if (!registered) return null
      return {
        label: resolveWorkbenchPanelLabel(t, registered, registered.labelKey),
        icon: registered.icon ?? PanelRightIcon,
        preferredMode: registered.preferredMode ?? "narrow",
      }
    },
    [t]
  )
}

/** Whether the strip's content is wider than the strip, and on which sides. */
function useOverflow(element: HTMLElement | null, contentKey: string) {
  const [overflow, setOverflow] = useState({ start: false, end: false })
  useEffect(() => {
    if (!element) return
    const measure = () => {
      const start = element.scrollLeft > 1
      const end = element.scrollLeft + element.clientWidth < element.scrollWidth - 1
      setOverflow((previous) =>
        previous.start === start && previous.end === end ? previous : { start, end }
      )
    }
    measure()
    element.addEventListener("scroll", measure, { passive: true })
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure)
    observer?.observe(element)
    return () => {
      element.removeEventListener("scroll", measure)
      observer?.disconnect()
    }
  }, [element, contentKey])
  return overflow
}

export function DockTabStrip({
  sessionId,
  sessionScopeKey,
  onWidthHint,
  canOpenNewTab = true,
  className,
}: DockTabStripProps) {
  const t = useTranslations("contextWorkbench.dockTabs")
  const tArtifacts = useTranslations("artifacts")
  const tJump = useTranslations("chat.jump")
  const panelInfo = usePanelInfo()
  const layout = useContextWorkbenchStore((state) => state.layouts[sessionScopeKey])
  const navigatePanel = useContextWorkbenchStore((state) => state.navigatePanel)
  const closePanelTab = useContextWorkbenchStore((state) => state.closePanelTab)
  const artifacts = useArtifactStore((state) => state.artifacts)
  const openArtifactIds = useOpenArtifactIds()
  const activeArtifactId = useActiveArtifactId()
  const setActiveArtifact = useArtifactStore((state) => state.setActiveArtifact)
  const closeArtifact = useArtifactStore((state) => state.closeArtifact)
  const setDockCollapsed = useArtifactDockLayoutStore((state) => state.setDockCollapsed)
  const storedOrder = useDockTabsStore((state) =>
    sessionId ? state.bySession[sessionId]?.order : undefined
  )
  const pageTabs = useDockTabsStore((state) =>
    sessionId ? (state.bySession[sessionId]?.pages ?? EMPTY_PAGES) : EMPTY_PAGES
  )
  const activePageTabId = useDockTabsStore((state) =>
    sessionId ? (state.bySession[sessionId]?.activePageTabId ?? null) : null
  )
  const moveTab = useDockTabsStore((state) => state.moveTab)
  const addContextSelection = useChatStore((state) => state.addContextSelection)
  const activeTurnMessageIds = useChatViewportStore((state) => state.activeTurnMessageIds)
  const jumpToMessage = useChatViewportStore((state) => state.jumpToMessage)
  const [strip, setStrip] = useState<HTMLDivElement | null>(null)
  const [dragged, setDragged] = useState<DockTabKey | null>(null)
  const tabRefs = useRef(new Map<DockTabKey, HTMLButtonElement>())

  const activatedPanelIds = layout?.activatedPanelIds ?? EMPTY_IDS
  const activePanelId = layout?.activePanelId ?? null
  const pendingPanelIds = layout?.pendingPanelIds ?? EMPTY_IDS

  const keys = useMemo(
    () =>
      orderDockTabs(
        storedOrder,
        presentDockTabs({
          activatedPanelIds,
          activePanelId,
          openArtifactIds,
          artifactExists: (id) => Boolean(artifacts[id]),
          isKnownPanel: (id) => panelInfo(id) !== null,
          pageTabIds: pageTabs.map((tab) => tab.id),
        })
      ),
    [activatedPanelIds, activePanelId, artifacts, openArtifactIds, pageTabs, panelInfo, storedOrder]
  )

  const activeKey: DockTabKey | null =
    activeArtifactId && artifacts[activeArtifactId]
      ? artifactTabKey(activeArtifactId)
      : activePanelId === DOCK_BROWSER_PANEL_ID
        ? activePageTabId && keys.includes(pageTabKey(activePageTabId))
          ? pageTabKey(activePageTabId)
          : null
        : activePanelId && keys.includes(panelTabKey(activePanelId))
          ? panelTabKey(activePanelId)
          : null

  const overflow = useOverflow(strip, keys.join("\u0000"))

  useEffect(() => {
    if (activeKey) tabRefs.current.get(activeKey)?.scrollIntoView?.({ inline: "nearest" })
  }, [activeKey])

  const activatePanel = (panelId: string) => {
    // Park the artifact rather than closing it: its tab stays on the strip.
    if (activeArtifactId) setActiveArtifact(null, sessionId)
    const mode = panelInfo(panelId)?.preferredMode ?? "narrow"
    navigatePanel(sessionScopeKey, panelId, mode)
    onWidthHint(mode, panelId)
  }

  const activate = (key: DockTabKey) => {
    const tab = parseDockTabKey(key)
    if (tab.kind === "artifact") setActiveArtifact(tab.artifactId, sessionId)
    else if (tab.kind === "page") {
      if (!sessionId) return
      activateDockPageTab(sessionId, tab.tabId)
      onWidthHint("wide", DOCK_BROWSER_PANEL_ID)
    } else activatePanel(tab.panelId)
  }

  const close = (key: DockTabKey) => {
    const index = keys.indexOf(key)
    const remaining = keys.filter((candidate) => candidate !== key)
    const tab = parseDockTabKey(key)
    if (tab.kind === "artifact") closeArtifact(tab.artifactId)
    else if (tab.kind === "page") {
      if (sessionId) closeDockPageTab(sessionId, tab.tabId)
    } else closePanelTab(sessionScopeKey, tab.panelId)
    // Nothing left open in this task: the dock has nothing to show.
    if (remaining.length === 0) {
      setDockCollapsed(true)
      return
    }
    // The browser convention: the tab to the right takes over, else the left.
    if (key === activeKey) activate(remaining[Math.min(index, remaining.length - 1)])
  }

  const goToSource = (messageId: string) => {
    if (!jumpToMessage) return
    if (!jumpToMessage(messageId, undefined, { align: "center" })) toast.error(tJump("notFound"))
  }

  const focusTab = (key: DockTabKey | undefined) => {
    if (!key) return
    tabRefs.current.get(key)?.focus()
    activate(key)
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const focused = keys.find((key) => tabRefs.current.get(key) === document.activeElement)
    if (!focused) return
    const index = keys.indexOf(focused)
    if (event.key === "ArrowRight") focusTab(keys[(index + 1) % keys.length])
    else if (event.key === "ArrowLeft") focusTab(keys[(index - 1 + keys.length) % keys.length])
    else if (event.key === "Home") focusTab(keys[0])
    else if (event.key === "End") focusTab(keys.at(-1))
    else if (event.key === "Delete") close(focused)
    else return
    event.preventDefault()
  }

  const describe = (key: DockTabKey) => {
    const tab = parseDockTabKey(key)
    if (tab.kind === "artifact") {
      const artifact = artifacts[tab.artifactId]
      return {
        label: artifact.title,
        icon: (
          <span className="shrink-0 text-muted-foreground">
            {getArtifactTypeIcon(artifact.type)}
          </span>
        ),
        artifact,
        page: null,
      }
    }
    if (tab.kind === "page") {
      const page = pageTabs.find((entry) => entry.id === tab.tabId)!
      const favicon = faviconFor(page.url)
      return {
        label: pageTabLabel(page),
        icon: favicon.host ? (
          <SourceFavicon key={page.url} src={favicon.src} host={favicon.host} />
        ) : (
          <GlobeIcon className="size-3.5 shrink-0 text-muted-foreground" />
        ),
        artifact: null,
        page,
      }
    }
    const info = panelInfo(tab.panelId)!
    const Icon = info.icon
    return {
      label: info.label,
      icon: <Icon className="size-3.5 shrink-0 text-muted-foreground" />,
      artifact: null,
      page: null,
    }
  }

  return (
    <div className={cn("flex min-w-0 flex-1 items-center gap-0.5", className)}>
      <div className="relative flex min-w-0 flex-1">
        <div
          ref={setStrip}
          role="tablist"
          aria-label={t("label")}
          data-testid="dock-tab-strip"
          onKeyDown={handleKeyDown}
          className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {keys.map((key, index) => {
            const { label, icon, artifact, page } = describe(key)
            const active = key === activeKey
            const tab = parseDockTabKey(key)
            const pending = tab.kind === "panel" && pendingPanelIds.includes(tab.panelId)
            const sourceInView =
              artifact !== null && !active && activeTurnMessageIds.includes(artifact.messageId)
            return (
              <ContextMenu key={key}>
                <ContextMenuTrigger asChild>
                  <div
                    draggable
                    data-testid={`dock-tab-${key}`}
                    data-active={active || undefined}
                    data-source-in-view={sourceInView || undefined}
                    onDragStart={(event) => {
                      setDragged(key)
                      event.dataTransfer.effectAllowed = "move"
                    }}
                    onDragEnd={() => setDragged(null)}
                    onDragOver={(event) => {
                      // Required, or the browser refuses the drop.
                      if (dragged && dragged !== key) event.preventDefault()
                    }}
                    onDrop={(event) => {
                      event.preventDefault()
                      if (dragged && dragged !== key && sessionId) {
                        moveTab(sessionId, keys, dragged, index)
                      }
                      setDragged(null)
                    }}
                    className={cn(
                      "group relative flex h-7 min-w-24 max-w-44 flex-1 basis-36 items-center rounded-md",
                      !active && "hover:bg-accent/50",
                      // The conversation is scrolled to the turn this artifact
                      // came out of — a ring, since "selected" spends the fill.
                      sourceInView && "ring-1 ring-primary/40 ring-inset",
                      dragged === key && "opacity-50"
                    )}
                  >
                    <MotionSelectionIndicator
                      groupId={`dock-tabs-${sessionId ?? "none"}`}
                      active={active}
                      className="absolute inset-0 rounded-md bg-secondary"
                    />
                    <button
                      ref={(element) => {
                        if (element) tabRefs.current.set(key, element)
                        else tabRefs.current.delete(key)
                      }}
                      type="button"
                      role="tab"
                      aria-selected={active}
                      tabIndex={active || (!activeKey && index === 0) ? 0 : -1}
                      className="relative flex h-full min-w-0 flex-1 items-center gap-1.5 pl-2 text-xs outline-offset-[-2px]"
                      title={
                        artifact && jumpToMessage
                          ? tArtifacts("dock.tabHint", { title: artifact.title })
                          : page
                            ? page.url
                            : label
                      }
                      onClick={() => activate(key)}
                      onDoubleClick={() => {
                        if (artifact) goToSource(artifact.messageId)
                      }}
                      // Browser convention: middle-click closes the tab.
                      onAuxClick={(event) => {
                        if (event.button === 1) close(key)
                      }}
                    >
                      {icon}
                      <span className="min-w-0 truncate">{label}</span>
                      {page?.engine === "embedded" ? (
                        <FeatherIcon
                          className="size-3 shrink-0 text-muted-foreground"
                          aria-label={t("lightweightBadge")}
                          data-testid={`dock-tab-lightweight-${key}`}
                        />
                      ) : null}
                      {pending ? (
                        <span
                          className="size-1.5 shrink-0 rounded-full bg-primary"
                          data-testid={`dock-tab-pending-${key}`}
                        />
                      ) : null}
                    </button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      tabIndex={-1}
                      aria-label={t("close", { name: label })}
                      className={cn(
                        "relative mr-0.5 size-5 shrink-0 opacity-0 focus-visible:opacity-100 group-hover:opacity-100 pointer-coarse:opacity-100",
                        active && "opacity-100"
                      )}
                      onClick={() => close(key)}
                    >
                      <XIcon className="size-3" />
                    </Button>
                  </div>
                </ContextMenuTrigger>
                <ContextMenuContent>
                  {artifact ? (
                    <>
                      <ContextMenuItem
                        onSelect={() => addContextSelection(wholeArtifactSelection(artifact))}
                      >
                        <MessageSquarePlusIcon className="size-4" />
                        {tArtifacts("dock.referenceInChat")}
                      </ContextMenuItem>
                      <ContextMenuItem
                        disabled={!jumpToMessage}
                        onSelect={() => goToSource(artifact.messageId)}
                      >
                        <CornerUpLeftIcon className="size-4" />
                        {tArtifacts("dock.goToSource")}
                      </ContextMenuItem>
                    </>
                  ) : null}
                  {page && sessionId ? (
                    <>
                      {page.engine === "embedded" ? (
                        isLocalChromiumInstalled() ? (
                          <ContextMenuItem
                            onSelect={() => setDockPageEngine(sessionId, page.id, "auto")}
                          >
                            <GlobeIcon className="size-4" />
                            {t("openInChromium")}
                          </ContextMenuItem>
                        ) : null
                      ) : (
                        <ContextMenuItem
                          onSelect={() => setDockPageEngine(sessionId, page.id, "embedded")}
                        >
                          <FeatherIcon className="size-4" />
                          {t("openInLightweight")}
                        </ContextMenuItem>
                      )}
                      <ContextMenuItem
                        disabled={!/^https?:/i.test(page.url)}
                        onSelect={() => void openExternal(page.url)}
                      >
                        <ExternalLinkIcon className="size-4" />
                        {t("openInDefaultBrowser")}
                      </ContextMenuItem>
                    </>
                  ) : null}
                  <ContextMenuItem onSelect={() => close(key)}>
                    <XIcon className="size-4" />
                    {tArtifacts("dock.closeTabMenuItem")}
                  </ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
            )
          })}
        </div>
        {/* Fade the clipped edge so a scrolled strip reads as "more this way". */}
        {overflow.start ? (
          <span
            aria-hidden
            className="pointer-events-none absolute inset-y-0 left-0 w-6 bg-linear-to-r from-background to-transparent"
          />
        ) : null}
        {overflow.end ? (
          <span
            aria-hidden
            className="pointer-events-none absolute inset-y-0 right-0 w-6 bg-linear-to-l from-background to-transparent"
          />
        ) : null}
      </div>
      {overflow.start || overflow.end ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              className="shrink-0"
              aria-label={t("allTabs")}
              data-testid="dock-tab-all"
            >
              <ChevronDownIcon className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="max-h-80 w-60 overflow-y-auto">
            {keys.map((key) => {
              const { label, icon } = describe(key)
              return (
                <DropdownMenuItem
                  key={key}
                  onSelect={() => activate(key)}
                  className={cn(key === activeKey && "bg-accent/60")}
                >
                  {icon}
                  <span className="min-w-0 flex-1 truncate">{label}</span>
                </DropdownMenuItem>
              )
            })}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
      {canOpenNewTab ? (
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          className="shrink-0"
          aria-label={t("newTab")}
          title={t("newTab")}
          data-testid="dock-tab-new"
          onClick={() => openDockNewTab(sessionId, sessionScopeKey)}
        >
          <PlusIcon className="size-4" />
        </Button>
      ) : null}
    </div>
  )
}
