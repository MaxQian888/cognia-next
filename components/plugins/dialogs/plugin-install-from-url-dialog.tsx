"use client"

// Replaces the previous `window.prompt()`-driven URL install flow with a
// proper modal dialog: input + submit + inline error + cancel. On success
// the parsed manifest gets staged through `usePluginsStore.setImportStaging`
// so the existing `PluginImportDialog` confirmation path takes over from
// there.

import { useState } from "react"
import { useTranslations } from "next-intl"
import { GlobeIcon, AlertTriangleIcon, Loader2Icon } from "lucide-react"
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
import { usePluginsStore } from "@/stores/plugins"
import { validatePluginManifest } from "@/lib/plugin/core/validation"

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function PluginInstallFromUrlDialog({ open, onOpenChange }: Props) {
  const t = useTranslations("plugins.toolbar.fromUrlDialog")
  const setImportStaging = usePluginsStore((s) => s.setImportStaging)
  const [url, setUrl] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const reset = () => {
    setUrl("")
    setBusy(false)
    setError(null)
  }

  const handleSubmit = async () => {
    const trimmed = url.trim()
    if (!trimmed) {
      setError(t("emptyError"))
      return
    }
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(trimmed, { credentials: "omit" })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const manifest = (await res.json()) as Record<string, unknown>
      // Host-side schema validation BEFORE staging — a raw URL can return any
      // JSON, and the downstream import path trusts the manifest's id/version.
      // Reject on hard errors; warnings (e.g. governance) still stage.
      const validation = validatePluginManifest(manifest)
      if (!validation.valid) {
        setError(t("invalidManifest", { errors: validation.errors.join("; ") }))
        return
      }
      setImportStaging({
        drafts: [
          {
            id: String(manifest.id ?? trimmed),
            name: String(manifest.name ?? trimmed),
            version: String(manifest.version ?? "0.0.0"),
            manifest,
            sourceLabel: trimmed,
          },
        ],
        sourceLabel: trimmed,
        parseErrors: [],
      })
      reset()
      onOpenChange(false)
    } catch (err) {
      setError(
        t("error", {
          message: err instanceof Error ? err.message : String(err),
        })
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset()
        onOpenChange(next)
      }}
    >
      <DialogContent className="w-[95vw] sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GlobeIcon className="size-4" />
            {t("title")}
          </DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          <Label htmlFor="plugin-install-url">{t("label")}</Label>
          <Input
            id="plugin-install-url"
            type="url"
            placeholder={t("placeholder")}
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !busy) void handleSubmit()
            }}
            disabled={busy}
          />
          {error && (
            <p role="alert" className="flex items-center gap-1.5 text-sm text-destructive">
              <AlertTriangleIcon className="size-3.5" />
              {error}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            {t("cancel")}
          </Button>
          <Button onClick={() => void handleSubmit()} disabled={busy}>
            {busy ? <Loader2Icon className="size-3.5 mr-1.5 animate-spin" /> : null}
            {t("submit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
