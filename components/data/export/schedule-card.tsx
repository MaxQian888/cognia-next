"use client"

// Settings card for the auto-backup schedule. Toggles the feature, sets the
// interval and retention, and (Tauri-only) picks a destination folder. The
// scheduler's actual runner lives in `BackupSchedulerProvider`.

import { useState } from "react"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { DirectoryField } from "@/components/settings/common/directory-field"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { CalendarClockIcon, ExternalLinkIcon, SparklesIcon } from "lucide-react"
import { useSettingsStore } from "@/stores/settings"
import { isTauri } from "@/lib/tauri"
import { DEFAULT_BACKUP_AUTO_SCHEDULE } from "@cognia/agent-config-types"
import { toast } from "sonner"
import { createLogger } from "@cognia/logging"
import {
  getLocalCloudProvider,
  LOCAL_CLOUD_PROVIDERS,
  type LocalCloudProviderId,
} from "@/lib/data/local-cloud-providers"
import { startNewSession } from "@/lib/chat/start-session"
import { queuePendingChatPrompt } from "@/lib/chat/pending-prompt"

const log = createLogger("data-backup-schedule")

export function ScheduleCard() {
  const t = useTranslations("settings.data.backup.schedule")
  const router = useRouter()
  const settings = useSettingsStore((s) => s.settings)
  const save = useSettingsStore((s) => s.save)
  const config = settings?.backupAutoSchedule ?? DEFAULT_BACKUP_AUTO_SCHEDULE
  const reminderDays = settings?.backupReminderDays ?? 7
  const [busy, setBusy] = useState(false)
  // Local draft so typing does not write on every keystroke. Committed on blur
  // and immediately after a pick, which is `DirectoryField`'s contract.
  const [folderDraft, setFolderDraft] = useState(config.dirPath ?? "")
  const [cloudProviderId, setCloudProviderId] = useState<LocalCloudProviderId>("google-drive")

  const update = async (next: Partial<typeof config>) => {
    setBusy(true)
    try {
      await save({ backupAutoSchedule: { ...config, ...next } })
    } catch (error) {
      log.error("schedule-save-failed", { error, patch: Object.keys(next) })
      throw error
    } finally {
      setBusy(false)
    }
  }

  const commitFolder = async (dirPath: string) => {
    const next = dirPath.trim()
    if (!next || next === (config.dirPath ?? "")) return
    try {
      await update({ dirPath: next })
      toast.success(t("folderSet"))
    } catch (error) {
      log.error("schedule-folder-pick-failed", { error })
      toast.error(error instanceof Error ? error.message : String(error))
    }
  }

  const configureCloudFolderWithAi = async () => {
    const provider = getLocalCloudProvider(cloudProviderId)
    const providerLabel = t(`cloudProviders.${cloudProviderId}`)
    try {
      const session = await startNewSession({
        title: t("cloudAiSessionTitle", { provider: providerLabel }),
      })
      queuePendingChatPrompt(
        session.id,
        t("cloudAiPrompt", {
          provider: providerLabel,
          docsUrl: provider.docsUrl,
        })
      )
      router.push("/")
    } catch (error) {
      toast.error(
        t("cloudAiFailed", {
          error: error instanceof Error ? error.message : String(error),
        })
      )
    }
  }

  return (
    <Card className="space-y-3 p-4">
      <div className="flex items-center gap-2">
        <CalendarClockIcon className="size-4" />
        <Label className="text-sm">{t("title")}</Label>
      </div>
      <p className="text-xs text-muted-foreground">{t("body")}</p>

      <label className="flex items-center justify-between text-sm">
        <span>
          <span className="font-medium">{t("enableLabel")}</span>
          <span className="block text-[11px] text-muted-foreground">{t("enableHint")}</span>
        </span>
        <Switch
          checked={config.enabled}
          onCheckedChange={(v) => void update({ enabled: v })}
          disabled={busy}
        />
      </label>

      <div className="grid gap-2 sm:grid-cols-2">
        <div className="space-y-1">
          <Label className="text-[11px]">{t("intervalLabel")}</Label>
          <Input
            type="number"
            min={1}
            max={30}
            value={config.intervalDays}
            onChange={(e) => {
              const v = Number(e.target.value)
              if (Number.isFinite(v)) void update({ intervalDays: Math.max(1, Math.min(30, v)) })
            }}
            disabled={busy}
          />
        </div>
        <div className="space-y-1">
          <Label className="text-[11px]">{t("retainLabel")}</Label>
          <Input
            type="number"
            min={1}
            max={50}
            value={config.retainCount}
            onChange={(e) => {
              const v = Number(e.target.value)
              if (Number.isFinite(v)) void update({ retainCount: Math.max(1, Math.min(50, v)) })
            }}
            disabled={busy}
          />
        </div>
      </div>

      {/* The destination is settable on every shell. It used to be a read-only
          input inside this `isTauri()` block, so off the desktop there was no
          way to configure a backup directory at all, even though the headless
          host writes backups through its own filesystem adapter. */}
      <div className="space-y-1">
        <Label className="text-[11px]">{t("folderLabel")}</Label>
        <DirectoryField
          value={folderDraft}
          onChange={setFolderDraft}
          onCommit={(next) => void commitFolder(next)}
          placeholder={t("folderPlaceholder")}
          ariaLabel={t("folderLabel")}
          browseLabel={t("pickFolder")}
          disabled={busy}
        />
      </div>

      {isTauri() && (
        <div className="space-y-3">
          <div className="space-y-1 rounded-md border p-3">
            <Label className="text-[11px]" htmlFor="backup-cloud-provider">
              {t("cloudProviderLabel")}
            </Label>
            <Select
              value={cloudProviderId}
              onValueChange={(value) => setCloudProviderId(value as LocalCloudProviderId)}
            >
              <SelectTrigger id="backup-cloud-provider">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LOCAL_CLOUD_PROVIDERS.map((provider) => (
                  <SelectItem key={provider.id} value={provider.id}>
                    {t(`cloudProviders.${provider.id}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-[11px] text-muted-foreground">{t("cloudFolderHint")}</p>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <a
                className="inline-flex items-center gap-1 text-[11px] text-primary hover:underline"
                href={getLocalCloudProvider(cloudProviderId).docsUrl}
                target="_blank"
                rel="noreferrer"
              >
                {t("cloudOfficialDocs")}
                <ExternalLinkIcon className="size-3" aria-hidden />
              </a>
              <Button variant="outline" size="sm" onClick={() => void configureCloudFolderWithAi()}>
                <SparklesIcon className="size-3.5" aria-hidden />
                {t("cloudAiConfigure")}
              </Button>
            </div>
          </div>
        </div>
      )}
      {!isTauri() && (
        <p className="rounded border bg-muted/30 p-2 text-[11px] text-muted-foreground">
          {t("webOnlyNote")}
        </p>
      )}

      <div className="space-y-1 border-t pt-3">
        <Label className="text-[11px]">{t("reminderLabel")}</Label>
        <Input
          type="number"
          min={0}
          max={90}
          value={reminderDays}
          onChange={(e) => {
            const v = Number(e.target.value)
            if (Number.isFinite(v)) {
              save({ backupReminderDays: Math.max(0, Math.min(90, v)) }).catch((error) =>
                log.error("reminder-days-save-failed", { error })
              )
            }
          }}
        />
        <p className="text-[11px] text-muted-foreground">{t("reminderHint")}</p>
      </div>
    </Card>
  )
}
