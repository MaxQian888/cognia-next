"use client"

/**
 * WorkflowPublishSection — publish a workflow as a typed callable unit (D5).
 *
 * Publishing reads the SAVED workflow from Dexie (so the user should save
 * first), derives the interface from the `trigger.manual` input schema +
 * `io.output` output schema, stamps `workflow.published`, and registers a
 * `kind:"workflow"` skill that exposes the graph as the `wf_run_workflow_typed`
 * tool. Unpublishing reverses both.
 */

import { useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import {
  publishWorkflow,
  rollbackWorkflow,
  unpublishWorkflow,
} from "@/lib/workflow/publish/publish-workflow"
import { getWorkflowDeployment, listWorkflowVersions } from "@/lib/db/workflow-deployments"
import type { WorkflowInterface, WorkflowPublication } from "@/types/workflow/visual"

export function WorkflowPublishSection({
  workflowId,
  published,
  onPublicationChange,
}: {
  workflowId: string
  published?: WorkflowPublication
  onPublicationChange: (
    published?: WorkflowPublication,
    workflowInterface?: WorkflowInterface
  ) => void
}) {
  const t = useTranslations("workflowEditor.settings.publish")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const deployment = useLiveQuery(() => getWorkflowDeployment(workflowId), [workflowId])
  const versions = useLiveQuery(
    async () => (await listWorkflowVersions(workflowId)).sort((a, b) => b.sequence - a.sequence),
    [workflowId]
  )

  const applyPublication = (result: Awaited<ReturnType<typeof publishWorkflow>>, at: number) => {
    onPublicationChange(
      {
        at,
        toolName: result.toolName,
        versionId: result.versionId,
        deploymentId: result.deploymentId,
        deploymentRevision: result.deploymentRevision,
      },
      result.workflowInterface
    )
  }

  const onPublish = async () => {
    setBusy(true)
    setError(null)
    try {
      const at = Date.now()
      const result = await publishWorkflow(workflowId, at)
      applyPublication(result, at)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const onRollback = async (versionId: string, at: number) => {
    setBusy(true)
    setError(null)
    try {
      const result = await rollbackWorkflow(workflowId, versionId, at)
      applyPublication(result, at)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const onUnpublish = async () => {
    setBusy(true)
    setError(null)
    try {
      await unpublishWorkflow(workflowId)
      onPublicationChange(undefined, undefined)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-2" data-testid="workflow-publish-section">
      <p className="text-[11px] text-muted-foreground">{t("hint")}</p>
      {published ? (
        <div className="space-y-2">
          <p className="text-xs">
            {t("publishedAs")}{" "}
            <code className="rounded bg-muted px-1 py-0.5">{published.toolName}</code>
          </p>
          {deployment ? (
            <p className="text-[11px] text-muted-foreground" data-testid="deployment-summary">
              {t("deploymentSummary", {
                sequence:
                  versions?.find((version) => version.id === deployment.versionId)?.sequence ?? 0,
                revision: deployment.revision,
                status: deployment.status,
              })}
            </p>
          ) : null}
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={onPublish} disabled={busy}>
              {t("republish")}
            </Button>
            <Button size="sm" variant="ghost" onClick={onUnpublish} disabled={busy}>
              {t("unpublish")}
            </Button>
          </div>
          {(versions?.length ?? 0) > 0 ? (
            <div className="space-y-1" data-testid="workflow-version-history">
              <p className="text-[11px] font-medium">{t("versionHistory")}</p>
              {versions?.map((version) => {
                const current = deployment?.versionId === version.id
                return (
                  <div
                    key={version.id}
                    className="flex items-center justify-between gap-2 rounded border px-2 py-1 text-[11px]"
                  >
                    <span>
                      {t("versionRow", {
                        sequence: version.sequence,
                        date: new Date(version.createdAt).toLocaleString(),
                      })}
                    </span>
                    {current ? (
                      <span className="text-muted-foreground">{t("current")}</span>
                    ) : (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 px-2 text-[11px]"
                        disabled={busy}
                        onClick={() => void onRollback(version.id, Date.now())}
                      >
                        {t("rollback")}
                      </Button>
                    )}
                  </div>
                )
              })}
            </div>
          ) : null}
        </div>
      ) : (
        <Button size="sm" onClick={onPublish} disabled={busy} data-testid="workflow-publish-button">
          {t("publish")}
        </Button>
      )}
      {error ? <p className="text-[11px] text-destructive">{error}</p> : null}
    </div>
  )
}
