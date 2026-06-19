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
import { toast } from "sonner"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { createAdapterInstance, updateAdapterInstance } from "@/lib/db/adapter-instances"
import { connectorsKeyringSet } from "@/lib/connectors/tauri/commands"
import { emitCredentialsRotated } from "@/lib/connectors/credentials-events"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"
import { defaultPrivateChatPolicy } from "@/types/connectors/policy"
import { AdapterFormSections, type FormSection } from "./_shared/adapter-form-sections"
import { QuietHoursAndMute, type QuietHoursValue } from "./quiet-hours-and-mute"

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
  const isNew = row === null

  const [displayName, setDisplayName] = useState(row?.displayName ?? t("displayNamePlaceholder"))
  const [appId, setAppId] = useState("")
  const [appSecret, setAppSecret] = useState("")
  const [token, setToken] = useState("")
  const [encodingAesKey, setEncodingAesKey] = useState("")
  const [muted, setMuted] = useState<boolean>(row?.muted ?? false)
  const [quietHours, setQuietHours] = useState<QuietHoursValue | null>(row?.quietHours ?? null)
  const [saving, setSaving] = useState(false)

  const dirty =
    isNew ||
    displayName.trim() !== row?.displayName ||
    appId.length > 0 ||
    appSecret.length > 0 ||
    token.length > 0 ||
    encodingAesKey.length > 0 ||
    muted !== (row?.muted ?? false) ||
    quietHours !== (row?.quietHours ?? null)

  const webhookPath = `/webhook/wechat-oa/${row?.id ?? t("webhookUrlAfterSave")}`

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
    children: (
      <div className="space-y-1.5">
        <Label htmlFor="wxoa-webhook">{t("webhookUrlLabel")}</Label>
        <p className="text-xs text-muted-foreground">{t("webhookUrlHelp")}</p>
        <Input
          id="wxoa-webhook"
          value={webhookPath}
          readOnly
          className="font-mono text-xs"
          onFocus={(e) => e.currentTarget.select()}
        />
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
