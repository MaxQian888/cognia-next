"use client"

// OneBot adapter configuration dialog.
//
// OneBot uses a reverse-WebSocket connection — the QQ client (NapCat/Lagrange/
// LLOneBot) connects TO cognia-next. There is no "Test connection" button;
// instead the user is shown the reverse-WS endpoint URL to paste into NapCat
// config, and a "Verify" button that listens for an `open` event for ~10 s.
//
// Fields:
//   - Display name (required)
//   - Bot UIN / QQ number (required)
//   - Optional bearer token (secret)
//   - Expected client hint (cosmetic)

import { useState, useCallback } from "react"
import { useTranslations } from "next-intl"
import { CheckCircle2Icon, LoaderIcon, XCircleIcon } from "lucide-react"
import { toast } from "sonner"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import { createAdapterInstance, updateAdapterInstance } from "@/lib/db/adapter-instances"
import { connectorsKeyringSet, connectorsHealth } from "@/lib/connectors/tauri/commands"
import { isTauri } from "@/lib/tauri"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"
import { defaultGroupChatPolicy } from "@/types/connectors/policy"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ExpectedClient = "napcat" | "lagrange" | "llonebot" | "other"

interface OneBotConfigDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** null = creating a new instance */
  row: AdapterInstanceRow | null
}

// ---------------------------------------------------------------------------
// Helper: resolve the WS endpoint URL
// ---------------------------------------------------------------------------

async function resolveWsEndpoint(adapterId: string): Promise<string> {
  try {
    const health = await connectorsHealth()
    const addr = health.boundAddr ?? "127.0.0.1:8080"
    return `ws://${addr}/ws/onebot/${adapterId}`
  } catch {
    return `ws://127.0.0.1:8080/ws/onebot/${adapterId}`
  }
}

// ---------------------------------------------------------------------------
// Dialog
// ---------------------------------------------------------------------------

export function OneBotConfigDialog({ open, onOpenChange, row }: OneBotConfigDialogProps) {
  const t = useTranslations("settings.connections.onebot")
  const isNew = row === null
  const settings = (row?.settings ?? {}) as {
    selfBotUin?: string
    expectedClient?: ExpectedClient
  }

  const [displayName, setDisplayName] = useState(row?.displayName ?? t("displayNamePlaceholder"))
  const [botUin, setBotUin] = useState(settings.selfBotUin ?? "")
  const [bearerToken, setBearerToken] = useState("")
  const [expectedClient, setExpectedClient] = useState<ExpectedClient>(
    settings.expectedClient ?? "napcat"
  )
  const [saving, setSaving] = useState(false)
  const [savedAdapterId, setSavedAdapterId] = useState<string | null>(row?.id ?? null)
  const [wsEndpoint, setWsEndpoint] = useState<string>("")
  const [verifying, setVerifying] = useState(false)
  const [verifyResult, setVerifyResult] = useState<"connected" | "timeout" | null>(null)

  const desktop = isTauri()

  // Resolve endpoint once we have an adapterId
  const resolveEndpoint = useCallback(async (adapterId: string) => {
    const url = await resolveWsEndpoint(adapterId)
    setWsEndpoint(url)
  }, [])

  // After save, trigger endpoint resolution
  const handleSave = async () => {
    if (!displayName.trim()) {
      toast.error(t("displayNameRequired"))
      return
    }
    if (!botUin.trim()) {
      toast.error(t("botUinRequired"))
      return
    }

    setSaving(true)
    try {
      let adapterId: string

      if (isNew) {
        const newRow = await createAdapterInstance({
          type: "onebot",
          displayName: displayName.trim(),
          enabled: true,
          transportMode: "reverse-ws",
          settings: {
            selfBotUin: botUin.trim(),
            expectedClient,
          },
          credentialsRef: {
            keyringService: "com.cognia.platforms",
            accounts: bearerToken.trim() ? ["onebotBearer"] : [],
          },
          trigger: defaultGroupChatPolicy(),
          defaultMode: "auto",
        })
        adapterId = newRow.id
      } else {
        adapterId = row.id
        await updateAdapterInstance(adapterId, {
          displayName: displayName.trim(),
          settings: {
            selfBotUin: botUin.trim(),
            expectedClient,
          },
        })
      }

      // Write bearer token to keyring if provided
      if (bearerToken.trim()) {
        await connectorsKeyringSet(adapterId, "onebotBearer", bearerToken.trim())
      }

      setSavedAdapterId(adapterId)
      await resolveEndpoint(adapterId)

      toast.success(isNew ? t("adapterCreatedWithEndpoint") : t("adapterUpdated"))
      onOpenChange(false)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const handleVerify = async () => {
    if (!savedAdapterId) {
      toast.error(t("saveBeforeVerify"))
      return
    }

    setVerifying(true)
    setVerifyResult(null)

    // Listen for the open event for up to 10 s
    try {
      const { listen } = await import("@tauri-apps/api/event")
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error("timeout"))
        }, 10_000)

        listen<void>(`connectors://onebot/${savedAdapterId}/open`, () => {
          clearTimeout(timer)
          resolve()
        }).then((unlisten) => {
          // Cleanup after 10 s regardless
          setTimeout(unlisten, 10_500)
        })
      })
      setVerifyResult("connected")
      toast.success(t("verifyConnectedToast"))
    } catch {
      setVerifyResult("timeout")
      toast.error(t("verifyTimeoutToast"))
    } finally {
      setVerifying(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{isNew ? t("titleNew") : t("titleEdit")}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {/* Display name */}
          <div className="space-y-1.5">
            <Label htmlFor="ob-display-name">{t("displayNameLabel")}</Label>
            <Input
              id="ob-display-name"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder={t("displayNamePlaceholder")}
              disabled={saving}
            />
          </div>

          {/* Bot UIN */}
          <div className="space-y-1.5">
            <Label htmlFor="ob-uin">
              {t("botUinLabel")}
              <span className="ml-1 text-destructive">*</span>
            </Label>
            <p className="text-xs text-muted-foreground">{t("botUinHelp")}</p>
            <Input
              id="ob-uin"
              value={botUin}
              onChange={(e) => setBotUin(e.target.value)}
              placeholder={t("botUinPlaceholder")}
              disabled={saving}
            />
          </div>

          {/* Bearer token */}
          <div className="space-y-1.5">
            <Label htmlFor="ob-bearer">{t("bearerTokenLabel")}</Label>
            <p className="text-xs text-muted-foreground">
              {t("bearerTokenHelpPrefix")} <code className="text-xs">accessToken</code>{" "}
              {t("bearerTokenHelpSuffix")}
            </p>
            <Input
              id="ob-bearer"
              type="password"
              autoComplete="new-password"
              value={bearerToken}
              onChange={(e) => setBearerToken(e.target.value)}
              placeholder={t("bearerTokenPlaceholder")}
              disabled={saving}
            />
          </div>

          {/* Expected client hint */}
          <div className="space-y-1.5">
            <Label htmlFor="ob-client">{t("expectedClientLabel")}</Label>
            <Select
              value={expectedClient}
              onValueChange={(v) => setExpectedClient(v as ExpectedClient)}
              disabled={saving}
            >
              <SelectTrigger id="ob-client">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="napcat">{t("expectedClientNapcat")}</SelectItem>
                <SelectItem value="lagrange">{t("expectedClientLagrange")}</SelectItem>
                <SelectItem value="llonebot">{t("expectedClientLlonebot")}</SelectItem>
                <SelectItem value="other">{t("expectedClientOther")}</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">{t("expectedClientHelp")}</p>
          </div>

          <Separator />

          {/* Reverse-WS endpoint display */}
          {savedAdapterId && wsEndpoint && (
            <div className="space-y-1.5">
              <Label>{t("endpointLabel")}</Label>
              <p className="text-xs text-muted-foreground">
                {t("endpointHelpPrefix")} <code className="text-xs">wsReverse</code>{" "}
                {t("endpointHelpSuffix")}
              </p>
              <div
                className="rounded-md bg-muted px-3 py-2 font-mono text-xs break-all"
                aria-label={t("endpointAria")}
              >
                {wsEndpoint}
              </div>

              {/* Verify connection button */}
              {desktop && (
                <div className="flex items-center gap-2 pt-1">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={handleVerify}
                    disabled={verifying}
                    aria-label={t("verifyConnectionAria")}
                  >
                    {verifying ? (
                      <LoaderIcon className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      t("verifyConnectionButton")
                    )}
                  </Button>
                  {verifyResult === "connected" && (
                    <span className="flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
                      <CheckCircle2Icon className="h-3.5 w-3.5" />
                      {t("verifyConnectedBadge")}
                    </span>
                  )}
                  {verifyResult === "timeout" && (
                    <span className="flex items-center gap-1 text-xs text-destructive">
                      <XCircleIcon className="h-3.5 w-3.5" />
                      {t("verifyTimeoutBadge")}
                    </span>
                  )}
                </div>
              )}
            </div>
          )}

          <Separator />

          {/* Actions */}
          <div className="flex items-center justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={saving}
            >
              {t("cancel")}
            </Button>
            <Button type="button" onClick={handleSave} disabled={saving}>
              {saving ? t("saving") : isNew ? t("create") : t("save")}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
