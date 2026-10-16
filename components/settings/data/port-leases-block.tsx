"use client"

import { useState } from "react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
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
import { PortLeaseBadge } from "@/components/workspace/port-lease-badge"
import { usePortLeaseList } from "@/hooks/task-workspace/use-port-lease-list"
import { useWorkspaceActionController } from "@/hooks/use-workspace-action-controller"
import { releaseSubjectPortLeases, releaseWorkspacePortLease } from "@/lib/task-workspace/client"
import { runWorkspaceUserAction } from "@/lib/task-workspace/user-action"
import type { PortLeaseSubject, WorkspacePortLease } from "@/lib/task-workspace/types"

interface ReleaseSelection {
  lease: WorkspacePortLease
  subject: PortLeaseSubject
}

export function PortLeasesBlock() {
  const t = useTranslations("settings.data.portLeases")
  const tPortLease = useTranslations("portLease")
  const inventory = usePortLeaseList()
  const action = useWorkspaceActionController()
  const [selection, setSelection] = useState<ReleaseSelection | null>(null)

  const subjectLabel = (subject: PortLeaseSubject) =>
    t(
      subject.kind === "project-root" && subject.key.startsWith("root:")
        ? "subjects.checkoutRoot"
        : `subjects.${subject.kind}`,
      {
        key:
          subject.kind === "project-root" && subject.key.startsWith("root:")
            ? subject.key.slice(5)
            : subject.key,
      }
    )

  const release = async () => {
    if (!selection || action.busy) return
    const { lease, subject } = selection
    const { kind, key } = subject
    const released = await action.run(lease.leaseId, async () => {
      if (kind === "registry") {
        await runWorkspaceUserAction("task_workspace_port_lease_release", () =>
          releaseWorkspacePortLease(key, lease.namespaceKey)
        )
      } else {
        await runWorkspaceUserAction("task_workspace_port_lease_subject_release", () =>
          releaseSubjectPortLeases({
            kind,
            key,
            namespace: lease.namespaceKey,
            leaseId: lease.leaseId,
          })
        )
      }
      return true
    })
    if (released) setSelection(null)
    await inventory.refresh()
  }

  return (
    <Card className="space-y-3 p-4">
      <h3 className="text-sm font-medium">{t("title")}</h3>
      <p className="text-xs text-muted-foreground">{t("description")}</p>
      {inventory.status === "inert" ? (
        <p role="status" className="text-xs text-muted-foreground">
          {t("needsHost")}
        </p>
      ) : (
        <>
          <Button
            variant="outline"
            size="sm"
            disabled={inventory.status === "loading" || action.busy}
            onClick={() => void inventory.refresh()}
          >
            {t("refresh")}
          </Button>
          {inventory.status === "loading" ? <p role="status">{t("loading")}</p> : null}
          {inventory.error ? (
            <p role="alert" className="text-xs text-destructive">
              {inventory.error}
            </p>
          ) : null}
          {inventory.status === "ready" && inventory.data?.leases.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t("empty")}</p>
          ) : null}
          <p className="text-xs text-muted-foreground">{t("occupancyNotice")}</p>
          <ul className="space-y-3" aria-label={t("listLabel")}>
            {inventory.data?.leases.map(({ lease, subjects, occupiedPorts, occupancyError }) => {
              const diagnostics = inventory.data!.diagnostics.filter((item) =>
                item.leaseIds.includes(lease.leaseId)
              )
              const missingRoot = diagnostics.some((item) => item.kind === "missingRoot")
              return (
                <li key={lease.leaseId} className="space-y-2 rounded-md border p-3">
                  <PortLeaseBadge
                    lease={lease}
                    occupiedPorts={occupiedPorts}
                    occupancyError={occupancyError}
                    diagnostics={diagnostics}
                  />
                  <p className="break-all text-xs">{t("root", { path: lease.canonicalRoot })}</p>
                  <ul className="space-y-1">
                    {subjects.map((subject) => {
                      const canRelease = subject.kind === "registry" || missingRoot
                      return (
                        <li
                          key={`${subject.kind}:${subject.key}`}
                          className="flex flex-wrap items-center justify-between gap-2"
                        >
                          <span className="break-all text-xs">{subjectLabel(subject)}</span>
                          {canRelease ? (
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={action.busy || inventory.status !== "ready"}
                              aria-label={t("releaseSubject", { subject: subjectLabel(subject) })}
                              onClick={() => {
                                action.clearError()
                                setSelection({ lease, subject })
                              }}
                            >
                              {t("release")}
                            </Button>
                          ) : null}
                        </li>
                      )
                    })}
                  </ul>
                </li>
              )
            })}
          </ul>
          {inventory.data && inventory.data.diagnostics.length > 0 ? (
            <div className="space-y-1">
              <h4 className="text-xs font-medium">{t("diagnosticsTitle")}</h4>
              <ul className="space-y-1 text-xs">
                {inventory.data.diagnostics.map((diagnostic, index) => (
                  <li key={`${diagnostic.kind}:${index}`}>
                    {tPortLease(`diagnostics.${diagnostic.kind}`)}: {diagnostic.detail}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </>
      )}
      <AlertDialog
        open={selection !== null}
        onOpenChange={(open) => {
          if (!open && !action.busy) setSelection(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("confirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{t("confirmDescription")}</AlertDialogDescription>
          </AlertDialogHeader>
          {selection ? (
            <p className="break-all text-xs">
              {subjectLabel(selection.subject)} · {selection.lease.canonicalRoot}
            </p>
          ) : null}
          {action.error ? (
            <p role="alert" className="text-xs text-destructive">
              {action.error}
            </p>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={action.busy}>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              disabled={action.busy || inventory.status === "loading"}
              onClick={(event) => {
                event.preventDefault()
                void release()
              }}
            >
              {action.busy ? t("releasing") : t("confirmRelease")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  )
}
