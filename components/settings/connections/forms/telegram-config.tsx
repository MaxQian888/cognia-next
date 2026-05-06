"use client"

// Telegram-specific adapter configuration dialog.
// Wraps AdapterForm with:
//   - Bot token field (secret, tested via getMe)
//   - Transport mode switcher (longpoll | webhook)
//   - Optional webhook secret token field
// On save: creates or updates the AdapterInstanceRow and writes the bot token
// to the keyring via connectorsKeyringSet.

import { useState } from "react"
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
import { connectorsHttpRequest, connectorsKeyringSet } from "@/lib/connectors/tauri/commands"
import { isTauri } from "@/lib/tauri"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"
import type { TransportMode } from "@/types/connectors/adapter"
import { defaultPrivateChatPolicy } from "@/types/connectors/policy"

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

interface GetMeResult {
  ok: boolean
  username?: string
  id?: number
  error?: string
}

// ----------------------------------------------------------------------------
// Test Connection
// ----------------------------------------------------------------------------

async function testTelegramToken(token: string): Promise<GetMeResult> {
  try {
    const resp = await connectorsHttpRequest({
      url: `https://api.telegram.org/bot${token}/getMe`,
      method: "GET",
      timeoutMs: 8000,
    })
    const parsed = JSON.parse(resp.body) as {
      ok: boolean
      result?: { id: number; username?: string }
      description?: string
    }
    if (parsed.ok && parsed.result) {
      return { ok: true, username: parsed.result.username, id: parsed.result.id }
    }
    return { ok: false, error: parsed.description ?? "Unknown error" }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

// ----------------------------------------------------------------------------
// Dialog
// ----------------------------------------------------------------------------

interface TelegramConfigDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** null = creating a new instance */
  row: AdapterInstanceRow | null
}

export function TelegramConfigDialog({ open, onOpenChange, row }: TelegramConfigDialogProps) {
  const t = useTranslations("settings.connections.telegram")
  const isNew = row === null

  const [displayName, setDisplayName] = useState(row?.displayName ?? t("displayNamePlaceholder"))
  const [botToken, setBotToken] = useState("")
  const [transport, setTransport] = useState<TransportMode>(
    (row?.transportMode as TransportMode) ?? "longpoll"
  )
  const [webhookSecret, setWebhookSecret] = useState("")

  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<GetMeResult | null>(null)

  const [saving, setSaving] = useState(false)

  const desktop = isTauri()

  const handleTest = async () => {
    if (!botToken.trim()) {
      toast.error(t("tokenRequiredForTest"))
      return
    }
    setTesting(true)
    setTestResult(null)
    const result = await testTelegramToken(botToken.trim())
    setTestResult(result)
    setTesting(false)
    if (result.ok) {
      toast.success(t("connectedToast", { username: result.username ?? t("unknownUsername") }))
    } else {
      toast.error(result.error ?? t("connectionFailedToast"))
    }
  }

  const handleSave = async () => {
    if (!displayName.trim()) {
      toast.error(t("displayNameRequired"))
      return
    }
    if (isNew && !botToken.trim()) {
      toast.error(t("botTokenRequired"))
      return
    }

    setSaving(true)
    try {
      let adapterId: string

      if (isNew) {
        const newRow = await createAdapterInstance({
          type: "telegram",
          displayName: displayName.trim(),
          enabled: true,
          transportMode: transport,
          settings: {},
          credentialsRef: {
            keyringService: "com.cognia.platforms",
            accounts: ["botToken"],
          },
          trigger: defaultPrivateChatPolicy(),
          defaultMode: "auto",
        })
        adapterId = newRow.id
      } else {
        adapterId = row.id
        await updateAdapterInstance(adapterId, {
          displayName: displayName.trim(),
          transportMode: transport,
        })
      }

      // Write secrets to keyring (Tauri only)
      if (botToken.trim()) {
        await connectorsKeyringSet(adapterId, "botToken", botToken.trim())
      }
      if (webhookSecret.trim()) {
        await connectorsKeyringSet(adapterId, "webhookSecret", webhookSecret.trim())
      }

      toast.success(isNew ? t("adapterCreated") : t("adapterUpdated"))
      onOpenChange(false)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
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
            <Label htmlFor="tg-display-name">{t("displayNameLabel")}</Label>
            <Input
              id="tg-display-name"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder={t("displayNamePlaceholder")}
              disabled={saving}
            />
          </div>

          {/* Bot token + test */}
          <div className="space-y-1.5">
            <Label htmlFor="tg-bot-token">
              {t("botTokenLabel")}
              <span className="ml-1 text-destructive">*</span>
            </Label>
            <p className="text-xs text-muted-foreground">{t("botTokenHelp")}</p>
            <div className="flex gap-2">
              <Input
                id="tg-bot-token"
                type="password"
                autoComplete="new-password"
                value={botToken}
                onChange={(e) => setBotToken(e.target.value)}
                placeholder={t("botTokenPlaceholder")}
                disabled={saving}
                className="flex-1"
              />
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={handleTest}
                disabled={testing || saving || !desktop}
                aria-label={t("testConnectionAria")}
              >
                {testing ? (
                  <LoaderIcon className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  t("testButtonLabel")
                )}
              </Button>
            </div>

            {/* Test result display */}
            {testResult !== null && (
              <div
                className={`flex items-center gap-2 rounded-md px-3 py-2 text-xs ${
                  testResult.ok
                    ? "bg-emerald-50 text-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-300"
                    : "bg-destructive/10 text-destructive"
                }`}
                role="status"
                aria-label={
                  testResult.ok ? t("connectionSucceededLabel") : t("connectionFailedLabel")
                }
              >
                {testResult.ok ? (
                  <CheckCircle2Icon className="h-3.5 w-3.5 shrink-0" />
                ) : (
                  <XCircleIcon className="h-3.5 w-3.5 shrink-0" />
                )}
                {testResult.ok
                  ? t("connectedAs", {
                      username: testResult.username ?? t("unknownUsername"),
                      id: testResult.id ?? t("unknownId"),
                    })
                  : testResult.error}
              </div>
            )}

            {!desktop && (
              <p className="text-xs text-amber-600 dark:text-amber-400">
                {t("testRequiresDesktop")}
              </p>
            )}
          </div>

          <Separator />

          {/* Transport mode */}
          <div className="space-y-1.5">
            <Label htmlFor="tg-transport">{t("transportLabel")}</Label>
            <Select
              value={transport}
              onValueChange={(v) => setTransport(v as TransportMode)}
              disabled={saving}
            >
              <SelectTrigger id="tg-transport">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="longpoll">{t("transportLongpoll")}</SelectItem>
                <SelectItem value="webhook">{t("transportWebhook")}</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              {transport === "longpoll" ? t("transportLongpollHelp") : t("transportWebhookHelp")}
            </p>
          </div>

          {/* Webhook secret (only when webhook selected) */}
          {transport === "webhook" && (
            <div className="space-y-1.5">
              <Label htmlFor="tg-webhook-secret">{t("webhookSecretLabel")}</Label>
              <p className="text-xs text-muted-foreground">
                {t("webhookSecretHelpPrefix")}{" "}
                <code className="text-xs">X-Telegram-Bot-Api-Secret-Token</code>{" "}
                {t("webhookSecretHelpSuffix")}
              </p>
              <Input
                id="tg-webhook-secret"
                type="password"
                autoComplete="new-password"
                value={webhookSecret}
                onChange={(e) => setWebhookSecret(e.target.value)}
                placeholder={t("webhookSecretPlaceholder")}
                disabled={saving}
              />
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
