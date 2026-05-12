"use client"

/**
 * QuickWorkflowTriggerDialog — lightweight modal that adds a `trigger.cron`
 * node to an existing workflow without opening the full editor. Workflow
 * combobox + cron expression + timezone select, then `syncWorkflowTriggers`
 * pushes to Rust.
 *
 * Out of scope: editing existing triggers (use the workflow editor for
 * anything more involved); non-cron trigger kinds.
 */

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { TimezoneSelect } from "../timezone-select"
import { getDb } from "@/lib/db/schema"
import { syncWorkflowTriggers } from "@/lib/workflow/runtime/webhook-bridge"
import type { VisualWorkflow, WorkflowNode } from "@/types/workflow/visual"

// Cron presets that align with the scheduler's BackupScheduleDialog visual
// pattern — copied (not extracted) per the plan; the two call sites diverge
// enough that a shared component isn't worth the extraction.
const CRON_PRESETS: Array<{ id: string; expression: string; labelKey: string }> = [
  { id: "every-hour", expression: "0 * * * *", labelKey: "hourly" },
  { id: "daily-9am", expression: "0 9 * * *", labelKey: "daily" },
  { id: "weekly-mon-9am", expression: "0 9 * * 1", labelKey: "weeklyMon" },
  { id: "custom", expression: "", labelKey: "custom" },
]

export interface QuickWorkflowTriggerDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Invoked after a trigger is created. */
  onCreated?: (workflowId: string, triggerId: string) => void
  /** Override for `getDb()` — tests inject a stub. */
  db?: ReturnType<typeof getDb>
  /** Override for `syncWorkflowTriggers` — tests inject a spy. */
  syncFn?: (workflow: VisualWorkflow) => Promise<void>
  /** Override for the unique id generator — tests inject a deterministic one. */
  newNodeId?: () => string
}

export function QuickWorkflowTriggerDialog({
  open,
  onOpenChange,
  onCreated,
  db,
  syncFn,
  newNodeId,
}: QuickWorkflowTriggerDialogProps) {
  const t = useTranslations("scheduler")
  const sync = syncFn ?? syncWorkflowTriggers
  const idGen =
    newNodeId ??
    (() => "trigger_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6))

  const workflows = useLiveQuery(async () => {
    const realDb = db ?? getDb()
    return realDb.workflows.toArray()
  }, [open])

  const [workflowId, setWorkflowId] = useState<string>("")
  const [presetId, setPresetId] = useState<string>("daily-9am")
  const [cron, setCron] = useState<string>("0 9 * * *")
  const [timezone, setTimezone] = useState<string>("UTC")
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  // Reset on open transition. React's "adjust state during render" pattern —
  // safer than useEffect+setState (which the lint rule blocks because effect
  // setState triggers an extra render).
  const [openSnapshot, setOpenSnapshot] = useState(open)
  if (open !== openSnapshot) {
    setOpenSnapshot(open)
    if (open) {
      setError(null)
      setSubmitting(false)
    }
  }

  const selectedPreset = useMemo(
    () => CRON_PRESETS.find((p) => p.id === presetId) ?? CRON_PRESETS[0],
    [presetId]
  )

  const handlePresetChange = (id: string) => {
    setPresetId(id)
    const preset = CRON_PRESETS.find((p) => p.id === id)
    if (preset && preset.expression) setCron(preset.expression)
  }

  async function handleSubmit() {
    if (!workflowId) {
      setError(t("pickAWorkflow") || "Pick a workflow")
      return
    }
    if (!cron.trim()) {
      setError(t("cronRequired") || "Cron expression required")
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      const realDb = db ?? getDb()
      const workflow = await realDb.workflows.get(workflowId)
      if (!workflow) {
        setError(t("workflowNotFound") || "Workflow not found")
        return
      }
      const triggerId = idGen()
      const newNode: WorkflowNode = {
        id: triggerId,
        type: "trigger.cron",
        typeVersion: 1,
        position: { x: 100, y: 100 + workflow.nodes.length * 80 },
        data: {
          label: t("cronTriggerLabel") || "Cron trigger",
          params: { cron: cron.trim(), timezone },
        },
      }
      const updated: VisualWorkflow = {
        ...workflow,
        nodes: [...workflow.nodes, newNode],
      }
      await realDb.workflows.put(updated)
      await realDb.workflowTriggers.put({
        id: triggerId,
        workflowId,
        kind: "trigger.cron",
        enabled: true,
        cron: cron.trim(),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
      await sync(updated)
      onCreated?.(workflowId, triggerId)
      onOpenChange(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[480px]" data-testid="quick-workflow-trigger-dialog">
        <DialogHeader>
          <DialogTitle>{t("quickCreateWorkflowTrigger") || "Create workflow trigger"}</DialogTitle>
          <DialogDescription>
            {t("quickCreateWorkflowTriggerDescription") ||
              "Add a cron trigger to an existing workflow without leaving the scheduler."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div>
            <Label className="text-xs" htmlFor="qwt-workflow">
              {t("workflow") || "Workflow"}
            </Label>
            <Select value={workflowId} onValueChange={setWorkflowId}>
              <SelectTrigger id="qwt-workflow" data-testid="qwt-workflow-trigger">
                <SelectValue placeholder={t("pickWorkflow") || "Pick a workflow"} />
              </SelectTrigger>
              <SelectContent>
                {workflows?.map((wf) => (
                  <SelectItem key={wf.id} value={wf.id} data-testid={`qwt-workflow-${wf.id}`}>
                    {wf.name ?? wf.id}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div>
            <Label className="text-xs">{t("schedule") || "Schedule"}</Label>
            <Select value={presetId} onValueChange={handlePresetChange}>
              <SelectTrigger data-testid="qwt-preset-trigger">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CRON_PRESETS.map((preset) => (
                  <SelectItem key={preset.id} value={preset.id}>
                    {t(`cronPreset.${preset.labelKey}`) || preset.labelKey}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {selectedPreset.id === "custom" || !selectedPreset.expression ? (
            <div>
              <Label className="text-xs" htmlFor="qwt-cron">
                {t("cronExpression") || "Cron expression"}
              </Label>
              <Input
                id="qwt-cron"
                data-testid="qwt-cron-input"
                value={cron}
                onChange={(e) => setCron(e.target.value)}
                placeholder="0 9 * * *"
              />
            </div>
          ) : (
            <p
              className="rounded bg-muted px-2 py-1 text-[11px] font-mono text-muted-foreground"
              data-testid="qwt-cron-resolved"
            >
              {cron}
            </p>
          )}

          <div>
            <Label className="text-xs">{t("timezone") || "Timezone"}</Label>
            <TimezoneSelect value={timezone} onValueChange={setTimezone} />
          </div>

          {error && (
            <p className="text-xs text-red-500" data-testid="qwt-error">
              {error}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            {t("cancel") || "Cancel"}
          </Button>
          <Button
            data-testid="qwt-submit"
            disabled={submitting || !workflowId}
            onClick={() => void handleSubmit()}
          >
            {submitting ? t("creating") || "Creating…" : t("create") || "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
