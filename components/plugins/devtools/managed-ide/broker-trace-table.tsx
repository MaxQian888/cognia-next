"use client"

/**
 * The Managed IDE Dev Mode broker trace as a filterable table.
 *
 * Payloads are shown as recorded: a shape by default, or values when the
 * session opted in, which go through `@cognia/redact` first so an email
 * address or a key in a file the plugin read is never put on screen as is.
 */

import { Fragment, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { redactText } from "@cognia/redact"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import type { BrokerTraceRow } from "@/hooks/plugins/use-broker-trace"

export interface BrokerTraceTableProps {
  rows: BrokerTraceRow[]
  /** Values were kept (and must be redacted for display). */
  includePayloads: boolean
  error: string | null
}

/** A payload as displayed: shapes as they are, values redacted. */
export function displayPayload(payload: unknown, includePayloads: boolean): string | null {
  if (payload === null || payload === undefined) return null
  const text = JSON.stringify(payload, null, 2)
  return includePayloads ? redactText(text).redacted : text
}

function time(atMs: number): string {
  const date = new Date(atMs)
  const pad = (value: number, width = 2) => String(value).padStart(width, "0")
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`
}

export function BrokerTraceTable({ rows, includePayloads, error }: BrokerTraceTableProps) {
  const t = useTranslations("plugins.devtools.managedIde.trace")
  const [filter, setFilter] = useState("")
  const [open, setOpen] = useState<number | null>(null)

  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase()
    const matching = needle
      ? rows.filter(
          (row) =>
            row.method?.toLowerCase().includes(needle) ||
            row.pluginId?.toLowerCase().includes(needle)
        )
      : rows
    // Newest first: the frame you just caused is the one you are looking for.
    return [...matching].reverse()
  }, [rows, filter])

  return (
    <div className="space-y-2" data-testid="managed-ide-trace">
      <Input
        value={filter}
        onChange={(event) => setFilter(event.target.value)}
        placeholder={t("filterPlaceholder")}
        aria-label={t("filterLabel")}
        className="h-8 text-xs"
      />
      {error && (
        <p className="text-xs text-destructive" data-testid="managed-ide-trace-error">
          {t("loadFailed", { message: error })}
        </p>
      )}
      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground" data-testid="managed-ide-trace-empty">
          {t("empty")}
        </p>
      ) : visible.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t("noMatch")}</p>
      ) : (
        <div className="max-h-[420px] overflow-auto rounded-md border">
          <Table className="text-xs">
            <TableHeader>
              <TableRow>
                <TableHead>{t("columns.time")}</TableHead>
                <TableHead>{t("columns.direction")}</TableHead>
                <TableHead>{t("columns.kind")}</TableHead>
                <TableHead>{t("columns.method")}</TableHead>
                <TableHead>{t("columns.plugin")}</TableHead>
                <TableHead className="text-right">{t("columns.duration")}</TableHead>
                <TableHead className="text-right">{t("columns.size")}</TableHead>
                <TableHead>{t("columns.error")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map((row) => {
                const payload =
                  open === row.seq ? displayPayload(row.payload, includePayloads) : null
                return (
                  <Fragment key={row.seq}>
                    <TableRow data-testid={`managed-ide-trace-row-${row.seq}`}>
                      <TableCell className="font-mono tabular-nums">{time(row.atMs)}</TableCell>
                      <TableCell>{t(`direction.${row.direction}`)}</TableCell>
                      <TableCell>{t(`kind.${row.kind}`)}</TableCell>
                      <TableCell className="font-mono">
                        <Button
                          variant="link"
                          size="sm"
                          className="h-auto p-0 font-mono text-xs"
                          aria-expanded={open === row.seq}
                          onClick={() => setOpen(open === row.seq ? null : row.seq)}
                        >
                          {row.method ?? row.id ?? "—"}
                        </Button>
                      </TableCell>
                      <TableCell>
                        <span className="flex items-center gap-1.5">
                          {row.pluginId ?? "—"}
                          {row.simulated && (
                            <Badge
                              variant="outline"
                              className="text-[10px]"
                              data-testid={`managed-ide-trace-simulated-${row.seq}`}
                            >
                              {t("simulated")}
                            </Badge>
                          )}
                        </span>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {row.durationMs === null ? "—" : t("durationMs", { value: row.durationMs })}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {t("bytes", { value: row.bytes })}
                      </TableCell>
                      <TableCell className="tabular-nums">{row.errorCode ?? ""}</TableCell>
                    </TableRow>
                    {open === row.seq && (
                      <TableRow>
                        <TableCell colSpan={8}>
                          <span className="sr-only">{t("payload")}</span>
                          {payload === null ? (
                            <span className="text-muted-foreground">{t("noPayload")}</span>
                          ) : (
                            <pre
                              className="max-h-64 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px]"
                              data-testid={`managed-ide-trace-payload-${row.seq}`}
                            >
                              {payload}
                            </pre>
                          )}
                        </TableCell>
                      </TableRow>
                    )}
                  </Fragment>
                )
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  )
}
