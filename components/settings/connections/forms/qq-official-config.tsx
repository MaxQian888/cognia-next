"use client"

/**
 * QQ Official Bot configuration dialog.
 *
 * Needs the App ID + Client Secret from the QQ open platform; the adapter
 * exchanges them for an access token on demand. Both are stored in the OS
 * keyring under `appId` / `clientSecret`. Advanced holds the shared
 * Quiet-Hours + Mute controls.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { CheckCircle2Icon, LoaderIcon, XCircleIcon } from "lucide-react"
import { toast } from "sonner"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { createAdapterInstance, updateAdapterInstance } from "@/lib/db/adapter-instances"
import { connectorsKeyringSet } from "@/lib/connectors/tauri/commands"
import { emitCredentialsRotated } from "@/lib/connectors/credentials-events"
import { getQQAccessToken, getQQGatewayUrl } from "@/lib/connectors/adapters/qq-official/auth"
import { isTauri } from "@/lib/tauri"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"
import { defaultGroupChatPolicy } from "@/types/connectors/policy"
import { AdapterFormSections, type FormSection } from "./_shared/adapter-form-sections"
import { QuietHoursAndMute, type QuietHoursValue } from "./quiet-hours-and-mute"

interface QQCredentialTestResult {
  ok: boolean
  gatewayUrl?: string
  error?: string
}

interface QQOfficialConfigDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Called with the new adapter id after a successful create, so the parent
   * can auto-select and open the freshly created adapter. */
  onCreated?: (id: string) => void
  row: AdapterInstanceRow | null
}

export function QQOfficialConfigDialog({
  open,
  onOpenChange,
  row,
  onCreated,
}: QQOfficialConfigDialogProps) {
  const t = useTranslations("settings.connections.qqOfficial")
  const isNew = row === null

  const [displayName, setDisplayName] = useState(row?.displayName ?? t("displayNamePlaceholder"))
  const [appId, setAppId] = useState("")
  const [clientSecret, setClientSecret] = useState("")
  const [transportMode, setTransportMode] = useState<"gateway" | "webhook">(
    row?.transportMode === "webhook" ? "webhook" : "gateway"
  )
  const [muted, setMuted] = useState<boolean>(row?.muted ?? false)
  const [quietHours, setQuietHours] = useState<QuietHoursValue | null>(row?.quietHours ?? null)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<QQCredentialTestResult | null>(null)
  const [saving, setSaving] = useState(false)

  const desktop = isTauri()

  const dirty =
    isNew ||
    displayName.trim() !== row?.displayName ||
    appId.length > 0 ||
    clientSecret.length > 0 ||
    transportMode !== (row?.transportMode === "webhook" ? "webhook" : "gateway") ||
    muted !== (row?.muted ?? false) ||
    quietHours !== (row?.quietHours ?? null)

  const handleTest = async () => {
    if (!appId.trim() || !clientSecret.trim()) {
      toast.error(t("credentialsRequired"))
      return
    }

    setTesting(true)
    setTestResult(null)
    try {
      const accessToken = await getQQAccessToken(appId.trim(), clientSecret.trim())
      const gatewayUrl = await getQQGatewayUrl(accessToken)
      setTestResult({ ok: true, gatewayUrl })
      toast.success(t("testSucceededToast", { gatewayUrl }))
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
    if (isNew && (!appId.trim() || !clientSecret.trim())) {
      toast.error(t("credentialsRequired"))
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
          type: "qq-official",
          displayName: displayName.trim(),
          enabled: true,
          transportMode,
          settings: {},
          credentialsRef: {
            keyringService: "com.cognia.platforms",
            accounts: ["appId", "clientSecret"],
          },
          trigger: defaultGroupChatPolicy(),
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
          muted,
          quietHours: quietHours ?? undefined,
        })
      }

      if (appId.trim()) await connectorsKeyringSet(adapterId, "appId", appId.trim())
      if (clientSecret.trim())
        await connectorsKeyringSet(adapterId, "clientSecret", clientSecret.trim())

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
          <Label htmlFor="qq-display-name">{t("displayNameLabel")}</Label>
          <Input
            id="qq-display-name"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder={t("displayNamePlaceholder")}
            disabled={saving}
          />
        </div>
        <div className="grid grid-cols-1 gap-x-4 gap-y-4 sm:grid-cols-2 sm:items-start">
          <div className="space-y-1.5">
            <Label htmlFor="qq-app-id">
              {t("appIdLabel")}
              {isNew && <span className="ml-1 text-destructive">*</span>}
            </Label>
            <p className="text-xs text-muted-foreground">{t("appIdHelp")}</p>
            <Input
              id="qq-app-id"
              value={appId}
              onChange={(e) => setAppId(e.target.value)}
              placeholder={isNew ? t("appIdPlaceholder") : t("credentialUnchangedPlaceholder")}
              disabled={saving}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="qq-client-secret">
              {t("clientSecretLabel")}
              {isNew && <span className="ml-1 text-destructive">*</span>}
            </Label>
            <p className="text-xs text-muted-foreground">{t("clientSecretHelp")}</p>
            <div className="flex gap-2">
              <Input
                id="qq-client-secret"
                type="password"
                autoComplete="new-password"
                value={clientSecret}
                onChange={(e) => setClientSecret(e.target.value)}
                placeholder={
                  isNew ? t("clientSecretPlaceholder") : t("credentialUnchangedPlaceholder")
                }
                disabled={saving}
                className="min-w-0 flex-1"
              />
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={handleTest}
                disabled={testing || saving || !desktop}
                aria-label={t("testCredentialsAria")}
                className="shrink-0"
              >
                {testing ? (
                  <LoaderIcon data-icon="inline-start" className="animate-spin" />
                ) : (
                  t("testButtonLabel")
                )}
              </Button>
            </div>
          </div>
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
            {testResult.ok
              ? t("testGatewayUrl", { gatewayUrl: testResult.gatewayUrl ?? "" })
              : testResult.error}
          </div>
        )}
        {!desktop && (
          <p className="text-xs text-amber-600 dark:text-amber-400">{t("testRequiresDesktop")}</p>
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

  const deliverySection: FormSection = {
    id: "delivery",
    label: t("sectionDelivery"),
    description: t("sectionDeliveryDesc"),
    defaultOpen: true,
    children: (
      <div className="space-y-2">
        <Label>{t("transportLabel")}</Label>
        <RadioGroup
          value={transportMode}
          onValueChange={(value) => setTransportMode(value as "gateway" | "webhook")}
          disabled={saving}
          className="gap-3"
        >
          <div className="flex items-start gap-3">
            <RadioGroupItem id="qq-transport-gateway" value="gateway" />
            <div className="space-y-0.5">
              <Label htmlFor="qq-transport-gateway">{t("transportGateway")}</Label>
              <p className="text-xs text-muted-foreground">{t("transportGatewayHelp")}</p>
            </div>
          </div>
          <div className="flex items-start gap-3">
            <RadioGroupItem id="qq-transport-webhook" value="webhook" />
            <div className="space-y-0.5">
              <Label htmlFor="qq-transport-webhook">{t("transportWebhook")}</Label>
              <p className="text-xs text-muted-foreground">{t("transportWebhookHelp")}</p>
            </div>
          </div>
        </RadioGroup>
      </div>
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
