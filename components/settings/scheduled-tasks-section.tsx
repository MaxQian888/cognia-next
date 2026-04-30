"use client"

/**
 * Scheduled Tasks settings section.
 *
 * Adapted from Cognia's `components/settings/scheduler/scheduler-permission-settings.tsx`.
 * The confirmation-required task-type list is filtered down to the executors
 * cognia-next actually ships (chat / agent / skill / script / custom / plugin)
 * — Cognia surfaced workflow / sync / backup / im-push too, but those have no
 * runtime here.
 */

import Link from "next/link"
import { useTranslations } from "next-intl"
import { ClockIcon, ExternalLinkIcon } from "lucide-react"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Input } from "@/components/ui/input"
import { Checkbox } from "@/components/ui/checkbox"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { useSchedulerStore } from "@/stores/scheduler/scheduler-store"
import type { ScheduledTaskType } from "@/types/scheduler"
import { loggers } from "@/lib/logger"

const SUPPORTED_TASK_TYPES: ScheduledTaskType[] = [
  "chat",
  "agent",
  "skill",
  "script",
  "custom",
  "plugin",
]

export function ScheduledTasksSection() {
  const t = useTranslations("scheduler")
  const tTypes = useTranslations("scheduler.taskTypes")
  const policy = useSchedulerStore((s) => s.permissionPolicy)
  const updatePolicy = useSchedulerStore((s) => s.updatePermissionPolicy)

  const handleConfirmationToggle = (type: ScheduledTaskType, checked: boolean) => {
    const current = policy.confirmationRequired
    const updated = checked ? [...current, type] : current.filter((x) => x !== type)
    loggers.scheduler.info("settings.confirmationRequiredChanged", { type, required: checked })
    updatePolicy({ confirmationRequired: updated })
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-lg font-medium flex items-center gap-2">
            <ClockIcon className="h-5 w-5" />
            {t("permissions.title")}
          </h3>
          <p className="text-sm text-muted-foreground">{t("permissions.description")}</p>
        </div>
        <Button asChild variant="outline" size="sm">
          <Link href="/scheduler">
            {t("openScheduler")}
            <ExternalLinkIcon className="ml-1.5 h-3.5 w-3.5" />
          </Link>
        </Button>
      </div>

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
          <div className="grid grid-cols-2 gap-3">
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
        </CardContent>
      </Card>
    </div>
  )
}
