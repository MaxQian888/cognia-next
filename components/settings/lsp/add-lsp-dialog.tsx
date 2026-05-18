"use client"

/**
 * Modal form to add a Language Server entry to
 * `AppSettings.developer.userLspServers`.
 *
 * Kept deliberately minimal: name, languages (comma-separated), command,
 * args (one per line). Advanced fields (env, transport, settings, etc.)
 * can be added in follow-ups — most users only need command + languages.
 */

import { useState, type FormEvent } from "react"
import { useTranslations } from "next-intl"
import type { UserLspServerEntry } from "@/lib/claude/types"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"

export interface AddLspDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onAdd: (entry: Omit<UserLspServerEntry, "id">) => void
}

export function AddLspDialog({ open, onOpenChange, onAdd }: AddLspDialogProps) {
  const t = useTranslations("settings.lspServers.add")
  const [name, setName] = useState("")
  const [languages, setLanguages] = useState("")
  const [command, setCommand] = useState("")
  const [argsText, setArgsText] = useState("")
  const [error, setError] = useState<string | null>(null)

  const reset = () => {
    setName("")
    setLanguages("")
    setCommand("")
    setArgsText("")
    setError(null)
  }

  const handleClose = (next: boolean) => {
    if (!next) reset()
    onOpenChange(next)
  }

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault()
    const trimmedName = name.trim()
    const trimmedCommand = command.trim()
    const parsedLanguages = languages
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)

    if (!trimmedName) {
      setError(t("error.name"))
      return
    }
    if (!trimmedCommand) {
      setError(t("error.command"))
      return
    }
    if (parsedLanguages.length === 0) {
      setError(t("error.languages"))
      return
    }

    const args = argsText
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean)

    onAdd({
      name: trimmedName,
      languages: parsedLanguages,
      command: trimmedCommand,
      args: args.length > 0 ? args : undefined,
      transport: "stdio",
      enabled: true,
    })
    reset()
  }

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent data-testid="add-lsp-dialog">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1">
            <Label htmlFor="lsp-name">{t("field.name")}</Label>
            <Input
              id="lsp-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("placeholder.name")}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="lsp-languages">{t("field.languages")}</Label>
            <Input
              id="lsp-languages"
              value={languages}
              onChange={(e) => setLanguages(e.target.value)}
              placeholder={t("placeholder.languages")}
            />
            <p className="text-xs text-muted-foreground">{t("hint.languages")}</p>
          </div>
          <div className="space-y-1">
            <Label htmlFor="lsp-command">{t("field.command")}</Label>
            <Input
              id="lsp-command"
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder={t("placeholder.command")}
            />
            <p className="text-xs text-muted-foreground">{t("hint.command")}</p>
          </div>
          <div className="space-y-1">
            <Label htmlFor="lsp-args">{t("field.args")}</Label>
            <Textarea
              id="lsp-args"
              value={argsText}
              onChange={(e) => setArgsText(e.target.value)}
              placeholder={t("placeholder.args")}
              rows={3}
            />
            <p className="text-xs text-muted-foreground">{t("hint.args")}</p>
          </div>
          {error ? (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => handleClose(false)}>
              {t("cancel")}
            </Button>
            <Button type="submit">{t("submit")}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
