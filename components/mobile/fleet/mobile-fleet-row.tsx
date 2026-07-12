"use client"

/**
 * Mobile-tailored fleet row — a theme-aware shadcn `Card` (NOT the dark-overlay
 * `island-row`, which is styled for the frameless island). Reuses the pure
 * `lib/fleet/format` helpers and the shared `useNowTicker`. Reveal-transcript is
 * omitted (no OS file manager on a phone); a parked permission can be answered,
 * an OpenCode session replied to, and the terminal focused (best-effort — the
 * command runs on the desktop) — all over the companion transport.
 */

import { useTranslations } from "next-intl"
import { TerminalIcon } from "lucide-react"
import { toast } from "sonner"

import { Card, CardContent } from "@/components/ui/card"
import { MobileFleetPermissionActions } from "./mobile-fleet-permission-actions"
import { MobileFleetReply } from "./mobile-fleet-reply"
import { useNowTicker } from "@/hooks/fleet/use-now-ticker"
import { fleetRemoteFocusTerminal } from "@/lib/fleet/fleet-remote-actions"
import { activityLine, formatElapsed, formatModelLabel, truncateLine } from "@/lib/fleet/format"
import type { FleetSession, FleetStatus } from "@/lib/fleet/types"
import { cn } from "@/lib/utils"

const STATUS_DOT: Record<FleetStatus, string> = {
  working: "bg-emerald-500",
  "waiting-permission": "bg-red-500",
  "plan-pending": "bg-sky-500",
  "waiting-input": "bg-amber-500",
  idle: "bg-muted-foreground/40",
  ended: "bg-muted-foreground/25",
}

export function MobileFleetRow({ session }: { session: FleetSession }) {
  const t = useTranslations("mobile.fleet.row")
  const nowMs = useNowTicker()
  const model = formatModelLabel(session.model)
  const activity = activityLine(session)
  const lastError = session.lastError ?? null
  const elapsedRef = session.status === "ended" ? (session.endedAt ?? nowMs) : nowMs

  const statusLabel = (() => {
    switch (session.status) {
      case "waiting-permission":
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
    <Card
      data-testid={`mobile-fleet-row-${session.agent}-${session.sessionId}`}
      data-status={session.status}
    >
      <CardContent className="space-y-1.5 px-3 py-2.5">
        <div className="flex items-center gap-2">
          <span
            aria-hidden
            data-testid="mobile-fleet-dot"
            className={cn("size-2 shrink-0 rounded-full", STATUS_DOT[session.status])}
          />
          <span className="min-w-0 flex-1 truncate text-sm font-medium">
            {session.projectName ?? session.sessionId}
          </span>
          {model ? (
            <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
              {model}
            </span>
          ) : null}
          <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
            {formatElapsed(session.startedAt, elapsedRef)}
          </span>
          {session.capabilities.focusTerminal ? (
            <button
              type="button"
              data-testid="mobile-fleet-focus"
              aria-label={t("focus")}
              onClick={() => {
                void fleetRemoteFocusTerminal(session.agent, session.sessionId).catch(() =>
                  toast.error(t("focusFailed"))
                )
              }}
              className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <TerminalIcon className="size-3.5" aria-hidden />
            </button>
          ) : null}
        </div>

        {session.lastPrompt ? (
          <p className="truncate text-xs text-muted-foreground" data-testid="mobile-fleet-prompt">
            {t("you")} {truncateLine(session.lastPrompt, 120)}
          </p>
        ) : null}

        {lastError ? (
          <p className="text-xs text-red-600 dark:text-red-400" data-testid="mobile-fleet-error">
            {t(`error.${lastError.kind}`)}
            {lastError.detail ? ` · ${truncateLine(lastError.detail, 100)}` : ""}
          </p>
        ) : null}

        {session.pendingPermission ? (
          <MobileFleetPermissionActions pending={session.pendingPermission} />
        ) : statusLabel ? (
          <p className="truncate text-xs text-muted-foreground" data-testid="mobile-fleet-status">
            {statusLabel}
          </p>
        ) : null}

        {session.capabilities.sendMessage && session.status !== "ended" ? (
          <MobileFleetReply sessionId={session.sessionId} />
        ) : null}
      </CardContent>
    </Card>
  )
}

export default MobileFleetRow
