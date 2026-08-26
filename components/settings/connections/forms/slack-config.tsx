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
import { useRouter } from "next/navigation"
import { CheckCircle2Icon, ExternalLinkIcon, LoaderIcon, XCircleIcon } from "lucide-react"
import { toast } from "sonner"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { createAdapterInstance, updateAdapterInstance } from "@/lib/db/adapter-instances"
import { connectorsHttpRequest } from "@/lib/connectors/tauri/commands"
import { emitCredentialsRotated } from "@/lib/connectors/credentials-events"
import { openUrl } from "@/lib/native/opener"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"
import { defaultTriggerPolicyFor } from "@/types/connectors/policy"
import { beginSlackOAuth } from "@/lib/connectors/adapters/slack/oauth-begin"
import { CONNECTOR_OAUTH_STATE_KEY } from "@/lib/connectors/oauth-registry"
import {
  connectorOAuthRelayPath,
  resolveConnectorsIngressBase,
} from "@/lib/connectors/server-transport"
import { useTunnelStatus } from "@/hooks/use-tunnel-status"
import { useAdapterCredentials } from "@/hooks/connectors/use-adapter-credentials"
import { AdapterFormSections, type FormSection } from "./_shared/adapter-form-sections"
import { CredentialInput } from "./_shared/credential-input"
import { QuietHoursAndMute, type QuietHoursValue } from "./quiet-hours-and-mute"
import {
  ConnectorHostNotice,
  useConnectorControlReach,
} from "@/components/connectors/connector-host-notice"

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

/**
 * Settings persisted on the adapter row. `assistantAppEnabled` and
 * `historyMaxPages` are read verbatim by `buildSlackAdapter` in
 * `lib/connectors/adapter-registry.ts` (`settings.assistantAppEnabled === true`
 * / `Number(settings.historyMaxPages)`), so the key names + types here are the
 * contract the factory depends on.
 */
interface SlackPersistedSettings {
  transport?: TransportMode
  /**
   * Opt into the Slack "Agents & AI Apps" surface — enables the typing
   * indicator (`assistant.threads.setStatus`), suggested prompts, and the
   * run-presentation streaming driver. Off by default because those APIs
   * fail on apps without the feature enabled in the Slack app console.
   */
  assistantAppEnabled?: boolean
  /** Max `conversations.history` pages pulled per history hydration (1–50). */
  historyMaxPages?: number
  [key: string]: unknown
}

/** Bounds + default for `historyMaxPages` (mirrors the adapter's own default). */
export const SLACK_HISTORY_MAX_PAGES_MIN = 1
export const SLACK_HISTORY_MAX_PAGES_MAX = 50
export const SLACK_HISTORY_MAX_PAGES_DEFAULT = 10

/**
 * Parse a form value into a valid `historyMaxPages` integer, or `null` when
 * the value is not an integer within [1, 50].
 */
export function parseSlackHistoryMaxPages(raw: string): number | null {
  const trimmed = raw.trim()
  if (!/^\d+$/.test(trimmed)) return null
  const n = Number(trimmed)
  if (n < SLACK_HISTORY_MAX_PAGES_MIN || n > SLACK_HISTORY_MAX_PAGES_MAX) return null
  return n
}

/** Coerce a persisted `historyMaxPages` (number, or a legacy string) to a valid value. */
function persistedHistoryMaxPages(value: unknown): number {
  const parsed =
    typeof value === "number" || typeof value === "string"
      ? parseSlackHistoryMaxPages(String(value))
      : null
  return parsed ?? SLACK_HISTORY_MAX_PAGES_DEFAULT
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

// `signingSecret` and `appToken` belong to one transport each, but both are
// read unconditionally so toggling transport does not re-probe the keyring.
// `userToken` is OAuth output — presence only, never a field.
const SLACK_CREDENTIALS = [
  "botToken",
  "signingSecret",
  "appToken",
  "clientId",
  "clientSecret",
] as const
const SLACK_DERIVED_CREDENTIALS = ["userToken"] as const

export function SlackConfigDialog({ open, onOpenChange, row, onCreated }: SlackConfigDialogProps) {
  const t = useTranslations("settings.connections.slack")
  const router = useRouter()
  const isNew = row === null
  const persisted = (row?.settings ?? {}) as SlackPersistedSettings

  const [displayName, setDisplayName] = useState(row?.displayName ?? t("displayNamePlaceholder"))
  const credentials = useAdapterCredentials({
    adapterId: row?.id ?? null,
    accounts: SLACK_CREDENTIALS,
    derivedAccounts: SLACK_DERIVED_CREDENTIALS,
    enabled: open,
  })
  const botToken = credentials.value("botToken")
  const signingSecret = credentials.value("signingSecret")
  const appToken = credentials.value("appToken")
  const clientId = credentials.value("clientId")
  const clientSecret = credentials.value("clientSecret")
  const [authorizing, setAuthorizing] = useState(false)
  const [transport, setTransport] = useState<TransportMode>(persisted.transport ?? "socket-mode")
  const [assistantAppEnabled, setAssistantAppEnabled] = useState<boolean>(
    persisted.assistantAppEnabled === true
  )
  const persistedPages = persistedHistoryMaxPages(persisted.historyMaxPages)
  const [historyMaxPagesInput, setHistoryMaxPagesInput] = useState<string>(String(persistedPages))
  const [muted, setMuted] = useState<boolean>(row?.muted ?? false)
  const [quietHours, setQuietHours] = useState<QuietHoursValue | null>(row?.quietHours ?? null)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<AuthTestResult | null>(null)
  const [saving, setSaving] = useState(false)

  const reach = useConnectorControlReach()
  const desktop = reach.available
  const tunnel = useTunnelStatus()
  const ingressBase = resolveConnectorsIngressBase({
    isDesktop: desktop,
    tunnelUrl: tunnel.url,
    publicBase: typeof window === "undefined" ? null : window.location.origin,
  })
  /** Exact redirect Slack's console must have registered. Null with no ingress. */
  const relayUrl = ingressBase ? `${ingressBase}${connectorOAuthRelayPath("slack")}` : null

  const dirty =
    isNew ||
    displayName.trim() !== row?.displayName ||
    credentials.dirty ||
    transport !== (persisted.transport ?? "socket-mode") ||
    assistantAppEnabled !== (persisted.assistantAppEnabled === true) ||
    parseSlackHistoryMaxPages(historyMaxPagesInput) !== persistedPages ||
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

  const handleOAuth = async () => {
    if (!row) {
      toast.error(t("oauthNeedsSavedAdapter"))
      return
    }
    setAuthorizing(true)
    try {
      // Slack's console only accepts an https redirect, so the flow goes
      // through the connectors relay rather than the `cognia://` scheme it
      // used to point at — Slack would have rejected that at authorize time.
      const effectiveRedirect = relayUrl ?? ""
      if (!effectiveRedirect) {
        toast.error(t("oauthNeedsRelay"))
        return
      }
      // The exchange reads these back out of the keyring, so they must be on
      // disk before the brain mints the pending record.
      await credentials.persist(row.id)
      // The brain mints the state and owns the pending record, because the
      // brain is what spends it when the relay hands the code back. On the
      // desktop that is this same process; a headless install drives the very
      // same function through the `oauth-begin` operator intent.
      const begun = await beginSlackOAuth({ adapterId: row.id, redirectUri: effectiveRedirect })
      // The deep-link router validates the redirect's `state`. sessionStorage
      // covers the live path; a localStorage mirror survives a cold restart.
      // This is a pre-check only — the authoritative one is against the
      // pending record inside `handleSlackOAuth`.
      sessionStorage.setItem(CONNECTOR_OAUTH_STATE_KEY, begun.state)
      try {
        localStorage.setItem(CONNECTOR_OAUTH_STATE_KEY, begun.state)
      } catch {
        // localStorage unavailable — the live sessionStorage path still works.
      }
      await openUrl(begun.authorizeUrl)
      toast.info(t("oauthOpened"))
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      // `beginSlackOAuth` throws short stable reasons; map the one an operator
      // can actually fix rather than showing them a bare code.
      toast.error(
        reason === "client_id_missing" ? t("oauthNeedsClientId") : t("connectionFailedToast")
      )
    } finally {
      setAuthorizing(false)
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
    const historyMaxPages = parseSlackHistoryMaxPages(historyMaxPagesInput)
    if (historyMaxPages === null) {
      toast.error(
        t("historyMaxPagesInvalid", {
          min: SLACK_HISTORY_MAX_PAGES_MIN,
          max: SLACK_HISTORY_MAX_PAGES_MAX,
        })
      )
      return
    }

    setSaving(true)
    try {
      let adapterId: string
      const transportMode = transport === "socket-mode" ? "gateway" : "webhook"
      const nextSettings: SlackPersistedSettings = {
        transport,
        assistantAppEnabled,
        historyMaxPages,
      }

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
          trigger: defaultTriggerPolicyFor("slack"),
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
          transportMode,
          settings: nextSettings,
          muted,
          quietHours: quietHours ?? undefined,
        })
      }

      // The OAuth app credentials live in the keyring next to the tokens, the
      // same place `handleSlackOAuth` reads them from at exchange time. They
      // used to be expected from `NEXT_PUBLIC_SLACK_CLIENT_ID`, which is set
      // nowhere and which the exchange never looked at.
      await credentials.persist(adapterId)

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
              <CredentialInput
                id="sl-bot-token"
                value={botToken}
                onChange={(next) => credentials.set("botToken", next)}
                status={credentials.status("botToken")}
                placeholder={t("botTokenPlaceholder")}
                disabled={saving}
                className="min-w-0 flex-1"
                onRetry={credentials.retry}
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
            <CredentialInput
              id="sl-signing-secret"
              value={signingSecret}
              onChange={(next) => credentials.set("signingSecret", next)}
              status={credentials.status("signingSecret")}
              placeholder={t("signingSecretPlaceholder")}
              disabled={saving}
              onRetry={credentials.retry}
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

        <ConnectorHostNotice reach={reach} />

        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">{t("oauthHint")}</p>
          <div className="space-y-1">
            <Label htmlFor="slack-client-id" className="text-xs">
              {t("clientIdLabel")}
            </Label>
            <CredentialInput
              id="slack-client-id"
              sensitive={false}
              value={clientId}
              onChange={(next) => credentials.set("clientId", next)}
              status={credentials.status("clientId")}
              placeholder={t("clientIdPlaceholder")}
              onRetry={credentials.retry}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="slack-client-secret" className="text-xs">
              {t("clientSecretLabel")}
            </Label>
            <CredentialInput
              id="slack-client-secret"
              value={clientSecret}
              onChange={(next) => credentials.set("clientSecret", next)}
              status={credentials.status("clientSecret")}
              placeholder={t("clientSecretPlaceholder")}
              onRetry={credentials.retry}
            />
          </div>
          {/* The relay URL is what Slack's console must have registered; show
              it so the operator can copy it rather than guess. */}
          {relayUrl ? (
            <p className="text-muted-foreground text-[11px]" data-testid="slack-oauth-redirect">
              {t("oauthRedirectHint", { url: relayUrl })}
            </p>
          ) : (
            <p
              className="text-xs text-amber-600 dark:text-amber-400"
              data-testid="slack-oauth-no-relay"
            >
              {t("oauthNeedsRelay")}
            </p>
          )}
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void handleOAuth()}
            // OAuth needs a saved row: the state carries the adapter id and the
            // pending record is keyed by it, so there is nothing to bind to
            // before the first Save.
            disabled={saving || authorizing || isNew || !relayUrl}
            aria-label={t("oauthButtonAria")}
          >
            {authorizing ? t("oauthConnecting") : t("oauthButton")}
          </Button>
          {isNew ? (
            <p className="text-muted-foreground text-[11px]" data-testid="slack-oauth-needs-save">
              {t("oauthNeedsSavedAdapter")}
            </p>
          ) : null}
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
            <CredentialInput
              id="sl-app-token"
              value={appToken}
              onChange={(next) => credentials.set("appToken", next)}
              status={credentials.status("appToken")}
              placeholder={t("appTokenPlaceholder")}
              disabled={saving}
              onRetry={credentials.retry}
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
                  onClick={() => router.push("/settings?section=connections&connectionsTab=tunnel")}
                >
                  {t("openCompanion")}
                </Button>
              </div>
            )}
          </div>
        )}

        {/* Slack "Agents & AI Apps" opt-in. Read by `buildSlackAdapter`
            (adapter-registry) as `settings.assistantAppEnabled === true` and
            gates setTyping / suggested prompts / run-presentation streaming. */}
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 space-y-0.5">
            <Label htmlFor="sl-assistant-app" className="text-sm">
              {t("assistantAppLabel")}
            </Label>
            <p className="text-xs leading-relaxed text-muted-foreground">{t("assistantAppHint")}</p>
          </div>
          <Switch
            id="sl-assistant-app"
            checked={assistantAppEnabled}
            onCheckedChange={setAssistantAppEnabled}
            disabled={saving}
            aria-label={t("assistantAppLabel")}
            data-testid="slack-assistant-app-switch"
          />
        </div>

        {/* History hydration page cap. Read by `buildSlackAdapter` as
            `Number(settings.historyMaxPages)`; the adapter itself defaults to 10. */}
        <div className="space-y-1.5">
          <Label htmlFor="sl-history-max-pages">{t("historyMaxPagesLabel")}</Label>
          <Input
            id="sl-history-max-pages"
            type="number"
            inputMode="numeric"
            min={SLACK_HISTORY_MAX_PAGES_MIN}
            max={SLACK_HISTORY_MAX_PAGES_MAX}
            step={1}
            value={historyMaxPagesInput}
            onChange={(e) => setHistoryMaxPagesInput(e.target.value)}
            disabled={saving}
            aria-invalid={parseSlackHistoryMaxPages(historyMaxPagesInput) === null}
            className="w-32"
            data-testid="slack-history-max-pages"
          />
          <p className="text-xs text-muted-foreground">
            {t("historyMaxPagesHint", {
              min: SLACK_HISTORY_MAX_PAGES_MIN,
              max: SLACK_HISTORY_MAX_PAGES_MAX,
              defaultValue: SLACK_HISTORY_MAX_PAGES_DEFAULT,
            })}
          </p>
        </div>
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
            // Until the stored credentials are read back the form does not know its
            // own baseline, so it cannot honestly call itself edited.
            dirty={dirty && !credentials.loading}
            submitLabel={isNew ? t("create") : t("save")}
          />
        </div>
      </DialogContent>
    </Dialog>
  )
}
