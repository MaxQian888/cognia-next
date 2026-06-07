"use client"

// Third-party endpoint preset *library* (Anthropic + Codex only — the OpenCode
// provider tab doesn't render this component).
//
// Storage: `ProviderVault.presets` (a library of named presets per provider)
// plus `defaultPresetId`. Accounts bind to a preset by id; the default applies
// when an account has no explicit binding. A preset overrides
// `ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL` at sidecar spawn time, adds every
// `extraHeaders` row, and (via `modelMapping`) can remap the default / fast
// model env vars.

import { useState } from "react"
import { useTranslations } from "next-intl"
import { Loader2Icon, PlusIcon, ChevronDownIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Card, CardContent } from "@/components/ui/card"

import { useProviderPresets } from "@/lib/subscription/core/hooks"
import { uuidv7 } from "@/lib/subscription/core/uuidv7"
import type { ProviderId, ProviderPreset } from "@/types/subscription"
import { buildPresetTemplates, type PresetTemplate } from "@/types/subscription/preset-templates"
import { SelectablePresetCard } from "@/components/settings/presets/selectable-preset-card"

type PresetProvider = Extract<ProviderId, "anthropic" | "codex" | "opencode">

interface PresetPickerProps {
  provider: PresetProvider
}

/** Seed for the editor — either an existing preset to edit or a template-prefilled blank. */
type EditorSeed = { kind: "edit"; preset: ProviderPreset } | { kind: "new"; draft: ProviderPreset }

export function PresetPicker({ provider }: PresetPickerProps) {
  const t = useTranslations("subscription.common.preset")
  const { presets, defaultPresetId, loading, save, remove, setDefault } =
    useProviderPresets(provider)

  const [editorSeed, setEditorSeed] = useState<EditorSeed | null>(null)
  const [removeTarget, setRemoveTarget] = useState<ProviderPreset | null>(null)
  const [removeBusy, setRemoveBusy] = useState(false)

  const supportsFast = provider === "anthropic"
  const templates = buildPresetTemplates(provider)

  const openNewFromTemplate = (template: PresetTemplate) => {
    const draft: ProviderPreset = {
      id: uuidv7(),
      label: template.templateId === "custom" ? "" : template.label,
      baseUrl: template.baseUrl,
    }
    if (template.templateId !== "custom") draft.templateId = template.templateId
    setEditorSeed({ kind: "new", draft })
  }

  const handleConfirmRemove = async () => {
    if (!removeTarget) return
    setRemoveBusy(true)
    try {
      await remove(removeTarget.id)
      setRemoveTarget(null)
    } finally {
      setRemoveBusy(false)
    }
  }

  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div className="space-y-1">
          <Label className="text-sm">{t("title")}</Label>
          <p className="text-xs text-muted-foreground">{t("description")}</p>
        </div>

        {loading ? (
          <p className="text-xs text-muted-foreground">…</p>
        ) : presets.length === 0 ? (
          <SelectablePresetCard
            title={t("noPreset")}
            badge="inactive"
            badgeLabel={t("presetInactive")}
          />
        ) : (
          <ul className="space-y-1.5">
            {presets.map((preset) => {
              const isDefault = preset.id === defaultPresetId
              return (
                <li key={preset.id}>
                  <SelectablePresetCard
                    title={preset.label || preset.baseUrl}
                    badge={isDefault ? "default" : undefined}
                    badgeLabel={isDefault ? t("defaultBadge") : undefined}
                    details={<PresetDetails preset={preset} supportsFast={supportsFast} />}
                    actions={
                      <>
                        {!isDefault && (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => void setDefault(preset.id)}
                          >
                            {t("setDefault")}
                          </Button>
                        )}
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setEditorSeed({ kind: "edit", preset })}
                        >
                          {t("editPreset")}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-destructive"
                          onClick={() => setRemoveTarget(preset)}
                        >
                          {t("removePreset")}
                        </Button>
                      </>
                    }
                  />
                </li>
              )
            })}
          </ul>
        )}

        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => openNewFromTemplate(templates[0])}>
            <PlusIcon className="mr-1 size-4" />
            {t("addPreset")}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="outline">
                {t("newFromTemplate")}
                <ChevronDownIcon className="ml-1 size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              {templates.map((template) => (
                <DropdownMenuItem
                  key={template.templateId}
                  onSelect={() => openNewFromTemplate(template)}
                >
                  {template.templateId === "custom" ? t("customTemplate") : template.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </CardContent>

      {editorSeed && (
        <PresetEditor
          seed={editorSeed}
          supportsFast={supportsFast}
          onClose={() => setEditorSeed(null)}
          onSubmit={async (next) => {
            await save(next)
            setEditorSeed(null)
          }}
        />
      )}

      <AlertDialog open={removeTarget !== null} onOpenChange={(o) => !o && setRemoveTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("removeConfirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("removeConfirmDescription", { label: removeTarget?.label ?? "" })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={removeBusy}>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                // Manually intercept so we can await remove before closing.
                e.preventDefault()
                void handleConfirmRemove()
              }}
              disabled={removeBusy}
            >
              {removeBusy && <Loader2Icon className="mr-2 size-4 animate-spin" />}
              {t("removePreset")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  )
}

function PresetDetails({
  preset,
  supportsFast,
}: {
  preset: ProviderPreset
  supportsFast: boolean
}) {
  const t = useTranslations("subscription.common.preset")
  return (
    <div className="space-y-1.5">
      <div>
        <span className="text-muted-foreground">{t("baseUrlField")}: </span>
        <span className="font-mono break-all">{preset.baseUrl}</span>
      </div>
      {preset.extraHeaders && Object.keys(preset.extraHeaders).length > 0 && (
        <div>
          <span className="text-muted-foreground">{t("headersField")}: </span>
          <ul className="mt-1 space-y-0.5">
            {Object.entries(preset.extraHeaders).map(([k, v]) => (
              <li key={k} className="font-mono break-all">
                {k}: {v}
              </li>
            ))}
          </ul>
        </div>
      )}
      {preset.modelMapping?.default && (
        <div>
          <span className="text-muted-foreground">{t("defaultModelField")}: </span>
          <span className="font-mono break-all">{preset.modelMapping.default}</span>
        </div>
      )}
      {supportsFast && preset.modelMapping?.fast && (
        <div>
          <span className="text-muted-foreground">{t("fastModelField")}: </span>
          <span className="font-mono break-all">{preset.modelMapping.fast}</span>
        </div>
      )}
    </div>
  )
}

function PresetEditor({
  seed,
  supportsFast,
  onClose,
  onSubmit,
}: {
  seed: EditorSeed
  supportsFast: boolean
  onClose: () => void
  onSubmit: (next: ProviderPreset) => Promise<void>
}) {
  const t = useTranslations("subscription.common.preset")
  const base = seed.kind === "edit" ? seed.preset : seed.draft
  const isEdit = seed.kind === "edit"

  const [label, setLabel] = useState(base.label ?? "")
  const [baseUrl, setBaseUrl] = useState(base.baseUrl ?? "")
  const [headersText, setHeadersText] = useState(() => serializeHeaders(base.extraHeaders))
  const [defaultModel, setDefaultModel] = useState(base.modelMapping?.default ?? "")
  const [fastModel, setFastModel] = useState(base.modelMapping?.fast ?? "")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const onSave = async () => {
    const trimmedBase = baseUrl.trim()
    if (!trimmedBase) {
      setError(t("validationEmptyBaseUrl"))
      return
    }
    try {
      new URL(trimmedBase)
    } catch {
      setError(t("validationInvalidUrl"))
      return
    }
    let parsedHeaders: Record<string, string>
    try {
      parsedHeaders = parseHeaders(headersText, (k) => {
        if (!k) throw new Error(t("validationEmptyKey"))
      })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      return
    }

    const modelMapping: Record<string, string> = {}
    const trimmedDefault = defaultModel.trim()
    if (trimmedDefault) modelMapping.default = trimmedDefault
    const trimmedFast = fastModel.trim()
    if (supportsFast && trimmedFast) modelMapping.fast = trimmedFast

    setBusy(true)
    setError(null)
    try {
      const next: ProviderPreset = {
        id: base.id,
        label: label.trim() || trimmedBase,
        baseUrl: trimmedBase,
        extraHeaders: Object.keys(parsedHeaders).length > 0 ? parsedHeaders : undefined,
      }
      // Preserve provenance through edits / template instantiation.
      if (base.templateId) next.templateId = base.templateId
      if (Object.keys(modelMapping).length > 0) next.modelMapping = modelMapping
      await onSubmit(next)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{isEdit ? t("editPreset") : t("addPreset")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="preset-label">{t("labelField")}</Label>
            <Input
              id="preset-label"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder={t("labelPlaceholder")}
              autoFocus
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="preset-base-url">{t("baseUrlField")}</Label>
            <Input
              id="preset-base-url"
              type="url"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder={t("baseUrlPlaceholder")}
              spellCheck={false}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="preset-headers">{t("headersField")}</Label>
            <Textarea
              id="preset-headers"
              value={headersText}
              onChange={(e) => setHeadersText(e.target.value)}
              placeholder="X-Org: cognia"
              rows={4}
              spellCheck={false}
            />
            <p className="text-[11px] text-muted-foreground">{t("headersHint")}</p>
          </div>
          <div className="space-y-1">
            <Label htmlFor="preset-default-model">{t("defaultModelField")}</Label>
            <Input
              id="preset-default-model"
              value={defaultModel}
              onChange={(e) => setDefaultModel(e.target.value)}
              placeholder={t("defaultModelPlaceholder")}
              spellCheck={false}
            />
            <p className="text-[11px] text-muted-foreground">{t("modelMappingHint")}</p>
          </div>
          {supportsFast && (
            <div className="space-y-1">
              <Label htmlFor="preset-fast-model">{t("fastModelField")}</Label>
              <Input
                id="preset-fast-model"
                value={fastModel}
                onChange={(e) => setFastModel(e.target.value)}
                placeholder={t("fastModelPlaceholder")}
                spellCheck={false}
              />
            </div>
          )}
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            {t("cancel")}
          </Button>
          <Button onClick={() => void onSave()} disabled={busy}>
            {busy && <Loader2Icon className="mr-2 size-4 animate-spin" />}
            {t("save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function serializeHeaders(headers: Record<string, string> | undefined): string {
  if (!headers) return ""
  return Object.entries(headers)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n")
}

function parseHeaders(text: string, validateKey: (k: string) => void): Record<string, string> {
  const out: Record<string, string> = {}
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    const idx = line.indexOf(":")
    if (idx < 0) continue
    const key = line.slice(0, idx).trim()
    const value = line.slice(idx + 1).trim()
    validateKey(key)
    out[key] = value
  }
  return out
}
