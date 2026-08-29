"use client"

/**
 * Scheduled Tasks settings section.
 *
 * Single-page layout with eight cards:
 *
 *   1. Status & runtime           — read-only health digest of the in-app loop.
 *   2. Defaults for new tasks     — user-configurable defaults for the task form.
 *   3. System scheduler health    — desktop-only digest of native scheduler state.
 *   4. Webhook signing            — read-only signal of outbound HMAC signing.
 *   5. Agent Auto-Create          — existing permission toggle.
 *   6. Script Tasks               — existing permission toggle.
 *   7. Confirmation Required      — existing per-task-type checkbox grid.
 *   8. Limits                     — existing numeric inputs.
 *
 * Cards 5-8 mirror Cognia's
 * `components/settings/scheduler/scheduler-permission-settings.tsx` layout.
 * Cards 1-4 are net-new and intentionally avoid duplicating
 * `app/scheduler/page.tsx` (master-detail workbench),
 * `components/scheduler/scheduler-dashboard-view.tsx` (KPI / chart / strips),
 * `app/scheduler/scheduler-content-header.tsx` (cleanup / import / export menu),
 * `components/settings/data/tabs/backup-restore-tab.tsx` (backup cron list),
 * `components/settings/sections/plugins-section.tsx` (plugin scheduled jobs UI),
 * or `components/settings/webhooks/webhooks-section.tsx`
 * (the webhook signing-secret editor — we cross-link to it instead).
 */

import { useState } from "react"
import Link from "next/link"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import {
  ClockIcon,
  ExternalLinkIcon,
  ActivityIcon,
  CalendarClockIcon,
  Bell,
  ShieldCheck,
  ShieldAlert,
  ServerIcon,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Loader2,
} from "lucide-react"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Input } from "@/components/ui/input"
import { Checkbox } from "@/components/ui/checkbox"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { SettingsAlert } from "@/components/settings/common/settings-section"
import { TimezoneSelect } from "@/components/scheduler/timezone-select"
import { isTauri } from "@/lib/tauri"
import { useSchedulerStore } from "@/stores/scheduler/scheduler-store"
import { useSettingsStore } from "@/stores/settings"
import { useSystemScheduler } from "@/hooks/scheduler/use-system-scheduler"
import { useWebhookSigningState } from "@/lib/scheduler/webhook-outbound-config"
import { testNotificationChannel } from "@/lib/scheduler/notification-integration"
import {
  type NotificationChannel,
  type ScheduledTaskType,
  type TaskDefaults,
  DEFAULT_EXECUTION_CONFIG,
  DEFAULT_NOTIFICATION_CONFIG,
} from "@/types/scheduler"
import { loggers } from "@cognia/logging"

// Aligned with the executors actually shipped in cognia-next
// (`lib/scheduler/executors/`). `twin` (enqueues only), `workflow`, and `sync`
// remain excluded — they are typed but have no runtime today.
const SUPPORTED_TASK_TYPES: ScheduledTaskType[] = [
  "chat",
  "agent",
  "skill",
  "external-agent",
  "script",
  "backup",
  "custom",
  "plugin",
]

// Every channel `lib/scheduler/notification-integration.ts` can actually
// deliver on. `im` used to be missing here while the per-task form, the
// channel test, and the delivery path all supported it — so the ONE surface
// that sets the default for new tasks was the only one that could not pick it.
const NOTIFICATION_CHANNELS: NotificationChannel[] = ["desktop", "toast", "im", "webhook"]

export function ScheduledTasksSection() {
  const t = useTranslations("scheduler")
  const tTypes = useTranslations("scheduler.taskTypes")
  const tSettings = useTranslations("scheduler.settings")
  const tStatus = useTranslations("scheduler.settings.status")
  const tDefaults = useTranslations("scheduler.settings.defaults")
  const tSystem = useTranslations("scheduler.settings.system")
  const tSigning = useTranslations("scheduler.settings.signing")

  const policy = useSchedulerStore((s) => s.permissionPolicy)
  const updatePolicy = useSchedulerStore((s) => s.updatePermissionPolicy)
  const autoRefreshInterval = useSchedulerStore((s) => s.autoRefreshInterval)
  const setAutoRefreshInterval = useSchedulerStore((s) => s.setAutoRefreshInterval)
  // In-flight text for the auto-refresh box; `null` means "show the store's
  // number". See the input below for why the raw string has to exist.
  const [rawAutoRefresh, setRawAutoRefresh] = useState<string | null>(null)
  const schedulerStatus = useSchedulerStore((s) => s.schedulerStatus)
  const isInitialized = useSchedulerStore((s) => s.isInitialized)
  const tasks = useSchedulerStore((s) => s.tasks)

  const handleConfirmationToggle = (type: ScheduledTaskType, checked: boolean) => {
    const current = policy.confirmationRequired
    const updated = checked ? [...current, type] : current.filter((x) => x !== type)
    loggers.scheduler.info("settings.confirmationRequiredChanged", { type, required: checked })
    updatePolicy({ confirmationRequired: updated })
  }

  const activeCount = tasks.filter((task) => task.status === "active").length
  const totalCount = tasks.length

  return (
    <div className="space-y-6">
      {/* Stacks below `sm`: the actions keep their intrinsic width there and
          would squeeze the description into a narrow column. */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
        <div className="min-w-0">
          <h3 className="text-lg font-medium flex items-center gap-2">
            <ClockIcon className="h-5 w-5" />
            {t("permissions.title")}
          </h3>
          <p className="text-sm text-muted-foreground">{t("permissions.description")}</p>
        </div>
        <Button asChild variant="outline" size="sm" className="shrink-0 self-start">
          <Link href="/scheduler">
            {t("openScheduler")}
            <ExternalLinkIcon className="ml-1.5 h-3.5 w-3.5" />
          </Link>
        </Button>
      </div>

      <RuntimeStatusCard
        schedulerStatus={schedulerStatus}
        isInitialized={isInitialized}
        activeCount={activeCount}
        totalCount={totalCount}
        tStatus={tStatus}
      />

      <DefaultsCard
        defaults={policy.taskDefaults}
        onChange={(taskDefaults) => updatePolicy({ taskDefaults })}
        tDefaults={tDefaults}
      />

      <SystemSchedulerCard tSystem={tSystem} tSettings={tSettings} />

      <WebhookSigningCard tSigning={tSigning} tSettings={tSettings} />

      {/* Agent Auto-Create */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium">{t("permissions.agentAutoCreate")}</CardTitle>
          <CardDescription>{t("permissions.agentAutoCreateDesc")}</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between">
            <Label htmlFor="agent-auto-create">{t("permissions.allowAgentAutoCreate")}</Label>
            <Switch
              id="agent-auto-create"
              checked={policy.agentAutoCreate}
              onCheckedChange={(checked) => {
                loggers.scheduler.info("settings.agentAutoCreateChanged", { enabled: checked })
                updatePolicy({ agentAutoCreate: checked })
              }}
            />
          </div>
        </CardContent>
      </Card>

      {/* Script Tasks */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium">{t("permissions.scriptTasks")}</CardTitle>
          <CardDescription>{t("permissions.scriptTasksDesc")}</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between">
            <Label htmlFor="script-tasks-enabled">{t("permissions.enableScriptTasks")}</Label>
            <Switch
              id="script-tasks-enabled"
              checked={policy.scriptTasksEnabled}
              onCheckedChange={(checked) => {
                loggers.scheduler.info("settings.scriptTasksEnabledChanged", { enabled: checked })
                updatePolicy({ scriptTasksEnabled: checked })
              }}
            />
          </div>
        </CardContent>
      </Card>

      {/* Confirmation Required Types */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium">
            {t("permissions.confirmationRequired")}
          </CardTitle>
          <CardDescription>{t("permissions.confirmationRequiredDesc")}</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {SUPPORTED_TASK_TYPES.map((type) => (
              <div key={type} className="flex items-center gap-2">
                <Checkbox
                  id={`confirm-${type}`}
                  checked={policy.confirmationRequired.includes(type)}
                  onCheckedChange={(checked) => handleConfirmationToggle(type, checked === true)}
                />
                <Label htmlFor={`confirm-${type}`} className="text-sm font-normal">
                  {tTypes(type as ScheduledTaskType)}
                </Label>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Limits */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium">{t("permissions.limits")}</CardTitle>
          <CardDescription>{t("permissions.limitsDesc")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between gap-4">
            <Label htmlFor="max-tasks-per-source" className="flex-1">
              {t("permissions.maxTasksPerSource")}
            </Label>
            <Input
              id="max-tasks-per-source"
              type="number"
              min={1}
              max={500}
              className="w-24"
              value={policy.maxTasksPerSource}
              onChange={(e) => {
                const next = Math.max(1, parseInt(e.target.value) || 50)
                loggers.scheduler.info("settings.maxTasksPerSourceChanged", { value: next })
                updatePolicy({ maxTasksPerSource: next })
              }}
            />
          </div>
          <div className="flex items-center justify-between gap-4">
            <Label htmlFor="max-concurrent" className="flex-1">
              {t("permissions.maxConcurrentExecutions")}
            </Label>
            <Input
              id="max-concurrent"
              type="number"
              min={1}
              max={20}
              className="w-24"
              value={policy.maxConcurrentExecutions}
              onChange={(e) => {
                const next = Math.max(1, parseInt(e.target.value) || 5)
                loggers.scheduler.info("settings.maxConcurrentChanged", { value: next })
                updatePolicy({ maxConcurrentExecutions: next })
              }}
            />
          </div>
          {/* The scheduler page re-reads its slices on this cadence
              (`hooks/scheduler/use-scheduler.ts`). The value has been persisted
              since the store shipped and nothing could change it. */}
          <div className="flex items-center justify-between gap-4">
            <div className="flex-1">
              <Label htmlFor="auto-refresh-interval">{t("permissions.autoRefreshInterval")}</Label>
              <p className="text-xs text-muted-foreground">
                {t("permissions.autoRefreshIntervalDesc")}
              </p>
            </div>
            <Input
              id="auto-refresh-interval"
              data-testid="scheduler-auto-refresh-interval"
              type="number"
              min={0}
              max={3600}
              className="w-24"
              // `rawAutoRefresh` is what makes clearing the box possible. The
              // store holds a number, so a purely controlled input cannot say
              // "emptied, about to be retyped" — and committing that as
              // `parseInt("") === NaN → 0` is not a small interval, it is the
              // value that turns the poll OFF. Backspacing 30 to type 60 did
              // exactly that. Show the raw text, commit nothing until it parses,
              // and snap back to the committed number on blur.
              value={rawAutoRefresh ?? String(autoRefreshInterval)}
              onChange={(e) => {
                const next = e.target.value
                setRawAutoRefresh(next)
                if (next.trim() === "") return
                const parsed = Number(next)
                if (!Number.isFinite(parsed)) return
                loggers.scheduler.info("settings.autoRefreshIntervalChanged", { value: parsed })
                setAutoRefreshInterval(parsed)
              }}
              onBlur={() => setRawAutoRefresh(null)}
            />
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Card 1 — Status & runtime
// ---------------------------------------------------------------------------

interface RuntimeStatusCardProps {
  schedulerStatus: "idle" | "running" | "stopped"
  isInitialized: boolean
  activeCount: number
  totalCount: number
  tStatus: ReturnType<typeof useTranslations>
}

function RuntimeStatusCard({
  schedulerStatus,
  isInitialized,
  activeCount,
  totalCount,
  tStatus,
}: RuntimeStatusCardProps) {
  const statusLabel = !isInitialized
    ? tStatus("uninitialized")
    : schedulerStatus === "running"
      ? tStatus("running")
      : schedulerStatus === "stopped"
        ? tStatus("stopped")
        : tStatus("idle")

  const statusVariant: "default" | "secondary" | "outline" | "destructive" = !isInitialized
    ? "outline"
    : schedulerStatus === "running"
      ? "default"
      : schedulerStatus === "stopped"
        ? "destructive"
        : "secondary"

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <ActivityIcon className="h-4 w-4" />
          {tStatus("title")}
        </CardTitle>
        <CardDescription>{tStatus("description")}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex flex-wrap items-center gap-3">
          <Badge variant={statusVariant} className="gap-1" data-testid="scheduler-runtime-status">
            <span
              className={
                schedulerStatus === "running" && isInitialized
                  ? "h-2 w-2 rounded-full bg-current animate-pulse"
                  : "h-2 w-2 rounded-full bg-current"
              }
              aria-hidden="true"
            />
            {statusLabel}
          </Badge>
          <Badge variant="outline" data-testid="scheduler-runtime-counts">
            {tStatus("activeTotal", { active: activeCount, total: totalCount })}
          </Badge>
        </div>
      </CardContent>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Card 2 — Defaults for new tasks
// ---------------------------------------------------------------------------

interface DefaultsCardProps {
  defaults: TaskDefaults | undefined
  onChange: (next: TaskDefaults | undefined) => void
  tDefaults: ReturnType<typeof useTranslations>
}

function DefaultsCard({ defaults, onChange, tDefaults }: DefaultsCardProps) {
  const ndef = defaults?.notification ?? {}
  const edef = defaults?.execution ?? {}

  const tNotification = useTranslations("scheduler.settings.defaults.notification")
  const tTrigger = useTranslations("scheduler.settings.defaults.trigger")
  const tExecution = useTranslations("scheduler.settings.defaults.execution")

  const [testingChannel, setTestingChannel] = useState<NotificationChannel | null>(null)
  const isWebMode = !isTauri()

  // Layer 2 of the `im` channel — the ops chat a task notification falls back
  // to when the task names no `imTarget`. It lives on AppSettings rather than
  // on the scheduler's own defaults because it is a single app-wide address,
  // and `resolveFallbackConversationKey()` reads it straight from there.
  //
  // Nothing wrote it before this field existed, so the fallback resolved to
  // undefined every time and the `im` test button reported "no global ops
  // channel is set" with no place in the app to set one.
  const appSettings = useSettingsStore((s) => s.settings)
  const saveAppSettings = useSettingsStore((s) => s.save)
  const opsChannel = appSettings?.schedulerNotifications?.fallbackConversationKey ?? ""
  const setOpsChannel = (next: string) => {
    const trimmed = next.trim()
    void saveAppSettings({
      schedulerNotifications: {
        ...appSettings?.schedulerNotifications,
        fallbackConversationKey: trimmed || undefined,
      },
    })
  }

  const channels: NotificationChannel[] =
    ndef.channels && ndef.channels.length > 0
      ? ndef.channels
      : (DEFAULT_NOTIFICATION_CONFIG.channels ?? ["toast"])

  const setNotification = (patch: NonNullable<TaskDefaults["notification"]>) => {
    const merged = { ...ndef, ...patch }
    onChange({ ...defaults, notification: merged })
    loggers.scheduler.info("settings.defaultsNotificationChanged", { fields: Object.keys(patch) })
  }
  const setExecution = (patch: NonNullable<TaskDefaults["execution"]>) => {
    const merged = { ...edef, ...patch }
    onChange({ ...defaults, execution: merged })
    loggers.scheduler.info("settings.defaultsExecutionChanged", { fields: Object.keys(patch) })
  }
  const setTimezone = (timezone: string) => {
    onChange({ ...defaults, timezone: timezone || undefined })
    loggers.scheduler.info("settings.defaultsTimezoneChanged", { timezone })
  }

  const toggleChannel = (channel: NotificationChannel, checked: boolean) => {
    const next = checked
      ? Array.from(new Set([...channels, channel]))
      : channels.filter((c) => c !== channel)
    setNotification({ channels: next })
  }

  const handleTest = async (channel: NotificationChannel) => {
    setTestingChannel(channel)
    try {
      // Pass the ops channel explicitly so the test reflects what is in the
      // box right now rather than racing the settings write.
      const result = await testNotificationChannel(
        channel,
        ndef.webhookUrl,
        opsChannel || undefined
      )
      const channelLabel = tNotification(
        `channel${channel.charAt(0).toUpperCase() + channel.slice(1)}`
      )
      if (result.success) {
        toast.success(tNotification("testSuccess", { channel: channelLabel }))
      } else {
        toast.error(
          tNotification("testFailure", { channel: channelLabel, error: result.error || "" })
        )
      }
    } catch (err) {
      const channelLabel = tNotification(
        `channel${channel.charAt(0).toUpperCase() + channel.slice(1)}`
      )
      toast.error(
        tNotification("testFailure", {
          channel: channelLabel,
          error: err instanceof Error ? err.message : String(err),
        })
      )
    } finally {
      setTestingChannel(null)
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <CalendarClockIcon className="h-4 w-4" />
          {tDefaults("title")}
        </CardTitle>
        <CardDescription>{tDefaults("description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* Trigger defaults */}
        <section className="space-y-2">
          <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            {tTrigger("title")}
          </h4>
          <div className="space-y-1">
            <Label htmlFor="default-timezone">{tTrigger("timezone")}</Label>
            <TimezoneSelect
              value={defaults?.timezone || "UTC"}
              onValueChange={setTimezone}
              testId="default-timezone"
              includeOffset
            />
            <p className="text-xs text-muted-foreground">{tTrigger("timezoneHelp")}</p>
          </div>
        </section>

        <Separator />

        {/* Notification defaults */}
        <section className="space-y-3">
          <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
            <Bell className="h-3.5 w-3.5" />
            {tNotification("title")}
          </h4>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <label htmlFor="notify-on-start" className="flex items-center gap-2 text-sm">
              <Checkbox
                id="notify-on-start"
                checked={ndef.onStart ?? false}
                onCheckedChange={(c) => setNotification({ onStart: c === true })}
              />
              <span>{tNotification("onStart")}</span>
            </label>
            <label htmlFor="notify-on-complete" className="flex items-center gap-2 text-sm">
              <Checkbox
                id="notify-on-complete"
                checked={ndef.onComplete ?? true}
                onCheckedChange={(c) => setNotification({ onComplete: c === true })}
              />
              <span>{tNotification("onComplete")}</span>
            </label>
            <label htmlFor="notify-on-error" className="flex items-center gap-2 text-sm">
              <Checkbox
                id="notify-on-error"
                checked={ndef.onError ?? true}
                onCheckedChange={(c) => setNotification({ onError: c === true })}
              />
              <span>{tNotification("onError")}</span>
            </label>
          </div>

          <div className="space-y-2">
            <Label className="text-sm">{tNotification("channels")}</Label>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              {NOTIFICATION_CHANNELS.map((channel) => {
                const isChecked = channels.includes(channel)
                const channelLabel = tNotification(
                  `channel${channel.charAt(0).toUpperCase() + channel.slice(1)}`
                )
                return (
                  <div
                    key={channel}
                    className="flex items-center justify-between gap-2 rounded-md border bg-muted/30 px-2 py-1.5"
                  >
                    <label
                      htmlFor={`channel-${channel}`}
                      className="flex items-center gap-2 text-sm font-normal"
                    >
                      <Checkbox
                        id={`channel-${channel}`}
                        checked={isChecked}
                        onCheckedChange={(c) => toggleChannel(channel, c === true)}
                      />
                      <span>{channelLabel}</span>
                    </label>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2"
                      data-testid={`test-channel-${channel}`}
                      disabled={
                        !isChecked ||
                        testingChannel === channel ||
                        (channel === "webhook" && !ndef.webhookUrl) ||
                        // An `im` test with no ops channel can only ever report
                        // "no global ops channel is set" — say that with the
                        // control's state instead of with a failed test.
                        (channel === "im" && !opsChannel)
                      }
                      onClick={() => void handleTest(channel)}
                    >
                      {testingChannel === channel ? (
                        <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
                      ) : (
                        tNotification("testCta", { channel: channelLabel })
                      )}
                    </Button>
                  </div>
                )
              })}
            </div>
            {channels.includes("desktop") && isWebMode && (
              <p className="text-xs text-muted-foreground">{tNotification("desktopOnlyHint")}</p>
            )}
          </div>

          <div className="space-y-1">
            <Label htmlFor="default-ops-channel">{tNotification("opsChannel")}</Label>
            <Input
              id="default-ops-channel"
              value={opsChannel}
              onChange={(e) => setOpsChannel(e.target.value)}
              placeholder={tNotification("opsChannelPlaceholder")}
              data-testid="default-ops-channel"
            />
            <p className="text-xs text-pretty text-muted-foreground">
              {tNotification("opsChannelHint")}
            </p>
          </div>

          <div className="space-y-1">
            <Label htmlFor="default-webhook-url">{tNotification("webhookUrl")}</Label>
            <Input
              id="default-webhook-url"
              type="url"
              value={ndef.webhookUrl ?? ""}
              onChange={(e) => setNotification({ webhookUrl: e.target.value || undefined })}
              placeholder={tNotification("webhookUrlPlaceholder")}
              disabled={!channels.includes("webhook")}
            />
          </div>
        </section>

        <Separator />

        {/* Execution defaults */}
        <section className="space-y-3">
          <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            {tExecution("title")}
          </h4>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <div className="space-y-1">
              <Label htmlFor="default-timeout" className="text-xs">
                {tExecution("timeout")}
              </Label>
              <Input
                id="default-timeout"
                type="number"
                min={1}
                value={msToSeconds(edef.timeout ?? DEFAULT_EXECUTION_CONFIG.timeout)}
                onChange={(e) => {
                  const seconds = Math.max(1, parseInt(e.target.value) || 1)
                  setExecution({ timeout: seconds * 1000 })
                }}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="default-max-retries" className="text-xs">
                {tExecution("maxRetries")}
              </Label>
              <Input
                id="default-max-retries"
                type="number"
                min={0}
                value={edef.maxRetries ?? DEFAULT_EXECUTION_CONFIG.maxRetries}
                onChange={(e) =>
                  setExecution({ maxRetries: Math.max(0, parseInt(e.target.value) || 0) })
                }
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="default-retry-delay" className="text-xs">
                {tExecution("retryDelay")}
              </Label>
              <Input
                id="default-retry-delay"
                type="number"
                min={0}
                value={edef.retryDelay ?? DEFAULT_EXECUTION_CONFIG.retryDelay}
                onChange={(e) =>
                  setExecution({ retryDelay: Math.max(0, parseInt(e.target.value) || 0) })
                }
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="default-max-missed" className="text-xs">
                {tExecution("maxMissed")}
              </Label>
              <Input
                id="default-max-missed"
                type="number"
                min={0}
                value={edef.maxMissedRuns ?? DEFAULT_EXECUTION_CONFIG.maxMissedRuns ?? 1}
                onChange={(e) =>
                  setExecution({ maxMissedRuns: Math.max(0, parseInt(e.target.value) || 0) })
                }
              />
            </div>
          </div>
          <div className="flex items-center justify-between gap-4">
            <Label htmlFor="default-run-missed" className="flex-1 text-sm">
              {tExecution("runMissed")}
            </Label>
            <Switch
              id="default-run-missed"
              checked={edef.runMissedOnStartup ?? DEFAULT_EXECUTION_CONFIG.runMissedOnStartup}
              onCheckedChange={(checked) => setExecution({ runMissedOnStartup: checked })}
            />
          </div>
          <div className="flex items-center justify-between gap-4">
            <Label htmlFor="default-allow-concurrent" className="flex-1 text-sm">
              {tExecution("allowConcurrent")}
            </Label>
            <Switch
              id="default-allow-concurrent"
              checked={edef.allowConcurrent ?? DEFAULT_EXECUTION_CONFIG.allowConcurrent}
              onCheckedChange={(checked) => setExecution({ allowConcurrent: checked })}
            />
          </div>
        </section>
      </CardContent>
    </Card>
  )
}

function msToSeconds(ms: number): number {
  return Math.max(1, Math.round(ms / 1000))
}

// ---------------------------------------------------------------------------
// Card 3 — System scheduler health (desktop-only body)
// ---------------------------------------------------------------------------

interface SystemSchedulerCardProps {
  tSystem: ReturnType<typeof useTranslations>
  tSettings: ReturnType<typeof useTranslations>
}

function SystemSchedulerCard({ tSystem }: SystemSchedulerCardProps) {
  const desktopAvailable = isTauri()

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <ServerIcon className="h-4 w-4" />
          {tSystem("title")}
        </CardTitle>
        <CardDescription>{tSystem("description")}</CardDescription>
      </CardHeader>
      <CardContent>
        {desktopAvailable ? (
          <SystemSchedulerCardBody tSystem={tSystem} />
        ) : (
          <SettingsAlert icon={<AlertTriangle className="h-4 w-4" />}>
            {tSystem("unavailableOnWeb")}
          </SettingsAlert>
        )}
      </CardContent>
    </Card>
  )
}

function SystemSchedulerCardBody({ tSystem }: { tSystem: ReturnType<typeof useTranslations> }) {
  const { capabilities, isAvailable, isElevated, pendingConfirmations, tasks, requestElevation } =
    useSystemScheduler()

  const [requesting, setRequesting] = useState(false)

  const backendLabel = capabilities?.backend ?? capabilities?.os ?? ""

  const handleRequestElevation = async () => {
    setRequesting(true)
    try {
      const granted = await requestElevation()
      if (granted) {
        toast.success(tSystem("elevationGranted"))
      } else {
        toast.error(tSystem("elevationDenied"))
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setRequesting(false)
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge
          variant={isAvailable ? "default" : "destructive"}
          className="gap-1"
          data-testid="system-backend-availability"
        >
          {isAvailable ? (
            <CheckCircle2 className="h-3 w-3" aria-hidden="true" />
          ) : (
            <XCircle className="h-3 w-3" aria-hidden="true" />
          )}
          {isAvailable ? tSystem("backendAvailable") : tSystem("backendUnavailable")}
        </Badge>
        {backendLabel && (
          <Badge variant="outline" className="font-mono text-[11px]">
            {backendLabel}
          </Badge>
        )}
        <Badge
          variant={isElevated ? "default" : "secondary"}
          className="gap-1"
          data-testid="system-elevation-state"
        >
          {isElevated ? tSystem("elevated") : tSystem("notElevated")}
        </Badge>
        {!isElevated && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={requesting || !isAvailable}
            onClick={() => void handleRequestElevation()}
            data-testid="system-request-elevation"
          >
            {requesting ? (
              <Loader2 className="mr-1.5 h-3 w-3 animate-spin" aria-hidden="true" />
            ) : null}
            {tSystem("requestElevation")}
          </Button>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-3 text-sm">
        <span className="text-muted-foreground" data-testid="system-pending-count">
          {tSystem("pendingCount", { count: pendingConfirmations.length })}
        </span>
        {pendingConfirmations.length > 0 && (
          <Button asChild variant="link" size="sm" className="h-auto p-0">
            <Link href="/scheduler">{tSystem("openPending")}</Link>
          </Button>
        )}
        <span className="text-muted-foreground" data-testid="system-native-count">
          {tSystem("nativeTasksCount", { count: tasks.length })}
        </span>
      </div>

      <Button asChild variant="outline" size="sm" className="w-fit">
        <Link href="/scheduler">
          {tSystem("manageCta")}
          <ExternalLinkIcon className="ml-1.5 h-3.5 w-3.5" />
        </Link>
      </Button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Card 4 — Webhook signing
// ---------------------------------------------------------------------------

interface WebhookSigningCardProps {
  tSigning: ReturnType<typeof useTranslations>
  tSettings: ReturnType<typeof useTranslations>
}

function WebhookSigningCard({ tSigning }: WebhookSigningCardProps) {
  const desktopAvailable = isTauri()
  const { enabled, loading } = useWebhookSigningState()

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <ShieldCheck className="h-4 w-4" />
          {tSigning("title")}
        </CardTitle>
        <CardDescription>{tSigning("description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {!desktopAvailable ? (
          <SettingsAlert icon={<AlertTriangle className="h-4 w-4" />}>
            {tSigning("webOnly")}
          </SettingsAlert>
        ) : loading ? (
          <SettingsAlert icon={<Loader2 className="h-4 w-4 animate-spin" />}>
            {tSigning("loading")}
          </SettingsAlert>
        ) : enabled ? (
          <SettingsAlert
            icon={<ShieldCheck className="h-4 w-4 text-emerald-500" />}
            className="border-emerald-500/50"
          >
            <span data-testid="signing-state-enabled">{tSigning("enabled")}</span>
          </SettingsAlert>
        ) : (
          <SettingsAlert icon={<ShieldAlert className="h-4 w-4" />} variant="default">
            <span data-testid="signing-state-disabled">{tSigning("disabled")}</span>
          </SettingsAlert>
        )}

        <Button asChild variant="outline" size="sm" className="w-fit">
          <Link href="/settings?section=webhooks">
            {tSigning("manageSecret")}
            <ExternalLinkIcon className="ml-1.5 h-3.5 w-3.5" />
          </Link>
        </Button>
      </CardContent>
    </Card>
  )
}
