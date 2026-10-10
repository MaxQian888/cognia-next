"use client"

/**
 * The live-share audit trail (ADR-0222 §7.5): every sign-in, read, change
 * and refusal the host recorded, newest first, a page at a time. Scoped to
 * one grant, one conversation, or (Settings) the whole host.
 */

import { useEffect, useState } from "react"
import { useFormatter, useTranslations } from "next-intl"
import { Loader2Icon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  fileShareErrorDetails,
  listFileShareAuditPage,
  type FileShareErrorCode,
  type FileShareTarget,
} from "@/lib/filespace/grants-client"
import type { Transport } from "@/lib/tauri/transport-types"
import type { FileShareAuditRow } from "@/types/filespace/live"

const PAGE_SIZE = 50
const CHANNELS = ["app", "webdav", "sftp", "sftpgo"] as const
const OUTCOMES = ["allowed", "denied", "failed"] as const

export interface LiveShareAuditProps {
  sessionId?: string
  grantId?: string
  hostId?: string
  /** Must be stable across renders. */
  transport?: Transport
}

type Failure = { code: FileShareErrorCode | "unknown"; message: string }

type Load =
  | { state: "loading"; rows: FileShareAuditRow[] }
  | { state: "ready"; rows: FileShareAuditRow[]; next?: string }
  | { state: "failed"; rows: FileShareAuditRow[]; failure: Failure; retry?: string }

interface AuditQuery {
  sessionId?: string
  grantId?: string
  hostId?: string
  transport?: Transport
}

/** One more page appended to `rows`, or the failure with what to retry. */
function fetchPage(
  { sessionId, grantId, hostId, transport }: AuditQuery,
  pageToken: string | undefined,
  rows: FileShareAuditRow[]
): Promise<Load> {
  const target: FileShareTarget = transport ? { transport } : { hostId }
  return listFileShareAuditPage(
    {
      ...(sessionId ? { sessionId } : {}),
      ...(grantId ? { grantId } : {}),
      pageSize: PAGE_SIZE,
      ...(pageToken ? { pageToken } : {}),
    },
    target
  ).then(
    (page): Load => ({ state: "ready", rows: [...rows, ...page.items], next: page.nextPageToken }),
    (error: unknown): Load => ({
      state: "failed",
      rows,
      failure: fileShareErrorDetails(error),
      retry: pageToken,
    })
  )
}

export function LiveShareAudit({ sessionId, grantId, hostId, transport }: LiveShareAuditProps) {
  const t = useTranslations("liveShare")
  const format = useFormatter()
  const scope = `${sessionId ?? ""}|${grantId ?? ""}|${transport ? "transport" : (hostId ?? "")}`
  const [load, setLoad] = useState<{ scope: string; value: Load } | null>(null)
  const current: Load = load?.scope === scope ? load.value : { state: "loading", rows: [] }

  useEffect(() => {
    let cancelled = false
    void fetchPage({ sessionId, grantId, hostId, transport }, undefined, []).then((value) => {
      if (!cancelled) setLoad({ scope, value })
    })
    return () => {
      cancelled = true
    }
  }, [scope, sessionId, grantId, hostId, transport])

  const fetchMore = (pageToken: string | undefined) => {
    const rows = current.rows
    setLoad({ scope, value: { state: "loading", rows } })
    void fetchPage({ sessionId, grantId, hostId, transport }, pageToken, rows).then((value) =>
      setLoad({ scope, value })
    )
  }

  const principal = (value: string) => {
    if (value === "owner") return t("audit.principal.owner")
    if (value === "system") return t("audit.principal.system")
    if (value.startsWith("device:")) return t("audit.principal.device", { id: value.slice(7) })
    if (value.startsWith("credential:")) {
      return t("audit.principal.credential", { username: value.slice(11) })
    }
    return value
  }

  return (
    <div className="space-y-2" data-testid="live-share-audit">
      {current.rows.length === 0 && current.state === "ready" ? (
        <p className="text-sm text-muted-foreground">{t("audit.empty")}</p>
      ) : current.rows.length > 0 ? (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("audit.at")}</TableHead>
              <TableHead>{t("audit.who")}</TableHead>
              <TableHead>{t("audit.via")}</TableHead>
              <TableHead>{t("audit.action")}</TableHead>
              <TableHead>{t("audit.path")}</TableHead>
              <TableHead>{t("audit.result")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {current.rows.map((row) => (
              <TableRow key={row.id} data-testid={`live-audit-${row.id}`}>
                <TableCell className="whitespace-nowrap text-xs">
                  {format.dateTime(new Date(row.at), { dateStyle: "short", timeStyle: "medium" })}
                </TableCell>
                <TableCell className="text-xs" title={row.remote ?? undefined}>
                  {principal(row.principal)}
                </TableCell>
                <TableCell className="text-xs">
                  {(CHANNELS as readonly string[]).includes(row.channel)
                    ? t(`audit.channel.${row.channel}`)
                    : row.channel}
                </TableCell>
                <TableCell className="font-mono text-xs">{row.action}</TableCell>
                <TableCell
                  className="max-w-48 truncate font-mono text-xs"
                  title={row.path ?? undefined}
                >
                  {row.path ?? ""}
                </TableCell>
                <TableCell className="text-xs">
                  <Badge
                    variant={row.outcome === "allowed" ? "secondary" : "destructive"}
                    title={row.reason ?? undefined}
                  >
                    {(OUTCOMES as readonly string[]).includes(row.outcome)
                      ? t(`audit.outcome.${row.outcome}`)
                      : row.outcome}
                  </Badge>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : null}
      {current.state === "failed" ? (
        <div className="flex items-center gap-2">
          <p role="alert" className="text-sm text-destructive">
            {current.failure.code === "unknown"
              ? t("audit.loadFailed")
              : t(`errors.${current.failure.code}`, { message: current.failure.message })}
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => fetchMore(current.retry)}
          >
            {t("audit.retry")}
          </Button>
        </div>
      ) : null}
      {current.state === "loading" ? (
        <p className="flex items-center gap-1 text-xs text-muted-foreground" role="status">
          <Loader2Icon className="size-3 animate-spin" aria-hidden />
          {t("audit.loading")}
        </p>
      ) : current.state === "ready" && current.next ? (
        <Button type="button" variant="outline" size="sm" onClick={() => fetchMore(current.next)}>
          {t("audit.loadMore")}
        </Button>
      ) : null}
    </div>
  )
}
