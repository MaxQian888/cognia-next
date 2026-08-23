"use client"

import { useCallback, useEffect, useState } from "react"
import { BoxesIcon, PinIcon, PinOffIcon, RefreshCwIcon } from "lucide-react"
import { useTranslations } from "next-intl"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { listManagedWorkspaces, pinManagedWorkspace } from "@/lib/task-workspace/client"
import type { ManagedWorkspaceRecord } from "@/lib/task-workspace/types"

export function WorkspaceEnvironmentList() {
  const t = useTranslations("workspace.environments")
  const [rows, setRows] = useState<ManagedWorkspaceRecord[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pendingId, setPendingId] = useState<string | null>(null)

  const load = useCallback(async () => {
    setError(null)
    try {
      setRows(await listManagedWorkspaces())
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      setRows([])
    }
  }, [])

  useEffect(() => {
    let cancelled = false

    void listManagedWorkspaces().then(
      (workspaces) => {
        if (!cancelled) setRows(workspaces)
      },
      (cause: unknown) => {
        if (cancelled) return
        setError(cause instanceof Error ? cause.message : String(cause))
        setRows([])
      }
    )

    return () => {
      cancelled = true
    }
  }, [])

  const togglePin = async (row: ManagedWorkspaceRecord) => {
    setPendingId(row.workspaceId)
    setError(null)
    try {
      const updated = await pinManagedWorkspace(row.workspaceId, !row.pinned)
      setRows(
        (current) =>
          current?.map((item) => (item.workspaceId === row.workspaceId ? updated : item)) ?? []
      )
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setPendingId(null)
    }
  }

  return (
    <section className="flex flex-col gap-2" data-testid="workspace-environments">
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t("title")}
          </h2>
          <p className="text-xs text-muted-foreground">{t("description")}</p>
        </div>
        <Button
          size="icon-sm"
          variant="ghost"
          onClick={() => void load()}
          aria-label={t("refresh")}
        >
          <RefreshCwIcon aria-hidden className="size-4" />
        </Button>
      </div>

      {error ? (
        <p className="text-sm text-destructive" role="alert">
          {t("loadError", { error })}
        </p>
      ) : null}

      {rows === null ? (
        <div className="flex flex-col gap-2" aria-label={t("loading")}>
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : rows.length === 0 ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <BoxesIcon aria-hidden />
            </EmptyMedia>
            <EmptyTitle>{t("emptyTitle")}</EmptyTitle>
            <EmptyDescription>{t("emptyDescription")}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("path")}</TableHead>
              <TableHead>{t("kind")}</TableHead>
              <TableHead>{t("state")}</TableHead>
              <TableHead>{t("base")}</TableHead>
              <TableHead className="text-right">{t("actions")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow
                key={row.workspaceId}
                data-testid={`workspace-environment-${row.workspaceId}`}
              >
                <TableCell
                  className="max-w-80 truncate font-mono text-xs"
                  title={row.executionRoot}
                >
                  {row.executionRoot}
                </TableCell>
                <TableCell>
                  <Badge variant={row.environmentKind === "managed" ? "secondary" : "outline"}>
                    {t(`kinds.${row.environmentKind}`)}
                  </Badge>
                </TableCell>
                <TableCell>{t(`states.${row.state}`)}</TableCell>
                <TableCell className="font-mono text-xs">{t(`bases.${row.base.kind}`)}</TableCell>
                <TableCell className="text-right">
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    disabled={pendingId === row.workspaceId || row.environmentKind === "imported"}
                    onClick={() => void togglePin(row)}
                    aria-label={row.pinned ? t("unpin") : t("pin")}
                  >
                    {row.pinned ? (
                      <PinOffIcon aria-hidden className="size-4" />
                    ) : (
                      <PinIcon aria-hidden className="size-4" />
                    )}
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </section>
  )
}
