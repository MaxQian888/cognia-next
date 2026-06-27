"use client"

/**
 * SubagentTemplatesTab — CRUD over `BUILT_IN_SUBAGENT_TEMPLATES` + user
 * forks. Mirrors the UX in `agent-team-templates-section.tsx`: built-ins
 * read-only, duplicate to fork, edit / delete only on user copies.
 *
 * Phase 6 of the ClaudeCode 完整化 plan.
 */

import { useMemo, useState, useCallback } from "react"
import { useTranslations } from "next-intl"
import {
  CopyIcon,
  DownloadIcon,
  PencilIcon,
  PlusIcon,
  Trash2Icon,
  NetworkIcon,
  SearchIcon,
  XIcon,
} from "lucide-react"
import { nanoid } from "nanoid"

import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
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
  SettingsCard,
  SettingsGrid,
  SettingsGroup,
  SettingsEmptyState,
  SettingsDivider,
} from "@/components/settings/common/settings-section"

import { useSubagentRuntimeStore } from "@/stores/agent/subagent-runtime-store"
import type { SubAgentTemplate, SubAgentPriority } from "@/types/agent/sub-agent"
import { SUB_AGENT_PRIORITY_CONFIG } from "@/types/agent/sub-agent"
import { createLogger } from "@/lib/logging"
import { SubagentImportDialog } from "./subagent-import-dialog"
import { ProviderModelCombobox } from "@/components/settings/provider/routing/provider-model-combobox"
import type { ProviderName } from "@cognia/provider-types/provider"
import { listSubagentEntries } from "@/lib/plugin/registries/subagent-registry"

const log = createLogger("settings.subagents.templates")

const CATEGORIES: SubAgentTemplate["category"][] = [
  "research",
  "coding",
  "writing",
  "analysis",
  "general",
]

const PRIORITIES: SubAgentPriority[] = ["critical", "high", "normal", "low", "background"]

export function SubagentTemplatesTab() {
  const t = useTranslations("settings.subagents.templates")
  const tImport = useTranslations("settings.subagents.import")
  const tCommon = useTranslations("common")
  const templates = useSubagentRuntimeStore((s) => s.templates)
  const addTemplate = useSubagentRuntimeStore((s) => s.addTemplate)
  const updateTemplate = useSubagentRuntimeStore((s) => s.updateTemplate)
  const deleteTemplate = useSubagentRuntimeStore((s) => s.deleteTemplate)

  const [editing, setEditing] = useState<SubAgentTemplate | null>(null)
  const [creating, setCreating] = useState(false)
  const [importing, setImporting] = useState(false)
  const [search, setSearch] = useState("")
  const [categoryFilter, setCategoryFilter] = useState<SubAgentTemplate["category"] | null>(null)

  const filteredTemplates = useMemo(() => {
    const all = Object.values(templates)
    let list = all

    if (categoryFilter) {
      list = list.filter((tpl) => tpl.category === categoryFilter)
    }

    if (search.trim()) {
      const q = search.toLowerCase()
      list = list.filter(
        (tpl) => tpl.name.toLowerCase().includes(q) || tpl.description.toLowerCase().includes(q)
      )
    }

    return list.sort((a, b) => {
      const aBuilt = a.isBuiltIn ?? false
      const bBuilt = b.isBuiltIn ?? false
      if (aBuilt !== bBuilt) return aBuilt ? -1 : 1
      if (aBuilt && bBuilt && a.category !== b.category) {
        return a.category.localeCompare(b.category)
      }
      return a.name.localeCompare(b.name)
    })
  }, [templates, categoryFilter, search])

  const handleDuplicate = useCallback(
    (source: SubAgentTemplate) => {
      const copy: SubAgentTemplate = {
        ...source,
        id: nanoid(),
        name: `${source.name} (copy)`,
        isBuiltIn: false,
      }
      addTemplate(copy)
      log.info("template_duplicated", { sourceId: source.id, newId: copy.id })
      toast.success(t("duplicatedToast", { name: copy.name }))
      setEditing(copy)
    },
    [addTemplate, t]
  )

  const handleDelete = useCallback(
    (template: SubAgentTemplate) => {
      if (template.isBuiltIn) return
      deleteTemplate(template.id)
      log.info("template_deleted", { id: template.id })
      toast.success(t("removedToast", { name: template.name }))
    },
    [deleteTemplate, t]
  )

  return (
    <div className="space-y-4">
      {/* Header with actions */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <Label className="flex items-center gap-2">
            <NetworkIcon className="size-4" />
            {t("title")}
          </Label>
          <p className="text-xs text-muted-foreground">{t("description")}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => setImporting(true)}
            data-testid="subagent-template-import"
          >
            <DownloadIcon className="mr-2 size-4" />
            {tImport("trigger")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setEditing(null)
              setCreating(true)
            }}
            data-testid="subagent-template-new"
          >
            <PlusIcon className="mr-2 size-4" />
            {t("newTemplate")}
          </Button>
        </div>
      </div>

      <SubagentImportDialog
        open={importing}
        onOpenChange={setImporting}
        onImported={() => setCreating(false)}
      />

      {/* Search + category filter bar */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative w-full sm:max-w-xs">
          <SearchIcon className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("searchPlaceholder")}
            className="h-8 pl-8 text-xs"
            data-testid="subagent-template-search"
          />
          {search && (
            <button
              onClick={() => setSearch("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              aria-label={tCommon("close")}
            >
              <XIcon className="size-3" />
            </button>
          )}
        </div>
        <div className="flex flex-wrap gap-1" data-testid="subagent-category-filter">
          <Badge
            variant={categoryFilter === null ? "default" : "outline"}
            className="cursor-pointer text-[10px]"
            onClick={() => setCategoryFilter(null)}
            data-testid="category-filter-all"
          >
            {t("filterAll")}
          </Badge>
          {CATEGORIES.map((cat) => (
            <Badge
              key={cat}
              variant={categoryFilter === cat ? "default" : "outline"}
              className="cursor-pointer text-[10px]"
              onClick={() => setCategoryFilter(cat)}
              data-testid={`category-filter-${cat}`}
            >
              {t(`categories.${cat}`)}
            </Badge>
          ))}
        </div>
      </div>

      {/* Empty states */}
      {filteredTemplates.length === 0 && (
        <SettingsEmptyState
          title={search || categoryFilter ? t("noResults") : t("noUserTemplates")}
          description={search || categoryFilter ? undefined : t("noUserTemplatesDescription")}
        />
      )}

      {/* Template grid */}
      <div data-testid="subagent-template-grid">
        <SettingsGrid columns={2}>
          {filteredTemplates.map((tpl) => (
            <TemplateRow
              key={tpl.id}
              template={tpl}
              editing={editing?.id === tpl.id}
              onEditStart={() => setEditing(tpl)}
              onEditCancel={() => setEditing(null)}
              onSave={(patch) => {
                updateTemplate(tpl.id, patch)
                setEditing(null)
                toast.success(t("updatedToast", { name: patch.name ?? tpl.name }))
              }}
              onDuplicate={() => handleDuplicate(tpl)}
              onDelete={() => handleDelete(tpl)}
              t={t}
              tCommon={tCommon}
            />
          ))}
        </SettingsGrid>
      </div>

      {/* Create editor */}
      {creating && (
        <TemplateEditor
          initial={{
            id: "",
            name: "",
            description: "",
            category: "general",
            taskTemplate: "",
            config: {},
            isBuiltIn: false,
          }}
          submitLabel={t("create")}
          onCancel={() => setCreating(false)}
          onSave={(draft) => {
            const newTemplate: SubAgentTemplate = {
              ...draft,
              id: nanoid(),
              isBuiltIn: false,
            }
            addTemplate(newTemplate)
            setCreating(false)
            toast.success(t("addedToast", { name: newTemplate.name }))
          }}
        />
      )}

      <PluginSubagentList t={t} />
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  PluginSubagentList — read-only listing of plugin overlay subagents */
/* ------------------------------------------------------------------ */

/**
 * Lists every subagent registered via the `subagent` plugin capability.
 * Plugin entries cannot be edited or deleted here — the source of truth
 * lives in the plugin manifest. Their runtime ids appear as
 * `<pluginId>:<defId>` in the team / workflow-editor dispatch surfaces.
 */
function PluginSubagentList({ t }: { t: ReturnType<typeof useTranslations> }) {
  const entries = useMemo(() => listSubagentEntries(), [])
  if (entries.length === 0) return null
  return (
    <div className="space-y-2" data-testid="plugin-subagent-list">
      <SettingsDivider />
      <Label className="text-sm font-medium">{t("pluginSection.title")}</Label>
      <p className="text-xs text-muted-foreground">{t("pluginSection.description")}</p>
      <div className="grid gap-2 sm:grid-cols-2">
        {entries.map((entry) => {
          const runtimeId = entry.pluginId ? `${entry.pluginId}:${entry.id}` : entry.id
          return (
            <Card key={runtimeId} className="p-3" data-testid={`plugin-subagent-row-${runtimeId}`}>
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-sm font-medium">{entry.entry.name}</p>
                    {entry.pluginId ? (
                      <Badge variant="secondary" className="text-[10px]">
                        {entry.pluginId}
                      </Badge>
                    ) : null}
                    {entry.entry.model ? (
                      <Badge variant="outline" className="font-mono text-[10px]">
                        {entry.entry.model}
                      </Badge>
                    ) : null}
                  </div>
                  {entry.entry.description ? (
                    <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                      {entry.entry.description}
                    </p>
                  ) : null}
                  <p className="mt-1 font-mono text-[10px] text-muted-foreground">{runtimeId}</p>
                </div>
              </div>
            </Card>
          )
        })}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  TemplateRow                                                        */
/* ------------------------------------------------------------------ */

interface RowProps {
  template: SubAgentTemplate
  editing: boolean
  onEditStart: () => void
  onEditCancel: () => void
  onSave: (patch: Partial<SubAgentTemplate>) => void
  onDuplicate: () => void
  onDelete: () => void
  t: ReturnType<typeof useTranslations>
  tCommon: ReturnType<typeof useTranslations>
}

function TemplateRow({
  template,
  editing,
  onEditStart,
  onEditCancel,
  onSave,
  onDuplicate,
  onDelete,
  t,
  tCommon,
}: RowProps) {
  if (editing) {
    return (
      <TemplateEditor
        initial={template}
        submitLabel={t("save")}
        onCancel={onEditCancel}
        onSave={(patch) => onSave(patch)}
      />
    )
  }

  const iconChar = template.icon?.charAt(0) ?? template.name.charAt(0).toUpperCase()

  return (
    <div
      data-testid={`subagent-template-row-${template.id}`}
      data-builtin={template.isBuiltIn ? "true" : "false"}
    >
      <SettingsCard
        icon={
          <span
            className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm"
            aria-hidden
          >
            {iconChar}
          </span>
        }
        title={template.name}
        description={template.description || undefined}
        badge={template.isBuiltIn ? t("builtIn") : undefined}
        badgeVariant={template.isBuiltIn ? "secondary" : "outline"}
        variant={template.isBuiltIn ? "ghost" : "default"}
        headerAction={
          <div className="flex items-center gap-1">
            <Badge variant="outline" className="text-[10px]">
              {t(`categories.${template.category}`)}
            </Badge>
          </div>
        }
      >
        {/* Template metadata summary */}
        <div className="flex flex-wrap items-center gap-2">
          {template.config?.model && (
            <span className="text-[11px] text-muted-foreground">{template.config.model}</span>
          )}
          {(template.variables?.length ?? 0) > 0 && (
            <span className="text-[11px] text-muted-foreground">
              {template.variables!.length} variable{template.variables!.length !== 1 ? "s" : ""}
            </span>
          )}
        </div>

        {/* Action buttons */}
        <div className="flex items-center gap-1 pt-2">
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            onClick={onEditStart}
            disabled={template.isBuiltIn}
            title={template.isBuiltIn ? t("builtInReadOnly") : t("edit")}
            aria-label={t("editAria", { name: template.name })}
            data-testid={`edit-${template.id}`}
          >
            <PencilIcon className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            onClick={onDuplicate}
            title={t("duplicate")}
            aria-label={t("duplicateAria", { name: template.name })}
            data-testid={`duplicate-${template.id}`}
          >
            <CopyIcon className="size-3.5" />
          </Button>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-7 text-destructive hover:text-destructive"
                disabled={template.isBuiltIn}
                title={template.isBuiltIn ? t("builtInReadOnly") : tCommon("delete")}
                aria-label={t("deleteAria", { name: template.name })}
                data-testid={`delete-${template.id}`}
              >
                <Trash2Icon className="size-3.5" />
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{t("removeTitle")}</AlertDialogTitle>
                <AlertDialogDescription>
                  {t("removeBody", { name: template.name })}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{tCommon("cancel")}</AlertDialogCancel>
                <AlertDialogAction onClick={onDelete}>{tCommon("delete")}</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </SettingsCard>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  TemplateEditor                                                     */
/* ------------------------------------------------------------------ */

interface EditorProps {
  initial: SubAgentTemplate
  submitLabel: string
  onCancel: () => void
  onSave: (template: SubAgentTemplate) => void
}

function TemplateEditor({ initial, submitLabel, onCancel, onSave }: EditorProps) {
  const t = useTranslations("settings.subagents.templates")
  const tCommon = useTranslations("common")
  const tPriority = useTranslations("agentPriority")
  const [draft, setDraft] = useState<SubAgentTemplate>(initial)

  const submit = () => {
    if (!draft.name.trim()) {
      toast.error(t("nameRequired"))
      return
    }
    onSave({ ...draft, name: draft.name.trim() })
  }

  const updateConfig = (key: string, value: unknown) => {
    setDraft({ ...draft, config: { ...draft.config, [key]: value } })
  }

  const addVariable = () => {
    const vars = draft.variables ?? []
    setDraft({
      ...draft,
      variables: [...vars, { name: "", description: "", required: false }],
    })
  }

  const updateVariable = (
    index: number,
    patch: Partial<{ name: string; description: string; required: boolean; defaultValue?: string }>
  ) => {
    const vars = [...(draft.variables ?? [])]
    vars[index] = { ...vars[index], ...patch }
    setDraft({ ...draft, variables: vars })
  }

  const removeVariable = (index: number) => {
    const vars = [...(draft.variables ?? [])]
    vars.splice(index, 1)
    setDraft({ ...draft, variables: vars.length > 0 ? vars : undefined })
  }

  return (
    <Card className="space-y-3 p-4" data-testid="subagent-template-editor">
      {/* Name */}
      <div className="space-y-1">
        <Label className="text-xs">{t("editorName")}</Label>
        <Input
          value={draft.name}
          onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          placeholder={t("editorNamePlaceholder")}
          data-testid="editor-name"
        />
      </div>

      {/* Description */}
      <div className="space-y-1">
        <Label className="text-xs">{t("editorDescription")}</Label>
        <Textarea
          rows={2}
          value={draft.description}
          onChange={(e) => setDraft({ ...draft, description: e.target.value })}
          className="text-xs"
        />
      </div>

      {/* Icon + Category row */}
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <Label className="text-xs">{t("editorIcon")}</Label>
          <Input
            value={draft.icon ?? ""}
            onChange={(e) => setDraft({ ...draft, icon: e.target.value || undefined })}
            placeholder={t("editorIconPlaceholder")}
            data-testid="editor-icon"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">{t("editorCategory")}</Label>
          <Select
            value={draft.category}
            onValueChange={(v) =>
              setDraft({ ...draft, category: v as SubAgentTemplate["category"] })
            }
          >
            <SelectTrigger>
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

      {/* Task template */}
      <div className="space-y-1">
        <Label className="text-xs">{t("editorTaskTemplate")}</Label>
        <Textarea
          rows={3}
          value={draft.taskTemplate}
          onChange={(e) => setDraft({ ...draft, taskTemplate: e.target.value })}
          className="font-mono text-xs"
          placeholder={t("editorTaskTemplatePlaceholder")}
          data-testid="editor-task-template"
        />
      </div>

      {/* Variables editor */}
      <SettingsDivider label={t("editorVariables")} />
      {(draft.variables ?? []).map((v, i) => (
        <div
          key={i}
          className="space-y-2 rounded border p-2"
          data-testid={`editor-variable-row-${i}`}
        >
          <div className="flex items-center justify-between gap-2">
            <span className="text-[10px] font-medium text-muted-foreground">Variable {i + 1}</span>
            <Button
              variant="ghost"
              size="icon"
              className="size-6"
              onClick={() => removeVariable(i)}
              title={t("editorRemoveVariable")}
              data-testid={`editor-variable-remove-${i}`}
            >
              <XIcon className="size-3" />
            </Button>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label className="text-[10px]">{t("editorVariableName")}</Label>
              <Input
                value={v.name}
                onChange={(e) => updateVariable(i, { name: e.target.value })}
                placeholder={t("editorVariableNamePlaceholder")}
                className="h-7 text-xs"
                data-testid={`editor-var-name-${i}`}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-[10px]">{t("editorVariableDescription")}</Label>
              <Input
                value={v.description}
                onChange={(e) => updateVariable(i, { description: e.target.value })}
                placeholder={t("editorVariableDescriptionPlaceholder")}
                className="h-7 text-xs"
                data-testid={`editor-var-desc-${i}`}
              />
            </div>
          </div>
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-1.5 cursor-pointer">
              <Checkbox
                checked={v.required}
                onCheckedChange={(c) => updateVariable(i, { required: !!c })}
                data-testid={`editor-var-required-${i}`}
              />
              <span className="text-[10px]">{t("editorVariableRequired")}</span>
            </label>
            <div className="flex-1 space-y-1">
              <Input
                value={v.defaultValue ?? ""}
                onChange={(e) => updateVariable(i, { defaultValue: e.target.value || undefined })}
                placeholder={t("editorVariableDefaultValue")}
                className="h-7 text-xs"
                data-testid={`editor-var-default-${i}`}
              />
            </div>
          </div>
        </div>
      ))}
      <Button variant="outline" size="sm" onClick={addVariable} data-testid="editor-add-variable">
        <PlusIcon className="mr-1 size-3" />
        {t("editorAddVariable")}
      </Button>

      {/* Advanced configuration */}
      <SettingsGroup title={t("configTitle")} defaultOpen={false}>
        <div className="grid grid-cols-2 gap-3">
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
              data-testid="editor-max-steps"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">{t("editorTimeout")}</Label>
            <div className="flex items-center gap-1">
              <Input
                type="number"
                min={1000}
                step={1000}
                value={draft.config?.timeout ?? ""}
                onChange={(e) =>
                  updateConfig("timeout", e.target.value ? Number(e.target.value) : undefined)
                }
                className="h-8 text-xs flex-1"
                data-testid="editor-timeout"
              />
              <span className="text-[10px] text-muted-foreground shrink-0">
                {t("editorTimeoutUnit")}
              </span>
            </div>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <Label className="text-xs">{t("editorPriority")}</Label>
            <Select
              value={draft.config?.priority ?? ""}
              onValueChange={(v) =>
                updateConfig("priority", v ? (v as SubAgentPriority) : undefined)
              }
            >
              <SelectTrigger className="h-8 text-xs">
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
                setDraft((d) => ({
                  ...d,
                  config: { ...d.config, provider: providerId as ProviderName, model: modelId },
                }))
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
                  setDraft((d) => ({
                    ...d,
                    config: { ...d.config, provider: undefined, model: undefined },
                  }))
                }
                data-testid="editor-model-clear"
              >
                {t("editorModelClear")}
              </Button>
            ) : null}
          </div>
          <p className="text-muted-foreground text-xs">{t("editorProviderModelHint")}</p>
        </div>
        <div className="space-y-1">
          <Label className="text-xs">{t("editorSystemPrompt")}</Label>
          <Textarea
            rows={2}
            value={draft.config?.systemPrompt ?? ""}
            onChange={(e) => updateConfig("systemPrompt", e.target.value || undefined)}
            className="text-xs"
            placeholder={t("editorSystemPromptPlaceholder")}
            data-testid="editor-system-prompt"
          />
        </div>
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
                updateConfig("maxNestingDepth", e.target.value ? Number(e.target.value) : undefined)
              }
              className="h-8 text-xs"
              data-testid="editor-max-nesting-depth"
            />
          </div>
        ) : null}
      </SettingsGroup>

      {/* Action buttons */}
      <div className="flex justify-end gap-2 pt-1">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          {tCommon("cancel")}
        </Button>
        <Button size="sm" onClick={submit} data-testid="editor-submit">
          {submitLabel}
        </Button>
      </div>
    </Card>
  )
}
