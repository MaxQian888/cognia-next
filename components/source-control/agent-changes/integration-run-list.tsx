"use client"

import { useState } from "react"
import { useTranslations } from "next-intl"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
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
import type { IntegrationRun } from "@/lib/scm/types"
import type { AgentChangesActions } from "@/hooks/scm/use-agent-changesets"
import { integrationReasonKey } from "./presentation"

interface Props {
  integrations: IntegrationRun[]
  actions: Pick<AgentChangesActions, "rollback" | "abort" | "busy" | "error">
}

export function IntegrationRunList({ integrations, actions }: Props) {
  const t = useTranslations("agentChanges")
  const [rollbackId, setRollbackId] = useState<string | null>(null)
  const rollbackRun = integrations.find(
    (run) => run.integrationId === rollbackId && run.state === "published"
  )
  return (
    <section className="space-y-2" aria-label={t("runs.title")}>
      <h3 className="text-sm font-medium">{t("runs.title")}</h3>
      {integrations.length === 0 && (
        <p className="text-sm text-muted-foreground">{t("runs.empty")}</p>
      )}
      <ul className="space-y-2">
        {integrations.map((run) => (
          <li
            key={run.integrationId}
            className="space-y-2 rounded-md border p-3 text-xs"
            data-testid={`integration-run-${run.integrationId}`}
          >
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline">{t(`runStates.${run.state}`)}</Badge>
              <span className="break-all font-mono">{run.targetRef}</span>
              <span>{t("runs.attempt", { attempt: run.attempt })}</span>
            </div>
            {run.resultSha && <p>{t("runs.result", { sha: run.resultSha.slice(0, 8) })}</p>}
            {run.error && (
              <p role="alert">
                {t(integrationReasonKey(run.error.code), { code: run.error.code })}
              </p>
            )}
            <ul className="space-y-1">
              {run.items.map((item) => (
                <li key={item.changesetId} className="break-all">
                  <span>{item.changesetId}</span>
                  <Badge variant="secondary" className="mx-2">
                    {t(`itemOutcomes.${item.outcome}`)}
                  </Badge>
                  <code>{item.commitSha?.slice(0, 8) ?? item.headSha.slice(0, 8)}</code>
                  <ul className="font-mono">
                    {item.conflictFiles.map((file) => (
                      <li key={file}>{file}</li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
            {run.opLog.length > 0 && (
              <details>
                <summary className="cursor-pointer">{t("runs.opLog")}</summary>
                <ol className="space-y-1 pt-2">
                  {run.opLog.map((entry, index) => (
                    <li key={index} className="break-all">
                      <p>
                        {t("runs.transition", {
                          ref: entry.refName,
                          old: entry.oldSha.slice(0, 8),
                          next: entry.newSha.slice(0, 8),
                        })}
                      </p>
                      <p>{t("runs.operation", { reason: entry.reason })}</p>
                    </li>
                  ))}
                </ol>
              </details>
            )}
            {run.state === "published" && (
              <Button
                size="sm"
                variant="outline"
                disabled={actions.busy}
                onClick={() => setRollbackId(run.integrationId)}
                data-testid={`rollback-${run.integrationId}`}
              >
                {t("actions.rollback")}
              </Button>
            )}
            {["prepared", "stale", "conflicted"].includes(run.state) && (
              <Button
                size="sm"
                variant="outline"
                disabled={actions.busy}
                onClick={() => void actions.abort(run.integrationId)}
                data-testid={`abort-${run.integrationId}`}
              >
                {t("actions.abort")}
              </Button>
            )}
          </li>
        ))}
      </ul>
      <AlertDialog
        open={!!rollbackRun}
        onOpenChange={(open) => {
          if (!open && !actions.busy) setRollbackId(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("confirm.rollbackTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("confirm.rollbackDescription", { ref: rollbackRun?.targetRef ?? "" })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {actions.error && <p role="alert">{t("errors.action")}</p>}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={actions.busy}>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              disabled={actions.busy}
              data-testid="rollback-confirm"
              onClick={(event) => {
                event.preventDefault()
                if (rollbackRun)
                  void actions.rollback(rollbackRun.integrationId).then((result) => {
                    if (result) setRollbackId(null)
                  })
              }}
            >
              {t("actions.rollback")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
}
