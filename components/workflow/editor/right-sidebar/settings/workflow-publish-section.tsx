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
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { publishWorkflow, unpublishWorkflow } from "@/lib/workflow/publish/publish-workflow"
import type { WorkflowPublication } from "@/types/workflow/visual"

export function WorkflowPublishSection({
  workflowId,
  published: initialPublished,
}: {
  workflowId: string
  published?: WorkflowPublication
}) {
  const t = useTranslations("workflowEditor.settings.publish")
  const [published, setPublished] = useState<WorkflowPublication | undefined>(initialPublished)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [toolName, setToolName] = useState<string | undefined>(initialPublished?.toolName)

  const onPublish = async () => {
    setBusy(true)
    setError(null)
    try {
      const at = Date.now()
      const result = await publishWorkflow(workflowId, at)
      setPublished({ at, toolName: result.toolName })
      setToolName(result.toolName)
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
      setPublished(undefined)
      setToolName(undefined)
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
            {t("publishedAs")} <code className="rounded bg-muted px-1 py-0.5">{toolName}</code>
          </p>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={onPublish} disabled={busy}>
              {t("republish")}
            </Button>
            <Button size="sm" variant="ghost" onClick={onUnpublish} disabled={busy}>
              {t("unpublish")}
            </Button>
          </div>
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
