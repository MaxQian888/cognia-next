"use client"

// Third-party endpoint preset editor. Supported on Anthropic + Codex only —
// the OpenCode provider tab doesn't render this component.
//
// Storage: `ProviderVault.preset` (one preset per provider). Set/clear via
// `subscription_set_preset`. Whatever the user saves overrides
// `ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL` at sidecar spawn time and adds
// every `extraHeaders` row to the request.

import { useState } from "react"
import { useTranslations } from "next-intl"
import { Loader2Icon } from "lucide-react"

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
import { Textarea } from "@/components/ui/textarea"
import { Card, CardContent } from "@/components/ui/card"

import { useProviderPreset } from "@/lib/subscription/core/hooks"
import { uuidv7 } from "@/lib/subscription/core/uuidv7"
import type { ProviderId, ProviderPreset } from "@/lib/subscription/core/types"

interface PresetPickerProps {
  provider: Extract<ProviderId, "anthropic" | "codex">
}

export function PresetPicker({ provider }: PresetPickerProps) {
  const t = useTranslations("subscription.common.preset")
  const { preset, loading, save } = useProviderPreset(provider)
  const [open, setOpen] = useState(false)

  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div className="space-y-1">
          <div className="flex items-center justify-between gap-2">
            <Label className="text-sm">{t("title")}</Label>
            {!loading &&
              (preset ? (
                <Badge variant="default" className="text-[10px]">
                  {t("presetActive")}
                </Badge>
              ) : (
                <Badge variant="outline" className="text-[10px]">
                  {t("presetInactive")}
                </Badge>
              ))}
          </div>
          <p className="text-xs text-muted-foreground">{t("description")}</p>
        </div>

        {loading ? (
          <p className="text-xs text-muted-foreground">…</p>
        ) : preset ? (
          <div className="space-y-2 rounded border bg-muted/30 px-3 py-2 text-xs">
            <div>
              <span className="text-muted-foreground">{t("labelField")}: </span>
              <span className="font-medium">{preset.label}</span>
            </div>
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
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">{t("noPreset")}</p>
        )}

        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
            {preset ? t("editPreset") : t("addPreset")}
          </Button>
          {preset && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void save(null)}
              className="text-destructive"
            >
              {t("removePreset")}
            </Button>
          )}
        </div>
      </CardContent>

      {open && (
        <PresetEditor
          current={preset}
          onClose={() => setOpen(false)}
          onSubmit={async (next) => {
            await save(next)
            setOpen(false)
          }}
        />
      )}
    </Card>
  )
}

function PresetEditor({
  current,
  onClose,
  onSubmit,
}: {
  current: ProviderPreset | null
  onClose: () => void
  onSubmit: (next: ProviderPreset) => Promise<void>
}) {
  const t = useTranslations("subscription.common.preset")
  const [label, setLabel] = useState(current?.label ?? "")
  const [baseUrl, setBaseUrl] = useState(current?.baseUrl ?? "")
  const [headersText, setHeadersText] = useState(() => serializeHeaders(current?.extraHeaders))
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

    setBusy(true)
    setError(null)
    try {
      await onSubmit({
        id: current?.id ?? uuidv7(),
        label: label.trim() || trimmedBase,
        baseUrl: trimmedBase,
        extraHeaders: Object.keys(parsedHeaders).length > 0 ? parsedHeaders : undefined,
      })
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
          <DialogTitle>{current ? t("editPreset") : t("addPreset")}</DialogTitle>
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
