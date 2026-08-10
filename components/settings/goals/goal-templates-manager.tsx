"use client"

import { useState } from "react"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import { StarIcon, PencilIcon, Trash2Icon, PlusIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import type { GoalTemplate } from "@/types/goal"
import {
  deleteGoalTemplate,
  listGoalTemplates,
  setTemplateFavorite,
  upsertGoalTemplate,
} from "@/lib/db/goal-templates"

interface EditorState {
  /** Source row when editing; null for a brand-new template. */
  source: GoalTemplate | null
  title: string
  objectiveText: string
}

/**
 * CRUD manager for goal templates (ADR-0019 Phase 2). Built-ins are
 * clone-on-edit (editing one creates a new user copy) and cannot be deleted.
 */
export function GoalTemplatesManager() {
  const t = useTranslations("goal")
  const templates = useLiveQuery(() => listGoalTemplates(), [])
  const [editor, setEditor] = useState<EditorState | null>(null)

  function openNew() {
    setEditor({ source: null, title: "", objectiveText: "" })
  }

  function openEdit(tpl: GoalTemplate) {
    setEditor({ source: tpl, title: tpl.title, objectiveText: tpl.objectiveText })
  }

  async function handleSave() {
    if (!editor) return
    const title = editor.title.trim()
    const objectiveText = editor.objectiveText.trim()
    if (!title || !objectiveText) return
    const src = editor.source
    // Clone-on-edit for built-ins: never mutate a seeded row in place.
    const isClone = !src || src.builtin
    const now = Date.now()
    const row: GoalTemplate = {
      id: isClone ? `gtpl_${crypto.randomUUID()}` : src.id,
      title,
      objectiveText,
      configOverrides: src?.configOverrides,
      builtin: false,
      isFavorite: src?.isFavorite ?? false,
      sortOrder: src?.sortOrder ?? templates?.length ?? 0,
      createdAt: src && !isClone ? src.createdAt : now,
      updatedAt: now,
    }
    await upsertGoalTemplate(row)
    setEditor(null)
  }

  return (
    <div className="space-y-3" data-testid="goal-templates-manager">
      <div className="flex items-center justify-between">
        <h3 className="font-medium">{t("templates.heading")}</h3>
        <Button size="sm" variant="outline" onClick={openNew} data-testid="goal-template-new">
          <PlusIcon className="size-3.5" aria-hidden />
          {t("templates.add")}
        </Button>
      </div>

      {editor && (
        <div className="space-y-2 rounded-md border p-3" data-testid="goal-template-editor">
          <div>
            <Label className="text-xs font-medium">{t("templates.titleField")}</Label>
            <Input
              value={editor.title}
              onChange={(e) => setEditor({ ...editor, title: e.target.value })}
              data-testid="goal-template-title"
            />
          </div>
          <div>
            <Label className="text-xs font-medium">{t("templates.objectiveField")}</Label>
            <Textarea
              rows={3}
              value={editor.objectiveText}
              onChange={(e) => setEditor({ ...editor, objectiveText: e.target.value })}
              data-testid="goal-template-objective"
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setEditor(null)}>
              {t("templates.cancel")}
            </Button>
            <Button
              size="sm"
              disabled={!editor.title.trim() || !editor.objectiveText.trim()}
              onClick={() => void handleSave()}
              data-testid="goal-template-save"
            >
              {t("templates.save")}
            </Button>
          </div>
        </div>
      )}

      {!templates ? (
        <p className="text-sm text-muted-foreground">{t("activity.loading")}</p>
      ) : templates.length === 0 ? (
        <p
          className="rounded-md border border-dashed bg-muted/30 p-4 text-sm text-muted-foreground"
          data-testid="goal-templates-empty"
        >
          {t("templates.empty")}
        </p>
      ) : (
        <ul className="space-y-2" data-testid="goal-templates-list">
          {templates.map((tpl) => (
            <li
              key={tpl.id}
              className="flex items-start gap-2 rounded-md border bg-card px-3 py-2 text-sm"
              data-testid="goal-template-row"
            >
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={t("templates.favorite")}
                onClick={() => void setTemplateFavorite(tpl.id, !tpl.isFavorite)}
                className="mt-0.5 size-6"
                data-testid="goal-template-favorite"
              >
                <StarIcon
                  className={cn(
                    "size-4",
                    tpl.isFavorite ? "fill-amber-400 text-amber-400" : "text-muted-foreground"
                  )}
                  aria-hidden
                />
              </Button>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate font-medium">{tpl.title}</span>
                  {tpl.builtin && (
                    <Badge variant="outline" className="text-[10px]">
                      {t("templates.builtinBadge")}
                    </Badge>
                  )}
                </div>
                <p className="truncate text-xs text-muted-foreground" title={tpl.objectiveText}>
                  {tpl.objectiveText}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-7"
                  aria-label={t("templates.edit")}
                  onClick={() => openEdit(tpl)}
                  data-testid="goal-template-edit"
                >
                  <PencilIcon className="size-3.5" aria-hidden />
                </Button>
                {!tpl.builtin && (
                  <Button
                    size="icon"
                    variant="ghost"
                    className="size-7"
                    aria-label={t("templates.delete")}
                    onClick={() => void deleteGoalTemplate(tpl.id)}
                    data-testid="goal-template-delete"
                  >
                    <Trash2Icon className="size-3.5" aria-hidden />
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

GoalTemplatesManager.displayName = "GoalTemplatesManager"
