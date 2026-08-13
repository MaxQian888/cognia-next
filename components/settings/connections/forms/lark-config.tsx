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
import {
  connectorsHttpRequest,
  connectorsKeyringGet,
  connectorsKeyringSet,
} from "@/lib/connectors/tauri/commands"
import { buildLarkOAuthUrl, LARK_SENDAS_SCOPES } from "@/lib/connectors/adapters/lark/auth"
import { computeCodeChallenge, generateCodeVerifier } from "@/lib/connectors/adapters/lark/pkce"
import { setLarkOAuthPending } from "@/lib/connectors/adapters/lark/oauth-pending"
import {
  buildLarkOAuthState,
  type LarkConnectedUser,
} from "@/lib/connectors/adapters/lark/oauth-handler"
import { CONNECTOR_OAUTH_STATE_KEY } from "@/lib/connectors/oauth-registry"
import { emitCredentialsRotated } from "@/lib/connectors/credentials-events"
import { isTauri } from "@/lib/tauri"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"
import { defaultPrivateChatPolicy } from "@/types/connectors/policy"
import { refreshSelfBotOpenId } from "@/lib/connectors/adapter-registry"
import { useTunnelStatus } from "@/hooks/use-tunnel-status"
import { AdapterFormSections, type FormSection } from "./_shared/adapter-form-sections"
import { QuietHoursAndMute, type QuietHoursValue } from "./quiet-hours-and-mute"
import { LarkAtStrategy } from "./lark/lark-at-strategy"
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

/**
 * The relay callback path Feishu redirects to. Served by the connectors axum
 * server (crates/cognia-connectors/src/axum_app.rs) and exposed via the same
 * Cloudflared tunnel as the webhook route. It 302s back to
 * `cognia://connector/oauth/lark`.
 */
const LARK_OAUTH_RELAY_PATH = "/oauth/lark/callback"

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

export function LarkConfigDialog({ open, onOpenChange, row, onCreated }: LarkConfigDialogProps) {
  const t = useTranslations("settings.connections.lark")
  const isNew = row === null
  const persistedSettings = (row?.settings ?? {}) as LarkPersistedSettings

  // ── Form state ───────────────────────────────────────────────────────────
  const [displayName, setDisplayName] = useState(row?.displayName ?? t("displayNamePlaceholder"))
  const [appId, setAppId] = useState("")
  const [appSecret, setAppSecret] = useState("")
  const [encryptKey, setEncryptKey] = useState("")
  const [verificationToken, setVerificationToken] = useState("")
  const [transport, setTransport] = useState<TransportMode>(
    persistedSettings.transport ?? "long-connection"
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

  const desktop = isTauri()
  const tunnel = useTunnelStatus()

  // Treat any non-secret edit as dirty so the Save button is enabled even
  // before the user touches a credential field. Secret entry alone also
  // counts as dirty (writing a fresh value to the keyring).
  const dirty =
    isNew ||
    displayName.trim() !== row?.displayName ||
    appId.length > 0 ||
    appSecret.length > 0 ||
    encryptKey.length > 0 ||
    verificationToken.length > 0 ||
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
      const appIdVal = (await connectorsKeyringGet(row.id, "appId")) ?? ""
      if (!appIdVal) {
        toast.error(t("authorizeNeedsAppId"))
        return
      }
      // Redirect precedence: an explicit override, else the tunnel-derived
      // relay URL. Both must be registered in the Feishu console.
      const effectiveRedirect =
        redirectUri.trim() ||
        (tunnel.url ? `${tunnel.url.replace(/\/$/, "")}${LARK_OAUTH_RELAY_PATH}` : "")
      if (!effectiveRedirect) {
        toast.error(t("authorizeNeedsRedirect"))
        return
      }
      const nonce = crypto.randomUUID().replace(/-/g, "").slice(0, 16)
      const state = buildLarkOAuthState(row.id, nonce)
      // PKCE — the verifier travels via the durable pending store; only the
      // challenge is sent to Feishu.
      const codeVerifier = generateCodeVerifier()
      const codeChallenge = await computeCodeChallenge(codeVerifier)
      // The deep-link router validates the redirect's `state`. sessionStorage
      // covers the live path; a localStorage mirror survives a cold restart.
      sessionStorage.setItem(CONNECTOR_OAUTH_STATE_KEY, state)
      try {
        localStorage.setItem(CONNECTOR_OAUTH_STATE_KEY, state)
      } catch {
        // localStorage unavailable — the live sessionStorage path still works.
      }
      // The completion handler reads the verifier + exact redirect back out.
      setLarkOAuthPending(row.id, { state, codeVerifier, redirectUri: effectiveRedirect })
      const url = buildLarkOAuthUrl({
        appId: appIdVal,
        redirectUri: effectiveRedirect,
        state,
        scope: LARK_SENDAS_SCOPES,
        codeChallenge,
      })
      await openUrl(url)
      toast.info(t("authorizeOpened"))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
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
    if (isNew && !appId.trim()) {
      toast.error(t("appIdRequired"))
      return
    }
    if (isNew && !appSecret.trim()) {
      toast.error(t("appSecretRequired"))
      return
    }
    if (isNew && !verificationToken.trim()) {
      toast.error(t("verificationTokenRequired"))
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
            accounts: ["appId", "appSecret", "encryptKey", "verificationToken"],
          },
          trigger: defaultPrivateChatPolicy(),
          defaultMode: "auto",
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
        }
        // updateAdapterInstance preserves keys that aren't in the patch — only
        // explicitly pass quietHours when it has changed so an existing row
        // doesn't get wiped accidentally.
        update.quietHours = quietHours ?? undefined
        await updateAdapterInstance(adapterId, update)
      }

      // Write secrets to keyring (Tauri only)
      if (appId.trim()) {
        await connectorsKeyringSet(adapterId, "appId", appId.trim())
      }
      if (appSecret.trim()) {
        await connectorsKeyringSet(adapterId, "appSecret", appSecret.trim())
      }
      // Encrypt Key is optional per the Lark Open Platform — only persist
      // when the operator filled the field. Leaving it blank means
      // "encryption disabled in the Lark app"; the adapter falls back to
      // plaintext events.
      if (encryptKey.trim()) {
        await connectorsKeyringSet(adapterId, "encryptKey", encryptKey.trim())
      }
      if (verificationToken.trim()) {
        await connectorsKeyringSet(adapterId, "verificationToken", verificationToken.trim())
      }

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
  const webhookPath = isNew ? null : `/webhook/lark/${row?.id ?? ""}`
  const webhookUrl =
    tunnel.url && webhookPath ? `${tunnel.url.replace(/\/$/, "")}${webhookPath}` : null

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
  const derivedRelayUrl =
    !isNew && tunnel.url ? `${tunnel.url.replace(/\/$/, "")}${LARK_OAUTH_RELAY_PATH}` : null
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
        appId={appId}
        setAppId={setAppId}
        appSecret={appSecret}
        setAppSecret={setAppSecret}
        encryptKey={encryptKey}
        setEncryptKey={setEncryptKey}
        verificationToken={verificationToken}
        setVerificationToken={setVerificationToken}
        selfBotOpenId={selfBotOpenId}
        onRefreshOpenId={handleRefreshSelfBotOpenId}
        refreshingOpenId={refreshingOpenId}
        canRefreshOpenId={!isNew}
        testing={testing}
        testResult={testResult}
        onTest={handleTest}
        openConsoleUrl={openConsoleUrl}
        desktop={desktop}
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
        {row && (
          <>
            <LarkAtStrategy adapterId={row.id} />
            <LarkWhitelistEditor adapterId={row.id} />
          </>
        )}
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
            desktop={desktop}
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
            dirty={dirty}
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
  desktop: boolean
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
          disabled={p.authorizing || p.saving || !p.desktop || !p.effectiveRedirectUri}
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

      {!p.desktop && (
        <p className="text-xs text-amber-600 dark:text-amber-400">
          {t("authorizeRequiresDesktop")}
        </p>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Identity section
// ---------------------------------------------------------------------------

interface IdentityFieldsProps {
  displayName: string
  setDisplayName: (s: string) => void
  appId: string
  setAppId: (s: string) => void
  appSecret: string
  setAppSecret: (s: string) => void
  encryptKey: string
  setEncryptKey: (s: string) => void
  verificationToken: string
  setVerificationToken: (s: string) => void
  selfBotOpenId: string | null
  onRefreshOpenId: () => void
  refreshingOpenId: boolean
  canRefreshOpenId: boolean
  testing: boolean
  testResult: TatTestResult | null
  onTest: () => void
  openConsoleUrl: string
  desktop: boolean
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
            <Input
              id="lk-app-id"
              value={p.appId}
              onChange={(e) => p.setAppId(e.target.value)}
              placeholder={t("appIdPlaceholder")}
              disabled={p.saving}
              className="min-w-0 flex-1"
            />
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={p.onTest}
              disabled={p.testing || p.saving || !p.desktop}
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
          <Input
            id="lk-app-secret"
            type="password"
            autoComplete="new-password"
            value={p.appSecret}
            onChange={(e) => p.setAppSecret(e.target.value)}
            placeholder={t("appSecretPlaceholder")}
            disabled={p.saving}
          />
        </FieldRow>

        {/* Verification Token */}
        <FieldRow
          id="lk-verification-token"
          label={t("verificationTokenLabel")}
          required
          help={t("verificationTokenHelp")}
        >
          <Input
            id="lk-verification-token"
            type="password"
            autoComplete="new-password"
            value={p.verificationToken}
            onChange={(e) => p.setVerificationToken(e.target.value)}
            placeholder={t("verificationTokenPlaceholder")}
            disabled={p.saving}
          />
        </FieldRow>

        {/* Encrypt Key (optional) */}
        <FieldRow id="lk-encrypt-key" label={t("encryptKeyLabel")} help={t("encryptKeyHelp")}>
          <Input
            id="lk-encrypt-key"
            type="password"
            autoComplete="new-password"
            value={p.encryptKey}
            onChange={(e) => p.setEncryptKey(e.target.value)}
            placeholder={t("encryptKeyPlaceholder")}
            disabled={p.saving}
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

      {!p.desktop && (
        <p className="text-xs text-amber-600 dark:text-amber-400">{t("testRequiresDesktop")}</p>
      )}

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
            disabled={p.refreshingOpenId || !p.canRefreshOpenId || !p.desktop}
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
          ) : (
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
          )}
        </div>
      )}
    </div>
  )
}
