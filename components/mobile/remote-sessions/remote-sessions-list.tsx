"use client"

/**
 * Remote Session Control: mobile session picker.
 *
 * Lists the host's chat sessions so the operator can open one for live
 * viewing and control. Tapping a row calls `onSelect` with its id and the
 * parent route swaps in `<RemoteSessionDetail>`.
 *
 * Reads the synced `sessions` table through `useDexieFirstQuery` rather than
 * calling `session_list` over RPC. `sessions` is a critical-stage synced table
 * (`lib/sync/companion-sync.ts`), so the rows are already on the device and
 * the list paints offline, after a cold deep link, and while the Host is
 * reconnecting. The old RPC-in-an-effect version was the exact pattern the
 * hook replaced, and off the network it showed nothing but an error string.
 * A failed background pull is reported as a line under the list instead of
 * replacing it.
 */

import { useTranslations } from "next-intl"

import { Surface } from "@/components/surface/surface"
import { useDexieFirstQuery } from "@/hooks/data/use-dexie-first-query"
import { getDb } from "@/lib/db/schema"
import type { ChatSession } from "@cognia/agent-config-types"

export interface RemoteSessionsListProps {
  onSelect: (sessionId: string) => void
}

/** Newest sessions first, one screen's worth. */
export const REMOTE_SESSIONS_LIST_LIMIT = 50

export function RemoteSessionsList({ onSelect }: RemoteSessionsListProps) {
  const t = useTranslations("mobile.remoteSessions.list")
  const query = useDexieFirstQuery<ChatSession[] | null>({
    query: () =>
      getDb().sessions.orderBy("updatedAt").reverse().limit(REMOTE_SESSIONS_LIST_LIMIT).toArray(),
    deps: [],
    initial: null,
    table: "sessions",
  })
  const sessions = query.data

  if (sessions === null || sessions === undefined) {
    return (
      <p className="p-4 text-xs text-muted-foreground" data-testid="remote-sessions-loading">
        {t("loading")}
      </p>
    )
  }

  if (sessions.length === 0) {
    return (
      <div className="space-y-2">
        <p className="p-4 text-xs text-muted-foreground" data-testid="remote-sessions-empty">
          {t("empty")}
        </p>
        {query.error ? (
          <p className="px-4 text-xs text-destructive" data-testid="remote-sessions-error">
            {t("error", { reason: query.error })}
          </p>
        ) : null}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-2 p-3" data-testid="remote-sessions-list">
      {/* One surface with hairline rows. A card per session turned a list of
          one-line titles into a stack of framed boxes, each 8px apart. */}
      <Surface layer="raised" radius="panel" className="overflow-hidden border">
        {sessions.map((s) => (
          <div
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
            className="cursor-pointer px-3 py-2.5 transition-colors not-last:border-b hover:bg-accent/40"
          >
            <p className="truncate text-sm">{s.title ?? t("untitled")}</p>
          </div>
        ))}
      </Surface>
      {query.error ? (
        <p className="text-xs text-destructive" data-testid="remote-sessions-error">
          {t("error", { reason: query.error })}
        </p>
      ) : null}
    </div>
  )
}
