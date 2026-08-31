"use client"

/**
 * Lark / Feishu adapter configuration dialog.
 *
 * Migrated to the shared `AdapterFormSections` shell with three collapsible
 * sections so the form stays scannable as it grew past the original six
 * fields:
 *
 *   Identity   — credentials + Test connection + selfBotOpenId refresh
 *   Delivery   — transport selector + dynamic webhook URL (auto-resolved
 *                from the Cloudflared tunnel status) + Open-Lark-console
 *                deep link
 *   Advanced   — QuietHoursAndMute (mute + per-IANA-tz quiet window)
 *
 * On save: creates / updates the AdapterInstanceRow and writes secrets to
 * the OS keyring.
 */

import { useMemo, useState, type ReactNode } from "react"
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
import { Switch } from "@/components/ui/switch"
import { openUrl } from "@/lib/native/opener"
import { connectorsHttpRequest } from "@/lib/connectors/tauri/commands"
import { beginLarkOAuth } from "@/lib/connectors/adapters/lark/oauth-begin"
import type { LarkConnectedUser } from "@/lib/connectors/adapters/lark/oauth-handler"
import { CONNECTOR_OAUTH_STATE_KEY } from "@/lib/connectors/oauth-registry"
import { emitCredentialsRotated } from "@/lib/connectors/credentials-events"
import { isTauri } from "@/lib/tauri"
import {
  ConnectorHostNotice,
  useConnectorControlReach,
} from "@/components/connectors/connector-host-notice"
import type { ConnectorControlReach } from "@/lib/connectors/control-reach"
import {
  connectorWebhookPath,
  LARK_OAUTH_RELAY_PATH,
  resolveConnectorsIngressBase,
} from "@/lib/connectors/server-transport"
import { resolveLarkApiBase } from "@/lib/connectors/lark-web/entry-client"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"
import { defaultTriggerPolicyFor } from "@/types/connectors/policy"
import { refreshSelfBotOpenId } from "@/lib/connectors/adapter-registry"
import { useTunnelStatus } from "@/hooks/use-tunnel-status"
import {
  useAdapterCredentials,
  type UseAdapterCredentialsResult,
} from "@/hooks/connectors/use-adapter-credentials"
import { AdapterFormSections, type FormSection } from "./_shared/adapter-form-sections"
import { CredentialInput } from "./_shared/credential-input"
import { QuietHoursAndMute, type QuietHoursValue } from "./quiet-hours-and-mute"
import { LarkWhitelistEditor } from "./lark/lark-whitelist-editor"
import { LarkQuickCommandsEditor } from "./lark/lark-quick-commands-editor"
import type { LarkQuickCommand } from "@/lib/connectors/adapters/lark/quick-commands"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TatTestResult {
  ok: boolean
  appId?: string
  error?: string
}

type TransportMode = "long-connection" | "webhook"

interface LarkPersistedSettings {
  transport?: TransportMode
  /** Cached at adapter start by `buildLarkAdapter`; refreshed via the UI affordance. */
  selfBotOpenId?: string
  /** Bot-menu (快捷指令) `event_key` → action mappings. */
  quickCommands?: LarkQuickCommand[]
  /** Opt-in: send replies as the connected user (user_access_token) not the bot. */
  sendAsUser?: boolean
  /** Stamped by the OAuth handler after a successful user-token exchange. */
  connectedUser?: LarkConnectedUser
  /**
   * OAuth 2.0 redirect_uri for the send-as-user flow. Blank → derived from the
   * tunnel (`${tunnel}/oauth/lark/callback`). Must be registered in the Feishu
   * console Security Settings → Redirect URL.
   */
  redirectUri?: string
  /** Index signature so the row's open-ended `Record<string, unknown>` accepts us. */
  [key: string]: unknown
}

// ---------------------------------------------------------------------------
// Test connection via tenant_access_token/internal
// ---------------------------------------------------------------------------

async function testLarkConnection(appId: string, appSecret: string): Promise<TatTestResult> {
  try {
    const resp = await connectorsHttpRequest({
      url: "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
      timeoutMs: 8000,
    })
    const parsed = JSON.parse(resp.body) as {
      code: number
      tenant_access_token?: string
      msg?: string
    }
    if (parsed.code === 0 && parsed.tenant_access_token) {
      return { ok: true, appId }
    }
    return { ok: false, error: parsed.msg ?? `code ${parsed.code}` }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

// ---------------------------------------------------------------------------
// Dialog
// ---------------------------------------------------------------------------

interface LarkConfigDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Called with the new adapter id after a successful create, so the parent
   * can auto-select and open the freshly created adapter. */
  onCreated?: (id: string) => void
  /** null = creating a new instance */
  row: AdapterInstanceRow | null
}

// `appId` + `appSecret` mint the tenant access token, `verificationToken`
// verifies inbound events, and `encryptKey` is optional (blank = encryption
// disabled in the Lark app). The user tokens below are OAuth output —
// presence only, never a field.
const LARK_CREDENTIALS = ["appId", "appSecret", "verificationToken", "encryptKey"] as const
const LARK_REQUIRED_CREDENTIALS = ["appId", "appSecret", "verificationToken"] as const
const LARK_DERIVED_CREDENTIALS = ["user_token", "user_refresh_token"] as const

/**
 * Every keyring account a Lark bot can own — the OAuth-minted user tokens
 * included. `credentialsRef` is the only vocabulary `removeAdapterInstance`
 * purges from and `ctx.secrets.list()` probes, so omitting them left them in
 * the OS keyring after the bot was deleted.
 */
const LARK_KEYRING_ACCOUNTS = [...LARK_CREDENTIALS, ...LARK_DERIVED_CREDENTIALS] as const

export function LarkConfigDialog({ open, onOpenChange, row, onCreated }: LarkConfigDialogProps) {
  const t = useTranslations("settings.connections.lark")
  const isNew = row === null
  const persistedSettings = (row?.settings ?? {}) as LarkPersistedSettings

  // ── Form state ───────────────────────────────────────────────────────────
  const [displayName, setDisplayName] = useState(row?.displayName ?? t("displayNamePlaceholder"))
  const credentials = useAdapterCredentials({
    adapterId: row?.id ?? null,
    accounts: LARK_CREDENTIALS,
    derivedAccounts: LARK_DERIVED_CREDENTIALS,
    enabled: open,
  })
  const appId = credentials.value("appId")
  const appSecret = credentials.value("appSecret")
  // Cloud installs default to `webhook`: they have a public origin and no
  // cloudflared tunnel, and a webhook survives a brain restart without
  // re-establishing an outbound socket. Desktop keeps `long-connection`, which
  // needs no inbound reachability at all. Only the NEW-row default is
  // host-aware — an existing row's saved choice is always honoured.
  const [transport, setTransport] = useState<TransportMode>(
    persistedSettings.transport ?? (isTauri() ? "long-connection" : "webhook")
  )
  const [selfBotOpenId, setSelfBotOpenId] = useState<string | null>(
    persistedSettings.selfBotOpenId ?? null
  )
  const [muted, setMuted] = useState<boolean>(row?.muted ?? false)
  const [quietHours, setQuietHours] = useState<QuietHoursValue | null>(row?.quietHours ?? null)
  const [quickCommands, setQuickCommands] = useState<LarkQuickCommand[]>(
    persistedSettings.quickCommands ?? []
  )

  const [sendAsUser, setSendAsUser] = useState<boolean>(persistedSettings.sendAsUser === true)
  const [redirectUri, setRedirectUri] = useState<string>(persistedSettings.redirectUri ?? "")
  const connectedUser = persistedSettings.connectedUser

  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<TatTestResult | null>(null)
  const [refreshingOpenId, setRefreshingOpenId] = useState(false)
  const [authorizing, setAuthorizing] = useState(false)
  const [saving, setSaving] = useState(false)

  // Two different questions that `isTauri()` used to answer at once.
  // `desktopShell` shapes the INGRESS — cloudflared versus a public origin —
  // and is a property of the machine this page runs on. `reach` answers
  // whether the connector controls can be driven from here at all.
  const desktopShell = isTauri()
  const reach = useConnectorControlReach()
  const tunnel = useTunnelStatus()

  // Public base a platform should be pointed at, per host. Declared up here
  // because the authorize handler needs it too — the desktop reaches the
  // internet through cloudflared, while a cloud install serves the same
  // connectors router nested under `/connectors` on its own origin.
  const ingressBase = resolveConnectorsIngressBase({
    isDesktop: desktopShell,
    tunnelUrl: tunnel.url,
    publicBase:
      resolveLarkApiBase() || (typeof window === "undefined" ? null : window.location.origin),
  })

  // Treat any non-secret edit as dirty so the Save button is enabled even
  // before the user touches a credential field. Secret entry alone also
  // counts as dirty (writing a fresh value to the keyring).
  const dirty =
    isNew ||
    displayName.trim() !== row?.displayName ||
    credentials.dirty ||
    transport !== (persistedSettings.transport ?? "long-connection") ||
    muted !== (row?.muted ?? false) ||
    quietHours !== (row?.quietHours ?? null) ||
    sendAsUser !== (persistedSettings.sendAsUser === true) ||
    redirectUri.trim() !== (persistedSettings.redirectUri ?? "") ||
    JSON.stringify(quickCommands) !== JSON.stringify(persistedSettings.quickCommands ?? [])

  // ── Handlers ─────────────────────────────────────────────────────────────

  const handleTest = async () => {
    if (!appId.trim() || !appSecret.trim()) {
      toast.error(t("tokenRequiredForTest"))
      return
    }
    setTesting(true)
    setTestResult(null)
    const result = await testLarkConnection(appId.trim(), appSecret.trim())
    setTestResult(result)
    setTesting(false)
    if (result.ok) {
      toast.success(t("connectedToast", { appId: result.appId ?? t("unknownApp") }))
    } else {
      toast.error(result.error ?? t("connectionFailedToast"))
    }
  }

  const handleRefreshSelfBotOpenId = async () => {
    if (!row) {
      toast.error(t("selfBotOpenIdNeedsSavedAdapter"))
      return
    }
    setRefreshingOpenId(true)
    try {
      const result = await refreshSelfBotOpenId(row.id)
      if (result.ok) {
        setSelfBotOpenId(result.openId)
        toast.success(t("selfBotOpenIdRefreshed"))
      } else {
        toast.error(t("selfBotOpenIdRefreshFailed", { reason: result.message }))
      }
    } finally {
      setRefreshingOpenId(false)
    }
  }

  const handleAuthorize = async () => {
    if (!row) {
      toast.error(t("authorizeNeedsSavedAdapter"))
      return
    }
    setAuthorizing(true)
    try {
      // Redirect precedence: an explicit override, else the host-derived relay
      // URL. Both must be registered in the Feishu console.
      const effectiveRedirect =
        redirectUri.trim() || (ingressBase ? `${ingressBase}${LARK_OAUTH_RELAY_PATH}` : "")
      if (!effectiveRedirect) {
        toast.error(t("authorizeNeedsRedirect"))
        return
      }
      // The brain mints state + PKCE and owns the pending record, because the
      // brain is what spends it when the relay hands the code back. On the
      // desktop that is this same process; a headless install drives the very
      // same function through the `oauth-begin` operator intent.
      const begun = await beginLarkOAuth({ adapterId: row.id, redirectUri: effectiveRedirect })
      // The deep-link router validates the redirect's `state`. sessionStorage
      // covers the live path; a localStorage mirror survives a cold restart.
      // This is a pre-check only — the authoritative one is against the
      // pending record inside `handleLarkOAuth`.
      sessionStorage.setItem(CONNECTOR_OAUTH_STATE_KEY, begun.state)
      try {
        localStorage.setItem(CONNECTOR_OAUTH_STATE_KEY, begun.state)
      } catch {
        // localStorage unavailable — the live sessionStorage path still works.
      }
      await openUrl(begun.authorizeUrl)
      toast.info(t("authorizeOpened"))
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      // `beginLarkOAuth` throws short stable reasons; map the one an operator
      // can actually fix rather than showing them a bare code.
      toast.error(reason === "app_id_missing" ? t("authorizeNeedsAppId") : reason)
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

  const handleCopyRedirectUri = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url)
      toast.success(t("redirectUriCopied"))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  const handleSave = async () => {
    if (!displayName.trim()) {
      toast.error(t("displayNameRequired"))
      return
    }
    const missing = credentials.missingRequired(LARK_REQUIRED_CREDENTIALS)
    if (missing.length > 0) {
      toast.error(
        t(
          missing[0] === "appId"
            ? "appIdRequired"
            : missing[0] === "appSecret"
              ? "appSecretRequired"
              : "verificationTokenRequired"
        )
      )
      return
    }
    // Quiet hours validation — if enabled, all three fields must be set.
    if (quietHours) {
      if (!quietHours.from || !quietHours.to || !quietHours.tz) {
        toast.error(t("quietHoursIncomplete"))
        return
      }
    }

    setSaving(true)
    try {
      let adapterId: string
      const transportMode = transport === "long-connection" ? "gateway" : "webhook"
      const nextSettings: LarkPersistedSettings = {
        transport,
        ...(selfBotOpenId ? { selfBotOpenId } : {}),
        ...(quickCommands.length > 0 ? { quickCommands } : {}),
        // Preserve the OAuth-stamped connected-user metadata across saves —
        // rebuilding nextSettings from scratch would otherwise drop it.
        ...(connectedUser ? { connectedUser } : {}),
        ...(sendAsUser ? { sendAsUser: true } : {}),
        ...(redirectUri.trim() ? { redirectUri: redirectUri.trim() } : {}),
      }

      if (isNew) {
        const newRow = await createAdapterInstance({
          type: "lark",
          displayName: displayName.trim(),
          enabled: true,
          transportMode,
          settings: nextSettings,
          credentialsRef: {
            keyringService: "com.cognia.platforms",
            accounts: [...LARK_KEYRING_ACCOUNTS],
          },
          trigger: defaultTriggerPolicyFor("lark"),
          defaultMode: "auto",
          mediaModelPolicy: "local_extract_only",
          quietHours: quietHours ?? undefined,
          muted,
        })
        adapterId = newRow.id
      } else {
        adapterId = row.id
        const update: Parameters<typeof updateAdapterInstance>[1] = {
          displayName: displayName.trim(),
          transportMode,
          settings: nextSettings,
          muted,
          // Repair a row created before the OAuth-minted accounts were listed,
          // so the purge on delete reaches them.
          credentialsRef: {
            keyringService: row.credentialsRef?.keyringService ?? "com.cognia.platforms",
            accounts: [...LARK_KEYRING_ACCOUNTS],
          },
        }
        // updateAdapterInstance preserves keys that aren't in the patch — only
        // explicitly pass quietHours when it has changed so an existing row
        // doesn't get wiped accidentally.
        update.quietHours = quietHours ?? undefined
        await updateAdapterInstance(adapterId, update)
      }

      // Encrypt Key is optional per the Lark Open Platform: blank means
      // "encryption disabled in the Lark app" and the adapter falls back to
      // plaintext events. Now that the field is prefilled, clearing one the
      // operator can actually see is a real request to disable it, which is
      // exactly what `persist` writes.
      await credentials.persist(adapterId)

      // Hot-reload: tell the lifecycle layer the credentials rotated so
      // the running adapter is requeued without an app restart. Only
      // emit on updates — new rows are picked up by the bus provider on
      // its next mount cycle through `listEnabledAdapterInstances`.
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

  // ── Derived Webhook URL ──────────────────────────────────────────────────
  // Must match the Rust axum route `POST /webhook/{adapter_type}/{adapter_id}`
  // (axum_app.rs) — the same `/webhook/<type>/<id>` shape every other adapter
  // form uses. The previous `/connectors/lark/...` prefix 404'd, so a Feishu
  // webhook aimed at the surfaced URL never reached the receiver.
  const webhookPath = isNew ? null : connectorWebhookPath("lark", row?.id ?? "")
  const webhookUrl = ingressBase && webhookPath ? `${ingressBase}${webhookPath}` : null

  // Lark Open Platform deep link to the app's Event-subscriptions panel.
  const openConsoleUrl = appId.trim().startsWith("cli_")
    ? `https://open.feishu.cn/app/${encodeURIComponent(appId.trim())}/event-subscriptions`
    : "https://open.feishu.cn/app"

  // Deep link to the app's Security Settings, where the redirect URL is
  // registered for the send-as-user OAuth flow.
  const openSecurityConsoleUrl = appId.trim().startsWith("cli_")
    ? `https://open.feishu.cn/app/${encodeURIComponent(appId.trim())}/safe`
    : "https://open.feishu.cn/app"

  // Relay redirect derived from the running tunnel (send-as-user OAuth). The
  // user can override it via the redirect-URI field.
  // Same host split as the webhook URL — on cloud the relay lives behind the
  // `/connectors` nest, so a tunnel-derived redirect would 404 there.
  const derivedRelayUrl = !isNew && ingressBase ? `${ingressBase}${LARK_OAUTH_RELAY_PATH}` : null
  const effectiveRedirectUri = redirectUri.trim() || derivedRelayUrl || ""

  // ── Sections ─────────────────────────────────────────────────────────────
  const identitySection: FormSection = {
    id: "identity",
    label: t("sectionIdentity"),
    description: t("sectionIdentityDesc"),
    defaultOpen: true,
    children: (
      <IdentityFields
        displayName={displayName}
        setDisplayName={setDisplayName}
        credentials={credentials}
        selfBotOpenId={selfBotOpenId}
        onRefreshOpenId={handleRefreshSelfBotOpenId}
        refreshingOpenId={refreshingOpenId}
        canRefreshOpenId={!isNew}
        testing={testing}
        testResult={testResult}
        onTest={handleTest}
        openConsoleUrl={openConsoleUrl}
        reach={reach}
        saving={saving}
      />
    ),
  }

  const deliverySection: FormSection = {
    id: "delivery",
    label: t("sectionDelivery"),
    description: t("sectionDeliveryDesc"),
    defaultOpen: true,
    children: (
      <DeliveryFields
        transport={transport}
        setTransport={setTransport}
        saving={saving}
        desktop={desktopShell}
        webhookUrl={webhookUrl}
        tunnelLoading={tunnel.loading}
        tunnelRunning={tunnel.running}
        webhookPath={webhookPath}
        openConsoleUrl={openConsoleUrl}
        onCopyWebhookUrl={handleCopyWebhookUrl}
      />
    ),
  }

  const quickCommandsSection: FormSection = {
    id: "quick-commands",
    label: t("sectionQuickCommands"),
    description: t("sectionQuickCommandsDesc"),
    children: (
      <LarkQuickCommandsEditor
        value={quickCommands}
        onChange={setQuickCommands}
        disabled={saving}
      />
    ),
  }

  const advancedSection: FormSection = {
    id: "advanced",
    label: t("sectionAdvanced"),
    description: t("sectionAdvancedDesc"),
    children: (
      <div className="space-y-4">
        <QuietHoursAndMute
          muted={muted}
          onMutedChange={setMuted}
          quietHours={quietHours}
          onQuietHoursChange={setQuietHours}
          disabled={saving}
        />
        {/* v45 — adapter-level at-response strategy + chat allow/blocklist.
         * Both components self-manage their state via useLiveQuery so they
         * only render once the row has an id (i.e. after Save on first
         * creation). Hidden for unsaved rows; the operator must finish
         * the initial Save → reopen to surface them. */}
        {/* `InboundActivationEditor` is deliberately NOT mounted here. It is
            mounted once for every adapter kind in `config-detail.tsx`, and a
            second copy in this dialog meant a Lark operator saw the same
            admission controls twice in one detail view, each with its own
            unsaved state. */}
        {row && <LarkWhitelistEditor adapterId={row.id} />}
      </div>
    ),
  }

  // Send-as-user is only meaningful once the adapter exists (authorize needs a
  // saved adapter id to scope the OAuth state), so it is hidden for new rows.
  const sendAsUserSection: FormSection | null = row
    ? {
        id: "send-as-user",
        label: t("sectionSendAsUser"),
        description: t("sectionSendAsUserDesc"),
        children: (
          <SendAsUserFields
            connectedUser={connectedUser}
            sendAsUser={sendAsUser}
            onSendAsUserChange={setSendAsUser}
            onAuthorize={handleAuthorize}
            authorizing={authorizing}
            saving={saving}
            reach={reach}
            redirectUri={redirectUri}
            onRedirectUriChange={setRedirectUri}
            derivedRelayUrl={derivedRelayUrl}
            effectiveRedirectUri={effectiveRedirectUri}
            onCopyRedirectUri={handleCopyRedirectUri}
            openSecurityConsoleUrl={openSecurityConsoleUrl}
            tunnelLoading={tunnel.loading}
            tunnelRunning={tunnel.running}
          />
        ),
      }
    : null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[90vh] flex-col sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{isNew ? t("titleNew") : t("titleEdit")}</DialogTitle>
        </DialogHeader>

        <div className="-mx-6 flex-1 overflow-y-auto px-6">
          <AdapterFormSections
            sections={[
              identitySection,
              deliverySection,
              ...(sendAsUserSection ? [sendAsUserSection] : []),
              quickCommandsSection,
              advancedSection,
            ]}
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

// ---------------------------------------------------------------------------
// Send-as-user section — OAuth connect + opt-in identity toggle (ADR-0009 A4)
// ---------------------------------------------------------------------------

interface SendAsUserFieldsProps {
  connectedUser?: LarkConnectedUser
  sendAsUser: boolean
  onSendAsUserChange: (v: boolean) => void
  onAuthorize: () => void
  authorizing: boolean
  saving: boolean
  reach: ConnectorControlReach
  redirectUri: string
  onRedirectUriChange: (v: string) => void
  derivedRelayUrl: string | null
  effectiveRedirectUri: string
  onCopyRedirectUri: (url: string) => void
  openSecurityConsoleUrl: string
  tunnelLoading: boolean
  tunnelRunning: boolean
}

function SendAsUserFields(p: SendAsUserFieldsProps) {
  const t = useTranslations("settings.connections.lark")
  const connectedLabel =
    p.connectedUser?.name ??
    p.connectedUser?.email ??
    p.connectedUser?.enterpriseEmail ??
    p.connectedUser?.openId

  const openSecurityConsole = () => {
    if (typeof window !== "undefined") {
      window.open(p.openSecurityConsoleUrl, "_blank", "noopener,noreferrer")
    }
  }

  return (
    <div className="space-y-4">
      {/* Redirect URL — register in the Feishu console before connecting. */}
      <div className="space-y-2 rounded border bg-card px-3 py-3">
        <Label className="text-xs font-medium">{t("redirectUriLabel")}</Label>
        <Input
          value={p.redirectUri}
          onChange={(e) => p.onRedirectUriChange(e.target.value)}
          placeholder={p.derivedRelayUrl ?? t("redirectUriPlaceholder")}
          disabled={p.saving}
          className="font-mono text-[11px]"
          data-testid="lark-redirect-uri-input"
          aria-label={t("redirectUriLabel")}
        />
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => p.onCopyRedirectUri(p.effectiveRedirectUri)}
            disabled={!p.effectiveRedirectUri}
            aria-label={t("redirectUriCopyAria")}
            data-testid="lark-redirect-uri-copy"
          >
            {t("redirectUriCopy")}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={openSecurityConsole}
            aria-label={t("openConsoleSecurityAria")}
          >
            <ExternalLinkIcon className="mr-1 h-3.5 w-3.5" />
            {t("openConsole")}
          </Button>
        </div>
        <p className="text-[10px] text-muted-foreground">{t("redirectUriRegisterHelp")}</p>
        {!p.tunnelRunning && !p.tunnelLoading && !p.redirectUri.trim() && (
          <p
            className="text-[10px] text-amber-700 dark:text-amber-400"
            data-testid="lark-redirect-uri-tunnel-off"
          >
            {t("redirectUriTunnelOffHelp")}
          </p>
        )}
      </div>

      <div className="flex items-center justify-between gap-4 rounded-md border bg-muted/30 px-3 py-2.5">
        <div className="min-w-0 space-y-0.5">
          <Label className="text-xs font-medium">{t("connectedAccountLabel")}</Label>
          <p className="text-xs text-muted-foreground break-all">
            {p.connectedUser
              ? t("connectedAccountValue", { name: connectedLabel ?? "" })
              : t("connectedAccountNone")}
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={p.onAuthorize}
          disabled={p.authorizing || p.saving || !p.reach.available || !p.effectiveRedirectUri}
          className="shrink-0"
        >
          {p.authorizing ? (
            <LoaderIcon className="h-3.5 w-3.5 animate-spin" />
          ) : p.connectedUser ? (
            t("reauthorizeButton")
          ) : (
            t("authorizeButton")
          )}
        </Button>
      </div>

      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 space-y-0.5">
          <Label htmlFor="lk-send-as-user" className="text-sm">
            {t("sendAsUserLabel")}
          </Label>
          <p className="text-xs leading-relaxed text-muted-foreground">{t("sendAsUserHelp")}</p>
        </div>
        <Switch
          id="lk-send-as-user"
          checked={p.sendAsUser}
          onCheckedChange={p.onSendAsUserChange}
          disabled={p.saving || !p.connectedUser}
          aria-label={t("sendAsUserLabel")}
        />
      </div>

      <ConnectorHostNotice reach={p.reach} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Identity section
// ---------------------------------------------------------------------------

interface IdentityFieldsProps {
  displayName: string
  setDisplayName: (s: string) => void
  /** The whole credential facade: value, status and edit for all four fields. */
  credentials: UseAdapterCredentialsResult
  selfBotOpenId: string | null
  onRefreshOpenId: () => void
  refreshingOpenId: boolean
  canRefreshOpenId: boolean
  testing: boolean
  testResult: TatTestResult | null
  onTest: () => void
  openConsoleUrl: string
  reach: ConnectorControlReach
  saving: boolean
}

function IdentityFields(p: IdentityFieldsProps) {
  const t = useTranslations("settings.connections.lark")

  return (
    <div className="space-y-4">
      {/* Display name — full width */}
      <FieldRow id="lk-display-name" label={t("displayNameLabel")}>
        <Input
          id="lk-display-name"
          value={p.displayName}
          onChange={(e) => p.setDisplayName(e.target.value)}
          placeholder={t("displayNamePlaceholder")}
          disabled={p.saving}
        />
      </FieldRow>

      {/* Credentials grid — 1 col on narrow, 2 cols ≥ sm.
          Help text sits BELOW the input so inputs across columns align even
          when the help copy varies in length. `items-start` keeps each cell
          independent. */}
      <div className="grid grid-cols-1 gap-x-4 gap-y-4 sm:grid-cols-2 sm:items-start">
        {/* App ID + Test connection */}
        <FieldRow id="lk-app-id" label={t("appIdLabel")} required help={t("appIdHelp")}>
          <div className="flex gap-2">
            <CredentialInput
              id="lk-app-id"
              sensitive={false}
              value={p.credentials.value("appId")}
              onChange={(next) => p.credentials.set("appId", next)}
              status={p.credentials.status("appId")}
              placeholder={t("appIdPlaceholder")}
              disabled={p.saving}
              className="min-w-0 flex-1"
              onRetry={p.credentials.retry}
            />
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={p.onTest}
              disabled={p.testing || p.saving || !p.reach.available}
              aria-label={t("testConnectionAria")}
              className="shrink-0"
            >
              {p.testing ? (
                <LoaderIcon className="h-3.5 w-3.5 animate-spin" />
              ) : (
                t("testButtonLabel")
              )}
            </Button>
          </div>
        </FieldRow>

        {/* App Secret */}
        <FieldRow id="lk-app-secret" label={t("appSecretLabel")} required help={t("appSecretHelp")}>
          <CredentialInput
            id="lk-app-secret"
            value={p.credentials.value("appSecret")}
            onChange={(next) => p.credentials.set("appSecret", next)}
            status={p.credentials.status("appSecret")}
            placeholder={t("appSecretPlaceholder")}
            disabled={p.saving}
            onRetry={p.credentials.retry}
          />
        </FieldRow>

        {/* Verification Token */}
        <FieldRow
          id="lk-verification-token"
          label={t("verificationTokenLabel")}
          required
          help={t("verificationTokenHelp")}
        >
          <CredentialInput
            id="lk-verification-token"
            value={p.credentials.value("verificationToken")}
            onChange={(next) => p.credentials.set("verificationToken", next)}
            status={p.credentials.status("verificationToken")}
            placeholder={t("verificationTokenPlaceholder")}
            disabled={p.saving}
            onRetry={p.credentials.retry}
          />
        </FieldRow>

        {/* Encrypt Key (optional) */}
        <FieldRow id="lk-encrypt-key" label={t("encryptKeyLabel")} help={t("encryptKeyHelp")}>
          <CredentialInput
            id="lk-encrypt-key"
            value={p.credentials.value("encryptKey")}
            onChange={(next) => p.credentials.set("encryptKey", next)}
            status={p.credentials.status("encryptKey")}
            placeholder={t("encryptKeyPlaceholder")}
            disabled={p.saving}
            onRetry={p.credentials.retry}
          />
        </FieldRow>
      </div>

      {/* Test connection status block — full width below the grid so a long
          error message can wrap without distorting the App ID column. */}
      {p.testResult !== null && (
        <div
          className={`flex items-start gap-2 rounded-md px-3 py-2 text-xs ${
            p.testResult.ok
              ? "bg-emerald-50 text-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-300"
              : "bg-destructive/10 text-destructive"
          }`}
          role="status"
          aria-label={p.testResult.ok ? t("connectionSucceededLabel") : t("connectionFailedLabel")}
        >
          {p.testResult.ok ? (
            <CheckCircle2Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          ) : (
            <XCircleIcon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          )}
          <span className="min-w-0 break-words">
            {p.testResult.ok
              ? t("connectedAs", { appId: p.testResult.appId ?? t("unknownAppShort") })
              : p.testResult.error}
          </span>
        </div>
      )}

      <ConnectorHostNotice reach={p.reach} />

      {/* Console jump — available on every transport (not just webhook). */}
      <div className="flex justify-end">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => {
            if (typeof window !== "undefined") {
              window.open(p.openConsoleUrl, "_blank", "noopener,noreferrer")
            }
          }}
          aria-label={t("openConsoleAria")}
          data-testid="lark-identity-open-console"
        >
          <ExternalLinkIcon className="mr-1 h-3.5 w-3.5" />
          {t("openConsole")}
        </Button>
      </div>

      {/* selfBotOpenId — read-only display + Refresh, spans full width */}
      <div className="space-y-1.5 rounded-md border bg-muted/30 px-3 py-2.5">
        <div className="flex items-center justify-between gap-3">
          <Label className="text-xs font-medium">{t("selfBotOpenIdLabel")}</Label>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={p.onRefreshOpenId}
            disabled={p.refreshingOpenId || !p.canRefreshOpenId || !p.reach.available}
            aria-label={t("selfBotOpenIdRefreshAria")}
            data-testid="lark-self-bot-open-id-refresh"
          >
            {p.refreshingOpenId ? (
              <LoaderIcon className="h-3.5 w-3.5 animate-spin" />
            ) : (
              t("selfBotOpenIdRefresh")
            )}
          </Button>
        </div>
        <p className="font-mono text-[11px] text-muted-foreground break-all">
          {p.selfBotOpenId ?? t("selfBotOpenIdUnknown")}
        </p>
        <p className="text-[10px] text-muted-foreground">
          {p.canRefreshOpenId ? t("selfBotOpenIdHelp") : t("selfBotOpenIdHelpAfterSave")}
        </p>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Field row — label on top, control in the middle, help text on the bottom.
// Keeps inputs aligned across columns in the credentials grid.
// ---------------------------------------------------------------------------

interface FieldRowProps {
  id: string
  label: string
  required?: boolean
  help?: string
  children: ReactNode
}

function FieldRow({ id, label, required, help, children }: FieldRowProps) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>
        {label}
        {required && <span className="ml-1 text-destructive">*</span>}
      </Label>
      {children}
      {help && <p className="text-xs leading-relaxed text-muted-foreground">{help}</p>}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Delivery section
// ---------------------------------------------------------------------------

interface DeliveryFieldsProps {
  transport: TransportMode
  setTransport: (t: TransportMode) => void
  saving: boolean
  /**
   * `isTauri()`, threaded down rather than re-derived: with no reachable
   * ingress the desktop's remedy is to start the cloudflared tunnel, while a
   * cloud install has no tunnel and needs none — two different empty states.
   */
  desktop: boolean
  webhookUrl: string | null
  tunnelLoading: boolean
  tunnelRunning: boolean
  webhookPath: string | null
  openConsoleUrl: string
  onCopyWebhookUrl: (url: string) => void
}

function DeliveryFields(p: DeliveryFieldsProps) {
  const t = useTranslations("settings.connections.lark")
  const router = useRouter()

  const onOpenConsole = useMemo(
    () => () => {
      if (typeof window !== "undefined") {
        window.open(p.openConsoleUrl, "_blank", "noopener,noreferrer")
      }
    },
    [p.openConsoleUrl]
  )

  return (
    <div className="space-y-4">
      {/* Transport — selector + inline description, side-by-side on ≥ sm */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,12rem)_1fr] sm:items-start sm:gap-4">
        <div className="space-y-1.5">
          <Label htmlFor="lk-transport">{t("transportLabel")}</Label>
          <Select
            value={p.transport}
            onValueChange={(v) => p.setTransport(v as TransportMode)}
            disabled={p.saving}
          >
            <SelectTrigger id="lk-transport" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="long-connection">{t("transportLongConnection")}</SelectItem>
              <SelectItem value="webhook">{t("transportWebhook")}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <p className="text-xs text-muted-foreground sm:pt-7">
          {p.transport === "webhook" ? t("transportWebhookDesc") : t("transportLongConnectionDesc")}
        </p>
      </div>

      {/* Webhook URL — only when transport = webhook */}
      {p.transport === "webhook" && (
        <div className="space-y-2 rounded border bg-card px-3 py-3">
          <Label className="text-xs font-medium">{t("webhookUrlLabel")}</Label>

          {p.webhookPath === null ? (
            <p className="text-xs text-muted-foreground">{t("webhookUrlNewAdapterHint")}</p>
          ) : p.tunnelLoading ? (
            <p className="text-xs text-muted-foreground">{t("webhookUrlTunnelLoading")}</p>
          ) : p.tunnelRunning && p.webhookUrl ? (
            <div className="space-y-2">
              <Input
                readOnly
                value={p.webhookUrl}
                className="font-mono text-[11px]"
                data-testid="lark-webhook-url-input"
                aria-label={t("webhookUrlLabel")}
              />
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => p.onCopyWebhookUrl(p.webhookUrl!)}
                  aria-label={t("webhookUrlCopyAria")}
                  data-testid="lark-webhook-url-copy"
                >
                  {t("webhookUrlCopy")}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={onOpenConsole}
                  aria-label={t("openConsoleAria")}
                >
                  <ExternalLinkIcon className="mr-1 h-3.5 w-3.5" />
                  {t("openConsole")}
                </Button>
              </div>
              <p className="text-[10px] text-muted-foreground">{t("webhookUrlHelp")}</p>
            </div>
          ) : p.desktop ? (
            <div className="space-y-2">
              <p
                className="text-xs text-amber-700 dark:text-amber-400"
                data-testid="lark-webhook-url-tunnel-off"
              >
                {t("webhookUrlTunnelOffHelp")}
              </p>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => router.push("/settings?section=connections&connectionsTab=tunnel")}
                aria-label={t("openCompanionAria")}
                data-testid="lark-open-companion"
              >
                {t("openCompanion")}
              </Button>
            </div>
          ) : (
            // A cloud install has no tunnel and needs none — pointing it at the
            // tunnel settings was advice for the wrong host.
            <p
              className="text-xs text-amber-700 dark:text-amber-400"
              data-testid="lark-webhook-url-origin-missing"
            >
              {t("webhookUrlOriginMissingHelp")}
            </p>
          )}
        </div>
      )}
    </div>
  )
}
