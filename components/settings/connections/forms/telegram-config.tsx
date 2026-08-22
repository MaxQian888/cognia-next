"use client"

/**
 * Telegram adapter configuration dialog.
 *
 * Migrated to the shared `AdapterFormSections` shell — Identity holds the
 * bot token + Test connection; Delivery holds the transport (longpoll vs
 * webhook), the dynamic webhook URL (auto-resolved from the Cloudflared
 * tunnel) and the webhook secret token; Advanced holds the cross-cutting
 * Quiet-Hours + Mute controls.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { useRouter } from "next/navigation"
import { CheckCircle2Icon, ExternalLinkIcon, LoaderIcon, XCircleIcon } from "lucide-react"
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
import { createAdapterInstance, updateAdapterInstance } from "@/lib/db/adapter-instances"
import {
  connectorsHttpRequest,
  connectorsKeyringGet,
  connectorsKeyringSet,
} from "@/lib/connectors/tauri/commands"
import { emitCredentialsRotated } from "@/lib/connectors/credentials-events"
import { isTauri } from "@/lib/tauri"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"
import type { TransportMode } from "@/types/connectors/adapter"
import { defaultPrivateChatPolicy } from "@/types/connectors/policy"
import { useTunnelStatus } from "@/hooks/use-tunnel-status"
import { AdapterFormSections, type FormSection } from "./_shared/adapter-form-sections"
import { QuietHoursAndMute, type QuietHoursValue } from "./quiet-hours-and-mute"

interface GetMeResult {
  ok: boolean
  username?: string
  id?: number
  error?: string
}

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

interface TelegramConfigDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Called with the new adapter id after a successful create, so the parent
   * can auto-select and open the freshly created adapter. */
  onCreated?: (id: string) => void
  /** null = creating a new instance */
  row: AdapterInstanceRow | null
}

function telegramCredentialAccounts(transport: TransportMode): string[] {
  // "secretToken" is the keyring key the Rust webhook verifier reads
  // (crates/cognia-connectors/src/axum_app.rs — X-Telegram-Bot-Api-Secret-Token
  // check); "webhookSecret" is the legacy key kept for backward compat.
  return transport === "webhook" ? ["botToken", "secretToken", "webhookSecret"] : ["botToken"]
}

function sameCredentialAccounts(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && expected.every((account) => actual.includes(account))
}

export function TelegramConfigDialog({
  open,
  onOpenChange,
  row,
  onCreated,
}: TelegramConfigDialogProps) {
  const t = useTranslations("settings.connections.telegram")
  const router = useRouter()
  const isNew = row === null

  const [displayName, setDisplayName] = useState(row?.displayName ?? t("displayNamePlaceholder"))
  const [botToken, setBotToken] = useState("")
  const [transport, setTransport] = useState<TransportMode>(
    (row?.transportMode as TransportMode) ?? "longpoll"
  )
  const [webhookSecret, setWebhookSecret] = useState("")
  const [muted, setMuted] = useState<boolean>(row?.muted ?? false)
  const [quietHours, setQuietHours] = useState<QuietHoursValue | null>(row?.quietHours ?? null)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<GetMeResult | null>(null)
  const [saving, setSaving] = useState(false)

  const desktop = isTauri()
  const tunnel = useTunnelStatus()

  const dirty =
    isNew ||
    displayName.trim() !== row?.displayName ||
    botToken.length > 0 ||
    webhookSecret.length > 0 ||
    transport !== ((row?.transportMode as TransportMode) ?? "longpoll") ||
    muted !== (row?.muted ?? false) ||
    quietHours !== (row?.quietHours ?? null)

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

  const handleCopyWebhookUrl = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url)
      toast.success(t("webhookUrlCopied"))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
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
    if (quietHours && (!quietHours.from || !quietHours.to || !quietHours.tz)) {
      toast.error(t("quietHoursIncomplete"))
      return
    }
    // Webhook mode cannot work without a secret: the local receiver
    // (`verify_telegram` in axum_app.rs) answers 401 to every delivery that
    // arrives without one, and the adapter therefore refuses to register the
    // webhook at all. Say so here rather than letting the operator find out
    // from a degraded health row. Only the desktop can read the keyring, so a
    // browser session falls back to "a secret must have been set at some
    // point", which is what the adapter's health reason then reports.
    if (transport === "webhook" && !webhookSecret.trim()) {
      const stored =
        !isNew && desktop
          ? await connectorsKeyringGet(row.id, "secretToken").catch(() => null)
          : null
      if (isNew || (desktop && !stored?.trim())) {
        toast.error(t("webhookSecretRequired"))
        return
      }
    }

    setSaving(true)
    try {
      let adapterId: string
      const credentialAccounts = telegramCredentialAccounts(transport)

      if (isNew) {
        const newRow = await createAdapterInstance({
          type: "telegram",
          displayName: displayName.trim(),
          enabled: true,
          transportMode: transport,
          settings: {},
          credentialsRef: {
            keyringService: "com.cognia.platforms",
            accounts: credentialAccounts,
          },
          trigger: defaultPrivateChatPolicy(),
          defaultMode: "auto",
          mediaModelPolicy: "local_extract_only",
          quietHours: quietHours ?? undefined,
          muted,
        })
        adapterId = newRow.id
      } else {
        adapterId = row.id
        const existingAccounts = row.credentialsRef?.accounts ?? []
        const needsMigration = !sameCredentialAccounts(existingAccounts, credentialAccounts)
        await updateAdapterInstance(adapterId, {
          displayName: displayName.trim(),
          transportMode: transport,
          muted,
          quietHours: quietHours ?? undefined,
          ...(needsMigration && {
            credentialsRef: {
              keyringService: row.credentialsRef?.keyringService ?? "com.cognia.platforms",
              accounts: credentialAccounts,
            },
          }),
        })
      }

      if (botToken.trim()) {
        await connectorsKeyringSet(adapterId, "botToken", botToken.trim())
      }
      if (webhookSecret.trim()) {
        // The Rust webhook 401-gate reads "secretToken" — saving only the old
        // "webhookSecret" key meant every webhook delivery failed verification.
        // Keep writing "webhookSecret" too for backward compatibility with
        // anything still reading the legacy key.
        await connectorsKeyringSet(adapterId, "secretToken", webhookSecret.trim())
        await connectorsKeyringSet(adapterId, "webhookSecret", webhookSecret.trim())
      }

      // Hot-reload the running adapter so the new bot token + webhook
      // secret are picked up without an app restart.
      if (!isNew) {
        emitCredentialsRotated(adapterId)
      }

      toast.success(isNew ? t("adapterCreated") : t("adapterUpdated"))
      if (isNew) onCreated?.(adapterId)
      onOpenChange(false)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const webhookPath = isNew ? null : `/webhook/telegram/${row?.id ?? ""}`
  const webhookUrl =
    tunnel.url && webhookPath ? `${tunnel.url.replace(/\/$/, "")}${webhookPath}` : null

  const identitySection: FormSection = {
    id: "identity",
    label: t("sectionIdentity"),
    description: t("sectionIdentityDesc"),
    defaultOpen: true,
    children: (
      <div className="space-y-4">
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
              {testing ? <LoaderIcon className="h-3.5 w-3.5 animate-spin" /> : t("testButtonLabel")}
            </Button>
          </div>

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
            <p className="text-xs text-amber-600 dark:text-amber-400">{t("testRequiresDesktop")}</p>
          )}
        </div>
      </div>
    ),
  }

  const deliverySection: FormSection = {
    id: "delivery",
    label: t("sectionDelivery"),
    description: t("sectionDeliveryDesc"),
    defaultOpen: true,
    children: (
      <div className="space-y-4">
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

        {transport === "webhook" && (
          <>
            <div className="space-y-1.5">
              <Label htmlFor="tg-webhook-secret">
                {t("webhookSecretLabel")}
                <span className="ml-1 text-destructive">*</span>
              </Label>
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

            <div className="space-y-2 rounded border bg-card px-3 py-3">
              <Label className="text-xs font-medium">{t("webhookUrlLabel")}</Label>
              {webhookPath === null ? (
                <p className="text-xs text-muted-foreground">{t("webhookUrlNewAdapterHint")}</p>
              ) : tunnel.loading ? (
                <p className="text-xs text-muted-foreground">{t("webhookUrlTunnelLoading")}</p>
              ) : tunnel.running && webhookUrl ? (
                <div className="space-y-2">
                  <Input
                    readOnly
                    value={webhookUrl}
                    className="font-mono text-[11px]"
                    aria-label={t("webhookUrlLabel")}
                    data-testid="telegram-webhook-url-input"
                  />
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => handleCopyWebhookUrl(webhookUrl)}
                      aria-label={t("webhookUrlCopyAria")}
                    >
                      {t("webhookUrlCopy")}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        typeof window !== "undefined" &&
                        window.open(
                          "https://core.telegram.org/bots/api#setwebhook",
                          "_blank",
                          "noopener,noreferrer"
                        )
                      }
                    >
                      <ExternalLinkIcon className="mr-1 h-3.5 w-3.5" />
                      {t("openDocs")}
                    </Button>
                  </div>
                  <p className="text-[10px] text-muted-foreground">{t("webhookUrlHelp")}</p>
                </div>
              ) : (
                <div className="space-y-2">
                  <p
                    className="text-xs text-amber-700 dark:text-amber-400"
                    data-testid="telegram-webhook-url-tunnel-off"
                  >
                    {t("webhookUrlTunnelOffHelp")}
                  </p>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      router.push("/settings?section=connections&connectionsTab=tunnel")
                    }
                  >
                    {t("openCompanion")}
                  </Button>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    ),
  }

  const advancedSection: FormSection = {
    id: "advanced",
    label: t("sectionAdvanced"),
    description: t("sectionAdvancedDesc"),
    children: (
      <QuietHoursAndMute
        muted={muted}
        onMutedChange={setMuted}
        quietHours={quietHours}
        onQuietHoursChange={setQuietHours}
        disabled={saving}
      />
    ),
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[90vh] flex-col sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{isNew ? t("titleNew") : t("titleEdit")}</DialogTitle>
        </DialogHeader>

        <div className="-mx-6 flex-1 overflow-y-auto px-6">
          <AdapterFormSections
            sections={[identitySection, deliverySection, advancedSection]}
            onSubmit={handleSave}
            onCancel={() => onOpenChange(false)}
            submitting={saving}
            dirty={dirty}
            submitLabel={isNew ? t("create") : t("save")}
          />
        </div>
      </DialogContent>
    </Dialog>
  )
}
