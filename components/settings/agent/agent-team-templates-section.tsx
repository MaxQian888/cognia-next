"use client"

/**
 * AgentTeamTemplatesSection — Settings panel for agent-team templates.
 *
 * Surfaces both the eight built-in templates (seeded into the store via
 * `builtInTemplatesMap` in `initial-state.ts`) and any user-created templates,
 * with the same built-in / duplicate-to-fork / edit / delete UX used by
 * `teams-section.tsx` for character teams. The store already enforces the
 * built-in guards (deleteTemplate / updateTemplate refuse to mutate
 * `isBuiltIn: true` rows; importTemplates skips conflicts), so this panel is
 * a thin UI layer over the existing actions — no new store actions needed.
 *
 * Picking "Use" instantiates a team via `createTeam` + `addTeammate` (mirroring
 * `app/agent-teams/page.tsx:onPickTemplate`) and routes to the workspace
 * via the static search-param route.
 */

import { useMemo, useState, useCallback } from "react"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { CopyIcon, PencilIcon, PlayIcon, PlusIcon, Trash2Icon, UsersIcon } from "lucide-react"
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

import { useAgentTeamStore } from "@/stores/agent/agent-team-store"
import type { AgentTeamTemplate } from "@/types/agent/agent-team"
import { createLogger } from "@/lib/logger"

const log = createLogger("settings.agent-teams")

const CATEGORIES: AgentTeamTemplate["category"][] = [
  "review",
  "research",
  "development",
  "debugging",
  "analysis",
  "general",
  "documentation",
  "security",
]

export function AgentTeamTemplatesSection() {
  const t = useTranslations("settings.agentTeams")
  const tCommon = useTranslations("common")
  const router = useRouter()

  const templates = useAgentTeamStore((s) => s.templates)
  const createTeam = useAgentTeamStore((s) => s.createTeam)
  const addTeammate = useAgentTeamStore((s) => s.addTeammate)
  const addTemplate = useAgentTeamStore((s) => s.addTemplate)
  const updateTemplate = useAgentTeamStore((s) => s.updateTemplate)
  const deleteTemplate = useAgentTeamStore((s) => s.deleteTemplate)

  const [editing, setEditing] = useState<AgentTeamTemplate | null>(null)
  const [creating, setCreating] = useState(false)

  // Built-ins first, then user templates by name. Within built-ins, group by
  // category so related templates sit together.
  const sortedTemplates = useMemo(() => {
    const all = Object.values(templates)
    return all.sort((a, b) => {
      const aBuiltIn = a.isBuiltIn ?? false
      const bBuiltIn = b.isBuiltIn ?? false
      if (aBuiltIn !== bBuiltIn) return aBuiltIn ? -1 : 1
      if (aBuiltIn && bBuiltIn && a.category !== b.category) {
        return a.category.localeCompare(b.category)
      }
      return a.name.localeCompare(b.name)
    })
  }, [templates])

  const handleUse = useCallback(
    (template: AgentTeamTemplate) => {
      const team = createTeam({
        name: template.name,
        description: template.description,
        task: template.description,
        config: template.config,
      })
      for (const tm of template.teammates) {
        addTeammate({
          teamId: team.id,
          name: tm.name,
          description: tm.description,
          role: "teammate",
          config: tm.config,
        })
      }
      log.info("template_used", { templateId: template.id, teamId: team.id })
      router.push(`/agent-teams/workspace?teamId=${team.id}`)
    },
    [addTeammate, createTeam, router]
  )

  const handleDuplicate = useCallback(
    (source: AgentTeamTemplate) => {
      // Built-ins live in initial-state and are read-only via the store
      // guards; for user templates, the store also accepts a fresh row.
      // Either way, addTemplate is the right call — clone, mint id, force
      // isBuiltIn=false, suffix the name.
      const copy: AgentTeamTemplate = {
        ...source,
        id: nanoid(),
        name: `${source.name} (copy)`,
        teammates: source.teammates.map((tm) => ({ ...tm })),
        isBuiltIn: false,
      }
      addTemplate(copy)
      log.info("template_duplicated", { sourceId: source.id, newId: copy.id })
      toast.success(t("duplicatedToast", { name: copy.name }))
      // Drop straight into the editor so the user can rename / tweak.
      setEditing(copy)
    },
    [addTemplate, t]
  )

  const handleDelete = useCallback(
    (template: AgentTeamTemplate) => {
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
            <UsersIcon className="size-4" />
            {t("title")}
          </Label>
          <p className="text-xs text-muted-foreground">{t("description")}</p>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            setEditing(null)
            setCreating(true)
          }}
        >
          <PlusIcon className="mr-2 size-4" />
          {t("newTemplate")}
        </Button>
      </div>

      <div className="grid gap-2" data-testid="agent-team-templates-grid">
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
            onUse={() => handleUse(tpl)}
            onDuplicate={() => handleDuplicate(tpl)}
            onDelete={() => handleDelete(tpl)}
            tCommon={tCommon}
            t={t}
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
            teammates: [],
            isBuiltIn: false,
          }}
          submitLabel={t("create")}
          onCancel={() => setCreating(false)}
          onSave={(draft) => {
            const newTemplate: AgentTeamTemplate = {
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

// ---- Row ------------------------------------------------------------------

interface RowProps {
  template: AgentTeamTemplate
  editing: boolean
  onEditStart: () => void
  onEditCancel: () => void
  onSave: (patch: Partial<AgentTeamTemplate>) => void
  onUse: () => void
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
  onUse,
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
      data-testid={`agent-team-template-row-${template.id}`}
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
            {template.isBuiltIn && (
              <Badge variant="secondary" className="text-[10px]">
                {t("builtIn")}
              </Badge>
            )}
            <Badge variant="outline" className="text-[10px]">
              {template.category}
            </Badge>
          </div>
          {template.description && (
            <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
              {template.description}
            </p>
          )}
          <p className="mt-1 text-[11px] text-muted-foreground">
            {t("teammateCount", { count: template.teammates.length })}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            onClick={onUse}
            aria-label={t("useAria", { name: template.name })}
            title={t("useTemplate")}
            data-testid={`use-${template.id}`}
          >
            <PlayIcon className="size-3.5" />
          </Button>
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

// ---- Inline editor --------------------------------------------------------

interface EditorProps {
  initial: AgentTeamTemplate
  submitLabel: string
  onCancel: () => void
  onSave: (template: AgentTeamTemplate) => void
}

function TemplateEditor({ initial, submitLabel, onCancel, onSave }: EditorProps) {
  const t = useTranslations("settings.agentTeams")
  const tCommon = useTranslations("common")
  const [draft, setDraft] = useState<AgentTeamTemplate>(initial)

  const submit = () => {
    if (!draft.name.trim()) {
      toast.error(t("nameRequired"))
      return
    }
    onSave({ ...draft, name: draft.name.trim() })
  }

  return (
    <Card className="space-y-3 p-4" data-testid="agent-team-template-editor">
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
          rows={3}
          value={draft.description}
          onChange={(e) => setDraft({ ...draft, description: e.target.value })}
          className="text-xs"
          placeholder={t("editorDescriptionPlaceholder")}
        />
      </div>
      <div className="space-y-1">
        <Label className="text-xs">{t("editorCategory")}</Label>
        <Select
          value={draft.category}
          onValueChange={(v) =>
            setDraft({ ...draft, category: v as AgentTeamTemplate["category"] })
          }
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
      <p className="text-[11px] text-muted-foreground">
        {t("teammateEditNote", { count: draft.teammates.length })}
      </p>
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

export default AgentTeamTemplatesSection
