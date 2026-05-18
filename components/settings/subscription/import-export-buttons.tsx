"use client"

// One-click encrypted export / import for the three provider vaults. The
// encrypted file is a JSON envelope keyed by a user-supplied passphrase
// (AES-GCM + PBKDF2-SHA256-600k via `lib/subscription/core/encrypted-package`).

import { useState } from "react"
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
import { toast } from "sonner"

import {
  buildSubscriptionPackage,
  decryptSubscriptionPackage,
  encryptSubscriptionPackage,
  SubscriptionPassphraseError,
  type SubscriptionEncryptedEnvelope,
} from "@/lib/subscription/core/encrypted-package"
import {
  getActiveAccount,
  getProviderPreset,
  listAccounts,
  getAccount,
  saveAccount,
  setActiveAccount,
  setProviderPreset,
} from "@/lib/subscription/core/transport"
import type { Account, ProviderId, ProviderVault } from "@/lib/subscription/core/types"
import { ALL_PROVIDER_IDS } from "@/lib/subscription/core/types"

type Mode = "idle" | "exporting" | "importing"

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

async function snapshotVaults(): Promise<Partial<Record<ProviderId, ProviderVault>>> {
  const result: Partial<Record<ProviderId, ProviderVault>> = {}
  for (const provider of ALL_PROVIDER_IDS) {
    const summaries = await listAccounts(provider)
    if (summaries.length === 0) {
      // Still record the empty vault when there's an active pointer / preset.
      const [activeSnapshot, preset] = await Promise.all([
        getActiveAccount(provider),
        getProviderPreset(provider),
      ])
      if (activeSnapshot.activeAccountId || preset) {
        result[provider] = {
          schemaVersion: 2,
          accounts: [],
          activeAccountId: activeSnapshot.activeAccountId,
          preset: preset ?? undefined,
        }
      }
      continue
    }
    const fullAccounts: Account[] = []
    for (const summary of summaries) {
      const account = await getAccount(provider, summary.id)
      if (account) fullAccounts.push(account)
    }
    const [activeSnapshot, preset] = await Promise.all([
      getActiveAccount(provider),
      getProviderPreset(provider),
    ])
    result[provider] = {
      schemaVersion: 2,
      accounts: fullAccounts,
      activeAccountId: activeSnapshot.activeAccountId,
      preset: preset ?? undefined,
    }
  }
  return result
}

async function applyVaults(
  vaults: Partial<Record<ProviderId, ProviderVault>>
): Promise<{ accountCount: number }> {
  let accountCount = 0
  for (const provider of Object.keys(vaults) as ProviderId[]) {
    const vault = vaults[provider]
    if (!vault) continue
    for (const account of vault.accounts) {
      await saveAccount(provider, account)
      accountCount += 1
    }
    if (vault.preset !== undefined) {
      await setProviderPreset(provider, vault.preset ?? null)
    }
    if (vault.activeAccountId !== undefined) {
      await setActiveAccount(provider, vault.activeAccountId ?? null)
    }
  }
  return { accountCount }
}

function ExportDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useTranslations("subscription.common.importExport")
  const [pass, setPass] = useState("")
  const [passConfirm, setPassConfirm] = useState("")
  const [mode, setMode] = useState<Mode>("idle")
  const [error, setError] = useState<string | null>(null)

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
            <p className="text-xs text-muted-foreground">
              <Loader2Icon className="mr-2 inline size-3 animate-spin" />
              {t("downloading")}
            </p>
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
  const [mode, setMode] = useState<Mode>("idle")
  const [error, setError] = useState<string | null>(null)

  const reset = () => {
    setPass("")
    setFile(null)
    setMode("idle")
    setError(null)
  }

  const onSubmit = async () => {
    setError(null)
    if (!file) {
      setError(t("fileFieldHint"))
      return
    }
    setMode("importing")
    try {
      const json = JSON.parse(await file.text()) as SubscriptionEncryptedEnvelope
      const body = await decryptSubscriptionPackage(json, pass)
      const { accountCount } = await applyVaults(body.vaults)
      toast.success(t("importSuccess", { count: accountCount }))
      reset()
      onClose()
    } catch (e) {
      setMode("idle")
      if (e instanceof SubscriptionPassphraseError) {
        setError(t("passphraseWrong"))
      } else {
        setError(t("importFailed", { error: e instanceof Error ? e.message : String(e) }))
      }
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
          <DialogTitle>{t("importDialogTitle")}</DialogTitle>
          <DialogDescription>{t("importDialogBody")}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="import-file">{t("fileField")}</Label>
            <Input
              id="import-file"
              type="file"
              accept=".json,application/json"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
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
            />
          </div>
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
          <Button onClick={() => void onSubmit()} disabled={!file || mode !== "idle"}>
            {mode === "importing" && <Loader2Icon className="mr-2 size-4 animate-spin" />}
            {t("confirmImport")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
