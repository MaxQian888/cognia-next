"use client"

/**
 * Remote Session Control — mobile session picker.
 *
 * Lists the host's chat sessions (via the `session_list` RPC through
 * `lib/claude/ipc.ts:listSessions`) so the operator can open one for live
 * viewing + control. Tapping a row calls `onSelect` with its id; the parent
 * route swaps in `<RemoteSessionDetail>`.
 */

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"

import { Card, CardContent } from "@/components/ui/card"
import { listSessions } from "@/lib/claude/ipc"
import { hydrateCompanionConfig } from "@/lib/tauri/transport-companion"
import type { ChatSession } from "@cognia/agent-config-types"

export interface RemoteSessionsListProps {
  onSelect: (sessionId: string) => void
}

export function RemoteSessionsList({ onSelect }: RemoteSessionsListProps) {
  const t = useTranslations("mobile.remoteSessions.list")
  const [sessions, setSessions] = useState<ChatSession[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        // The mobile boot provider hydrates the transport cache asynchronously
        // while route children are already mounted. Await the same idempotent
        // boundary here so a cold deep link cannot issue session_list against
        // an empty cache and get stuck in a false "not paired" error state.
        await hydrateCompanionConfig()
        const page = await listSessions({ limit: 50, offset: 0 })
        if (!cancelled) setSessions(page.rows)
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  if (error) {
    return (
      <p className="p-4 text-xs text-destructive" data-testid="remote-sessions-error">
        {t("error", { reason: error })}
      </p>
    )
  }

  if (sessions === null) {
    return (
      <p className="p-4 text-xs text-muted-foreground" data-testid="remote-sessions-loading">
        {t("loading")}
      </p>
    )
  }

  if (sessions.length === 0) {
    return (
      <p className="p-4 text-xs text-muted-foreground" data-testid="remote-sessions-empty">
        {t("empty")}
      </p>
    )
  }

  return (
    <div className="space-y-2 p-3" data-testid="remote-sessions-list">
      {sessions.map((s) => (
        <Card
          key={s.id}
          role="button"
          tabIndex={0}
          onClick={() => onSelect(s.id)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault()
              onSelect(s.id)
            }
          }}
          aria-label={t("openAria", { title: s.title ?? t("untitled") })}
          data-testid={`remote-session-row-${s.id}`}
          className="cursor-pointer transition-colors hover:bg-accent/40"
        >
          <CardContent className="px-3 py-2">
            <p className="truncate text-sm">{s.title ?? t("untitled")}</p>
          </CardContent>
        </Card>
      ))}
    </div>
  )
}
