"use client"

/**
 * Live view of an SSH tab's port forwards, with per-rule start/stop.
 *
 * Polled rather than pushed. The terminal host never volunteers forwarding
 * frames (ADR-0033), so this asks while it is open and stops the moment it
 * closes or the tab stops being an SSH session — nothing runs in the
 * background for tabs nobody is looking at.
 *
 * A toggle sends the change and renders the reply, which is the state *after*
 * the change rather than an echo of the request: binding a socket can fail, and
 * when it does the reason belongs on the row that failed.
 */

import { useCallback, useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { NetworkIcon } from "lucide-react"

import { MotionPopover } from "@/components/chat/motion/motion-reveal"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Switch } from "@/components/ui/switch"
import { cn } from "@/lib/utils"
import {
  readSshForwardStatus,
  setSshForwardEnabled,
  type SshForwardRunState,
  type SshForwardStatus,
} from "@/lib/terminal/ssh-forward-control"
import { useTerminalStore } from "@/stores/terminal/terminal-store"

import { TERMINAL_LAYOUT } from "./terminal-layout-tokens"

/** Slow enough to be invisible on the wire, quick enough to feel live. */
const POLL_INTERVAL_MS = 2_000

export interface TerminalForwardPanelProps {
  sessionId: string
  className?: string
  /** Injected in tests; defaults to the real host calls. */
  read?: typeof readSshForwardStatus
  setEnabled?: typeof setSshForwardEnabled
}

const STATE_DOT: Record<SshForwardRunState, string> = {
  stopped: "bg-muted-foreground/40",
  starting: "bg-blue-500",
  listening: "bg-emerald-500",
  waiting: "bg-amber-500",
  failed: "bg-red-500",
}

export function TerminalForwardPanel({
  sessionId,
  className,
  read = readSshForwardStatus,
  setEnabled = setSshForwardEnabled,
}: TerminalForwardPanelProps) {
  const t = useTranslations("terminal.forwards")
  // Mounted with `key={sessionId}`, so every piece of state below belongs to
  // one session and switching tabs cannot show another tab's tunnels.
  const isSsh = useTerminalStore((state) => state.sessions[sessionId]?.kind) === "ssh"
  const [open, setOpen] = useState(false)
  const [forwards, setForwards] = useState<SshForwardStatus[]>([])
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Keeps a reply that lost the race with a later one from overwriting it, and
  // stops a poll landing after unmount from setting state.
  const requestSeq = useRef(0)

  const apply = useCallback((seq: number, next: SshForwardStatus[]) => {
    if (seq < requestSeq.current) return
    setForwards(next)
    setError(null)
  }, [])

  useEffect(() => {
    if (!isSsh) return
    let cancelled = false
    const poll = async () => {
      const seq = (requestSeq.current += 1)
      try {
        const next = await read(sessionId)
        if (!cancelled) apply(seq, next)
      } catch (cause) {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : String(cause))
        }
      }
    }
    void poll()
    // Poll only while the rail is open. A collapsed rail still runs one read so
    // the entry point can hide itself for a session with no tunnels at all.
    if (!open)
      return () => {
        cancelled = true
      }
    const timer = window.setInterval(() => void poll(), POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [apply, isSsh, open, read, sessionId])

  const toggle = useCallback(
    async (forwardId: string, enabled: boolean) => {
      setBusyId(forwardId)
      const seq = (requestSeq.current += 1)
      try {
        apply(seq, await setEnabled(sessionId, forwardId, enabled))
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        setBusyId(null)
      }
    },
    [apply, sessionId, setEnabled]
  )

  // Nothing to steer and nothing to report: no rail, no button, no poll.
  if (!isSsh || (forwards.length === 0 && !error)) return null

  return (
    <>
      {!open ? (
        <Button
          size="icon"
          variant="ghost"
          className={cn(
            "absolute right-2 top-11 z-10 h-7 w-7 opacity-60 hover:opacity-100",
            className
          )}
          onClick={() => setOpen(true)}
          aria-label={t("open")}
          data-testid="terminal-forward-open"
        >
          <NetworkIcon className="h-3 w-3" />
        </Button>
      ) : null}
      <MotionPopover
        open={open}
        className={cn("absolute right-0 top-0 z-10 h-full", className)}
        from={{ opacity: 0, x: "100%" }}
      >
        <aside
          role="complementary"
          data-testid="terminal-forward-panel"
          className={cn(
            "flex h-full flex-col border-l bg-background/95 backdrop-blur",
            TERMINAL_LAYOUT.historyRailWidth
          )}
        >
          <div className="flex items-center justify-between border-b px-2 py-1.5">
            <span className="text-xs font-medium">{t("title")}</span>
            <Button
              size="icon"
              variant="ghost"
              className="h-6 w-6"
              onClick={() => setOpen(false)}
              aria-label={t("close")}
              data-testid="terminal-forward-close"
            >
              <span className="text-xs">×</span>
            </Button>
          </div>
          <ScrollArea className="flex-1">
            {error ? (
              <p
                className="px-3 py-4 text-[11px] text-red-500"
                data-testid="terminal-forward-error"
              >
                {error}
              </p>
            ) : null}
            <ul className="divide-y">
              {forwards.map((rule) => (
                <li
                  key={rule.id}
                  className="space-y-1 px-2.5 py-2"
                  data-testid={`terminal-forward-${rule.id}`}
                  data-state={rule.state}
                >
                  <div className="flex items-center gap-1.5">
                    <span
                      className={cn("h-1.5 w-1.5 shrink-0 rounded-full", STATE_DOT[rule.state])}
                      aria-label={t(`state.${rule.state}`)}
                    />
                    <span className="truncate font-mono text-[11px]" title={rule.summary}>
                      {rule.summary}
                    </span>
                    <Switch
                      className="ml-auto scale-75"
                      checked={rule.enabled}
                      disabled={busyId === rule.id}
                      onCheckedChange={(next) => void toggle(rule.id, next)}
                      aria-label={t(`toggle.${rule.direction}`, { summary: rule.summary })}
                      data-testid={`terminal-forward-toggle-${rule.id}`}
                    />
                  </div>
                  <p className="text-[10px] text-muted-foreground">
                    {t(`direction.${rule.direction}`)} · {t(`state.${rule.state}`)}
                    {rule.activeConnections > 0
                      ? ` · ${t("active", { count: rule.activeConnections })}`
                      : ""}
                    {rule.queuedConnections > 0
                      ? ` · ${t("queued", { count: rule.queuedConnections })}`
                      : ""}
                  </p>
                  {rule.error ? (
                    <p
                      className="text-[10px] text-red-500"
                      data-testid={`terminal-forward-reason-${rule.id}`}
                    >
                      {rule.error}
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          </ScrollArea>
        </aside>
      </MotionPopover>
    </>
  )
}

export default TerminalForwardPanel
