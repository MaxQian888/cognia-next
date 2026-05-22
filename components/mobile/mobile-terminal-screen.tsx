"use client"

/**
 * Full-screen terminal experience for the Capacitor mobile shell. Lives
 * at `/me/terminal` and skips the desktop dock (which expects a
 * resizable bottom panel — not viable on a 375-wide phone).
 *
 * Composition reuses `TerminalTabStrip` + `TerminalInstance` directly so
 * the dock and the mobile screen share the same tab logic and renderer
 * setup. The mobile shell adds:
 *   * a header with the connection-state badge + "+ New" + close-page,
 *   * a smaller default font (mobile-pinned) and reduced backlog,
 *   * a one-line empty state when there are no live remote sessions.
 *
 * Transport: the picker is fixed to `ws` for this surface. Mobile is the
 * primary user of the LAN/WAN remote terminal, and Tauri-channel doesn't
 * apply.
 */

import { useCallback, useMemo, useRef } from "react"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { ArrowLeftIcon, PlusIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { ConnectionStateBadge } from "@/components/mobile/connection-state-badge"
import {
  TerminalInstance,
  type TerminalInstanceHandle,
} from "@/components/terminal/terminal-instance"
import { TerminalTabStrip } from "@/components/terminal/terminal-tab-strip"
import { selectTerminalTransport } from "@/lib/terminal/pick-transport"
import { killFromDock, spawnFromDock } from "@/lib/terminal/spawn-orchestrator"
import { resolveDefaultShell } from "@/lib/terminal/shell-detect"
import { useProjectStore } from "@/stores/project/project-store"
import { useSettingsStore } from "@/stores/settings"
import { useTerminalStore, type TerminalSessionRow } from "@/stores/terminal/terminal-store"

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

  const instanceRef = useRef<TerminalInstanceHandle | null>(null)

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
          <TerminalInstance
            ref={instanceRef}
            sessionId={activeRow.id}
            fontSize={MOBILE_FONT_SIZE}
            scrollback={MOBILE_SCROLLBACK}
          />
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
    </main>
  )
}

export default MobileTerminalScreen
