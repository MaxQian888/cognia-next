"use client"

/**
 * Structured payload editor for `workflow` tasks — schedule a published
 * visual workflow through the app scheduler (executor:
 * `lib/scheduler/executors/workflow-executor.ts`).
 *
 * The workflow picker lists every workflow row from Dexie; a workflow still
 * needs an ACTIVE deployment in the chosen environment or the run is refused
 * at admission (`deployment-not-found`), which the execution row explains.
 */

import { useMemo } from "react"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { cn } from "@/lib/utils"
import { getDb } from "@/lib/db/schema"
import type { WorkflowDraft } from "./types"

export interface WorkflowOption {
  id: string
  name: string
}

export interface WorkflowPayloadEditorProps {
  draft: WorkflowDraft
  onDraftChange: (next: WorkflowDraft) => void
  errors?: Record<string, string>
  disabled?: boolean
  testId?: string
  /** Test seam / remote-host override; defaults to the local Dexie `workflows` table. */
  loadWorkflows?: () => Promise<WorkflowOption[]>
}

async function loadLocalWorkflows(): Promise<WorkflowOption[]> {
  const rows = await getDb().workflows.toArray()
  return rows
    .map((row) => ({ id: row.id, name: row.name || row.id }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

export function WorkflowPayloadEditor({
  draft,
  onDraftChange,
  errors,
  disabled,
  testId = "workflow-payload-editor",
  loadWorkflows,
}: WorkflowPayloadEditorProps) {
  const t = useTranslations("scheduler")
  const loader = loadWorkflows ?? loadLocalWorkflows
  const liveWorkflows = useLiveQuery(loader, [loader])
  const workflows = useMemo(() => liveWorkflows ?? [], [liveWorkflows])

  const knownIds = useMemo(() => new Set(workflows.map((w) => w.id)), [workflows])
  const showFreeText = draft.workflowId.length > 0 && !knownIds.has(draft.workflowId)

  function update<K extends keyof WorkflowDraft>(key: K, value: WorkflowDraft[K]) {
    onDraftChange({ ...draft, [key]: value })
  }

  return (
    <div className="space-y-4" data-testid={testId}>
      <div className="space-y-2">
        <Label className="text-sm font-medium">
          {t("payload.workflow.workflowId")} <span className="text-destructive">*</span>
        </Label>
        <Select
          value={knownIds.has(draft.workflowId) ? draft.workflowId : ""}
          onValueChange={(value) => update("workflowId", value)}
          disabled={disabled}
        >
          <SelectTrigger
            className={cn("h-10", errors?.workflowId && "border-destructive")}
            data-testid={`${testId}-workflow-select`}
            aria-label={t("payload.workflow.workflowId")}
          >
            <SelectValue placeholder={t("payload.workflow.workflowPlaceholder")} />
          </SelectTrigger>
          <SelectContent>
            {workflows.length === 0 && (
              <div className="px-2 py-1.5 text-xs text-muted-foreground">
                {t("payload.workflow.noWorkflows")}
              </div>
            )}
            {workflows.map((workflow) => (
              <SelectItem key={workflow.id} value={workflow.id}>
                {workflow.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          value={draft.workflowId}
          onChange={(e) => update("workflowId", e.target.value)}
          placeholder={t("payload.workflow.workflowIdManualPlaceholder")}
          disabled={disabled}
          className={cn(
            "h-9 font-mono text-xs",
            errors?.workflowId && "border-destructive focus-visible:ring-destructive/20"
          )}
          aria-label={t("payload.workflow.workflowIdManual")}
          data-testid={`${testId}-workflow-id-input`}
        />
        {showFreeText && (
          <p className="text-xs text-muted-foreground">
            {t("payload.workflow.unknownWorkflowHint")}
          </p>
        )}
        {errors?.workflowId && (
          <p className="text-xs text-destructive">{t(`payload.errors.${errors.workflowId}`)}</p>
        )}
        <p className="text-xs text-muted-foreground">{t("payload.workflow.deploymentHelp")}</p>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="space-y-2">
          <Label className="text-sm font-medium">{t("payload.workflow.environment")}</Label>
          <Input
            value={draft.environment}
            onChange={(e) => update("environment", e.target.value)}
            placeholder="production"
            disabled={disabled}
            className="h-10 font-mono text-xs"
            data-testid={`${testId}-environment-input`}
          />
        </div>
        <div className="space-y-2">
          <Label className="text-sm font-medium">{t("payload.workflow.triggerId")}</Label>
          <Input
            value={draft.triggerId}
            onChange={(e) => update("triggerId", e.target.value)}
            placeholder={t("payload.workflow.triggerIdPlaceholder")}
            disabled={disabled}
            className="h-10 font-mono text-xs"
            data-testid={`${testId}-trigger-id-input`}
          />
          <p className="text-xs text-muted-foreground">{t("payload.workflow.triggerIdHelp")}</p>
        </div>
      </div>

      <div className="space-y-2">
        <Label className="text-sm font-medium">{t("payload.workflow.inputs")}</Label>
        <Textarea
          value={draft.inputsJson}
          onChange={(e) => update("inputsJson", e.target.value)}
          rows={5}
          placeholder={'{\n  "key": "value"\n}'}
          disabled={disabled}
          className={cn(
            "font-mono text-xs",
            errors?.inputsJson && "border-destructive focus-visible:ring-destructive/20"
          )}
          data-testid={`${testId}-inputs-input`}
        />
        {errors?.inputsJson && (
          <p className="text-xs text-destructive">{t(`payload.errors.${errors.inputsJson}`)}</p>
        )}
        <p className="text-xs text-muted-foreground">{t("payload.workflow.inputsHelp")}</p>
      </div>

      <div className="space-y-2">
        <Label className="text-sm font-medium">{t("payload.workflow.idempotencyKey")}</Label>
        <Input
          value={draft.idempotencyKey}
          onChange={(e) => update("idempotencyKey", e.target.value)}
          placeholder={t("payload.workflow.idempotencyKeyPlaceholder")}
          disabled={disabled}
          className="h-10 font-mono text-xs"
          data-testid={`${testId}-idempotency-input`}
        />
        <p className="text-xs text-muted-foreground">{t("payload.workflow.idempotencyKeyHelp")}</p>
      </div>
    </div>
  )
}
