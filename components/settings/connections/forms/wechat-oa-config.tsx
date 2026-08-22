"use client"

/**
 * WeChat Official Account configuration dialog.
 *
 * Safe-mode callback config needs four values: App ID, App Secret (for the
 * access token / 客服 API), the server Token and the EncodingAESKey (for
 * signature + AES-256-CBC decrypt, read by the Rust webhook handler). All four
 * are stored in the OS keyring. Delivery surfaces the webhook URL to paste
 * into the WeChat console; Advanced holds Quiet-Hours + Mute.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { useRouter } from "next/navigation"
import { CheckCircle2Icon, CopyIcon, LoaderIcon, XCircleIcon } from "lucide-react"
import { toast } from "sonner"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useTunnelStatus } from "@/hooks/use-tunnel-status"
import { createAdapterInstance, updateAdapterInstance } from "@/lib/db/adapter-instances"
import { connectorsKeyringSet } from "@/lib/connectors/tauri/commands"
import { emitCredentialsRotated } from "@/lib/connectors/credentials-events"
import { getWechatOaAccessToken } from "@/lib/connectors/adapters/wechat-oa/auth"
import { isTauri } from "@/lib/tauri"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"
import { defaultPrivateChatPolicy } from "@/types/connectors/policy"
import { AdapterFormSections, type FormSection } from "./_shared/adapter-form-sections"
import { QuietHoursAndMute, type QuietHoursValue } from "./quiet-hours-and-mute"

interface WechatOaCredentialTestResult {
  ok: boolean
  error?: string
}

interface WechatOaConfigDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Called with the new adapter id after a successful create, so the parent
   * can auto-select and open the freshly created adapter. */
  onCreated?: (id: string) => void
  row: AdapterInstanceRow | null
}

export function WechatOaConfigDialog({
  open,
  onOpenChange,
  row,
  onCreated,
}: WechatOaConfigDialogProps) {
  const t = useTranslations("settings.connections.wechatOa")
  const router = useRouter()
  const isNew = row === null

  const [displayName, setDisplayName] = useState(row?.displayName ?? t("displayNamePlaceholder"))
  const [appId, setAppId] = useState("")
  const [appSecret, setAppSecret] = useState("")
  const [token, setToken] = useState("")
  const [encodingAesKey, setEncodingAesKey] = useState("")
  const [muted, setMuted] = useState<boolean>(row?.muted ?? false)
  const [quietHours, setQuietHours] = useState<QuietHoursValue | null>(row?.quietHours ?? null)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<WechatOaCredentialTestResult | null>(null)
  const [saving, setSaving] = useState(false)

  const desktop = isTauri()
  const tunnel = useTunnelStatus()

  const dirty =
    isNew ||
    displayName.trim() !== row?.displayName ||
    appId.length > 0 ||
    appSecret.length > 0 ||
    token.length > 0 ||
    encodingAesKey.length > 0 ||
    muted !== (row?.muted ?? false) ||
    quietHours !== (row?.quietHours ?? null)

  const webhookPath = row ? `/webhook/wechat-oa/${row.id}` : null
  // Only an absolute, tunnel-backed URL is reachable by WeChat's servers; when
  // the tunnel is down `webhookUrl` falls back to the relative `webhookPath`.
  const webhookUrlIsPublic = Boolean(webhookPath && tunnel.running && tunnel.url)
  const webhookUrl =
    webhookUrlIsPublic && tunnel.url
      ? `${tunnel.url.replace(/\/$/, "")}${webhookPath}`
      : (webhookPath ?? t("webhookUrlAfterSave"))

  const handleCopyWebhookUrl = async () => {
    if (!row) return
    if (!webhookUrlIsPublic) {
      // Don't copy the relative fallback path — pasting it into the WeChat
      // admin console yields an unreachable callback. Prompt to start the
      // public tunnel first instead.
      toast.error(t("webhookUrlTunnelOffHelp"))
      return
    }
    try {
      await navigator.clipboard.writeText(webhookUrl)
      toast.success(t("webhookUrlCopied"))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  const handleTest = async () => {
    if (!appId.trim() || !appSecret.trim()) {
      toast.error(t("appCredentialsRequired"))
      return
    }

    setTesting(true)
    setTestResult(null)
    try {
      await getWechatOaAccessToken(appId.trim(), appSecret.trim())
      setTestResult({ ok: true })
      toast.success(t("testSucceededToast"))
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      setTestResult({ ok: false, error })
      toast.error(t("testFailedToast", { error }))
    } finally {
      setTesting(false)
    }
  }

  const handleSave = async () => {
    if (!displayName.trim()) {
      toast.error(t("displayNameRequired"))
      return
    }
    if (isNew && (!appId.trim() || !appSecret.trim() || !token.trim() || !encodingAesKey.trim())) {
      toast.error(t("credentialsRequired"))
      return
    }
    if (encodingAesKey.trim() && encodingAesKey.trim().length !== 43) {
      toast.error(t("encodingAesKeyInvalid"))
      return
    }
    if (quietHours && (!quietHours.from || !quietHours.to || !quietHours.tz)) {
      toast.error(t("quietHoursIncomplete"))
      return
    }

    setSaving(true)
    try {
      let adapterId: string
      if (isNew) {
        const newRow = await createAdapterInstance({
          type: "wechat-oa",
          displayName: displayName.trim(),
          enabled: true,
          transportMode: "webhook",
          settings: {},
          credentialsRef: {
            keyringService: "com.cognia.platforms",
            accounts: ["appId", "appSecret", "token", "encodingAesKey"],
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
          muted,
          quietHours: quietHours ?? undefined,
        })
      }

      if (appId.trim()) await connectorsKeyringSet(adapterId, "appId", appId.trim())
      if (appSecret.trim()) await connectorsKeyringSet(adapterId, "appSecret", appSecret.trim())
      if (token.trim()) await connectorsKeyringSet(adapterId, "token", token.trim())
      if (encodingAesKey.trim())
        await connectorsKeyringSet(adapterId, "encodingAesKey", encodingAesKey.trim())

      if (!isNew) emitCredentialsRotated(adapterId)

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
          <Label htmlFor="wxoa-display-name">{t("displayNameLabel")}</Label>
          <Input
            id="wxoa-display-name"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder={t("displayNamePlaceholder")}
            disabled={saving}
          />
        </div>
        <div className="grid grid-cols-1 gap-x-4 gap-y-4 sm:grid-cols-2 sm:items-start">
          <div className="space-y-1.5">
            <Label htmlFor="wxoa-app-id">
              {t("appIdLabel")}
              {isNew && <span className="ml-1 text-destructive">*</span>}
            </Label>
            <p className="text-xs text-muted-foreground">{t("appIdHelp")}</p>
            <Input
              id="wxoa-app-id"
              value={appId}
              onChange={(e) => setAppId(e.target.value)}
              placeholder={isNew ? "wx…" : t("credentialUnchangedPlaceholder")}
              disabled={saving}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="wxoa-app-secret">
              {t("appSecretLabel")}
              {isNew && <span className="ml-1 text-destructive">*</span>}
            </Label>
            <p className="text-xs text-muted-foreground">{t("appSecretHelp")}</p>
            <Input
              id="wxoa-app-secret"
              type="password"
              autoComplete="new-password"
              value={appSecret}
              onChange={(e) => setAppSecret(e.target.value)}
              placeholder={isNew ? "" : t("credentialUnchangedPlaceholder")}
              disabled={saving}
            />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={handleTest}
                disabled={testing || saving || !desktop}
                aria-label={t("testCredentialsAria")}
              >
                {testing ? (
                  <LoaderIcon data-icon="inline-start" className="animate-spin" />
                ) : (
                  t("testButtonLabel")
                )}
              </Button>
              <p className="text-xs text-muted-foreground">{t("testCredentialScopeHelp")}</p>
            </div>
            {testResult !== null && (
              <div
                className={`flex items-center gap-2 rounded-md px-3 py-2 text-xs ${
                  testResult.ok
                    ? "bg-emerald-50 text-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-300"
                    : "bg-destructive/10 text-destructive"
                }`}
                role="status"
                aria-label={testResult.ok ? t("testSucceededLabel") : t("testFailedLabel")}
              >
                {testResult.ok ? (
                  <CheckCircle2Icon className="h-3.5 w-3.5 shrink-0" />
                ) : (
                  <XCircleIcon className="h-3.5 w-3.5 shrink-0" />
                )}
                {testResult.ok ? t("testSucceededStatus") : testResult.error}
              </div>
            )}
            {!desktop && (
              <p className="text-xs text-amber-600 dark:text-amber-400">
                {t("testRequiresDesktop")}
              </p>
            )}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="wxoa-token">
              {t("tokenLabel")}
              {isNew && <span className="ml-1 text-destructive">*</span>}
            </Label>
            <p className="text-xs text-muted-foreground">{t("tokenHelp")}</p>
            <Input
              id="wxoa-token"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder={isNew ? "" : t("credentialUnchangedPlaceholder")}
              disabled={saving}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="wxoa-aes-key">
              {t("encodingAesKeyLabel")}
              {isNew && <span className="ml-1 text-destructive">*</span>}
            </Label>
            <p className="text-xs text-muted-foreground">{t("encodingAesKeyHelp")}</p>
            <Input
              id="wxoa-aes-key"
              type="password"
              autoComplete="new-password"
              value={encodingAesKey}
              onChange={(e) => setEncodingAesKey(e.target.value)}
              placeholder={isNew ? "" : t("credentialUnchangedPlaceholder")}
              disabled={saving}
            />
          </div>
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
      <div className="flex flex-col gap-2">
        <Label htmlFor="wxoa-webhook">{t("webhookUrlLabel")}</Label>
        <p className="text-xs text-muted-foreground">{t("webhookUrlHelp")}</p>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            id="wxoa-webhook"
            value={webhookUrl}
            readOnly
            className="font-mono text-xs"
            onFocus={(e) => e.currentTarget.select()}
            data-testid="wechat-oa-webhook-url-input"
            aria-label={t("webhookUrlLabel")}
          />
          {row && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={handleCopyWebhookUrl}
              disabled={!webhookUrlIsPublic}
              aria-label={t("webhookUrlCopyAria")}
              data-testid="wechat-oa-webhook-url-copy"
              className="shrink-0"
            >
              <CopyIcon data-icon="inline-start" />
              {t("webhookUrlCopy")}
            </Button>
          )}
        </div>
        {row && tunnel.loading && (
          <p className="text-xs text-muted-foreground">{t("webhookUrlTunnelLoading")}</p>
        )}
        {row && !tunnel.loading && !tunnel.running && (
          <div className="flex flex-col gap-2 rounded-md bg-muted px-3 py-2">
            <p
              className="text-xs text-muted-foreground"
              data-testid="wechat-oa-webhook-url-tunnel-off"
            >
              {t("webhookUrlTunnelOffHelp")}
            </p>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="self-start"
              onClick={() => router.push("/settings?section=connections&connectionsTab=tunnel")}
              aria-label={t("openCompanionAria")}
            >
              {t("openCompanion")}
            </Button>
          </div>
        )}
        <p className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
          {t("windowNote")}
        </p>
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
