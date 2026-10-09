"use client"

import { useState } from "react"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import { toast } from "sonner"
import { PencilIcon, PlayIcon, PlusIcon, StarIcon, Trash2Icon } from "lucide-react"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Skeleton } from "@/components/ui/skeleton"
import { Textarea } from "@/components/ui/textarea"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { GoalQuickCreateDialog } from "@/components/goal/goal-quick-create-dialog"
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
 *
 * One list with hairline rows rather than a bordered box per template, and
 * every row says what it does on hover: Use (opens New goal with the template
 * picked), Edit, Delete (asks first — it used to delete on the first click).
 * The editor opens inline above the list, in place of a row, so the page does
 * not grow a second frame.
 */
export function GoalTemplatesManager() {
  const t = useTranslations("goal")
  const templates = useLiveQuery(() => listGoalTemplates(), [])
  const [editor, setEditor] = useState<EditorState | null>(null)
  const [pendingDelete, setPendingDelete] = useState<GoalTemplate | null>(null)
  const [useTemplateId, setUseTemplateId] = useState<string | null>(null)

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
    try {
      await upsertGoalTemplate(row)
      setEditor(null)
      toast.success(t("templates.saved"))
    } catch (error) {
      toast.error(t("templates.saveFailed"), {
        description: error instanceof Error ? error.message : String(error),
      })
    }
  }

  async function handleDelete(tpl: GoalTemplate) {
    try {
      await deleteGoalTemplate(tpl.id)
      setPendingDelete(null)
    } catch (error) {
      toast.error(t("templates.deleteFailed"), {
        description: error instanceof Error ? error.message : String(error),
      })
    }
  }

  async function toggleFavorite(tpl: GoalTemplate) {
    try {
      await setTemplateFavorite(tpl.id, !tpl.isFavorite)
    } catch (error) {
      toast.error(t("templates.saveFailed"), {
        description: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return (
    <div className="space-y-3" data-testid="goal-templates-manager">
      {/* The Configure panel above already says what templates are for. */}
      <div className="flex items-center justify-end gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={openNew}
          disabled={editor !== null}
          data-testid="goal-template-new"
        >
          <PlusIcon className="size-3.5" aria-hidden />
          {t("templates.add")}
        </Button>
      </div>

      {editor && (
        <div
          className="space-y-3 border-l-2 border-primary/50 py-1 pl-3"
          data-testid="goal-template-editor"
        >
          <div className="space-y-1">
            <Label htmlFor="goal-template-title" className="text-xs font-medium">
              {t("templates.titleField")}
            </Label>
            <Input
              id="goal-template-title"
              value={editor.title}
              onChange={(e) => setEditor({ ...editor, title: e.target.value })}
              data-testid="goal-template-title"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="goal-template-objective" className="text-xs font-medium">
              {t("templates.objectiveField")}
            </Label>
            <Textarea
              id="goal-template-objective"
              rows={3}
              value={editor.objectiveText}
              onChange={(e) => setEditor({ ...editor, objectiveText: e.target.value })}
              data-testid="goal-template-objective"
            />
          </div>
          {editor.source?.builtin ? (
            <p className="text-[11px] text-muted-foreground">{t("templates.cloneNote")}</p>
          ) : null}
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
        <div className="space-y-2" aria-busy>
          {Array.from({ length: 3 }, (_, index) => (
            <Skeleton key={index} className="h-12 w-full" />
          ))}
        </div>
      ) : templates.length === 0 ? (
        <p
          className="py-6 text-center text-sm text-muted-foreground"
          data-testid="goal-templates-empty"
        >
          {t("templates.empty")}
        </p>
      ) : (
        <ul
          className="divide-y divide-border/60 border-y border-border/60"
          data-testid="goal-templates-list"
        >
          {templates.map((tpl) => (
            <li
              key={tpl.id}
              className="group/template flex items-start gap-2 py-2.5 text-sm"
              data-testid="goal-template-row"
            >
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={t("templates.favorite")}
                aria-pressed={tpl.isFavorite}
                onClick={() => void toggleFavorite(tpl)}
                className="mt-0.5 size-6 shrink-0"
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
                <p className="line-clamp-2 text-xs text-muted-foreground" title={tpl.objectiveText}>
                  {tpl.objectiveText}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-0.5">
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2 text-xs"
                  onClick={() => setUseTemplateId(tpl.id)}
                  data-testid="goal-template-use"
                >
                  <PlayIcon className="size-3.5" aria-hidden />
                  {t("templates.use")}
                </Button>
                <RowIconButton
                  label={t("templates.edit")}
                  onClick={() => openEdit(tpl)}
                  testId="goal-template-edit"
                >
                  <PencilIcon className="size-3.5" aria-hidden />
                </RowIconButton>
                {!tpl.builtin && (
                  <RowIconButton
                    label={t("templates.delete")}
                    onClick={() => setPendingDelete(tpl)}
                    testId="goal-template-delete"
                    destructive
                  >
                    <Trash2Icon className="size-3.5" aria-hidden />
                  </RowIconButton>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(next) => !next && setPendingDelete(null)}
      >
        <AlertDialogContent data-testid="goal-template-delete-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>{t("templates.deleteTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("templates.deleteBody", { title: pendingDelete?.title ?? "" })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("templates.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => pendingDelete && void handleDelete(pendingDelete)}
              data-testid="goal-template-delete-confirm"
            >
              {t("templates.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {useTemplateId ? (
        <GoalQuickCreateDialog
          open
          onOpenChange={(next) => !next && setUseTemplateId(null)}
          initialTemplateId={useTemplateId}
          showTrigger={false}
        />
      ) : null}
    </div>
  )
}

function RowIconButton({
  label,
  onClick,
  testId,
  destructive = false,
  children,
}: {
  label: string
  onClick: () => void
  testId: string
  destructive?: boolean
  children: React.ReactNode
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          size="icon"
          variant="ghost"
          className={cn(
            "size-7 text-muted-foreground hover:text-foreground",
            destructive && "hover:text-destructive"
          )}
          aria-label={label}
          onClick={onClick}
          data-testid={testId}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

GoalTemplatesManager.displayName = "GoalTemplatesManager"
