"use client"

/**
 * Full-screen terminal experience for the Capacitor mobile shell. Lives
 * at `/me/terminal` and skips the desktop dock (which expects a
 * resizable bottom panel — not viable on a 375-wide phone).
 *
 * Composition reuses `TerminalTabStrip` + `TerminalInstance` directly so
 * the dock and the mobile screen share the same tab logic and renderer
 * setup. The mobile shell adds:
 *   * a header with the connection-state badge, search + history
 *     toggles, "+ New" and close-page,
 *   * a smaller default font (mobile-pinned) and reduced backlog,
 *   * a one-line empty state when there are no live remote sessions.
 *
 * Where the desktop dock pins the search
 * overlay top-right and the history panel as a right rail, the mobile
 * screen pops them on demand:
 *   * search: floats above the xterm pane (`<TerminalSearchOverlay>`).
 *   * history: slides up as a `<Sheet>` so it doesn't fight the
 *     keyboard on a narrow viewport (`<TerminalHistoryPanel>`).
 *
 * Transport: mobile tries the paired host over LAN first, then uses the
 * authenticated ordered WebRTC terminal channel over WAN. Tauri-channel
 * doesn't apply.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import {
  ArrowDownIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  ArrowUpIcon,
  HistoryIcon,
  KeyboardIcon,
  PlusIcon,
  SearchIcon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable"
import { ProjectOverviewPanel } from "@/components/artifacts/workspace-mode/project-overview-panel"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { ConnectionStateBadge } from "@/components/mobile/connection-state-badge"
import { TerminalHistoryPanel } from "@/components/terminal/terminal-history-panel"
import { TerminalHostStateBanner } from "@/components/terminal/terminal-host-state-banner"
import {
  TerminalInstance,
  type TerminalInstanceHandle,
} from "@/components/terminal/terminal-instance"
import { TerminalSearchOverlay } from "@/components/terminal/terminal-search-overlay"
import { TerminalTabStrip } from "@/components/terminal/terminal-tab-strip"
import { selectTerminalTransport } from "@/lib/terminal/pick-transport"
import { useMediaQuery, useResizableLayout } from "@/hooks/ui"
import { detachFromDock, spawnFromDock } from "@/lib/terminal/spawn-orchestrator"
import { resolveDefaultShell } from "@/lib/terminal/shell-detect"
import { useProjectStore } from "@/stores/project/project-store"
import { useSettingsStore } from "@/stores/settings"
import { useTerminalStore, type TerminalSessionRow } from "@/stores/terminal/terminal-store"

// Phone-sized *defaults*, not overrides: a phone screen fits fewer columns, so
// the desktop 13px default is too large here. An explicit user setting still
// wins — otherwise Settings → Terminal → Font size silently does nothing on
// mobile, which reads as "the font setting doesn't work".
const MOBILE_FONT_SIZE = 11
const MOBILE_SCROLLBACK = 5000

export function MobileTerminalScreen() {
  const router = useRouter()
  const t = useTranslations("mobile.terminal")
  const sessions = useTerminalStore((s) => s.sessions)
  const activeByProject = useTerminalStore((s) => s.activeSessionIdByProject)
  const setActiveSession = useTerminalStore((s) => s.setActiveSession)

  const activeProjectId = useProjectStore((s) => s.activeProjectId)
  const project = useProjectStore((s) =>
    s.activeProjectId ? (s.projects.find((p) => p.id === s.activeProjectId) ?? null) : null
  )
  const settingsShell = useSettingsStore(
    (s) => (s.settings?.terminal as { defaultShell?: string } | undefined)?.defaultShell
  )
  const settingsFontSize = useSettingsStore(
    (s) => (s.settings?.terminal as { fontSize?: number } | undefined)?.fontSize
  )
  const settingsScrollback = useSettingsStore(
    (s) => (s.settings?.terminal as { scrollback?: number } | undefined)?.scrollback
  )
  const fontSize = typeof settingsFontSize === "number" ? settingsFontSize : MOBILE_FONT_SIZE
  const scrollback = typeof settingsScrollback === "number" ? settingsScrollback : MOBILE_SCROLLBACK

  const instanceRef = useRef<TerminalInstanceHandle | null>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [keyboardVisible, setKeyboardVisible] = useState(false)
  const [viewportHeight, setViewportHeight] = useState<number | null>(null)
  const isTablet = useMediaQuery("(min-width: 768px)")
  const isLandscape = useMediaQuery("(orientation: landscape)")
  const portraitLayout = useResizableLayout("cognia-tablet-terminal-portrait")
  const landscapeLayout = useResizableLayout("cognia-tablet-terminal-landscape")

  useEffect(() => {
    const viewport = window.visualViewport
    if (!viewport) return
    const update = () => setViewportHeight(Math.round(viewport.height))
    update()
    viewport.addEventListener("resize", update)
    viewport.addEventListener("scroll", update)
    return () => {
      viewport.removeEventListener("resize", update)
      viewport.removeEventListener("scroll", update)
    }
  }, [])

  useEffect(() => {
    // Host-owned sessions survive mobile app backgrounding/restarts. Restore
    // their tabs immediately on entry; the transport walks LAN then WAN.
    void import("@/lib/terminal/rehydrate")
      .then(({ rehydrateTerminals }) => rehydrateTerminals())
      .catch(() => undefined)
  }, [])

  const projectKey = activeProjectId ?? ""
  const tabs = useMemo<TerminalSessionRow[]>(
    () =>
      Object.values(sessions)
        .filter((row) => (row.projectId ?? "") === projectKey)
        .sort((a, b) => a.createdAt - b.createdAt),
    [sessions, projectKey]
  )
  const activeId = activeByProject[projectKey] ?? null
  const activeRow = activeId ? sessions[activeId] : undefined

  const handleNew = useCallback(async () => {
    const shell = resolveDefaultShell({
      projectShell: project?.terminalConfig?.shell,
      settingShell: settingsShell,
    })
    const cwd = project?.terminalConfig?.cwd?.trim() || project?.rootDir?.trim() || undefined
    const env = project?.terminalConfig?.env
    await spawnFromDock({
      req: {
        shell,
        // Mobile defaults — the remote host re-fits on attach.
        rows: 28,
        cols: 80,
        cwd,
        env,
        projectId: activeProjectId ?? undefined,
        enableShellIntegration: true,
      },
      store: useTerminalStore.getState(),
    })
  }, [project, activeProjectId, settingsShell])

  const handleClose = useCallback((id: string) => {
    void detachFromDock(id, useTerminalStore.getState())
  }, [])

  const handleSelect = useCallback(
    (id: string) => setActiveSession(activeProjectId, id),
    [activeProjectId, setActiveSession]
  )

  const transport = selectTerminalTransport()
  const showTabletWorkbench = isTablet && !!activeProjectId
  const tabletLayout = isLandscape ? landscapeLayout : portraitLayout

  return (
    <main
      data-testid="mobile-terminal-screen"
      className="flex h-[100dvh] w-full flex-col bg-background pt-[env(safe-area-inset-top)]"
      style={viewportHeight ? { height: `${viewportHeight}px` } : undefined}
    >
      <header className="flex items-center gap-2 border-b px-2 py-2 text-sm">
        <Button
          size="icon"
          variant="ghost"
          className="h-8 w-8"
          onClick={() => router.back()}
          aria-label={t("back")}
          data-testid="mobile-terminal-back"
        >
          <ArrowLeftIcon className="h-4 w-4" />
        </Button>
        <h1 className="flex-1 truncate text-sm font-medium">{t("title")}</h1>
        <ConnectionStateBadge />
        <Button
          size="icon"
          variant="ghost"
          className="h-8 w-8"
          disabled={!activeRow}
          onClick={() => setSearchOpen((open) => !open)}
          aria-label={t("search")}
          aria-pressed={searchOpen}
          data-testid="mobile-terminal-search"
        >
          <SearchIcon className="h-4 w-4" />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="h-8 w-8"
          disabled={!activeRow}
          onClick={() => setHistoryOpen((open) => !open)}
          aria-label={t("history")}
          aria-pressed={historyOpen}
          data-testid="mobile-terminal-history"
        >
          <HistoryIcon className="h-4 w-4" />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="h-8 w-8"
          onClick={() => {
            void handleNew()
          }}
          aria-label={t("newSession")}
          data-testid="mobile-terminal-new"
        >
          <PlusIcon className="h-4 w-4" />
        </Button>
      </header>
      <div
        className="min-h-0 flex-1"
        data-testid={showTabletWorkbench ? "tablet-terminal-split" : "phone-terminal-surface"}
      >
        <ResizablePanelGroup
          orientation={isLandscape ? "horizontal" : "vertical"}
          defaultLayout={tabletLayout.defaultLayout}
          onLayoutChanged={tabletLayout.onLayoutChanged}
        >
          {showTabletWorkbench ? (
            <>
              <ResizablePanel
                id="workbench"
                defaultSize={isLandscape ? "45%" : "42%"}
                minSize="25%"
              >
                <div className="h-full min-h-0 overflow-hidden border-b bg-muted/20 landscape:border-r landscape:border-b-0">
                  <ProjectOverviewPanel
                    projectId={activeProjectId}
                    onOpenWorkspace={() => router.back()}
                  />
                </div>
              </ResizablePanel>
              <ResizableHandle withHandle />
            </>
          ) : null}
          <ResizablePanel
            id="terminal"
            defaultSize={showTabletWorkbench ? "58%" : "100%"}
            minSize="25%"
          >
            <section className="flex h-full min-h-0 flex-col">
              <TerminalHostStateBanner
                onRetry={() => {
                  useTerminalStore.getState().setHostState("reconnecting")
                  void import("@/lib/terminal/rehydrate").then(({ rehydrateTerminals }) =>
                    rehydrateTerminals()
                  )
                }}
                onOpenSettings={() => router.push("/settings?section=terminal")}
              />
              <TerminalTabStrip
                tabs={tabs}
                activeId={activeId}
                onSelect={handleSelect}
                onClose={handleClose}
                testId="mobile-terminal-tabs"
              />
              <div className="relative flex-1 overflow-hidden">
                {activeRow ? (
                  <>
                    <TerminalInstance
                      ref={instanceRef}
                      sessionId={activeRow.id}
                      fontSize={fontSize}
                      scrollback={scrollback}
                    />
                    <TerminalSearchOverlay
                      open={searchOpen}
                      onClose={() => setSearchOpen(false)}
                      instanceRef={instanceRef}
                    />
                  </>
                ) : (
                  <div
                    className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center text-xs text-muted-foreground"
                    data-testid="mobile-terminal-empty"
                  >
                    <p>
                      {transport === "ws"
                        ? t("empty.remoteReady")
                        : transport === "tauri-channel"
                          ? t("empty.notMobile")
                          : t("empty.unavailable")}
                    </p>
                    {transport === "ws" ? (
                      <Button
                        size="sm"
                        variant="default"
                        onClick={() => {
                          void handleNew()
                        }}
                      >
                        <PlusIcon className="mr-1 h-3 w-3" />
                        {t("empty.action")}
                      </Button>
                    ) : null}
                  </div>
                )}
              </div>
              <nav
                className="flex shrink-0 items-center gap-1 overflow-x-auto border-t bg-muted/70 px-2 pt-1 pb-[calc(0.25rem+env(safe-area-inset-bottom))] backdrop-blur"
                aria-label={t("accessory.label")}
                data-testid="mobile-terminal-accessory"
              >
                <AccessoryKey
                  label={t("accessory.esc")}
                  onPress={() => instanceRef.current?.sendInput("\u001b")}
                />
                <AccessoryKey
                  label={t("accessory.tab")}
                  onPress={() => instanceRef.current?.sendInput("\t")}
                />
                <AccessoryKey
                  label={t("accessory.ctrl")}
                  onPress={() => instanceRef.current?.sendInput("\u0003")}
                />
                <AccessoryKey
                  label={t("accessory.alt")}
                  onPress={() => instanceRef.current?.sendInput("\u001b")}
                />
                <AccessoryKey
                  label={t("accessory.left")}
                  icon={<ArrowLeftIcon className="h-3.5 w-3.5" />}
                  onPress={() => instanceRef.current?.sendInput("\u001b[D")}
                />
                <AccessoryKey
                  label={t("accessory.down")}
                  icon={<ArrowDownIcon className="h-3.5 w-3.5" />}
                  onPress={() => instanceRef.current?.sendInput("\u001b[B")}
                />
                <AccessoryKey
                  label={t("accessory.up")}
                  icon={<ArrowUpIcon className="h-3.5 w-3.5" />}
                  onPress={() => instanceRef.current?.sendInput("\u001b[A")}
                />
                <AccessoryKey
                  label={t("accessory.right")}
                  icon={<ArrowRightIcon className="h-3.5 w-3.5" />}
                  onPress={() => instanceRef.current?.sendInput("\u001b[C")}
                />
                <AccessoryKey
                  label={t("accessory.paste")}
                  onPress={() => instanceRef.current?.pasteFromClipboard()}
                />
                <AccessoryKey
                  label={t(keyboardVisible ? "accessory.hideKeyboard" : "accessory.showKeyboard")}
                  pressed={keyboardVisible}
                  icon={<KeyboardIcon className="h-3.5 w-3.5" />}
                  onPress={() => {
                    if (keyboardVisible) instanceRef.current?.hideKeyboard()
                    else instanceRef.current?.focusKeyboard()
                    setKeyboardVisible((visible) => !visible)
                  }}
                />
              </nav>
            </section>
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>
      {/* History as a slide-up sheet — on narrow viewports a right rail
          (the desktop pattern) would either eat too much width or fight
          the on-screen keyboard. */}
      <Sheet open={historyOpen && !!activeRow} onOpenChange={setHistoryOpen}>
        <SheetContent side="bottom" className="h-[60dvh] p-0">
          <SheetHeader className="px-4 pt-3 pb-1">
            <SheetTitle>{t("historyTitle")}</SheetTitle>
            <SheetDescription>{t("historySubtitle")}</SheetDescription>
          </SheetHeader>
          {activeRow ? <TerminalHistoryPanel sessionId={activeRow.id} className="flex-1" /> : null}
        </SheetContent>
      </Sheet>
    </main>
  )
}

function AccessoryKey({
  label,
  icon,
  pressed,
  onPress,
}: {
  label: string
  icon?: React.ReactNode
  pressed?: boolean
  onPress: () => void | Promise<void>
}) {
  return (
    <Button
      type="button"
      size="sm"
      variant={pressed ? "secondary" : "ghost"}
      className="h-8 min-w-9 shrink-0 px-2 font-mono text-[11px]"
      aria-label={label}
      aria-pressed={pressed}
      onPointerDown={(event) => event.preventDefault()}
      onClick={() => void onPress()}
    >
      {icon ?? label}
    </Button>
  )
}

export default MobileTerminalScreen
