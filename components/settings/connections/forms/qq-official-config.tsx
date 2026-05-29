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
import { toast } from "sonner"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { createAdapterInstance, updateAdapterInstance } from "@/lib/db/adapter-instances"
import { connectorsKeyringSet } from "@/lib/connectors/tauri/commands"
import { emitCredentialsRotated } from "@/lib/connectors/credentials-events"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"
import { defaultGroupChatPolicy } from "@/types/connectors/policy"
import { AdapterFormSections, type FormSection } from "./_shared/adapter-form-sections"
import { QuietHoursAndMute, type QuietHoursValue } from "./quiet-hours-and-mute"

interface QQOfficialConfigDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  row: AdapterInstanceRow | null
}

export function QQOfficialConfigDialog({ open, onOpenChange, row }: QQOfficialConfigDialogProps) {
  const t = useTranslations("settings.connections.qqOfficial")
  const isNew = row === null

  const [displayName, setDisplayName] = useState(row?.displayName ?? t("displayNamePlaceholder"))
  const [appId, setAppId] = useState("")
  const [clientSecret, setClientSecret] = useState("")
  const [muted, setMuted] = useState<boolean>(row?.muted ?? false)
  const [quietHours, setQuietHours] = useState<QuietHoursValue | null>(row?.quietHours ?? null)
  const [saving, setSaving] = useState(false)

  const dirty =
    isNew ||
    displayName.trim() !== row?.displayName ||
    appId.length > 0 ||
    clientSecret.length > 0 ||
    muted !== (row?.muted ?? false) ||
    quietHours !== (row?.quietHours ?? null)

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
          transportMode: "gateway",
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
          muted,
          quietHours: quietHours ?? undefined,
        })
      }

      if (appId.trim()) await connectorsKeyringSet(adapterId, "appId", appId.trim())
      if (clientSecret.trim())
        await connectorsKeyringSet(adapterId, "clientSecret", clientSecret.trim())

      if (!isNew) emitCredentialsRotated(adapterId)

      toast.success(isNew ? t("adapterCreated") : t("adapterUpdated"))
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
            />
          </div>
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
