"use client"

/**
 * Slack adapter configuration dialog.
 *
 * Migrated to the shared `AdapterFormSections` shell so credentials, the
 * outbound/inbound transport, and the cross-cutting Quiet-Hours +
 * Mute controls each live in their own collapsible section. The shell is
 * the same primitive used by `lark-config.tsx`.
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
import { isTauri } from "@/lib/tauri"
import { openUrl } from "@/lib/native/opener"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"
import { defaultPrivateChatPolicy } from "@/types/connectors/policy"
import { buildSlackOAuthUrl } from "@/lib/connectors/adapters/slack/oauth"
import { useTunnelStatus } from "@/hooks/use-tunnel-status"
import { AdapterFormSections, type FormSection } from "./_shared/adapter-form-sections"
import { QuietHoursAndMute, type QuietHoursValue } from "./quiet-hours-and-mute"

interface AuthTestResult {
  ok: boolean
  team?: string
  user?: string
  userId?: string
  error?: string
}

type TransportMode = "socket-mode" | "events-api-webhook"

async function testSlackToken(token: string): Promise<AuthTestResult> {
  try {
    const resp = await connectorsHttpRequest({
      url: "https://slack.com/api/auth.test",
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "",
      timeoutMs: 8000,
    })
    const parsed = JSON.parse(resp.body) as {
      ok: boolean
      team?: string
      user?: string
      user_id?: string
      error?: string
    }
    if (parsed.ok) {
      return { ok: true, team: parsed.team, user: parsed.user, userId: parsed.user_id }
    }
    return { ok: false, error: parsed.error ?? "Unknown error" }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

interface SlackPersistedSettings {
  transport?: TransportMode
  [key: string]: unknown
}

interface SlackConfigDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Called with the new adapter id after a successful create, so the parent
   * can auto-select and open the freshly created adapter. */
  onCreated?: (id: string) => void
  /** null = creating a new instance */
  row: AdapterInstanceRow | null
}

export function SlackConfigDialog({ open, onOpenChange, row, onCreated }: SlackConfigDialogProps) {
  const t = useTranslations("settings.connections.slack")
  const isNew = row === null
  const persisted = (row?.settings ?? {}) as SlackPersistedSettings

  const [displayName, setDisplayName] = useState(row?.displayName ?? t("displayNamePlaceholder"))
  const [botToken, setBotToken] = useState("")
  const [signingSecret, setSigningSecret] = useState("")
  const [appToken, setAppToken] = useState("")
  const [transport, setTransport] = useState<TransportMode>(persisted.transport ?? "socket-mode")
  const [muted, setMuted] = useState<boolean>(row?.muted ?? false)
  const [quietHours, setQuietHours] = useState<QuietHoursValue | null>(row?.quietHours ?? null)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<AuthTestResult | null>(null)
  const [saving, setSaving] = useState(false)

  const desktop = isTauri()
  const tunnel = useTunnelStatus()

  const dirty =
    isNew ||
    displayName.trim() !== row?.displayName ||
    botToken.length > 0 ||
    signingSecret.length > 0 ||
    appToken.length > 0 ||
    transport !== (persisted.transport ?? "socket-mode") ||
    muted !== (row?.muted ?? false) ||
    quietHours !== (row?.quietHours ?? null)

  const handleTest = async () => {
    if (!botToken.trim()) {
      toast.error(t("tokenRequiredForTest"))
      return
    }
    setTesting(true)
    setTestResult(null)
    const result = await testSlackToken(botToken.trim())
    setTestResult(result)
    setTesting(false)
    if (result.ok) {
      toast.success(
        t("connectedToast", {
          user: result.user ?? t("unknownUser"),
          team: result.team ?? t("unknownTeam"),
        })
      )
    } else {
      toast.error(result.error ?? t("connectionFailedToast"))
    }
  }

  const handleOAuth = () => {
    const clientId = process.env.NEXT_PUBLIC_SLACK_CLIENT_ID ?? ""
    if (!clientId) {
      toast.error(t("oauthClientIdMissing"))
      return
    }
    const state =
      typeof crypto !== "undefined" ? crypto.randomUUID() : Math.random().toString(36).slice(2)
    if (typeof sessionStorage !== "undefined") {
      sessionStorage.setItem("slack_oauth_state", state)
    }
    const url = buildSlackOAuthUrl({
      clientId,
      scopes: ["chat:write", "channels:history", "im:history", "app_mentions:read"],
      redirectUri: "cognia://connector/oauth/slack",
      state,
    })
    void openUrl(url)
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
    if (isNew && transport === "events-api-webhook" && !signingSecret.trim()) {
      toast.error(t("signingSecretRequired"))
      return
    }
    if (isNew && transport === "socket-mode" && !appToken.trim()) {
      toast.error(t("appTokenRequired"))
      return
    }
    if (quietHours && (!quietHours.from || !quietHours.to || !quietHours.tz)) {
      toast.error(t("quietHoursIncomplete"))
      return
    }

    setSaving(true)
    try {
      let adapterId: string
      const transportMode = transport === "socket-mode" ? "gateway" : "webhook"
      const nextSettings: SlackPersistedSettings = { transport }

      if (isNew) {
        const newRow = await createAdapterInstance({
          type: "slack",
          displayName: displayName.trim(),
          enabled: true,
          transportMode,
          settings: nextSettings,
          credentialsRef: {
            keyringService: "com.cognia.platforms",
            accounts: [
              "botToken",
              ...(transport === "events-api-webhook" ? ["signingSecret"] : []),
              ...(transport === "socket-mode" ? ["appToken"] : []),
            ],
          },
          trigger: defaultPrivateChatPolicy(),
          defaultMode: "auto",
          quietHours: quietHours ?? undefined,
          muted,
        })
        adapterId = newRow.id
      } else {
        adapterId = row.id
        await updateAdapterInstance(adapterId, {
          displayName: displayName.trim(),
          transportMode,
          settings: nextSettings,
          muted,
          quietHours: quietHours ?? undefined,
        })
      }

      if (botToken.trim()) {
        await connectorsKeyringSet(adapterId, "botToken", botToken.trim())
      }
      if (signingSecret.trim()) {
        await connectorsKeyringSet(adapterId, "signingSecret", signingSecret.trim())
      }
      if (appToken.trim()) {
        await connectorsKeyringSet(adapterId, "appToken", appToken.trim())
      }

      // Hot-reload the running adapter so the new keyring material is
      // picked up without an app restart. New rows boot from the next
      // bus-provider mount; only emit for updates.
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

  const webhookPath = isNew ? null : `/webhook/slack/${row?.id ?? ""}`
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
          <Label htmlFor="sl-display-name">{t("displayNameLabel")}</Label>
          <Input
            id="sl-display-name"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder={t("displayNamePlaceholder")}
            disabled={saving}
          />
        </div>

        {/* Credentials grid — 1 col on narrow, 2 cols ≥ sm. Help text sits
            below the label so inputs across columns stay independent.
            `items-start` keeps each cell's height self-contained. */}
        <div className="grid grid-cols-1 gap-x-4 gap-y-4 sm:grid-cols-2 sm:items-start">
          <div className="space-y-1.5">
            <Label htmlFor="sl-bot-token">
              {t("botTokenLabel")}
              <span className="ml-1 text-destructive">*</span>
            </Label>
            <p className="text-xs text-muted-foreground">{t("botTokenHelp")}</p>
            <div className="flex gap-2">
              <Input
                id="sl-bot-token"
                type="password"
                autoComplete="new-password"
                value={botToken}
                onChange={(e) => setBotToken(e.target.value)}
                placeholder={t("botTokenPlaceholder")}
                disabled={saving}
                className="min-w-0 flex-1"
              />
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={handleTest}
                disabled={testing || saving || !desktop}
                aria-label={t("testConnectionAria")}
                className="shrink-0"
              >
                {testing ? (
                  <LoaderIcon className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  t("testButtonLabel")
                )}
              </Button>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="sl-signing-secret">
              {t("signingSecretLabel")}
              {transport === "events-api-webhook" && (
                <span className="ml-1 text-destructive">*</span>
              )}
            </Label>
            <p className="text-xs text-muted-foreground">{t("signingSecretHelp")}</p>
            <Input
              id="sl-signing-secret"
              type="password"
              autoComplete="new-password"
              value={signingSecret}
              onChange={(e) => setSigningSecret(e.target.value)}
              placeholder={t("signingSecretPlaceholder")}
              disabled={saving}
            />
          </div>
        </div>

        {/* Test status + desktop hint — full width below the grid so a long
            error message can wrap without distorting the credential columns. */}
        {testResult !== null && (
          <div
            className={`flex items-center gap-2 rounded-md px-3 py-2 text-xs ${
              testResult.ok
                ? "bg-emerald-50 text-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-300"
                : "bg-destructive/10 text-destructive"
            }`}
            role="status"
            aria-label={testResult.ok ? t("connectionSucceededLabel") : t("connectionFailedLabel")}
          >
            {testResult.ok ? (
              <CheckCircle2Icon className="h-3.5 w-3.5 shrink-0" />
            ) : (
              <XCircleIcon className="h-3.5 w-3.5 shrink-0" />
            )}
            {testResult.ok
              ? t("connectedAs", {
                  user: testResult.user ?? t("unknownUser"),
                  team: testResult.team ?? t("unknownUser"),
                  userId: testResult.userId ?? t("unknownId"),
                })
              : testResult.error}
          </div>
        )}

        {!desktop && (
          <p className="text-xs text-amber-600 dark:text-amber-400">{t("testRequiresDesktop")}</p>
        )}

        <div className="space-y-1.5">
          <p className="text-xs text-muted-foreground">{t("oauthHint")}</p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleOAuth}
            disabled={saving}
            aria-label={t("oauthButtonAria")}
          >
            {t("oauthButton")}
          </Button>
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
          <Label htmlFor="sl-transport">{t("transportLabel")}</Label>
          <Select
            value={transport}
            onValueChange={(v) => setTransport(v as TransportMode)}
            disabled={saving}
          >
            <SelectTrigger id="sl-transport">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="socket-mode">{t("transportSocketMode")}</SelectItem>
              <SelectItem value="events-api-webhook">{t("transportEventsApi")}</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            {transport === "socket-mode"
              ? t("transportSocketModeDesc")
              : t("transportEventsApiDesc")}
          </p>
        </div>

        {transport === "socket-mode" && (
          <div className="space-y-1.5">
            <Label htmlFor="sl-app-token">
              {t("appTokenLabel")}
              <span className="ml-1 text-destructive">*</span>
            </Label>
            <p className="text-xs text-muted-foreground">{t("appTokenHelp")}</p>
            <Input
              id="sl-app-token"
              type="password"
              autoComplete="new-password"
              value={appToken}
              onChange={(e) => setAppToken(e.target.value)}
              placeholder={t("appTokenPlaceholder")}
              disabled={saving}
            />
          </div>
        )}

        {transport === "events-api-webhook" && (
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
                  data-testid="slack-webhook-url-input"
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
                      window.open("https://api.slack.com/apps", "_blank", "noopener,noreferrer")
                    }
                  >
                    <ExternalLinkIcon className="mr-1 h-3.5 w-3.5" />
                    {t("openConsole")}
                  </Button>
                </div>
                <p className="text-[10px] text-muted-foreground">{t("webhookUrlHelp")}</p>
              </div>
            ) : (
              <div className="space-y-2">
                <p
                  className="text-xs text-amber-700 dark:text-amber-400"
                  data-testid="slack-webhook-url-tunnel-off"
                >
                  {t("webhookUrlTunnelOffHelp")}
                </p>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    if (typeof window !== "undefined") {
                      window.location.assign("/settings/companion#tunnel")
                    }
                  }}
                >
                  {t("openCompanion")}
                </Button>
              </div>
            )}
          </div>
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
      <DialogContent className="flex max-h-[90vh] flex-col sm:max-w-3xl">
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
