"use client"

/**
 * Detail / editor for one subagent template.
 *
 * Replaces the old in-grid editor, which swapped a ~40-field form into a
 * single cell of a 2-column card grid (reflowing every sibling) while "new"
 * rendered a *second* editor below the grid — two landing places for one form.
 * Here the form is simply the detail pane.
 *
 * Beyond the layout it closes the gaps that made the previous editor unable to
 * describe its own data model: the tool allowlist (read by the projector,
 * never writable), the `disabled` / `hidden` flags (enforced by all three
 * resolvers, never writable), and honest read-outs of the three places where a
 * field silently overrides or strands another — see `template-diagnostics.ts`.
 */

import { useCallback, useMemo } from "react"
import { useTranslations } from "next-intl"
import { motion } from "motion/react"
import { AlertTriangleIcon, CopyIcon, InfoIcon, PlusIcon, Trash2Icon, XIcon } from "lucide-react"
import { nanoid } from "nanoid"

import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { toast } from "@/components/ui/sonner"
import {
  SettingsAlert,
  SettingsGroup,
  SettingsEmptyState,
} from "@/components/settings/common/settings-section"
import { UnsavedBar } from "@/components/settings/common/unsaved-bar"
import { ProviderModelCombobox } from "@/components/settings/provider/routing/provider-model-combobox"
import { useFlowMotion } from "@/components/chat/motion/motion-reveal"
import { STAGGER_CHILD, STAGGER_CONTAINER } from "@/lib/ui/motion"
import { useSubagentRuntimeStore } from "@/stores/agent/subagent-runtime-store"
import { useSettingsStore } from "@/stores/settings"
import type { ProviderName } from "@cognia/provider-types/provider"
import {
  BUILTIN_EXECUTABLE_PRESET_IDS,
  getPresetDisplayInfo,
} from "@/lib/ai/agent/external/presets"
import type { SubAgentTemplate, SubAgentPriority } from "@/types/agent/sub-agent"
import { SUB_AGENT_PRIORITY_CONFIG } from "@/types/agent/sub-agent"

import { usePolicyDraft } from "../use-policy-draft"
import { useReportPanelDirty } from "../panel-dirty-context"
import { ToolScopeField } from "../tool-scope-field"
import {
  dispatchRailUnavailable,
  reachability,
  taskTemplateOverridden,
  variableDiagnostics,
} from "../template-diagnostics"

/** Radix reserves the empty string, so the "built-in engine" option needs one. */
const EXTERNAL_NONE_VALUE = "__builtin__"

const CATEGORIES: SubAgentTemplate["category"][] = [
  "research",
  "coding",
  "writing",
  "analysis",
  "general",
]
const PRIORITIES: SubAgentPriority[] = ["critical", "high", "normal", "low", "background"]

export interface TemplatePanelProps {
  templateId: string
  /** Selects the freshly-forked copy after a duplicate. */
  onNavigate: (templateId: string) => void
}

export function TemplatePanel({ templateId, onNavigate }: TemplatePanelProps) {
  const t = useTranslations("settings.subagents.templates")
  const tCommon = useTranslations("common")
  const template = useSubagentRuntimeStore((s) => s.templates[templateId])
  const addTemplate = useSubagentRuntimeStore((s) => s.addTemplate)
  const updateTemplate = useSubagentRuntimeStore((s) => s.updateTemplate)
  const deleteTemplate = useSubagentRuntimeStore((s) => s.deleteTemplate)
  const nestingEnabled = useSettingsStore((s) => s.settings?.subagentNesting?.enabled ?? false)

  const duplicate = useCallback(
    (source: SubAgentTemplate) => {
      const copy: SubAgentTemplate = {
        ...source,
        id: nanoid(),
        name: t("copyName", { name: source.name }),
        isBuiltIn: false,
      }
      addTemplate(copy)
      toast.success(t("duplicatedToast", { name: copy.name }))
      onNavigate(copy.id)
    },
    [addTemplate, onNavigate, t]
  )

  if (!template) {
    return <SettingsEmptyState title={t("missingTitle")} description={t("missingBody")} />
  }

  if (template.isBuiltIn) {
    return <BuiltInView template={template} onDuplicate={() => duplicate(template)} />
  }

  return (
    <EditableView
      // Remount per template so the draft can never carry across a selection.
      key={template.id}
      template={template}
      nestingEnabled={nestingEnabled}
      onPersist={async (next) => updateTemplate(next.id, next)}
      onDuplicate={() => duplicate(template)}
      onDelete={() => {
        deleteTemplate(template.id)
        toast.success(t("removedToast", { name: template.name }))
      }}
      t={t}
      tCommon={tCommon}
    />
  )
}

/* ------------------------------------------------------------------ */
/*  Built-in — read-only at the store, so read-only here               */
/* ------------------------------------------------------------------ */

function BuiltInView({
  template,
  onDuplicate,
}: {
  template: SubAgentTemplate
  onDuplicate: () => void
}) {
  const t = useTranslations("settings.subagents.templates")
  return (
    <div className="space-y-4">
      <SettingsAlert
        icon={<InfoIcon className="size-4" />}
        title={t("forkOnlyTitle")}
        action={
          <Button size="sm" onClick={onDuplicate} data-testid="template-duplicate">
            <CopyIcon className="mr-1.5 size-3.5" />
            {t("duplicate")}
          </Button>
        }
      >
        {t("forkOnlyBody")}
      </SettingsAlert>

      <ReadOnlyRow label={t("editorDescription")} value={template.description} />
      <ReadOnlyRow label={t("editorCategory")} value={t(`categories.${template.category}`)} />
      {template.taskTemplate ? (
        <div className="space-y-1">
          <Label className="text-xs">{t("editorTaskTemplate")}</Label>
          <pre className="max-h-60 overflow-auto rounded border bg-muted/40 p-2 font-mono text-[11px] whitespace-pre-wrap">
            {template.taskTemplate}
          </pre>
        </div>
      ) : null}
    </div>
  )
}

function ReadOnlyRow({ label, value }: { label: string; value?: string }) {
  if (!value) return null
  return (
    <div className="space-y-0.5">
      <Label className="text-xs">{label}</Label>
      <p className="text-xs text-muted-foreground">{value}</p>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Editable                                                           */
/* ------------------------------------------------------------------ */

function EditableView({
  template,
  nestingEnabled,
  onPersist,
  onDuplicate,
  onDelete,
  t,
  tCommon,
}: {
  template: SubAgentTemplate
  nestingEnabled: boolean
  onPersist: (next: SubAgentTemplate) => Promise<void>
  onDuplicate: () => void
  onDelete: () => void
  t: ReturnType<typeof useTranslations>
  tCommon: ReturnType<typeof useTranslations>
}) {
  const tPriority = useTranslations("agentPriority")
  const { reduce } = useFlowMotion()

  const persist = useCallback(
    async (next: SubAgentTemplate) => {
      if (!next.name.trim()) throw new Error(t("nameRequired"))
      await onPersist({ ...next, name: next.name.trim() })
    },
    [onPersist, t]
  )

  const policy = usePolicyDraft(template.id, template, persist)
  useReportPanelDirty(policy.isDirty)
  const { draft, patch } = policy

  const updateConfig = useCallback(
    (key: string, value: unknown) => patch({ config: { ...draft.config, [key]: value } }),
    [draft.config, patch]
  )

  const reach = reachability(draft)
  const railBlocked = dispatchRailUnavailable(reach, { nestingEnabled })
  const promptShadowed = taskTemplateOverridden(draft)
  const vars = useMemo(
    () => variableDiagnostics(draft.taskTemplate, draft.variables),
    [draft.taskTemplate, draft.variables]
  )

  const setVariable = (
    index: number,
    p: Partial<NonNullable<SubAgentTemplate["variables"]>[number]>
  ) => {
    const next = [...(draft.variables ?? [])]
    next[index] = { ...next[index], ...p }
    patch({ variables: next })
  }

  return (
    <motion.div
      className="space-y-4"
      variants={reduce ? undefined : STAGGER_CONTAINER}
      initial={reduce ? undefined : "hidden"}
      animate={reduce ? undefined : "visible"}
    >
      {/* Availability — the honest read-out of what dispatch will do. */}
      <motion.div variants={reduce ? undefined : STAGGER_CHILD} className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <Badge
            variant={reach === "disabled" ? "outline" : "secondary"}
            className="text-[10px]"
            data-testid={`template-reach-${reach}`}
          >
            {t(`reach.${reach}`)}
          </Badge>
          {draft.hidden ? (
            <Badge variant="outline" className="text-[10px]">
              {t("hiddenBadge")}
            </Badge>
          ) : null}
        </div>

        <div className="flex items-center justify-between gap-4 rounded-md border p-3">
          <div className="space-y-0.5">
            <Label htmlFor="template-enabled" className="text-sm">
              {t("enabledLabel")}
            </Label>
            <p className="text-xs text-muted-foreground">{t("enabledHint")}</p>
          </div>
          <Switch
            id="template-enabled"
            checked={!draft.disabled}
            onCheckedChange={(on) => patch({ disabled: on ? undefined : true })}
            aria-label={t("enabledLabel")}
          />
        </div>

        <div className="flex items-center justify-between gap-4 rounded-md border p-3">
          <div className="space-y-0.5">
            <Label htmlFor="template-hidden" className="text-sm">
              {t("hiddenLabel")}
            </Label>
            <p className="text-xs text-muted-foreground">{t("hiddenHint")}</p>
          </div>
          <Switch
            id="template-hidden"
            checked={draft.hidden === true}
            onCheckedChange={(on) => patch({ hidden: on ? true : undefined })}
            aria-label={t("hiddenLabel")}
            disabled={draft.disabled === true}
          />
        </div>

        {railBlocked ? (
          <div data-testid="template-rail-blocked">
            <SettingsAlert
              variant="destructive"
              icon={<AlertTriangleIcon className="size-4" />}
              title={t("railBlockedTitle")}
            >
              {t("railBlockedBody")}
            </SettingsAlert>
          </div>
        ) : reach === "dispatch-only" ? (
          <div data-testid="template-dispatch-only">
            <SettingsAlert icon={<InfoIcon className="size-4" />} title={t("dispatchOnlyTitle")}>
              {t("dispatchOnlyBody")}
            </SettingsAlert>
          </div>
        ) : null}
      </motion.div>

      {/* Identity */}
      <motion.div variants={reduce ? undefined : STAGGER_CHILD} className="space-y-3">
        <div className="space-y-1">
          <Label className="text-xs">{t("editorName")}</Label>
          <Input
            value={draft.name}
            onChange={(e) => patch({ name: e.target.value })}
            placeholder={t("editorNamePlaceholder")}
            data-testid="editor-name"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">{t("editorDescription")}</Label>
          <Textarea
            rows={2}
            value={draft.description}
            onChange={(e) => patch({ description: e.target.value })}
            className="text-xs"
            data-testid="editor-description"
          />
        </div>
        <div className="grid gap-3 @md/subagent-pane:grid-cols-2">
          <div className="space-y-1">
            <Label className="text-xs">{t("editorIcon")}</Label>
            <Input
              value={draft.icon ?? ""}
              onChange={(e) => patch({ icon: e.target.value || undefined })}
              placeholder={t("editorIconPlaceholder")}
              data-testid="editor-icon"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">{t("editorCategory")}</Label>
            <Select
              value={draft.category}
              onValueChange={(v) => patch({ category: v as SubAgentTemplate["category"] })}
            >
              <SelectTrigger data-testid="editor-category">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CATEGORIES.map((c) => (
                  <SelectItem key={c} value={c}>
                    {t(`categories.${c}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </motion.div>

      {/* Prompt — with the override read-out */}
      <motion.div variants={reduce ? undefined : STAGGER_CHILD} className="space-y-2">
        {promptShadowed ? (
          <div data-testid="template-prompt-shadowed">
            <SettingsAlert
              variant="destructive"
              icon={<AlertTriangleIcon className="size-4" />}
              title={t("promptShadowedTitle")}
            >
              {t("promptShadowedBody")}
            </SettingsAlert>
          </div>
        ) : null}
        <div className="space-y-1">
          <Label className="text-xs">{t("editorTaskTemplate")}</Label>
          <Textarea
            rows={4}
            value={draft.taskTemplate}
            onChange={(e) => patch({ taskTemplate: e.target.value })}
            className="font-mono text-xs"
            placeholder={t("editorTaskTemplatePlaceholder")}
            data-testid="editor-task-template"
          />
        </div>
        {vars.undeclared.length > 0 ? (
          <p className="text-[11px] text-destructive" data-testid="template-vars-undeclared">
            {t("varsUndeclared", { names: vars.undeclared.join(", ") })}
          </p>
        ) : null}
        {vars.unused.length > 0 ? (
          <p className="text-[11px] text-muted-foreground" data-testid="template-vars-unused">
            {t("varsUnused", { names: vars.unused.join(", ") })}
          </p>
        ) : null}
      </motion.div>

      {/* Variables */}
      <motion.div variants={reduce ? undefined : STAGGER_CHILD} className="space-y-2">
        <Label className="text-xs">{t("editorVariables")}</Label>
        {(draft.variables ?? []).map((v, i) => (
          <div
            key={i}
            className="space-y-2 rounded border p-2"
            data-testid={`editor-variable-row-${i}`}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-[10px] font-medium text-muted-foreground">
                {t("variableIndex", { index: i + 1 })}
              </span>
              <Button
                variant="ghost"
                size="icon"
                className="size-6"
                onClick={() => {
                  const next = [...(draft.variables ?? [])]
                  next.splice(i, 1)
                  patch({ variables: next.length > 0 ? next : undefined })
                }}
                aria-label={t("editorRemoveVariable")}
                data-testid={`editor-variable-remove-${i}`}
              >
                <XIcon className="size-3" />
              </Button>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Input
                value={v.name}
                onChange={(e) => setVariable(i, { name: e.target.value })}
                placeholder={t("editorVariableNamePlaceholder")}
                className="h-7 text-xs"
                aria-label={t("editorVariableName")}
                data-testid={`editor-var-name-${i}`}
              />
              <Input
                value={v.description}
                onChange={(e) => setVariable(i, { description: e.target.value })}
                placeholder={t("editorVariableDescriptionPlaceholder")}
                className="h-7 text-xs"
                aria-label={t("editorVariableDescription")}
                data-testid={`editor-var-desc-${i}`}
              />
            </div>
            <div className="flex items-center gap-3">
              <label className="flex cursor-pointer items-center gap-1.5">
                <Checkbox
                  checked={v.required}
                  onCheckedChange={(c) => setVariable(i, { required: !!c })}
                  data-testid={`editor-var-required-${i}`}
                />
                <span className="text-[10px]">{t("editorVariableRequired")}</span>
              </label>
              <Input
                value={v.defaultValue ?? ""}
                onChange={(e) => setVariable(i, { defaultValue: e.target.value || undefined })}
                placeholder={t("editorVariableDefaultValue")}
                className="h-7 flex-1 text-xs"
                aria-label={t("editorVariableDefaultValue")}
                data-testid={`editor-var-default-${i}`}
              />
            </div>
          </div>
        ))}
        <Button
          variant="outline"
          size="sm"
          onClick={() =>
            patch({
              variables: [
                ...(draft.variables ?? []),
                { name: "", description: "", required: false },
              ],
            })
          }
          data-testid="editor-add-variable"
        >
          <PlusIcon className="mr-1 size-3" />
          {t("editorAddVariable")}
        </Button>
      </motion.div>

      {/* Tools — the knob the old editor could not write at all */}
      <motion.div variants={reduce ? undefined : STAGGER_CHILD}>
        <ToolScopeField
          label={t("toolsLabel")}
          description={t("toolsHint")}
          value={draft.config?.tools}
          onChange={(tools) => updateConfig("tools", tools)}
          testId="template-tools"
        />
      </motion.div>

      {/* Advanced */}
      <motion.div variants={reduce ? undefined : STAGGER_CHILD}>
        <SettingsGroup title={t("configTitle")} defaultOpen={false}>
          <div className="grid gap-3 @md/subagent-pane:grid-cols-2">
            <div className="space-y-1">
              <Label className="text-xs">{t("editorMaxSteps")}</Label>
              <Input
                type="number"
                min={1}
                max={100}
                value={draft.config?.maxSteps ?? ""}
                onChange={(e) =>
                  updateConfig("maxSteps", e.target.value ? Number(e.target.value) : undefined)
                }
                className="h-8 text-xs"
                aria-label={t("editorMaxSteps")}
                data-testid="editor-max-steps"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">{t("editorTimeout")}</Label>
              <Input
                type="number"
                min={1000}
                step={1000}
                value={draft.config?.timeout ?? ""}
                onChange={(e) =>
                  updateConfig("timeout", e.target.value ? Number(e.target.value) : undefined)
                }
                className="h-8 text-xs"
                aria-label={t("editorTimeout")}
                data-testid="editor-timeout"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">{t("editorPriority")}</Label>
              <Select
                value={draft.config?.priority ?? ""}
                onValueChange={(v) => updateConfig("priority", v || undefined)}
              >
                <SelectTrigger className="h-8 text-xs" data-testid="editor-priority">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PRIORITIES.map((p) => (
                    <SelectItem key={p} value={p}>
                      {tPriority(SUB_AGENT_PRIORITY_CONFIG[p].labelKey)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">{t("editorTemperature")}</Label>
              <Input
                type="number"
                min={0}
                max={2}
                step={0.1}
                value={draft.config?.temperature ?? ""}
                onChange={(e) =>
                  updateConfig("temperature", e.target.value ? Number(e.target.value) : undefined)
                }
                className="h-8 text-xs"
                aria-label={t("editorTemperature")}
                data-testid="editor-temperature"
              />
            </div>
          </div>

          <div className="space-y-1">
            <Label className="text-xs">{t("editorProviderModel")}</Label>
            <div className="flex items-center gap-2">
              <ProviderModelCombobox
                providerId={draft.config?.provider}
                modelId={draft.config?.model}
                onSelect={(providerId, modelId) =>
                  patch({
                    config: {
                      ...draft.config,
                      provider: providerId as ProviderName,
                      model: modelId,
                    },
                  })
                }
                className="flex-1"
              />
              {draft.config?.provider || draft.config?.model ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-8 px-2 text-xs"
                  onClick={() =>
                    patch({ config: { ...draft.config, provider: undefined, model: undefined } })
                  }
                  data-testid="editor-model-clear"
                >
                  {t("editorModelClear")}
                </Button>
              ) : null}
            </div>
            <p className="text-[11px] text-muted-foreground">{t("editorProviderModelHint")}</p>
          </div>

          <div className="space-y-1">
            <Label className="text-xs">{t("editorSystemPrompt")}</Label>
            <Textarea
              rows={3}
              value={draft.config?.systemPrompt ?? ""}
              onChange={(e) => updateConfig("systemPrompt", e.target.value || undefined)}
              className="text-xs"
              placeholder={t("editorSystemPromptPlaceholder")}
              aria-label={t("editorSystemPrompt")}
              data-testid="editor-system-prompt"
            />
          </div>

          <div className="space-y-1">
            <Label className="text-xs">{t("editorExternalRuntime")}</Label>
            <Select
              value={draft.config?.externalPresetId ?? EXTERNAL_NONE_VALUE}
              onValueChange={(v) =>
                updateConfig("externalPresetId", v === EXTERNAL_NONE_VALUE ? undefined : v)
              }
            >
              <SelectTrigger className="h-8 text-xs" data-testid="editor-external-runtime">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={EXTERNAL_NONE_VALUE}>{t("externalRuntimeNone")}</SelectItem>
                {BUILTIN_EXECUTABLE_PRESET_IDS.map((id) => (
                  <SelectItem key={id} value={id}>
                    {getPresetDisplayInfo(id)?.name ?? id}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-[11px] text-muted-foreground">{t("editorExternalRuntimeHint")}</p>
          </div>

          <ToolScopeField
            label={t("mcpLabel")}
            description={t("mcpHint")}
            value={draft.config?.mcpServerIds}
            onChange={(ids) => updateConfig("mcpServerIds", ids)}
            sources={["mcp"]}
            testId="template-mcp"
          />

          <div className="flex items-start gap-2">
            <Checkbox
              id="editor-allow-nesting"
              checked={draft.config?.allowNesting === true}
              onCheckedChange={(v) => updateConfig("allowNesting", v === true ? true : undefined)}
              data-testid="editor-allow-nesting"
            />
            <div className="space-y-0.5">
              <Label htmlFor="editor-allow-nesting" className="text-xs">
                {t("editorAllowNesting")}
              </Label>
              <p className="text-[11px] text-muted-foreground">{t("editorAllowNestingHint")}</p>
            </div>
          </div>
          {draft.config?.allowNesting === true ? (
            <div className="space-y-1">
              <Label className="text-xs">{t("editorMaxNestingDepth")}</Label>
              <Input
                type="number"
                min={1}
                max={5}
                value={draft.config?.maxNestingDepth ?? ""}
                onChange={(e) =>
                  updateConfig(
                    "maxNestingDepth",
                    e.target.value ? Number(e.target.value) : undefined
                  )
                }
                className="h-8 text-xs"
                aria-label={t("editorMaxNestingDepth")}
                data-testid="editor-max-nesting-depth"
              />
            </div>
          ) : null}
        </SettingsGroup>
      </motion.div>

      {/* Destructive / duplicate */}
      <motion.div
        variants={reduce ? undefined : STAGGER_CHILD}
        className="flex items-center gap-2 border-t pt-3"
      >
        <Button variant="outline" size="sm" onClick={onDuplicate} data-testid="template-duplicate">
          <CopyIcon className="mr-1.5 size-3.5" />
          {t("duplicate")}
        </Button>
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="text-destructive hover:text-destructive"
              data-testid="template-delete"
            >
              <Trash2Icon className="mr-1.5 size-3.5" />
              {tCommon("delete")}
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t("removeTitle")}</AlertDialogTitle>
              <AlertDialogDescription>
                {t("removeBody", { name: draft.name })}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{tCommon("cancel")}</AlertDialogCancel>
              <AlertDialogAction onClick={onDelete} data-testid="template-delete-confirm">
                {tCommon("delete")}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </motion.div>

      <div className="sticky bottom-0 z-10 pt-2">
        <UnsavedBar
          status={policy.status}
          count={policy.dirtyCount}
          onSave={policy.save}
          onDiscard={policy.discard}
        />
      </div>
    </motion.div>
  )
}
