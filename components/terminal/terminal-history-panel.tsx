"use client"

/**
 * Collapsible per-tab command-history rail. Reads `lastCommands` from
 * the terminal store (populated by `spawn-orchestrator` on OSC 633 C/D
 * events). Each row shows:
 *   * exit-status dot (reusing terminal-tab.tsx color scheme),
 *   * command text (mono, truncated),
 *   * relative time since the command ended.
 *
 * Click row → copy command to clipboard.
 * Shift+click row → re-run via `session.write(cmd + "\r")`.
 *
 * Open state is per-tab and lives in the store (`historyOpen` field).
 * The dock + mobile screen mount this rail when active and let it
 * collapse/expand itself.
 */

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { CopyIcon, MessageSquareIcon, PlayIcon } from "lucide-react"

import { MotionPopover } from "@/components/chat/motion/motion-reveal"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { cn } from "@/lib/utils"
import { getLiveSession } from "@/lib/terminal/session-registry"
import { useTerminalStore } from "@/stores/terminal/terminal-store"

import { TERMINAL_LAYOUT, terminalExitDotClass } from "./terminal-layout-tokens"

export interface TerminalHistoryPanelProps {
  sessionId: string
  className?: string
  /** Jump to the chat session that spawned this terminal. Shown only for agent-spawned tabs. */
  onLocateInChat?: (chatSessionId: string, messageId?: string | null) => void
}

function relativeTime(endedAt: number, now: number): string {
  const sec = Math.max(0, Math.floor((now - endedAt) / 1000))
  if (sec < 60) return `${sec}s`
  if (sec < 3600) return `${Math.floor(sec / 60)}m`
  return `${Math.floor(sec / 3600)}h`
}

export function TerminalHistoryPanel({
  sessionId,
  className,
  onLocateInChat,
}: TerminalHistoryPanelProps) {
  const t = useTranslations("terminal.history")
  const lastCommands = useTerminalStore((s) => s.sessions[sessionId]?.lastCommands)
  const open = useTerminalStore((s) => s.sessions[sessionId]?.historyOpen) ?? false
  const agentSpawner = useTerminalStore((s) => s.sessions[sessionId]?.agentSpawner) ?? null
  const agentSpawnerMessageId =
    useTerminalStore((s) => s.sessions[sessionId]?.agentSpawnerMessageId) ?? null
  const setHistoryOpen = useTerminalStore((s) => s.setHistoryOpen)
  // Tick `now` once per minute so relative timestamps stay fresh without
  // calling Date.now() in render (react-hooks/purity).
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!open) return
    const id = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(id)
  }, [open])

  const handleRerun = (cmd: string) => {
    const session = getLiveSession(sessionId)
    if (!session) return
    void session.write(cmd + "\r")
  }
  const handleCopy = (cmd: string) => {
    if (navigator.clipboard) {
      void navigator.clipboard.writeText(cmd).catch(() => {
        /* noop */
      })
    }
  }

  return (
    <>
      {!open ? (
        <Button
          size="icon"
          variant="ghost"
          className={cn(
            "absolute right-2 top-2 z-10 h-7 w-7 opacity-60 hover:opacity-100",
            className
          )}
          onClick={() => setHistoryOpen(sessionId, true)}
          aria-label={t("open")}
          data-testid="terminal-history-open"
        >
          <PlayIcon className="h-3 w-3" />
        </Button>
      ) : null}
      <MotionPopover
        open={open}
        className={cn("absolute right-0 top-0 z-10 h-full", className)}
        from={{ opacity: 0, x: "100%" }}
      >
        <aside
          role="complementary"
          data-testid="terminal-history-panel"
          className={cn(
            "flex h-full flex-col border-l bg-background/95 backdrop-blur",
            TERMINAL_LAYOUT.historyRailWidth
          )}
        >
          <div className="flex items-center justify-between border-b px-2 py-1.5">
            <span className="text-xs font-medium">{t("title")}</span>
            <div className="flex items-center gap-0.5">
              {agentSpawner && onLocateInChat ? (
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-6 w-6"
                  onClick={() => onLocateInChat(agentSpawner, agentSpawnerMessageId)}
                  aria-label={t("locateInChat")}
                  data-testid="terminal-history-locate"
                >
                  <MessageSquareIcon className="h-3 w-3" />
                </Button>
              ) : null}
              <Button
                size="icon"
                variant="ghost"
                className="h-6 w-6"
                onClick={() => setHistoryOpen(sessionId, false)}
                aria-label={t("close")}
                data-testid="terminal-history-close"
              >
                <span className="text-xs">×</span>
              </Button>
            </div>
          </div>
          <ScrollArea className="flex-1">
            {!lastCommands || lastCommands.length === 0 ? (
              <p
                className="px-3 py-4 text-[11px] text-muted-foreground"
                data-testid="terminal-history-empty"
              >
                {t("empty")}
              </p>
            ) : (
              <ul className="divide-y" data-testid="terminal-history-list">
                {lastCommands
                  .slice()
                  .reverse()
                  .map((rec, idx) => (
                    <li
                      key={`${idx}-${rec.endedAt}`}
                      className="group flex items-center gap-1 px-2 py-1.5 text-[11px] hover:bg-muted/50"
                      data-testid="terminal-history-row"
                    >
                      <span
                        className={cn(
                          "inline-block h-1.5 w-1.5 rounded-full",
                          terminalExitDotClass(rec.exitCode)
                        )}
                        aria-label={
                          rec.exitCode === null
                            ? t("status.unknown")
                            : rec.exitCode === 0
                              ? t("status.ok")
                              : t("status.error")
                        }
                      />
                      <code
                        className="flex-1 truncate font-mono"
                        title={rec.cmd || t("blank")}
                        onClick={(e) => {
                          if (e.shiftKey) handleRerun(rec.cmd)
                          else handleCopy(rec.cmd)
                        }}
                      >
                        {rec.cmd || (
                          <span className="text-muted-foreground italic">{t("blank")}</span>
                        )}
                      </code>
                      <span className="text-[10px] text-muted-foreground">
                        {relativeTime(rec.endedAt, now)}
                      </span>
                      <div className="hidden gap-0.5 group-hover:flex">
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-5 w-5"
                          onClick={() => handleCopy(rec.cmd)}
                          aria-label={t("copy")}
                          data-testid="terminal-history-copy"
                        >
                          <CopyIcon className="h-3 w-3" />
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-5 w-5"
                          onClick={() => handleRerun(rec.cmd)}
                          aria-label={t("rerun")}
                          data-testid="terminal-history-rerun"
                        >
                          <PlayIcon className="h-3 w-3" />
                        </Button>
                      </div>
                    </li>
                  ))}
              </ul>
            )}
          </ScrollArea>
        </aside>
      </MotionPopover>
    </>
  )
}

export default TerminalHistoryPanel
