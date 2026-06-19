"use client"

/**
 * WeCom 智能机器人 (AI bot) configuration dialog.
 *
 * The 智能机器人 long connection needs just two credentials — the BotID and
 * the long-connection Secret — and no public URL / encryption / IP whitelist.
 * Identity holds those plus an optional enter-chat welcome message; Advanced
 * holds the shared Quiet-Hours + Mute controls. Credentials are stored in the
 * OS keyring under `botId` / `secret`; only the welcome message lives in the
 * non-secret `settings` blob.
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
import { QuickCommandsEditor } from "./_shared/quick-commands-editor"
import { QuietHoursAndMute, type QuietHoursValue } from "./quiet-hours-and-mute"
import { normalizeQuickCommandList, type IMQuickCommand } from "@/lib/connectors/quick-commands"

interface WeComConfigDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Called with the new adapter id after a successful create, so the parent
   * can auto-select and open the freshly created adapter. */
  onCreated?: (id: string) => void
  /** null = creating a new instance */
  row: AdapterInstanceRow | null
}

export function WeComConfigDialog({ open, onOpenChange, row, onCreated }: WeComConfigDialogProps) {
  const t = useTranslations("settings.connections.wecom")
  const tHelp = useTranslations("settings.connections.wecom.quickCommands")
  const isNew = row === null
  const settings = (row?.settings ?? {}) as {
    welcomeMessage?: string
    quickCommands?: unknown
  }
  const persistedQuickCommands = normalizeQuickCommandList(settings.quickCommands)

  const [displayName, setDisplayName] = useState(row?.displayName ?? t("displayNamePlaceholder"))
  const [botId, setBotId] = useState("")
  const [secret, setSecret] = useState("")
  const [welcomeMessage, setWelcomeMessage] = useState(settings.welcomeMessage ?? "")
  const [quickCommands, setQuickCommands] = useState<IMQuickCommand[]>(persistedQuickCommands)
  const [muted, setMuted] = useState<boolean>(row?.muted ?? false)
  const [quietHours, setQuietHours] = useState<QuietHoursValue | null>(row?.quietHours ?? null)
  const [saving, setSaving] = useState(false)

  const dirty =
    isNew ||
    displayName.trim() !== row?.displayName ||
    botId.length > 0 ||
    secret.length > 0 ||
    welcomeMessage.trim() !== (settings.welcomeMessage ?? "") ||
    JSON.stringify(quickCommands) !== JSON.stringify(persistedQuickCommands) ||
    muted !== (row?.muted ?? false) ||
    quietHours !== (row?.quietHours ?? null)

  const handleSave = async () => {
    if (!displayName.trim()) {
      toast.error(t("displayNameRequired"))
      return
    }
    // BotID + Secret are required on create; on edit they're optional (only
    // rotate when re-entered).
    if (isNew && (!botId.trim() || !secret.trim())) {
      toast.error(t("credentialsRequired"))
      return
    }
    if (quietHours && (!quietHours.from || !quietHours.to || !quietHours.tz)) {
      toast.error(t("quietHoursIncomplete"))
      return
    }

    setSaving(true)
    try {
      const wecomSettings = {
        welcomeMessage: welcomeMessage.trim() || undefined,
        ...(quickCommands.length > 0 ? { quickCommands } : {}),
      }
      let adapterId: string

      if (isNew) {
        const newRow = await createAdapterInstance({
          type: "wecom",
          displayName: displayName.trim(),
          enabled: true,
          transportMode: "gateway",
          settings: wecomSettings,
          credentialsRef: {
            keyringService: "com.cognia.platforms",
            accounts: ["botId", "secret"],
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
          settings: wecomSettings,
          muted,
          quietHours: quietHours ?? undefined,
        })
      }

      if (botId.trim()) await connectorsKeyringSet(adapterId, "botId", botId.trim())
      if (secret.trim()) await connectorsKeyringSet(adapterId, "secret", secret.trim())

      // Hot-reload the running adapter so new credentials apply without a
      // restart.
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
          <Label htmlFor="wc-display-name">{t("displayNameLabel")}</Label>
          <Input
            id="wc-display-name"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder={t("displayNamePlaceholder")}
            disabled={saving}
          />
        </div>

        <div className="grid grid-cols-1 gap-x-4 gap-y-4 sm:grid-cols-2 sm:items-start">
          <div className="space-y-1.5">
            <Label htmlFor="wc-bot-id">
              {t("botIdLabel")}
              {isNew && <span className="ml-1 text-destructive">*</span>}
            </Label>
            <p className="text-xs text-muted-foreground">{t("botIdHelp")}</p>
            <Input
              id="wc-bot-id"
              value={botId}
              onChange={(e) => setBotId(e.target.value)}
              placeholder={isNew ? t("botIdPlaceholder") : t("credentialUnchangedPlaceholder")}
              disabled={saving}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="wc-secret">
              {t("secretLabel")}
              {isNew && <span className="ml-1 text-destructive">*</span>}
            </Label>
            <p className="text-xs text-muted-foreground">{t("secretHelp")}</p>
            <Input
              id="wc-secret"
              type="password"
              autoComplete="new-password"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              placeholder={isNew ? t("secretPlaceholder") : t("credentialUnchangedPlaceholder")}
              disabled={saving}
            />
          </div>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="wc-welcome">{t("welcomeLabel")}</Label>
          <p className="text-xs text-muted-foreground">{t("welcomeHelp")}</p>
          <Input
            id="wc-welcome"
            value={welcomeMessage}
            onChange={(e) => setWelcomeMessage(e.target.value)}
            placeholder={t("welcomePlaceholder")}
            disabled={saving}
          />
        </div>

        <p className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
          {t("proactiveNote")}
        </p>
      </div>
    ),
  }

  const quickCommandsSection: FormSection = {
    id: "quick-commands",
    label: t("sectionQuickCommands"),
    description: t("sectionQuickCommandsDesc"),
    children: (
      <QuickCommandsEditor
        value={quickCommands}
        onChange={setQuickCommands}
        helpText={tHelp("help")}
        disabled={saving}
        testIdPrefix="wqc"
      />
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
            sections={[identitySection, quickCommandsSection, advancedSection]}
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
