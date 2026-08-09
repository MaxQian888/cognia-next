"use client"

// OpenCode add-account dialog. Two paths:
//
//   • Paste API key — the user copies their managed-plan key (Zen
//     pay-per-request or Go flat-rate) from opencode.ai and pastes it here.
//     Stored in the unified vault as an `OpencodeZen` account tagged with
//     the chosen plan.
//   • Discovery is surfaced INLINE in the OpenCode provider tab (not in this
//     dialog) because it's read-only and never blocks; the dialog is reserved
//     for the explicit write path.

import { useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
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
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"

import { saveOpencodeZenKey } from "@/lib/subscription/opencode/discovery"
import { persistProviderAccount } from "@/lib/subscription/core/account-lifecycle"
import type { Account, OpencodePlan } from "@/types/subscription"

export interface OpencodeAddAccountDialogProps {
  open: boolean
  onOpenChange: (next: boolean) => void
  onAdded?: (account: Account) => void
  existingAccount?: Account
}

export function OpencodeAddAccountDialog({
  open,
  onOpenChange,
  onAdded,
  existingAccount,
}: OpencodeAddAccountDialogProps) {
  const t = useTranslations("subscription.opencode.zen")
  const tAccountList = useTranslations("subscription.common.accountList")

  const [accessToken, setAccessToken] = useState("")
  const [baseUrl, setBaseUrl] = useState("")
  const [label, setLabel] = useState("")
  const [plan, setPlan] = useState<OpencodePlan>("zen")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [prevOpen, setPrevOpen] = useState(open)
  if (open !== prevOpen) {
    setPrevOpen(open)
    if (open) {
      setAccessToken("")
      const existingCredential =
        existingAccount?.credential.provider === "opencode-zen"
          ? existingAccount.credential
          : undefined
      setBaseUrl(existingCredential?.baseUrl ?? "")
      setLabel(existingAccount?.label ?? "")
      setPlan(existingCredential?.plan ?? "zen")
      setError(null)
      setBusy(false)
    }
  }

  const onSubmit = async () => {
    if (!accessToken.trim()) return
    setBusy(true)
    setError(null)
    try {
      const account = existingAccount
        ? await persistProviderAccount("opencode", {
            ...existingAccount,
            label: label.trim() || existingAccount.label,
            credential: {
              provider: "opencode-zen",
              accessToken: accessToken.trim(),
              baseUrl: baseUrl.trim() || undefined,
              plan,
              storedAtMs: Date.now(),
            },
            lastUsedAtMs: Date.now(),
          })
        : await persistProviderAccount(
            "opencode",
            await saveOpencodeZenKey({
              accessToken: accessToken.trim(),
              baseUrl: baseUrl.trim() || undefined,
              label: label.trim() || undefined,
              plan,
            })
          )
      onAdded?.(account)
      toast.success(tAccountList(existingAccount ? "credentialsUpdated" : "accountAdded"))
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
            <Label>{t("planField")}</Label>
            <RadioGroup
              value={plan}
              onValueChange={(next) => setPlan(next === "go" ? "go" : "zen")}
              className="flex gap-4"
            >
              <div className="flex items-center gap-2">
                <RadioGroupItem id="opencode-plan-zen" value="zen" />
                <Label htmlFor="opencode-plan-zen" className="font-normal">
                  {t("planZen")}
                </Label>
              </div>
              <div className="flex items-center gap-2">
                <RadioGroupItem id="opencode-plan-go" value="go" />
                <Label htmlFor="opencode-plan-go" className="font-normal">
                  {t("planGo")}
                </Label>
              </div>
            </RadioGroup>
          </div>
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
              placeholder={plan === "go" ? t("labelPlaceholderGo") : t("labelPlaceholder")}
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
