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
 * Wave 2 — overlay parity. Where the desktop dock pins the search
 * overlay top-right and the history panel as a right rail, the mobile
 * screen pops them on demand:
 *   * search: floats above the xterm pane (`<TerminalSearchOverlay>`).
 *   * history: slides up as a `<Sheet>` so it doesn't fight the
 *     keyboard on a narrow viewport (`<TerminalHistoryPanel>`).
 *
 * Transport: the picker is fixed to `ws` for this surface (with the
 * future WAN fallback to `webrtc` via `selectTerminalTransportChain`).
 * Mobile is the primary user of the LAN/WAN remote terminal, and
 * Tauri-channel doesn't apply.
 */

import { useCallback, useMemo, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { ArrowLeftIcon, HistoryIcon, PlusIcon, SearchIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { ConnectionStateBadge } from "@/components/mobile/connection-state-badge"
import { TerminalHistoryPanel } from "@/components/terminal/terminal-history-panel"
import {
  TerminalInstance,
  type TerminalInstanceHandle,
} from "@/components/terminal/terminal-instance"
import { TerminalSearchOverlay } from "@/components/terminal/terminal-search-overlay"
import { TerminalTabStrip } from "@/components/terminal/terminal-tab-strip"
import { selectTerminalTransport } from "@/lib/terminal/pick-transport"
import { killFromDock, spawnFromDock } from "@/lib/terminal/spawn-orchestrator"
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
    void killFromDock(id, useTerminalStore.getState())
  }, [])

  const handleSelect = useCallback(
    (id: string) => setActiveSession(activeProjectId, id),
    [activeProjectId, setActiveSession]
  )

  const transport = selectTerminalTransport()

  return (
    <main
      data-testid="mobile-terminal-screen"
      className="flex h-[100dvh] w-full flex-col bg-background"
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

export default MobileTerminalScreen
