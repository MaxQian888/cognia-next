"use client"

// One-click encrypted export / import for the three provider vaults. The
// encrypted file is a JSON envelope keyed by a user-supplied passphrase
// (AES-GCM + PBKDF2-SHA256-600k via `lib/subscription/core/encrypted-package`).
// Import: a passphrase + file unlock step shows a content preview before
// `applyVaults` mutates the keyring, so users can sanity-check accounts /
// presets before committing.

import { useEffect, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { Loader2Icon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
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
import { Progress } from "@/components/ui/progress"
import { toast } from "sonner"

import {
  buildSubscriptionPackage,
  decryptSubscriptionPackage,
  encryptSubscriptionPackage,
  SubscriptionPassphraseError,
  type SubscriptionEncryptedEnvelope,
  type SubscriptionPackageBody,
} from "@/lib/subscription/core/encrypted-package"
import { applyVaults, snapshotVaults } from "@/lib/subscription/core/vault-snapshot"
import type { ProviderId } from "@/types/subscription"
import { ALL_PROVIDER_IDS } from "@/types/subscription"

type ExportMode = "idle" | "exporting"
type ImportMode = "idle" | "decrypting" | "preview" | "applying"

export function ImportExportButtons() {
  const t = useTranslations("subscription.common.importExport")
  const [exportOpen, setExportOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)

  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div className="space-y-1">
          <Label className="text-sm">{t("title")}</Label>
          <p className="text-xs text-muted-foreground">{t("description")}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => setExportOpen(true)}>
            {t("exportButton")}
          </Button>
          <Button size="sm" variant="outline" onClick={() => setImportOpen(true)}>
            {t("importButton")}
          </Button>
        </div>
      </CardContent>
      <ExportDialog open={exportOpen} onClose={() => setExportOpen(false)} />
      <ImportDialog open={importOpen} onClose={() => setImportOpen(false)} />
    </Card>
  )
}

/**
 * Faux progress ticker for the PBKDF2 600k-iteration step (~1-3s).
 * Bumps deterministically toward 90, leaving room for an explicit 100
 * landing when the underlying promise resolves. The crypto API doesn't
 * surface real progress so this is the honest substitute.
 */
function useFauxProgress(active: boolean): [number, () => void] {
  const [value, setValue] = useState(0)

  useEffect(() => {
    if (!active) return
    // Deferred via setTimeout(0) so the initial bump rides the same async
    // path as the interval ticks — calling setValue(5) synchronously in the
    // effect body trips react-hooks/set-state-in-effect.
    const initialId = setTimeout(() => setValue(5), 0)
    const intervalId = setInterval(() => {
      setValue((v) => (v >= 90 ? v : Math.min(90, v + 7)))
    }, 200)
    return () => {
      clearTimeout(initialId)
      clearInterval(intervalId)
    }
  }, [active])

  const finish = () => setValue(100)

  return [value, finish]
}

function ExportDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useTranslations("subscription.common.importExport")
  const [pass, setPass] = useState("")
  const [passConfirm, setPassConfirm] = useState("")
  const [mode, setMode] = useState<ExportMode>("idle")
  const [error, setError] = useState<string | null>(null)
  const [progress, finishProgress] = useFauxProgress(mode === "exporting")

  const reset = () => {
    setPass("")
    setPassConfirm("")
    setMode("idle")
    setError(null)
  }

  const onSubmit = async () => {
    setError(null)
    if (!pass) {
      setError(t("passphraseEmpty"))
      return
    }
    if (pass !== passConfirm) {
      setError(t("passphraseMismatch"))
      return
    }
    setMode("exporting")
    try {
      const vaults = await snapshotVaults()
      const body = buildSubscriptionPackage(vaults)
      const envelope = await encryptSubscriptionPackage(body, pass)
      finishProgress()
      const filename = `cognia-subscription-${new Date()
        .toISOString()
        .replace(/[:.]/g, "-")}.cogniabak.json`
      downloadJson(filename, envelope)
      toast.success(t("exportSuccess"))
      reset()
      onClose()
    } catch (e) {
      setMode("idle")
      setError(t("exportFailed", { error: e instanceof Error ? e.message : String(e) }))
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          reset()
          onClose()
        }
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("exportDialogTitle")}</DialogTitle>
          <DialogDescription>{t("exportDialogBody")}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="export-passphrase">{t("passphraseField")}</Label>
            <Input
              id="export-passphrase"
              type="password"
              value={pass}
              onChange={(e) => setPass(e.target.value)}
              autoFocus
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="export-passphrase-confirm">{t("passphraseConfirmField")}</Label>
            <Input
              id="export-passphrase-confirm"
              type="password"
              value={passConfirm}
              onChange={(e) => setPassConfirm(e.target.value)}
            />
          </div>
          {mode === "exporting" && (
            <div className="space-y-1.5">
              <p className="text-xs text-muted-foreground">
                <Loader2Icon className="mr-2 inline size-3 animate-spin" />
                {t("downloading")}
              </p>
              <Progress value={progress} aria-label={t("downloading")} />
            </div>
          )}
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => {
              reset()
              onClose()
            }}
            disabled={mode !== "idle"}
          >
            {t("cancel")}
          </Button>
          <Button onClick={() => void onSubmit()} disabled={mode !== "idle"}>
            {mode === "exporting" && <Loader2Icon className="mr-2 size-4 animate-spin" />}
            {t("exportButton")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ImportDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useTranslations("subscription.common.importExport")
  const [pass, setPass] = useState("")
  const [file, setFile] = useState<File | null>(null)
  const [mode, setMode] = useState<ImportMode>("idle")
  const [error, setError] = useState<string | null>(null)
  const [decrypted, setDecrypted] = useState<SubscriptionPackageBody | null>(null)
  const [decryptProgress, finishDecryptProgress] = useFauxProgress(mode === "decrypting")

  const reset = () => {
    setPass("")
    setFile(null)
    setMode("idle")
    setError(null)
    setDecrypted(null)
  }

  const onDecrypt = async () => {
    setError(null)
    if (!file) {
      setError(t("fileFieldHint"))
      return
    }
    setMode("decrypting")
    try {
      const json = JSON.parse(await file.text()) as SubscriptionEncryptedEnvelope
      const body = await decryptSubscriptionPackage(json, pass)
      finishDecryptProgress()
      setDecrypted(body)
      setMode("preview")
    } catch (e) {
      setMode("idle")
      if (e instanceof SubscriptionPassphraseError) {
        setError(t("passphraseWrong"))
      } else {
        setError(t("importFailed", { error: e instanceof Error ? e.message : String(e) }))
      }
    }
  }

  const onApply = async () => {
    if (!decrypted) return
    setMode("applying")
    try {
      const { accountCount } = await applyVaults(decrypted.vaults)
      toast.success(t("importSuccess", { count: accountCount }))
      reset()
      onClose()
    } catch (e) {
      setMode("preview")
      setError(t("importFailed", { error: e instanceof Error ? e.message : String(e) }))
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          reset()
          onClose()
        }
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {mode === "preview" ? t("preview.title") : t("importDialogTitle")}
          </DialogTitle>
          <DialogDescription>
            {mode === "preview" ? t("preview.description") : t("importDialogBody")}
          </DialogDescription>
        </DialogHeader>

        {mode === "preview" && decrypted ? (
          <ImportPreview body={decrypted} />
        ) : (
          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="import-file">{t("fileField")}</Label>
              <Input
                id="import-file"
                type="file"
                accept=".json,application/json"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                disabled={mode !== "idle"}
              />
              <p className="text-[11px] text-muted-foreground">{t("fileFieldHint")}</p>
            </div>
            <div className="space-y-1">
              <Label htmlFor="import-passphrase">{t("passphraseField")}</Label>
              <Input
                id="import-passphrase"
                type="password"
                value={pass}
                onChange={(e) => setPass(e.target.value)}
                disabled={mode !== "idle"}
              />
            </div>
            {mode === "decrypting" && (
              <div className="space-y-1.5">
                <p className="text-xs text-muted-foreground">
                  <Loader2Icon className="mr-2 inline size-3 animate-spin" />
                  {t("preview.decrypting")}
                </p>
                <Progress value={decryptProgress} aria-label={t("preview.decrypting")} />
              </div>
            )}
            {error && <p className="text-xs text-destructive">{error}</p>}
          </div>
        )}

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => {
              reset()
              onClose()
            }}
            disabled={mode === "decrypting" || mode === "applying"}
          >
            {t("cancel")}
          </Button>
          {mode === "preview" ? (
            <Button onClick={() => void onApply()} disabled={mode !== "preview"}>
              {t("preview.apply")}
            </Button>
          ) : (
            <Button onClick={() => void onDecrypt()} disabled={!file || mode !== "idle"}>
              {mode === "decrypting" && <Loader2Icon className="mr-2 size-4 animate-spin" />}
              {t("preview.unlock")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

interface ImportPreviewProps {
  body: SubscriptionPackageBody
}

function ImportPreview({ body }: ImportPreviewProps) {
  const t = useTranslations("subscription.common.importExport")
  const tCommon = useTranslations("subscription")

  const rows = useMemo(() => {
    const out: Array<{ provider: ProviderId; accounts: string[]; hasPreset: boolean }> = []
    for (const provider of ALL_PROVIDER_IDS) {
      const vault = body.vaults[provider]
      if (!vault) continue
      const accounts = vault.accounts.map((a) => a.label || a.id.slice(0, 8))
      out.push({ provider, accounts, hasPreset: vault.preset !== undefined })
    }
    return out
  }, [body])

  const safeProviderName = (p: ProviderId): string => {
    const out = tCommon(`providers.${p}` as never)
    return out === `subscription.providers.${p}` ? p : out
  }

  if (rows.length === 0) {
    return (
      <p className="rounded-md border border-dashed p-4 text-center text-xs text-muted-foreground">
        {t("preview.empty")}
      </p>
    )
  }

  return (
    <div className="max-h-[40vh] space-y-3 overflow-y-auto" data-testid="import-preview">
      {rows.map((row) => (
        <div key={row.provider} className="space-y-1.5 rounded-md border bg-muted/30 p-3">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">{safeProviderName(row.provider)}</span>
            {row.hasPreset && (
              <span className="rounded-full border border-primary/50 px-2 py-0.5 text-[10px] text-primary">
                {t("preview.hasPreset")}
              </span>
            )}
          </div>
          {row.accounts.length === 0 ? (
            <p className="text-[11px] italic text-muted-foreground">{t("preview.noAccounts")}</p>
          ) : (
            <ul className="space-y-0.5 text-[11px] text-muted-foreground">
              {row.accounts.map((label, idx) => (
                <li key={idx} className="font-mono break-all">
                  · {label}
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </div>
  )
}

function downloadJson(filename: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  // Free the blob URL on the next microtask.
  setTimeout(() => URL.revokeObjectURL(url), 0)
}
