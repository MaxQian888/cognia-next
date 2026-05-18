"use client"

/**
 * Templates tab — the right-sidebar surface for applying slot-filled
 * workflow copilot scaffolds.
 *
 * The same proposal flow the AI uses (`wf_propose_batch`-style diff card
 * in chat) is reused here: clicking "Apply" opens a slot drawer; on
 * submit, the template's `build(slots)` graph is converted to add_node +
 * connect_edge ops and pushed into the proposal store. The card then
 * appears in the chat tab (since the assistant message stream is the
 * canonical proposal surface).
 *
 * UX:
 *   • Top-level list shows every registered template (name, description,
 *     tags), with a `data-testid` per row for test selectors.
 *   • Clicking a row opens an inline drawer that renders one input per
 *     declared slot. Submit is gated on every `required` slot being
 *     non-empty.
 *   • On submit, the proposal is staged. We `toast.success` so the user
 *     knows the card landed in chat (the templates tab itself stays
 *     mounted so they can apply more than one back-to-back).
 */

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { useShallow } from "zustand/react/shallow"
import { toast } from "sonner"
import { ChevronRightIcon, SparklesIcon, XIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import type { EditorStore, EditorState } from "@/lib/workflow/editor/store"
import {
  listCopilotTemplates,
  materializeCopilotTemplate,
  type CopilotSlotValues,
  type CopilotTemplateSlot,
  type WorkflowCopilotTemplate,
} from "@/lib/workflow/copilot-templates"
import { useProposalStore } from "@/lib/workflow/editor/proposal-store"
import { templateToProposalOps } from "@/plugins/workflow-ai/src/tools/template-tools"

interface Props {
  useStore: EditorStore
  workflowId: string | undefined
}

export function TemplatesTab({ useStore, workflowId }: Props) {
  const t = useTranslations("workflowEditor.templates")
  const templates = useMemo(() => listCopilotTemplates(), [])
  const [activeId, setActiveId] = useState<string | null>(null)

  const activeTemplate = useMemo(
    () => (activeId ? templates.find((tpl) => tpl.id === activeId) : null) ?? null,
    [activeId, templates]
  )

  if (!workflowId) {
    return (
      <div
        className="flex h-full w-full flex-col items-center justify-center p-6 text-center text-sm text-muted-foreground"
        data-testid="workflow-templates-tab-empty"
      >
        <p>{t("emptyState")}</p>
      </div>
    )
  }

  if (activeTemplate) {
    return (
      <SlotForm
        template={activeTemplate}
        useStore={useStore}
        workflowId={workflowId}
        onClose={() => setActiveId(null)}
      />
    )
  }

  return (
    <div
      className="flex h-full w-full flex-col gap-2 overflow-y-auto p-3"
      data-testid="workflow-templates-tab"
    >
      <p className="text-xs text-muted-foreground">{t("tabHelp")}</p>
      {templates.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">{t("emptyState")}</p>
      ) : (
        templates.map((tpl) => (
          <button
            key={tpl.id}
            type="button"
            className={cn(
              "flex w-full items-start gap-2 rounded-md border bg-card px-3 py-2 text-left text-xs",
              "hover:bg-accent/40 transition-colors"
            )}
            onClick={() => setActiveId(tpl.id)}
            data-testid={`workflow-template-row-${tpl.id}`}
          >
            <SparklesIcon className="mt-0.5 size-4 shrink-0 text-violet-500" aria-hidden="true" />
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium">{tpl.label.en}</span>
                <ChevronRightIcon className="size-3.5 text-muted-foreground" aria-hidden="true" />
              </div>
              <p className="text-muted-foreground">{tpl.description.en}</p>
              {tpl.tags && tpl.tags.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {tpl.tags.map((tag) => (
                    <Badge key={tag} variant="outline" className="text-[10px]">
                      {tag}
                    </Badge>
                  ))}
                </div>
              )}
            </div>
          </button>
        ))
      )}
    </div>
  )
}

interface SlotFormProps {
  template: WorkflowCopilotTemplate
  useStore: EditorStore
  workflowId: string
  onClose: () => void
}

function SlotForm({ template, useStore, workflowId, onClose }: SlotFormProps) {
  const t = useTranslations("workflowEditor.templates")
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      template.slots.map((s) => [s.key, s.defaultValue !== undefined ? String(s.defaultValue) : ""])
    )
  )
  const [submitting, setSubmitting] = useState(false)

  const missingRequired = template.slots.some(
    (s) => s.required && s.defaultValue === undefined && (values[s.key] ?? "").trim() === ""
  )

  const existing = useStore(
    useShallow((s: EditorState) => ({
      nodeIds: new Set(s.nodes.map((n) => n.id)),
      edgeIds: new Set(s.edges.map((e) => e.id)),
    }))
  )

  const handleSubmit = (e: React.FormEvent): void => {
    e.preventDefault()
    if (missingRequired) {
      toast.error(t("slotRequiredMissing"))
      return
    }
    setSubmitting(true)
    try {
      const slotBag: CopilotSlotValues = {}
      for (const [k, v] of Object.entries(values)) {
        if (v.trim().length > 0) slotBag[k] = v.trim()
      }
      const materialize = materializeCopilotTemplate(template.id, slotBag)
      if (!materialize.ok) {
        toast.error(materialize.message)
        return
      }
      let counter = 0
      const reserveId = (): string => `${Date.now().toString(36)}_${counter++}`
      const { ops } = templateToProposalOps(materialize.workflow, existing, reserveId)
      const proposalId = `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
      const summary = `Apply template "${template.label.en}" — ${
        ops.filter((o) => o.type === "add_node").length
      } nodes`
      useProposalStore.getState().openProposal(workflowId, {
        proposalId,
        workflowId,
        summary,
        ops,
      })
      toast.success(`${template.label.en} → ${summary}`)
      onClose()
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="flex h-full w-full flex-col gap-3 overflow-y-auto p-3"
      data-testid={`workflow-templates-form-${template.id}`}
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium" data-testid="workflow-templates-form-title">
          {template.label.en}
        </h3>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 w-7 p-0"
          onClick={onClose}
          aria-label={t("cancel")}
          data-testid="workflow-templates-form-close"
        >
          <XIcon className="size-3.5" aria-hidden="true" />
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">{template.description.en}</p>
      <div className="flex flex-col gap-3">
        {template.slots.map((slot) => (
          <SlotInput
            key={slot.key}
            slot={slot}
            value={values[slot.key] ?? ""}
            onChange={(v) => setValues((cur) => ({ ...cur, [slot.key]: v }))}
          />
        ))}
      </div>
      <div className="mt-auto flex items-center gap-2 pt-2">
        <Button
          type="submit"
          size="sm"
          disabled={submitting || missingRequired}
          data-testid="workflow-templates-form-apply"
        >
          {t("applyCta")}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={onClose}
          data-testid="workflow-templates-form-cancel"
        >
          {t("cancel")}
        </Button>
      </div>
    </form>
  )
}

function SlotInput({
  slot,
  value,
  onChange,
}: {
  slot: CopilotTemplateSlot
  value: string
  onChange: (v: string) => void
}) {
  if (slot.type === "select" && slot.options && slot.options.length > 0) {
    return (
      <div className="flex flex-col gap-1">
        <Label htmlFor={`slot-${slot.key}`} className="text-xs">
          {slot.label.en}
          {slot.required ? <span className="text-destructive"> *</span> : null}
        </Label>
        <select
          id={`slot-${slot.key}`}
          className="h-8 rounded-md border bg-card px-2 text-xs"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          data-testid={`workflow-templates-slot-${slot.key}`}
        >
          {slot.options.map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </select>
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={`slot-${slot.key}`} className="text-xs">
        {slot.label.en}
        {slot.required ? <span className="text-destructive"> *</span> : null}
      </Label>
      <Input
        id={`slot-${slot.key}`}
        type={slot.type === "number" ? "number" : "text"}
        className="h-8 text-xs"
        placeholder={slot.placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        data-testid={`workflow-templates-slot-${slot.key}`}
      />
    </div>
  )
}
