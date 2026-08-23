"use client"

import { useCallback, useEffect, useState } from "react"
import {
  ArchiveIcon,
  BoxesIcon,
  PinIcon,
  PinOffIcon,
  RefreshCwIcon,
  RotateCcwIcon,
  ShieldCheckIcon,
  Trash2Icon,
} from "lucide-react"
import { useTranslations } from "next-intl"

import { Badge } from "@/components/ui/badge"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
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
import {
  archiveManagedWorkspace,
  deleteManagedWorkspace,
  listManagedWorkspaces,
  makeManagedWorkspacePermanent,
  pinManagedWorkspace,
  restoreManagedWorkspace,
} from "@/lib/task-workspace/client"
import type { ManagedWorkspaceRecord } from "@/lib/task-workspace/types"

export function WorkspaceEnvironmentList() {
  const t = useTranslations("workspace.environments")
  const [rows, setRows] = useState<ManagedWorkspaceRecord[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pendingId, setPendingId] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<ManagedWorkspaceRecord | null>(null)

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

  const updateEnvironment = async (
    row: ManagedWorkspaceRecord,
    operation: (workspaceId: string) => Promise<ManagedWorkspaceRecord>
  ) => {
    setPendingId(row.workspaceId)
    setError(null)
    try {
      const updated = await operation(row.workspaceId)
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

  const confirmDelete = async () => {
    if (!deleteTarget) return
    const workspaceId = deleteTarget.workspaceId
    setPendingId(workspaceId)
    setError(null)
    try {
      await deleteManagedWorkspace(workspaceId)
      setRows((current) => current?.filter((item) => item.workspaceId !== workspaceId) ?? [])
      setDeleteTarget(null)
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
                <TableCell>
                  <div className="flex justify-end gap-1">
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
                    {row.environmentKind === "managed" && row.state === "active" ? (
                      <>
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          disabled={pendingId === row.workspaceId}
                          onClick={() => void updateEnvironment(row, makeManagedWorkspacePermanent)}
                          aria-label={t("makePermanent")}
                        >
                          <ShieldCheckIcon aria-hidden className="size-4" />
                        </Button>
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          disabled={pendingId === row.workspaceId}
                          onClick={() => void updateEnvironment(row, archiveManagedWorkspace)}
                          aria-label={t("archive")}
                        >
                          <ArchiveIcon aria-hidden className="size-4" />
                        </Button>
                      </>
                    ) : null}
                    {row.environmentKind === "managed" &&
                    (row.state === "archived" || row.state === "restorable") ? (
                      <>
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          disabled={pendingId === row.workspaceId}
                          onClick={() => void updateEnvironment(row, restoreManagedWorkspace)}
                          aria-label={t("restore")}
                        >
                          <RotateCcwIcon aria-hidden className="size-4" />
                        </Button>
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          disabled={pendingId === row.workspaceId}
                          onClick={() => setDeleteTarget(row)}
                          aria-label={t("delete")}
                        >
                          <Trash2Icon aria-hidden className="size-4" />
                        </Button>
                      </>
                    ) : null}
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("deleteTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("deleteDescription", { path: deleteTarget?.executionRoot ?? "" })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => void confirmDelete()}
              disabled={pendingId === deleteTarget?.workspaceId}
            >
              {t("confirmDelete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
}
