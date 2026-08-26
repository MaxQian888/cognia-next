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
import { CheckCircle2Icon, LoaderIcon, XCircleIcon } from "lucide-react"
import { toast } from "sonner"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { createAdapterInstance, updateAdapterInstance } from "@/lib/db/adapter-instances"
import { emitCredentialsRotated } from "@/lib/connectors/credentials-events"
import { probeWeComCredentials } from "@/lib/connectors/adapters/wecom/probe"
import { preflightConnectorConfig } from "@/lib/connectors/config-preflight"
import { isTauri } from "@/lib/tauri"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"
import { defaultGroupChatPolicy } from "@/types/connectors/policy"
import { useAdapterCredentials } from "@/hooks/connectors/use-adapter-credentials"
import { AdapterFormSections, type FormSection } from "./_shared/adapter-form-sections"
import { CredentialInput } from "./_shared/credential-input"
import { QuickCommandsEditor } from "./_shared/quick-commands-editor"
import { QuietHoursAndMute, type QuietHoursValue } from "./quiet-hours-and-mute"
import { normalizeQuickCommandList, type IMQuickCommand } from "@/lib/connectors/quick-commands"

interface WeComCredentialTestResult {
  ok: boolean
  error?: string
}

interface WeComConfigDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Called with the new adapter id after a successful create, so the parent
   * can auto-select and open the freshly created adapter. */
  onCreated?: (id: string) => void
  /** null = creating a new instance */
  row: AdapterInstanceRow | null
}

/** Keyring accounts this dialog owns. WeCom authenticates with the pair,
 * so a bot missing either cannot subscribe. */
const WECOM_CREDENTIALS = ["botId", "secret"] as const

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
  const credentials = useAdapterCredentials({
    adapterId: row?.id ?? null,
    accounts: WECOM_CREDENTIALS,
    enabled: open,
  })
  const botId = credentials.value("botId")
  const secret = credentials.value("secret")
  const [welcomeMessage, setWelcomeMessage] = useState(settings.welcomeMessage ?? "")
  const [quickCommands, setQuickCommands] = useState<IMQuickCommand[]>(persistedQuickCommands)
  const [muted, setMuted] = useState<boolean>(row?.muted ?? false)
  const [quietHours, setQuietHours] = useState<QuietHoursValue | null>(row?.quietHours ?? null)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<WeComCredentialTestResult | null>(null)
  const [saving, setSaving] = useState(false)
  const desktop = isTauri()

  const dirty =
    isNew ||
    displayName.trim() !== row?.displayName ||
    credentials.dirty ||
    welcomeMessage.trim() !== (settings.welcomeMessage ?? "") ||
    JSON.stringify(quickCommands) !== JSON.stringify(persistedQuickCommands) ||
    muted !== (row?.muted ?? false) ||
    quietHours !== (row?.quietHours ?? null)

  const handleTest = async () => {
    if (!botId.trim() || !secret.trim()) {
      toast.error(t("credentialsRequired"))
      return
    }

    setTesting(true)
    setTestResult(null)
    try {
      const result = await probeWeComCredentials(botId.trim(), secret.trim())
      if (result.ok) {
        setTestResult({ ok: true })
        toast.success(t("testSucceededToast"))
      } else {
        // The conflict is not a credential failure and must not read like one:
        // WeCom allows one connection per bot, so nothing could be tested
        // without taking the running bot's slot. Say what to do instead.
        const conflict = result.code === "live_connection_conflict"
        const detail = conflict ? t("testConflictLiveConnection") : result.error
        setTestResult({ ok: false, error: detail })
        toast.error(conflict ? detail : t("testFailedToast", { error: result.error }))
      }
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
    // WeCom authenticates with the pair, so neither may end up empty —
    // on create, or by the operator clearing a value they can see.
    if (credentials.missingRequired(WECOM_CREDENTIALS).length > 0) {
      toast.error(t("credentialsRequired"))
      return
    }
    if (quietHours && (!quietHours.from || !quietHours.to || !quietHours.tz)) {
      toast.error(t("quietHoursIncomplete"))
      return
    }

    setSaving(true)
    try {
      if (credentials.dirty) {
        if (!botId.trim() || !secret.trim()) throw new Error(t("credentialsRequired"))
        try {
          await preflightConnectorConfig({
            // Saving new credentials IS a request to replace the connection —
            // the adapter restarts onto them immediately — so this path may
            // take the slot where the test button must not.
            probe: () => probeWeComCredentials(botId.trim(), secret.trim(), { intent: "replace" }),
          })
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error)
          throw new Error(t("preflightFailed", { error: detail }))
        }
      }
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
            accounts: [...WECOM_CREDENTIALS],
          },
          trigger: defaultGroupChatPolicy(),
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
          settings: wecomSettings,
          muted,
          quietHours: quietHours ?? undefined,
        })
      }

      await credentials.persist(adapterId)

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
            <CredentialInput
              id="wc-bot-id"
              sensitive={false}
              value={botId}
              onChange={(next) => credentials.set("botId", next)}
              status={credentials.status("botId")}
              placeholder={t("botIdPlaceholder")}
              disabled={saving}
              onRetry={credentials.retry}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="wc-secret">
              {t("secretLabel")}
              {isNew && <span className="ml-1 text-destructive">*</span>}
            </Label>
            <p className="text-xs text-muted-foreground">{t("secretHelp")}</p>
            <CredentialInput
              id="wc-secret"
              value={secret}
              onChange={(next) => credentials.set("secret", next)}
              status={credentials.status("secret")}
              placeholder={t("secretPlaceholder")}
              disabled={saving}
              onRetry={credentials.retry}
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
