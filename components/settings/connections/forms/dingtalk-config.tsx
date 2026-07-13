"use client"

/**
 * DingTalk (钉钉) configuration dialog.
 *
 * Needs the App Key + App Secret from the DingTalk open platform; inbound runs
 * over Stream mode (clientId/clientSecret = appKey/appSecret) and outbound mints
 * an app access token from the same pair. Both are stored in the OS keyring
 * under `appKey` / `appSecret`. Advanced holds the shared Quiet-Hours + Mute
 * controls.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { CheckCircle2Icon, LoaderIcon, XCircleIcon } from "lucide-react"
import { toast } from "sonner"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { createAdapterInstance, updateAdapterInstance } from "@/lib/db/adapter-instances"
import { connectorsKeyringSet } from "@/lib/connectors/tauri/commands"
import { emitCredentialsRotated } from "@/lib/connectors/credentials-events"
import { getDingTalkAccessToken } from "@/lib/connectors/adapters/dingtalk/auth"
import { isTauri } from "@/lib/tauri"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"
import { defaultGroupChatPolicy } from "@/types/connectors/policy"
import { AdapterFormSections, type FormSection } from "./_shared/adapter-form-sections"
import { QuietHoursAndMute, type QuietHoursValue } from "./quiet-hours-and-mute"

interface DingTalkCredentialTestResult {
  ok: boolean
  error?: string
}

interface DingTalkConfigDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Called with the new adapter id after a successful create, so the parent
   * can auto-select and open the freshly created adapter. */
  onCreated?: (id: string) => void
  row: AdapterInstanceRow | null
}

export function DingTalkConfigDialog({
  open,
  onOpenChange,
  row,
  onCreated,
}: DingTalkConfigDialogProps) {
  const t = useTranslations("settings.connections.dingtalk")
  const isNew = row === null

  const [displayName, setDisplayName] = useState(row?.displayName ?? t("displayNamePlaceholder"))
  const [appKey, setAppKey] = useState("")
  const [appSecret, setAppSecret] = useState("")
  const [muted, setMuted] = useState<boolean>(row?.muted ?? false)
  const [quietHours, setQuietHours] = useState<QuietHoursValue | null>(row?.quietHours ?? null)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<DingTalkCredentialTestResult | null>(null)
  const [saving, setSaving] = useState(false)

  const desktop = isTauri()

  const dirty =
    isNew ||
    displayName.trim() !== row?.displayName ||
    appKey.length > 0 ||
    appSecret.length > 0 ||
    muted !== (row?.muted ?? false) ||
    quietHours !== (row?.quietHours ?? null)

  const handleTest = async () => {
    if (!appKey.trim() || !appSecret.trim()) {
      toast.error(t("credentialsRequired"))
      return
    }

    setTesting(true)
    setTestResult(null)
    try {
      await getDingTalkAccessToken(appKey.trim(), appSecret.trim())
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
    if (isNew && (!appKey.trim() || !appSecret.trim())) {
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
          type: "dingtalk",
          displayName: displayName.trim(),
          enabled: true,
          // Stream mode = persistent outbound WebSocket ("gateway"). Older
          // rows may still carry "longpoll"; the registry ignores the value
          // when building the DingTalk adapter, so both are tolerated.
          transportMode: "gateway",
          settings: {},
          credentialsRef: {
            keyringService: "com.cognia.platforms",
            accounts: ["appKey", "appSecret"],
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
          muted,
          quietHours: quietHours ?? undefined,
        })
      }

      if (appKey.trim()) await connectorsKeyringSet(adapterId, "appKey", appKey.trim())
      if (appSecret.trim()) await connectorsKeyringSet(adapterId, "appSecret", appSecret.trim())

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
          <Label htmlFor="dingtalk-display-name">{t("displayNameLabel")}</Label>
          <Input
            id="dingtalk-display-name"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder={t("displayNamePlaceholder")}
            disabled={saving}
          />
        </div>
        <div className="grid grid-cols-1 gap-x-4 gap-y-4 sm:grid-cols-2 sm:items-start">
          <div className="space-y-1.5">
            <Label htmlFor="dingtalk-app-key">
              {t("appKeyLabel")}
              {isNew && <span className="ml-1 text-destructive">*</span>}
            </Label>
            <p className="text-xs text-muted-foreground">{t("appKeyHelp")}</p>
            <Input
              id="dingtalk-app-key"
              value={appKey}
              onChange={(e) => setAppKey(e.target.value)}
              placeholder={isNew ? t("appKeyPlaceholder") : t("credentialUnchangedPlaceholder")}
              disabled={saving}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="dingtalk-app-secret">
              {t("appSecretLabel")}
              {isNew && <span className="ml-1 text-destructive">*</span>}
            </Label>
            <p className="text-xs text-muted-foreground">{t("appSecretHelp")}</p>
            <div className="flex gap-2">
              <Input
                id="dingtalk-app-secret"
                type="password"
                autoComplete="new-password"
                value={appSecret}
                onChange={(e) => setAppSecret(e.target.value)}
                placeholder={
                  isNew ? t("appSecretPlaceholder") : t("credentialUnchangedPlaceholder")
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
            {testResult.ok ? t("testSucceededStatus") : testResult.error}
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[90vh] flex-col sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{isNew ? t("titleNew") : t("titleEdit")}</DialogTitle>
        </DialogHeader>
        <div className="-mx-6 flex-1 overflow-y-auto px-6">
          <AdapterFormSections
            sections={[identitySection, advancedSection]}
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
