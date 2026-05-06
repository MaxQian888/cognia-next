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
import { CopyIcon, DownloadIcon, PencilIcon, PlusIcon, Trash2Icon, NetworkIcon } from "lucide-react"
import { nanoid } from "nanoid"

import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card } from "@/components/ui/card"
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

import { useSubagentRuntimeStore } from "@/stores/agent/subagent-runtime-store"
import type { SubAgentTemplate } from "@/types/agent/sub-agent"
import { createLogger } from "@/lib/logger"
import { SubagentImportDialog } from "./subagent-import-dialog"

const log = createLogger("settings.subagents.templates")

const CATEGORIES: SubAgentTemplate["category"][] = [
  "research",
  "coding",
  "writing",
  "analysis",
  "general",
]

export function SubagentTemplatesTab() {
  const t = useTranslations("settings.subagents.templates")
  const tCommon = useTranslations("common")

  const templates = useSubagentRuntimeStore((s) => s.templates)
  const addTemplate = useSubagentRuntimeStore((s) => s.addTemplate)
  const updateTemplate = useSubagentRuntimeStore((s) => s.updateTemplate)
  const deleteTemplate = useSubagentRuntimeStore((s) => s.deleteTemplate)

  const [editing, setEditing] = useState<SubAgentTemplate | null>(null)
  const [creating, setCreating] = useState(false)
  const [importing, setImporting] = useState(false)

  const sortedTemplates = useMemo(() => {
    const all = Object.values(templates)
    return all.sort((a, b) => {
      const aBuilt = a.isBuiltIn ?? false
      const bBuilt = b.isBuiltIn ?? false
      if (aBuilt !== bBuilt) return aBuilt ? -1 : 1
      if (aBuilt && bBuilt && a.category !== b.category) {
        return a.category.localeCompare(b.category)
      }
      return a.name.localeCompare(b.name)
    })
  }, [templates])

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
      <div className="flex items-start justify-between gap-3">
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
            {t("import.trigger")}
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

      <SubagentImportDialog open={importing} onOpenChange={setImporting} />

      <div className="grid gap-2" data-testid="subagent-template-grid">
        {sortedTemplates.map((tpl) => (
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
      </div>

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
    </div>
  )
}

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

  return (
    <Card
      className="p-3"
      data-testid={`subagent-template-row-${template.id}`}
      data-builtin={template.isBuiltIn ? "true" : "false"}
    >
      <div className="flex items-start gap-3">
        <span
          className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-base"
          aria-hidden
        >
          {template.icon?.charAt(0) ?? template.name.charAt(0).toUpperCase()}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-medium">{template.name}</p>
            {template.isBuiltIn ? (
              <Badge variant="secondary" className="text-[10px]">
                {t("builtIn")}
              </Badge>
            ) : null}
            <Badge variant="outline" className="text-[10px]">
              {template.category}
            </Badge>
          </div>
          {template.description ? (
            <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
              {template.description}
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
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
      </div>
    </Card>
  )
}

interface EditorProps {
  initial: SubAgentTemplate
  submitLabel: string
  onCancel: () => void
  onSave: (template: SubAgentTemplate) => void
}

function TemplateEditor({ initial, submitLabel, onCancel, onSave }: EditorProps) {
  const t = useTranslations("settings.subagents.templates")
  const tCommon = useTranslations("common")
  const [draft, setDraft] = useState<SubAgentTemplate>(initial)

  const submit = () => {
    if (!draft.name.trim()) {
      toast.error(t("nameRequired"))
      return
    }
    onSave({ ...draft, name: draft.name.trim() })
  }

  return (
    <Card className="space-y-3 p-4" data-testid="subagent-template-editor">
      <div className="space-y-1">
        <Label className="text-xs">{t("editorName")}</Label>
        <Input
          value={draft.name}
          onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          placeholder={t("editorNamePlaceholder")}
          data-testid="editor-name"
        />
      </div>
      <div className="space-y-1">
        <Label className="text-xs">{t("editorDescription")}</Label>
        <Textarea
          rows={2}
          value={draft.description}
          onChange={(e) => setDraft({ ...draft, description: e.target.value })}
          className="text-xs"
        />
      </div>
      <div className="space-y-1">
        <Label className="text-xs">{t("editorCategory")}</Label>
        <Select
          value={draft.category}
          onValueChange={(v) => setDraft({ ...draft, category: v as SubAgentTemplate["category"] })}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {CATEGORIES.map((c) => (
              <SelectItem key={c} value={c}>
                {c}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
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
