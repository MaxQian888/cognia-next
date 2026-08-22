"use client"

/**
 * Discord adapter configuration dialog.
 *
 * Uses the shared `AdapterFormSections` shell — Identity / Delivery / Advanced
 * collapsible sections. The Delivery section offers a transport selector:
 * Gateway (WebSocket, default — messages + interactions) or Interactions
 * webhook (HTTP, interactions only). Webhook mode persists the Ed25519 public
 * key and surfaces the Interactions Endpoint URL to paste into the Developer
 * Portal.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
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
import { connectorsHttpRequest, connectorsKeyringSet } from "@/lib/connectors/tauri/commands"
import { emitCredentialsRotated } from "@/lib/connectors/credentials-events"
import { useTunnelStatus } from "@/hooks/use-tunnel-status"
import { isTauri } from "@/lib/tauri"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"
import type { TransportMode } from "@/types/connectors/adapter"
import { defaultPrivateChatPolicy } from "@/types/connectors/policy"
import { AdapterFormSections, type FormSection } from "./_shared/adapter-form-sections"
import { QuietHoursAndMute, type QuietHoursValue } from "./quiet-hours-and-mute"

interface GetCurrentUserResult {
  ok: boolean
  username?: string
  id?: string
  error?: string
}

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

interface DiscordConfigDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Called with the new adapter id after a successful create, so the parent
   * can auto-select and open the freshly created adapter. */
  onCreated?: (id: string) => void
  /** null = creating a new instance */
  row: AdapterInstanceRow | null
}

export function DiscordConfigDialog({
  open,
  onOpenChange,
  row,
  onCreated,
}: DiscordConfigDialogProps) {
  const t = useTranslations("settings.connections.discord")
  const isNew = row === null

  const initialIntents =
    typeof (row?.settings as Record<string, unknown> | undefined)?.intents === "number"
      ? String((row?.settings as Record<string, number>).intents)
      : ""

  const [displayName, setDisplayName] = useState(row?.displayName ?? t("displayNamePlaceholder"))
  const [botToken, setBotToken] = useState("")
  const [publicKey, setPublicKey] = useState("")
  const [intents, setIntents] = useState<string>(initialIntents)
  const [transport, setTransport] = useState<TransportMode>(
    row?.transportMode === "webhook" ? "webhook" : "gateway"
  )
  const [muted, setMuted] = useState<boolean>(row?.muted ?? false)
  const [quietHours, setQuietHours] = useState<QuietHoursValue | null>(row?.quietHours ?? null)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<GetCurrentUserResult | null>(null)
  const [saving, setSaving] = useState(false)

  const desktop = isTauri()
  const tunnel = useTunnelStatus()

  // Interactions Endpoint URL (webhook mode) — the tunnel origin + the Rust
  // webhook route path. Only resolvable once the adapter has an id.
  const webhookPath = isNew ? null : `/webhook/discord/${row?.id ?? ""}`
  const webhookUrl =
    tunnel.url && webhookPath ? `${tunnel.url.replace(/\/$/, "")}${webhookPath}` : null

  const dirty =
    isNew ||
    displayName.trim() !== row?.displayName ||
    botToken.length > 0 ||
    publicKey.length > 0 ||
    intents !== initialIntents ||
    transport !== (row?.transportMode === "webhook" ? "webhook" : "gateway") ||
    muted !== (row?.muted ?? false) ||
    quietHours !== (row?.quietHours ?? null)

  const handleCopyWebhookUrl = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url)
      toast.success(t("interactionsUrlCopied"))
    } catch {
      toast.error(t("connectionFailedToast"))
    }
  }

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
    const useWebhook = transport === "webhook"
    if (useWebhook && isNew && !publicKey.trim()) {
      toast.error(t("publicKeyRequiredForWebhook"))
      return
    }
    if (quietHours && (!quietHours.from || !quietHours.to || !quietHours.tz)) {
      toast.error(t("quietHoursIncomplete"))
      return
    }

    const trimmedIntents = intents.trim()
    let intentsNum: number | undefined
    if (trimmedIntents !== "") {
      const n = Number(trimmedIntents)
      if (!Number.isInteger(n) || n < 0) {
        toast.error(t("intentsInvalid"))
        return
      }
      intentsNum = n
    }

    // Merge onto the existing settings so unrelated keys survive; an empty
    // intents field clears the override (adapter falls back to the default).
    const nextSettings: Record<string, unknown> = {
      ...((row?.settings as Record<string, unknown> | undefined) ?? {}),
    }
    if (intentsNum !== undefined) nextSettings.intents = intentsNum
    else delete nextSettings.intents

    setSaving(true)
    try {
      let adapterId: string

      const accounts = useWebhook ? ["botToken", "publicKey"] : ["botToken"]

      if (isNew) {
        const newRow = await createAdapterInstance({
          type: "discord",
          displayName: displayName.trim(),
          enabled: true,
          transportMode: transport,
          settings: nextSettings,
          credentialsRef: {
            keyringService: "com.cognia.platforms",
            accounts,
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
        await updateAdapterInstance(adapterId, {
          displayName: displayName.trim(),
          transportMode: transport,
          settings: nextSettings,
          credentialsRef: {
            keyringService: "com.cognia.platforms",
            accounts,
          },
          muted,
          quietHours: quietHours ?? undefined,
        })
      }

      if (botToken.trim()) {
        await connectorsKeyringSet(adapterId, "botToken", botToken.trim())
      }
      // Webhook mode verifies each Interactions call with the Ed25519 public
      // key (Rust `verify_discord` reads it from the keyring).
      if (useWebhook && publicKey.trim()) {
        await connectorsKeyringSet(adapterId, "publicKey", publicKey.trim())
      }
      // Hot-reload the running adapter so the new credentials are picked up
      // without an app restart.
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

  const identitySection: FormSection = {
    id: "identity",
    label: t("sectionIdentity"),
    description: t("sectionIdentityDesc"),
    defaultOpen: true,
    children: (
      <div className="space-y-4">
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
          <Label htmlFor="dc-transport">{t("transportModeLabel")}</Label>
          <Select
            value={transport}
            onValueChange={(v) => setTransport(v as TransportMode)}
            disabled={saving}
          >
            <SelectTrigger id="dc-transport">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="gateway">{t("transportGatewayLabel")}</SelectItem>
              <SelectItem value="webhook">{t("transportWebhookLabel")}</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            {transport === "gateway" ? t("transportGatewayHelp") : t("transportWebhookHelp")}
          </p>
        </div>

        {transport === "gateway" && (
          <div className="space-y-1.5">
            <Label htmlFor="dc-intents">{t("intentsLabel")}</Label>
            <p className="text-xs text-muted-foreground">{t("intentsHelp")}</p>
            <Input
              id="dc-intents"
              inputMode="numeric"
              value={intents}
              onChange={(e) => setIntents(e.target.value)}
              placeholder={t("intentsPlaceholder")}
              disabled={saving}
            />
          </div>
        )}

        {transport === "webhook" && (
          <>
            <p
              className="rounded border border-amber-300/40 bg-amber-50 px-3 py-2 text-[11px] text-amber-800 dark:border-amber-400/30 dark:bg-amber-950/30 dark:text-amber-300"
              data-testid="dc-webhook-interactions-only-note"
            >
              {t("webhookInteractionsOnlyNote")}
            </p>

            <div className="space-y-1.5">
              <Label htmlFor="dc-public-key">
                {t("publicKeyLabel")}
                <span className="ml-1 text-destructive">*</span>
              </Label>
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

            <div className="space-y-2 rounded border bg-card px-3 py-3">
              <Label className="text-xs font-medium">{t("interactionsUrlLabel")}</Label>
              {webhookPath === null ? (
                <p className="text-xs text-muted-foreground">
                  {t("interactionsUrlNewAdapterHint")}
                </p>
              ) : tunnel.loading ? (
                <p className="text-xs text-muted-foreground">{t("interactionsUrlTunnelLoading")}</p>
              ) : tunnel.running && webhookUrl ? (
                <div className="space-y-2">
                  <Input
                    readOnly
                    value={webhookUrl}
                    className="font-mono text-[11px]"
                    aria-label={t("interactionsUrlLabel")}
                    data-testid="dc-interactions-url-input"
                  />
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => handleCopyWebhookUrl(webhookUrl)}
                      aria-label={t("interactionsUrlCopyAria")}
                    >
                      {t("interactionsUrlCopy")}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        typeof window !== "undefined" &&
                        window.open(
                          "https://discord.com/developers/applications",
                          "_blank",
                          "noopener,noreferrer"
                        )
                      }
                    >
                      <ExternalLinkIcon className="mr-1 h-3.5 w-3.5" />
                      {t("openConsole")}
                    </Button>
                  </div>
                  <p className="text-[10px] text-muted-foreground">{t("interactionsUrlHelp")}</p>
                </div>
              ) : (
                <p
                  className="text-xs text-amber-700 dark:text-amber-400"
                  data-testid="dc-interactions-url-tunnel-off"
                >
                  {t("interactionsUrlTunnelOffHelp")}
                </p>
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
