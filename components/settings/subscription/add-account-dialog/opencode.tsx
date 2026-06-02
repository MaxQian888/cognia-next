"use client"

// OpenCode add-account dialog. Two paths:
//
//   • Paste Zen API key — the user copies the key from opencode.ai/auth and
//     pastes it here. Stored in the unified vault as an `OpencodeZen` account.
//   • Discovery is surfaced INLINE in the OpenCode provider tab (not in this
//     dialog) because it's read-only and never blocks; the dialog is reserved
//     for the explicit write path.

import { useState } from "react"
import { useTranslations } from "next-intl"
import { Loader2Icon } from "lucide-react"

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

import { saveOpencodeZenKey } from "@/lib/subscription/opencode/discovery"
import type { Account } from "@/types/subscription"

export interface OpencodeAddAccountDialogProps {
  open: boolean
  onOpenChange: (next: boolean) => void
  onAdded?: (account: Account) => void
}

export function OpencodeAddAccountDialog({
  open,
  onOpenChange,
  onAdded,
}: OpencodeAddAccountDialogProps) {
  const t = useTranslations("subscription.opencode.zen")

  const [accessToken, setAccessToken] = useState("")
  const [baseUrl, setBaseUrl] = useState("")
  const [label, setLabel] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [prevOpen, setPrevOpen] = useState(open)
  if (open !== prevOpen) {
    setPrevOpen(open)
    if (open) {
      setAccessToken("")
      setBaseUrl("")
      setLabel("")
      setError(null)
      setBusy(false)
    }
  }

  const onSubmit = async () => {
    if (!accessToken.trim()) return
    setBusy(true)
    setError(null)
    try {
      const account = await saveOpencodeZenKey({
        accessToken: accessToken.trim(),
        baseUrl: baseUrl.trim() || undefined,
        label: label.trim() || undefined,
      })
      onAdded?.(account)
      onOpenChange(false)
    } catch (e) {
      setError(t("saveFailed", { error: e instanceof Error ? e.message : String(e) }))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="opencode-zen-token">{t("accessTokenField")}</Label>
            <Input
              id="opencode-zen-token"
              type="password"
              value={accessToken}
              onChange={(e) => setAccessToken(e.target.value)}
              placeholder={t("accessTokenPlaceholder")}
              autoFocus
              spellCheck={false}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="opencode-zen-base-url">{t("baseUrlField")}</Label>
            <Input
              id="opencode-zen-base-url"
              type="url"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder={t("baseUrlPlaceholder")}
              spellCheck={false}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="opencode-zen-label">{t("labelField")}</Label>
            <Input
              id="opencode-zen-label"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder={t("labelPlaceholder")}
            />
          </div>
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            {t("cancel")}
          </Button>
          <Button onClick={() => void onSubmit()} disabled={!accessToken.trim() || busy}>
            {busy && <Loader2Icon className="mr-2 size-4 animate-spin" />}
            {t("save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
