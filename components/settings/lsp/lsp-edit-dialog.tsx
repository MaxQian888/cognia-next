"use client"

/**
 * Add / edit dialog for a Language Server entry in `AppSettings.lsp.servers`.
 *
 * Exposes the full {@link LspServerConfig} surface: name, languages,
 * extensions, command, args, env, root markers, workspace-folder requirement,
 * enabled, and the per-server `settings` blob (edited as validated JSON — the
 * blob drives the LSP `workspace/configuration` pull, e.g.
 * `{ "rust-analyzer": { "cargo": { "features": "all" } } }`).
 *
 * Two modes:
 *   - add: `initial` omitted, a fresh id is generated on submit.
 *   - edit / override-builtin: `initial` provided, its id is preserved (a
 *     builtin override keeps the builtin id so the resolver merges them).
 */

import { useState, type FormEvent } from "react"
import { useTranslations } from "next-intl"
import type { LspServerConfig } from "@/types/lsp/config"
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
import { Switch } from "@/components/ui/switch"

export interface LspEditDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Edit / override mode when set — prefills the form and pins the id. */
  initial?: LspServerConfig
  /** Existing ids to reject as duplicates in add mode. */
  existingIds?: string[]
  onSubmit: (entry: LspServerConfig) => void
}

function generateEntryId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `lsp_${(crypto as Crypto).randomUUID().slice(0, 8)}`
  }
  return `lsp_${Math.random().toString(36).slice(2, 10)}`
}

const splitCsv = (s: string): string[] =>
  s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)

const splitLines = (s: string): string[] =>
  s
    .split("\n")
    .map((x) => x.trim())
    .filter(Boolean)

/** Normalise extensions to a leading dot, lower-cased (`ts` → `.ts`). */
const normalizeExtensions = (s: string): string[] =>
  splitCsv(s).map((e) => (e.startsWith(".") ? e : `.${e}`).toLowerCase())

/** Parse `KEY=VALUE` lines into an object (skips lines with no `=`). */
function parseEnv(text: string): Record<string, string> | undefined {
  const out: Record<string, string> = {}
  for (const line of splitLines(text)) {
    const eq = line.indexOf("=")
    if (eq <= 0) continue
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim()
  }
  return Object.keys(out).length > 0 ? out : undefined
}

function envToText(env: Record<string, string> | undefined): string {
  if (!env) return ""
  return Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n")
}

export function LspEditDialog({
  open,
  onOpenChange,
  initial,
  existingIds = [],
  onSubmit,
}: LspEditDialogProps) {
  const t = useTranslations("settings.lspServers.add")
  const isEdit = !!initial

  const [name, setName] = useState("")
  const [languages, setLanguages] = useState("")
  const [extensions, setExtensions] = useState("")
  const [command, setCommand] = useState("")
  const [argsText, setArgsText] = useState("")
  const [envText, setEnvText] = useState("")
  const [rootMarkers, setRootMarkers] = useState("")
  const [workspaceFolderRequired, setWorkspaceFolderRequired] = useState(false)
  const [enabled, setEnabled] = useState(true)
  const [settingsText, setSettingsText] = useState("")
  const [error, setError] = useState<string | null>(null)

  // Re-seed the form whenever the dialog opens (or the edit target changes).
  // Render-time state adjustment — the React-sanctioned alternative to a
  // setState-in-effect reset (react.dev "you might not need an effect").
  const [prevSeed, setPrevSeed] = useState<{ open: boolean; initial?: LspServerConfig }>({
    open: false,
  })
  if (open !== prevSeed.open || initial !== prevSeed.initial) {
    setPrevSeed({ open, initial })
    if (open) {
      setName(initial?.name ?? "")
      setLanguages((initial?.languages ?? []).join(", "))
      setExtensions((initial?.extensions ?? []).join(", "))
      setCommand(initial?.command ?? "")
      setArgsText((initial?.args ?? []).join("\n"))
      setEnvText(envToText(initial?.env))
      setRootMarkers((initial?.rootMarkers ?? []).join(", "))
      setWorkspaceFolderRequired(initial?.workspaceFolderRequired ?? false)
      setEnabled(initial?.enabled !== false)
      setSettingsText(initial?.settings ? JSON.stringify(initial.settings, null, 2) : "")
      setError(null)
    }
  }

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault()
    const trimmedName = name.trim()
    const trimmedCommand = command.trim()
    const parsedLanguages = splitCsv(languages)

    if (!trimmedName) return setError(t("error.name"))
    if (!trimmedCommand) return setError(t("error.command"))
    if (parsedLanguages.length === 0) return setError(t("error.languages"))

    const id = initial?.id ?? generateEntryId()
    if (!isEdit && existingIds.includes(id)) return setError(t("error.duplicate"))

    let settings: Record<string, unknown> | undefined
    if (settingsText.trim()) {
      try {
        const parsed = JSON.parse(settingsText)
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          return setError(t("error.settings"))
        }
        settings = parsed as Record<string, unknown>
      } catch {
        return setError(t("error.settings"))
      }
    }

    const args = splitLines(argsText)
    const exts = normalizeExtensions(extensions)
    const markers = splitCsv(rootMarkers)

    onSubmit({
      id,
      name: trimmedName,
      languages: parsedLanguages,
      extensions: exts.length > 0 ? exts : undefined,
      command: trimmedCommand,
      args: args.length > 0 ? args : undefined,
      env: parseEnv(envText),
      rootMarkers: markers.length > 0 ? markers : undefined,
      transport: "stdio",
      workspaceFolderRequired: workspaceFolderRequired || undefined,
      settings,
      enabled,
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="lsp-edit-dialog" className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isEdit ? t("editTitle") : t("title")}</DialogTitle>
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
            <Label htmlFor="lsp-extensions">{t("field.extensions")}</Label>
            <Input
              id="lsp-extensions"
              value={extensions}
              onChange={(e) => setExtensions(e.target.value)}
              placeholder={t("placeholder.extensions")}
            />
            <p className="text-xs text-muted-foreground">{t("hint.extensions")}</p>
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
              rows={2}
            />
            <p className="text-xs text-muted-foreground">{t("hint.args")}</p>
          </div>
          <div className="space-y-1">
            <Label htmlFor="lsp-env">{t("field.env")}</Label>
            <Textarea
              id="lsp-env"
              value={envText}
              onChange={(e) => setEnvText(e.target.value)}
              placeholder={t("placeholder.env")}
              rows={2}
            />
            <p className="text-xs text-muted-foreground">{t("hint.env")}</p>
          </div>
          <div className="space-y-1">
            <Label htmlFor="lsp-root-markers">{t("field.rootMarkers")}</Label>
            <Input
              id="lsp-root-markers"
              value={rootMarkers}
              onChange={(e) => setRootMarkers(e.target.value)}
              placeholder={t("placeholder.rootMarkers")}
            />
            <p className="text-xs text-muted-foreground">{t("hint.rootMarkers")}</p>
          </div>
          <div className="space-y-1">
            <Label htmlFor="lsp-settings">{t("field.settings")}</Label>
            <Textarea
              id="lsp-settings"
              value={settingsText}
              onChange={(e) => setSettingsText(e.target.value)}
              placeholder={t("placeholder.settings")}
              rows={4}
              className="font-mono text-xs"
            />
            <p className="text-xs text-muted-foreground">{t("hint.settings")}</p>
          </div>
          <div className="flex items-center justify-between">
            <Label htmlFor="lsp-wsf" className="cursor-pointer">
              {t("field.workspaceFolderRequired")}
            </Label>
            <Switch
              id="lsp-wsf"
              checked={workspaceFolderRequired}
              onCheckedChange={setWorkspaceFolderRequired}
              aria-label={t("field.workspaceFolderRequired")}
            />
          </div>
          <div className="flex items-center justify-between">
            <Label htmlFor="lsp-enabled" className="cursor-pointer">
              {t("field.enabled")}
            </Label>
            <Switch
              id="lsp-enabled"
              checked={enabled}
              onCheckedChange={setEnabled}
              aria-label={t("field.enabled")}
            />
          </div>
          {error ? (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t("cancel")}
            </Button>
            <Button type="submit">{isEdit ? t("save") : t("submit")}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
