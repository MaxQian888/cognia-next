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

import { useMemo, useState, useSyncExternalStore } from "react"
import { useLocale, useTranslations } from "next-intl"
import { useShallow } from "zustand/react/shallow"
import { toast } from "sonner"
import { BoxesIcon, ChevronRightIcon, SparklesIcon, XIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
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
import { workflowEditorRevision } from "@/lib/workflow/editor/editor-revision"
import { templateToProposalOps } from "@/plugins/workflow-ai/src/tools/template-tools"
import { templateCatalog } from "@/lib/templates/catalog"
import { isWorkflowNodeGroupDefinition } from "@/lib/workflow/node-groups/materialize"
import type { WorkflowNodeGroupDefinition } from "@cognia/plugin-sdk/templates"
import {
  planNodeGroupUpgrade,
  readNodeGroupInstance,
  type NodeGroupUpgradePlan,
} from "@/lib/workflow/node-groups/upgrade"

interface Props {
  useStore: EditorStore
  workflowId: string | undefined
}

export function TemplatesTab({ useStore, workflowId }: Props) {
  const t = useTranslations("workflowEditor.templates")
  const locale = useLocale()
  const templates = useMemo(() => listCopilotTemplates(), [])
  const templateSnapshot = useSyncExternalStore(
    templateCatalog.subscribe,
    templateCatalog.getSnapshot,
    templateCatalog.getServerSnapshot
  )
  const nodeGroups = useMemo(
    () => templateSnapshot.definitions.filter(isWorkflowNodeGroupDefinition),
    [templateSnapshot]
  )
  const [activeId, setActiveId] = useState<string | null>(null)
  const selectedGroup = useStore(
    useShallow((state: EditorState) => {
      if (state.selectedNodeIds.length !== 1) return null
      const groupId = state.selectedNodeIds[0]
      const instance = readNodeGroupInstance(state.nodes.find((node) => node.id === groupId))
      return instance
        ? {
            groupId,
            definitionId: instance.definitionId,
            version: instance.version,
            contentHash: instance.contentHash,
          }
        : null
    })
  )

  const activeTemplate = useMemo(
    () => (activeId ? templates.find((tpl) => tpl.id === activeId) : null) ?? null,
    [activeId, templates]
  )

  if (!workflowId) {
    return (
      <div
        className="flex h-full w-full min-w-0 max-w-full flex-col items-center justify-center overflow-x-hidden p-6 text-center text-sm text-muted-foreground"
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

  const insertNodeGroup = (definition: WorkflowNodeGroupDefinition): void => {
    const state = useStore.getState()
    const zoom = Math.max(state.viewport.zoom, 0.01)
    const position = {
      x: (-state.viewport.x + 160) / zoom,
      y: (-state.viewport.y + 120) / zoom,
    }
    const localized =
      definition.metadata.localized?.[locale] ??
      definition.metadata.localized?.[locale.split("-")[0]]
    const name = localized?.name ?? definition.metadata.name
    try {
      state.insertNodeGroup(definition, position)
      toast.success(t("nodeGroups.inserted", { name }))
    } catch (error) {
      toast.error(
        t("nodeGroups.failed", {
          name,
          message: error instanceof Error ? error.message : String(error),
        })
      )
    }
  }

  const upgradeNodeGroup = (definition: WorkflowNodeGroupDefinition): void => {
    if (!selectedGroup) return
    try {
      const plan = useStore.getState().upgradeNodeGroup(selectedGroup.groupId, definition)
      toast.success(
        t("nodeGroups.upgraded", {
          version: plan.toVersion ?? t("nodeGroups.draftVersion"),
        })
      )
    } catch (error) {
      toast.error(
        t("nodeGroups.upgradeFailed", {
          message: error instanceof Error ? error.message : String(error),
        })
      )
    }
  }

  return (
    <div
      className="flex h-full w-full min-w-0 max-w-full flex-col gap-2 overflow-x-hidden overflow-y-auto p-3"
      data-testid="workflow-templates-tab"
    >
      <p className="text-xs text-muted-foreground">{t("tabHelp")}</p>
      {nodeGroups.length > 0 ? (
        <section className="flex flex-col gap-2" data-testid="workflow-node-groups">
          <div className="pt-1">
            <h3 className="text-xs font-medium">{t("nodeGroups.heading")}</h3>
            <p className="text-[11px] text-muted-foreground">{t("nodeGroups.help")}</p>
          </div>
          {nodeGroups.map((definition) => {
            let upgradePlan: NodeGroupUpgradePlan | undefined
            if (
              selectedGroup?.definitionId === definition.id &&
              selectedGroup.contentHash !== definition.contentHash
            ) {
              try {
                const state = useStore.getState()
                upgradePlan = planNodeGroupUpgrade(
                  state.nodes,
                  state.edges,
                  selectedGroup.groupId,
                  definition
                )
              } catch {
                upgradePlan = undefined
              }
            }
            return (
              <NodeGroupRow
                key={`${definition.id}@${definition.version ?? definition.revision}`}
                definition={definition}
                locale={locale}
                onInsert={insertNodeGroup}
                upgradePlan={upgradePlan}
                onUpgrade={upgradeNodeGroup}
              />
            )
          })}
        </section>
      ) : null}
      {templates.length === 0 && nodeGroups.length === 0 ? (
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

function NodeGroupRow({
  definition,
  locale,
  onInsert,
  upgradePlan,
  onUpgrade,
}: {
  definition: WorkflowNodeGroupDefinition
  locale: string
  onInsert: (definition: WorkflowNodeGroupDefinition) => void
  upgradePlan?: NodeGroupUpgradePlan
  onUpgrade: (definition: WorkflowNodeGroupDefinition) => void
}) {
  const t = useTranslations("workflowEditor.templates.nodeGroups")
  const localized =
    definition.metadata.localized?.[locale] ?? definition.metadata.localized?.[locale.split("-")[0]]
  const name = localized?.name ?? definition.metadata.name
  const description = localized?.description ?? definition.metadata.description

  return (
    <div className="rounded-md border bg-card">
      <button
        type="button"
        className={cn(
          "flex w-full items-start gap-2 px-3 py-2 text-left text-xs",
          "hover:bg-accent/40 transition-colors"
        )}
        onClick={() => onInsert(definition)}
        data-testid={`workflow-node-group-row-${definition.id}`}
      >
        <BoxesIcon className="mt-0.5 size-4 shrink-0 text-sky-500" aria-hidden="true" />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex items-center justify-between gap-2">
            <span className="font-medium">{name}</span>
            <Badge variant="outline" className="text-[10px]">
              {definition.payload.nodes.length}
            </Badge>
          </div>
          {description ? <p className="text-muted-foreground">{description}</p> : null}
        </div>
      </button>
      {upgradePlan ? (
        <div
          className="space-y-1 border-t px-3 py-2 text-[11px]"
          data-testid="node-group-upgrade-diff"
        >
          <p>
            {t("upgradeDiff", {
              from: upgradePlan.fromVersion ?? t("draftVersion"),
              to: upgradePlan.toVersion ?? t("draftVersion"),
              added: upgradePlan.addedNodeIds.length,
              removed: upgradePlan.removedNodeIds.length,
              changed: upgradePlan.changedNodeIds.length,
            })}
          </p>
          {upgradePlan.blockers.length ? (
            <p className="text-destructive">{upgradePlan.blockers.join("; ")}</p>
          ) : null}
          <Button
            size="sm"
            className="h-7 text-[11px]"
            disabled={!upgradePlan.compatible}
            onClick={() => onUpgrade(definition)}
          >
            {t("upgrade")}
          </Button>
        </div>
      ) : null}
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
        baseRevision: workflowEditorRevision(useStore.getState()),
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
      className="flex h-full w-full min-w-0 max-w-full flex-col gap-3 overflow-x-hidden overflow-y-auto p-3"
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
        <NativeSelect
          id={`slot-${slot.key}`}
          size="sm"
          wrapperClassName="w-full"
          className="bg-card text-xs"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          data-testid={`workflow-templates-slot-${slot.key}`}
        >
          {slot.options.map((opt) => (
            <NativeSelectOption key={opt} value={opt}>
              {opt}
            </NativeSelectOption>
          ))}
        </NativeSelect>
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
