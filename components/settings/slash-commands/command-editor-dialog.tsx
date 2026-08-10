"use client"

/**
 * CommandEditorDialog — create / edit a custom slash-command markdown file.
 *
 * Stage 3 (Phase 7c) of the ClaudeCode 完整化 plan. Persistence goes through
 * `lib/slash-commands/custom:saveCustomSlashCommand`, which writes via
 * `@tauri-apps/plugin-fs`. In web mode the form is read-only with a banner —
 * the Settings UI also gates the trigger button behind `isTauri()`.
 */

import { useEffect, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { XIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { toast } from "sonner"

import {
  assertValidCommandName,
  buildCommandFile,
  saveCustomSlashCommand,
  type SaveCustomCommandInput,
} from "@/lib/slash-commands/custom"
import type { SlashCommand } from "@/lib/slash-commands/builtin"
import { isTauri } from "@/lib/tauri"

export type CommandEditorMode = "create" | "edit"

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Pre-populates the form when editing an existing command. */
  initial?: SlashCommand | null
  /** Active session cwd for project-scope commands; null when not available. */
  cwd?: string | null
  /** Called after a successful save with the absolute file path. */
  onSaved?: (filePath: string) => void
}

interface FormState {
  name: string
  scope: "user" | "project"
  description: string
  argumentHint: string
  model: string
  allowedToolDraft: string
  allowedTools: string[]
  body: string
}

const EMPTY: FormState = {
  name: "",
  scope: "user",
  description: "",
  argumentHint: "",
  model: "",
  allowedToolDraft: "",
  allowedTools: [],
  body: "",
}

export function CommandEditorDialog({ open, onOpenChange, initial, cwd, onSaved }: Props) {
  const t = useTranslations("settings.slashCommands.editor")
  const desktop = isTauri()
  const isEdit = !!initial

  const [form, setForm] = useState<FormState>(EMPTY)
  const [busy, setBusy] = useState(false)

  // Mirror the incoming `initial` into local state on every open. Reset to
  // EMPTY when creating a fresh command so a previous edit doesn't bleed
  // through.
  useEffect(() => {
    if (!open) return
    /* eslint-disable react-hooks/set-state-in-effect */
    if (initial) {
      setForm({
        name: initial.name,
        scope: initial.scope === "project" ? "project" : "user",
        description: initial.description ?? "",
        argumentHint: initial.argumentHint ?? "",
        model: initial.model ?? "",
        allowedToolDraft: "",
        allowedTools: initial.allowedTools ?? [],
        body: initial.template ?? "",
      })
    } else {
      setForm(EMPTY)
    }
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [open, initial])

  const preview = useMemo<string>(() => {
    try {
      return buildCommandFile(toInput(form, cwd))
    } catch {
      return ""
    }
  }, [form, cwd])

  const validationError = useMemo<string | null>(() => {
    try {
      assertValidCommandName(form.name)
    } catch (err) {
      return err instanceof Error ? err.message : String(err)
    }
    if (form.scope === "project" && !cwd) {
      return t("projectNeedsCwd")
    }
    if (!form.body.trim()) return t("bodyRequired")
    return null
  }, [form, cwd, t])

  const addTool = () => {
    const draft = form.allowedToolDraft.trim()
    if (!draft) return
    if (form.allowedTools.includes(draft)) {
      setForm((f) => ({ ...f, allowedToolDraft: "" }))
      return
    }
    setForm((f) => ({
      ...f,
      allowedTools: [...f.allowedTools, draft],
      allowedToolDraft: "",
    }))
  }

  const removeTool = (tool: string) =>
    setForm((f) => ({ ...f, allowedTools: f.allowedTools.filter((t) => t !== tool) }))

  const onSubmit = async () => {
    if (validationError) {
      toast.error(validationError)
      return
    }
    if (!desktop) {
      toast.error(t("webModeBlocked"))
      return
    }
    setBusy(true)
    try {
      const path = await saveCustomSlashCommand(toInput(form, cwd))
      toast.success(t("savedToast"))
      onSaved?.(path)
      onOpenChange(false)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const readOnly = !desktop

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{isEdit ? t("titleEdit") : t("titleCreate")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>

        {readOnly && (
          <div
            className="rounded border bg-muted/30 px-3 py-2 text-xs text-muted-foreground"
            role="status"
            data-testid="command-editor-web-banner"
          >
            {t("webModeBanner")}
          </div>
        )}

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="space-y-1.5 sm:col-span-1">
            <Label htmlFor="command-editor-name">{t("nameLabel")}</Label>
            <Input
              id="command-editor-name"
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              placeholder={t("namePlaceholder")}
              disabled={readOnly || isEdit}
              data-testid="command-editor-name"
            />
            <p className="text-[11px] text-muted-foreground">{t("nameHint")}</p>
          </div>

          <div className="space-y-1.5 sm:col-span-1">
            <Label htmlFor="command-editor-scope">{t("scopeLabel")}</Label>
            <Select
              value={form.scope}
              onValueChange={(v) =>
                setForm((f) => ({ ...f, scope: v === "project" ? "project" : "user" }))
              }
              disabled={readOnly || isEdit}
            >
              <SelectTrigger id="command-editor-scope" data-testid="command-editor-scope">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="user">{t("scopeUser")}</SelectItem>
                <SelectItem value="project" disabled={!cwd}>
                  {t("scopeProject")}
                </SelectItem>
              </SelectContent>
            </Select>
            <p className="text-[11px] text-muted-foreground">
              {form.scope === "user" ? t("scopeUserHint") : t("scopeProjectHint")}
            </p>
          </div>

          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="command-editor-description">{t("descriptionLabel")}</Label>
            <Input
              id="command-editor-description"
              value={form.description}
              onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
              placeholder={t("descriptionPlaceholder")}
              disabled={readOnly}
              data-testid="command-editor-description"
            />
          </div>

          <div className="space-y-1.5 sm:col-span-1">
            <Label htmlFor="command-editor-arg-hint">{t("argHintLabel")}</Label>
            <Input
              id="command-editor-arg-hint"
              value={form.argumentHint}
              onChange={(e) => setForm((f) => ({ ...f, argumentHint: e.target.value }))}
              placeholder={t("argHintPlaceholder")}
              disabled={readOnly}
              data-testid="command-editor-arg-hint"
            />
          </div>

          <div className="space-y-1.5 sm:col-span-1">
            <Label htmlFor="command-editor-model">{t("modelLabel")}</Label>
            <Input
              id="command-editor-model"
              value={form.model}
              onChange={(e) => setForm((f) => ({ ...f, model: e.target.value }))}
              placeholder={t("modelPlaceholder")}
              disabled={readOnly}
              data-testid="command-editor-model"
            />
          </div>

          <div className="space-y-1.5 sm:col-span-2">
            <Label>{t("allowedToolsLabel")}</Label>
            <div className="flex flex-wrap gap-1" data-testid="command-editor-tools">
              {form.allowedTools.length === 0 ? (
                <span className="text-[11px] italic text-muted-foreground">
                  {t("allowedToolsEmpty")}
                </span>
              ) : (
                form.allowedTools.map((tool) => (
                  <Badge key={tool} variant="secondary" className="gap-1 pr-1">
                    <span className="font-mono text-[11px]">{tool}</span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={() => removeTool(tool)}
                      disabled={readOnly}
                      aria-label={t("removeTool", { tool })}
                      className="size-5 rounded hover:bg-muted/60"
                      data-testid={`command-editor-remove-tool-${tool}`}
                    >
                      <XIcon className="size-3" />
                    </Button>
                  </Badge>
                ))
              )}
            </div>
            <div className="flex items-center gap-2">
              <Input
                value={form.allowedToolDraft}
                onChange={(e) => setForm((f) => ({ ...f, allowedToolDraft: e.target.value }))}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault()
                    addTool()
                  }
                }}
                placeholder={t("addToolPlaceholder")}
                disabled={readOnly}
                data-testid="command-editor-tool-draft"
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={addTool}
                disabled={readOnly || !form.allowedToolDraft.trim()}
                data-testid="command-editor-add-tool"
              >
                {t("addToolBtn")}
              </Button>
            </div>
          </div>

          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="command-editor-body">{t("bodyLabel")}</Label>
            <Textarea
              id="command-editor-body"
              rows={8}
              className="font-mono text-xs"
              value={form.body}
              onChange={(e) => setForm((f) => ({ ...f, body: e.target.value }))}
              placeholder={t("bodyPlaceholder")}
              disabled={readOnly}
              data-testid="command-editor-body"
            />
            <p className="text-[11px] text-muted-foreground">{t("bodyHint")}</p>
          </div>

          <div className="space-y-1.5 sm:col-span-2">
            <Label>{t("previewLabel")}</Label>
            <pre
              className="max-h-40 overflow-auto rounded border bg-muted/30 p-2 font-mono text-[11px]"
              data-testid="command-editor-preview"
            >
              {preview}
            </pre>
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t("cancel")}
          </Button>
          <Button
            onClick={() => void onSubmit()}
            disabled={readOnly || busy || !!validationError}
            data-testid="command-editor-save"
          >
            {busy ? t("saving") : t("save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function toInput(form: FormState, cwd: string | null | undefined): SaveCustomCommandInput {
  return {
    scope: form.scope,
    name: form.name.trim(),
    cwd: form.scope === "project" ? (cwd ?? null) : null,
    description: form.description,
    argumentHint: form.argumentHint,
    allowedTools: form.allowedTools,
    model: form.model,
    body: form.body,
  }
}

export default CommandEditorDialog
