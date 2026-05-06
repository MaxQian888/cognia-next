"use client"

// Discord-specific adapter configuration dialog.
// Wraps an adapter form with:
//   - Bot Token field (secret, tested via /users/@me)
//   - Optional Public Key field (for Ed25519 webhook verification)
//   - Intents toggle (defaults to 33281: GUILDS + GUILD_MESSAGES + MESSAGE_CONTENT + DIRECT_MESSAGES)
//
// On save: creates / updates the AdapterInstanceRow with transportMode="gateway"
// and writes botToken (+ optionally publicKey) to the OS keyring.

import { useState } from "react"
import { useTranslations } from "next-intl"
import { CheckCircle2Icon, LoaderIcon, XCircleIcon } from "lucide-react"
import { toast } from "sonner"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Separator } from "@/components/ui/separator"
import { createAdapterInstance, updateAdapterInstance } from "@/lib/db/adapter-instances"
import { connectorsHttpRequest, connectorsKeyringSet } from "@/lib/connectors/tauri/commands"
import { isTauri } from "@/lib/tauri"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"
import { defaultPrivateChatPolicy } from "@/types/connectors/policy"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface GetCurrentUserResult {
  ok: boolean
  username?: string
  id?: string
  error?: string
}

// ---------------------------------------------------------------------------
// Test connection
// ---------------------------------------------------------------------------

async function testDiscordToken(token: string): Promise<GetCurrentUserResult> {
  try {
    const resp = await connectorsHttpRequest({
      url: "https://discord.com/api/v10/users/@me",
      method: "GET",
      headers: { Authorization: `Bot ${token}` },
      timeoutMs: 8000,
    })
    const parsed = JSON.parse(resp.body) as {
      id?: string
      username?: string
      code?: number
      message?: string
    }
    if (parsed.id && parsed.username) {
      return { ok: true, username: parsed.username, id: parsed.id }
    }
    return { ok: false, error: parsed.message ?? "Unknown error" }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

// ---------------------------------------------------------------------------
// Dialog
// ---------------------------------------------------------------------------

interface DiscordConfigDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** null = creating a new instance */
  row: AdapterInstanceRow | null
}

export function DiscordConfigDialog({ open, onOpenChange, row }: DiscordConfigDialogProps) {
  const t = useTranslations("settings.connections.discord")
  const isNew = row === null

  const [displayName, setDisplayName] = useState(row?.displayName ?? t("displayNamePlaceholder"))
  const [botToken, setBotToken] = useState("")
  const [publicKey, setPublicKey] = useState("")

  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<GetCurrentUserResult | null>(null)

  const [saving, setSaving] = useState(false)

  const desktop = isTauri()

  const handleTest = async () => {
    if (!botToken.trim()) {
      toast.error(t("tokenRequiredForTest"))
      return
    }
    setTesting(true)
    setTestResult(null)
    const result = await testDiscordToken(botToken.trim())
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
          type: "discord",
          displayName: displayName.trim(),
          enabled: true,
          transportMode: "gateway",
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
          transportMode: "gateway",
        })
      }

      // Write secrets to keyring (Tauri only)
      if (botToken.trim()) {
        await connectorsKeyringSet(adapterId, "botToken", botToken.trim())
      }
      if (publicKey.trim()) {
        await connectorsKeyringSet(adapterId, "publicKey", publicKey.trim())
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
            <Label htmlFor="dc-display-name">{t("displayNameLabel")}</Label>
            <Input
              id="dc-display-name"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder={t("displayNamePlaceholder")}
              disabled={saving}
            />
          </div>

          {/* Bot token + test */}
          <div className="space-y-1.5">
            <Label htmlFor="dc-bot-token">
              {t("botTokenLabel")}
              <span className="ml-1 text-destructive">*</span>
            </Label>
            <p className="text-xs text-muted-foreground">{t("botTokenHelp")}</p>
            <div className="flex gap-2">
              <Input
                id="dc-bot-token"
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

            {/* Test result */}
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

          {/* Public key (optional) */}
          <div className="space-y-1.5">
            <Label htmlFor="dc-public-key">{t("publicKeyLabel")}</Label>
            <p className="text-xs text-muted-foreground">{t("publicKeyHelp")}</p>
            <Input
              id="dc-public-key"
              type="password"
              autoComplete="new-password"
              value={publicKey}
              onChange={(e) => setPublicKey(e.target.value)}
              placeholder={t("publicKeyPlaceholder")}
              disabled={saving}
            />
          </div>

          <Separator />

          {/* Info: transport mode */}
          <p className="text-xs text-muted-foreground">
            {t("transportInfoPrefix")}{" "}
            <span className="font-medium">{t("transportInfoValue")}</span>{" "}
            {t("transportInfoSuffix")}
          </p>

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
