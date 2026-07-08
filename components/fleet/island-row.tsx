"use client"

/**
 * IslandRow — one monitored session in the expanded island, mirroring the
 * reference layout: agent badge + project name on the lead line with the
 * terminal source and elapsed time on the right; the last user prompt and the
 * current activity (or waiting state) underneath. A pending permission swaps
 * the activity line for Approve/Deny controls.
 */

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { AgentBadge } from "./agent-badge"
import { TerminalBadge } from "./terminal-badge"
import { IslandPermissionActions } from "./island-permission-actions"
import { IslandReply } from "./island-reply"
import { activityLine, formatElapsed, truncateLine } from "@/lib/fleet/format"
import { fleetFocusTerminal } from "@/lib/tauri/fleet"
import type { FleetSession, FleetStatus } from "@/lib/fleet/types"
import { cn } from "@/lib/utils"

const STATUS_DOT: Record<FleetStatus, string> = {
  working: "bg-emerald-400 animate-pulse",
  "waiting-permission": "bg-red-400 animate-pulse",
  "plan-pending": "bg-sky-400 animate-pulse",
  "waiting-input": "bg-amber-400",
  idle: "bg-white/30",
  ended: "bg-white/15",
}

export function IslandRow({ session }: { session: FleetSession }) {
  const t = useTranslations("fleet.row")
  const [nowMs, setNowMs] = useState(() => Date.now())

  // Tick the elapsed label once a second — cheap, and only while expanded
  // (collapsed islands don't mount rows).
  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])

  const activity = activityLine(session)

  const canFocus = session.capabilities.focusTerminal
  const focusTerminal = () => {
    if (canFocus) void fleetFocusTerminal(session.agent, session.sessionId)
  }

  // OpenCode sessions can receive an injected prompt (see fleet/opencode.rs).
  const canReply = session.capabilities.sendMessage && session.status !== "ended"

  const statusLine = (() => {
    switch (session.status) {
      case "waiting-permission":
        // Rendered by IslandPermissionActions below (or a plain hint when the
        // request isn't approvable from here).
        return session.pendingPermission ? null : t("status.waitingPermission")
      case "plan-pending":
        return t("status.planPending")
      case "waiting-input":
        return t("status.waitingInput")
      case "ended":
        return t("status.ended")
      case "idle":
        return activity ?? t("status.idle")
      case "working":
        return activity ?? t("status.working")
    }
  })()

  return (
    <div
      data-testid={`island-row-${session.agent}-${session.sessionId}`}
      data-status={session.status}
      className={cn(
        "flex flex-col gap-0.5 rounded-xl px-3 py-2 hover:bg-white/5",
        canFocus && "cursor-pointer"
      )}
      onClick={canFocus ? focusTerminal : undefined}
      role={canFocus ? "button" : undefined}
      tabIndex={canFocus ? 0 : undefined}
      aria-label={canFocus ? t("focusTerminal") : undefined}
      onKeyDown={
        canFocus
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault()
                focusTerminal()
              }
            }
          : undefined
      }
    >
      <div className="flex items-center gap-2">
        <span
          aria-hidden
          data-testid="status-dot"
          className={cn("size-1.5 shrink-0 rounded-full", STATUS_DOT[session.status])}
        />
        <AgentBadge agent={session.agent} />
        <span className="min-w-0 flex-1 truncate text-xs font-semibold text-white/90">
          {session.projectName ?? session.sessionId}
        </span>
        {session.terminal ? <TerminalBadge terminal={session.terminal} /> : null}
        <span className="shrink-0 text-[10px] tabular-nums text-white/50" data-testid="elapsed">
          {formatElapsed(session.startedAt, nowMs)}
        </span>
        {canReply ? <IslandReply sessionId={session.sessionId} /> : null}
      </div>

      {session.lastPrompt ? (
        <p className="truncate pl-3.5 text-[11px] text-white/60" data-testid="last-prompt">
          {t("you")} {truncateLine(session.lastPrompt, 140)}
        </p>
      ) : null}

      {session.pendingPermission ? (
        // Stop clicks on the Approve/Deny controls from also focusing the
        // terminal (the row is a focus-terminal button when capable).
        <div
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
          role="presentation"
        >
          <IslandPermissionActions pending={session.pendingPermission} className="pl-3.5" />
        </div>
      ) : statusLine ? (
        <p className="truncate pl-3.5 text-[11px] text-white/45" data-testid="status-line">
          {statusLine}
        </p>
      ) : null}
    </div>
  )
}

export default IslandRow
