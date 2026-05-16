"use client"

/**
 * SystemTaskForm - Create or edit a system scheduled task
 */

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { TimezoneSelect } from "@/components/scheduler/timezone-select"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { ScriptTaskEditor } from "@/components/scheduler/script-task-editor"
import type {
  CreateSystemTaskInput,
  ExecuteScriptAction,
  LaunchAppAction,
  RunCommandAction,
  RunLevel,
  SchedulerCapabilities,
  SystemTaskAction,
  SystemTaskTrigger,
  ValidationResult,
} from "@/types/scheduler"
import { DEFAULT_SCRIPT_SETTINGS } from "@/types/scheduler"

interface SystemTaskFormProps {
  initialValues?: Partial<CreateSystemTaskInput>
  capabilities?: SchedulerCapabilities | null
  onSubmit: (input: CreateSystemTaskInput) => Promise<void>
  onCancel: () => void
  onValidate?: (input: CreateSystemTaskInput) => Promise<ValidationResult>
  isSubmitting?: boolean
}

type SystemTriggerType = SystemTaskTrigger["type"]
type SystemActionType = SystemTaskAction["type"]

const defaultScriptAction: ExecuteScriptAction = {
  type: "execute_script",
  language: "python",
  code: "",
  timeout_secs: DEFAULT_SCRIPT_SETTINGS.timeout_secs,
  memory_mb: DEFAULT_SCRIPT_SETTINGS.memory_mb,
  use_sandbox: DEFAULT_SCRIPT_SETTINGS.use_sandbox,
}

interface SystemFormState {
  name: string
  description: string
  runLevel: RunLevel
  triggerType: SystemTriggerType
  actionType: SystemActionType
  cronExpression: string
  cronTimezone: string
  intervalSeconds: number
  runAtDate: string
  runAtTime: string
  bootDelaySeconds: number
  logonUser: string
  eventSource: string
  eventId: number
  scriptAction: ExecuteScriptAction
  command: string
  commandArgs: string
  commandWorkingDir: string
  appPath: string
  appArgs: string
}

function systemFormReducer(
  state: SystemFormState,
  update: Partial<SystemFormState>
): SystemFormState {
  return { ...state, ...update }
}

function createSystemInitialState(
  iv?: Partial<CreateSystemTaskInput>,
  capabilities?: SchedulerCapabilities | null
): SystemFormState {
  const cronTrigger = iv?.trigger?.type === "cron" ? iv.trigger : null
  const intervalTrigger = iv?.trigger?.type === "interval" ? iv.trigger : null
  const bootTrigger = iv?.trigger?.type === "on_boot" ? iv.trigger : null
  const logonTrigger = iv?.trigger?.type === "on_logon" ? iv.trigger : null
  const eventTrigger = iv?.trigger?.type === "on_event" ? iv.trigger : null
  const initialActionType = iv?.action?.type || "execute_script"
  const supportedTriggers = capabilities?.supported_triggers ?? []
  const initialTriggerType = iv?.trigger?.type || "cron"
  const normalizedTriggerType =
    supportedTriggers.length === 0 || supportedTriggers.includes(initialTriggerType)
      ? initialTriggerType
      : (supportedTriggers[0] as SystemTriggerType)

  let initialRunAtDate = ""
  let initialRunAtTime = ""
  if (iv?.trigger?.type === "once") {
    const date = new Date(iv.trigger.run_at)
    if (!Number.isNaN(date.getTime())) {
      initialRunAtDate = date.toISOString().split("T")[0]
      initialRunAtTime = date.toISOString().split("T")[1]?.slice(0, 5) || ""
    }
  }

  return {
    name: iv?.name || "",
    description: iv?.description || "",
    runLevel: iv?.run_level || "user",
    triggerType: normalizedTriggerType,
    actionType: initialActionType,
    cronExpression: cronTrigger?.expression || "0 9 * * *",
    cronTimezone: cronTrigger?.timezone || "UTC",
    intervalSeconds: intervalTrigger?.seconds || 3600,
    runAtDate: initialRunAtDate,
    runAtTime: initialRunAtTime,
    bootDelaySeconds: bootTrigger?.delay_seconds || 0,
    logonUser: logonTrigger?.user || "",
    eventSource: eventTrigger?.source || "",
    eventId: eventTrigger?.event_id || 0,
    scriptAction:
      initialActionType === "execute_script"
        ? { ...defaultScriptAction, ...(iv?.action as ExecuteScriptAction) }
        : defaultScriptAction,
    command:
      initialActionType === "run_command" ? (iv?.action as RunCommandAction).command || "" : "",
    commandArgs:
      initialActionType === "run_command"
        ? ((iv?.action as RunCommandAction).args || []).join(" ")
        : "",
    commandWorkingDir:
      initialActionType === "run_command" ? (iv?.action as RunCommandAction).working_dir || "" : "",
    appPath: initialActionType === "launch_app" ? (iv?.action as LaunchAppAction).path || "" : "",
    appArgs:
      initialActionType === "launch_app"
        ? ((iv?.action as LaunchAppAction).args || []).join(" ")
        : "",
  }
}

export function SystemTaskForm({
  initialValues,
  capabilities,
  onSubmit,
  onCancel,
  onValidate,
  isSubmitting,
}: SystemTaskFormProps) {
  const t = useTranslations("scheduler")
  const [f, updateForm] = useReducer(systemFormReducer, { initialValues, capabilities }, (value) =>
    createSystemInitialState(value.initialValues, value.capabilities)
  )
  const workflowManagedScript = useMemo(
    () =>
      initialValues?.action?.type === "execute_script" &&
      (initialValues.action as ExecuteScriptAction).language === "workflow",
    [initialValues]
  )
  const triggerCapabilities = useMemo(
    () => capabilities?.trigger_capabilities ?? [],
    [capabilities]
  )
  const supportedTriggerTypes = useMemo(
    () =>
      triggerCapabilities.length > 0
        ? triggerCapabilities.filter((tc) => tc.available).map((tc) => tc.trigger_type)
        : (capabilities?.supported_triggers ?? []),
    [triggerCapabilities, capabilities]
  )
  const initialTriggerCapability = useMemo(
    () =>
      triggerCapabilities.find(
        (capability) => capability.trigger_type === initialValues?.trigger?.type
      ),
    [triggerCapabilities, initialValues]
  )
  const currentTriggerCapability = useMemo(
    () => triggerCapabilities.find((tc) => tc.trigger_type === f.triggerType),
    [triggerCapabilities, f.triggerType]
  )
  const initialTriggerWasUnsupported =
    !!initialValues?.trigger?.type &&
    supportedTriggerTypes.length > 0 &&
    !supportedTriggerTypes.includes(initialValues.trigger.type)

  const triggerTypeOptions = useMemo(
    () =>
      [
        { value: "cron", label: t("systemCronExpression") || "Cron Expression" },
        { value: "interval", label: t("intervalSeconds") || "Interval (seconds)" },
        { value: "once", label: t("systemRunAt") || "Run At" },
        { value: "on_boot", label: t("triggerOnBoot") || "On Boot" },
        { value: "on_logon", label: t("triggerOnLogon") || "On Logon" },
        { value: "on_event", label: t("triggerOnEvent") || "On Event" },
      ].filter(
        (option) =>
          supportedTriggerTypes.length === 0 || supportedTriggerTypes.includes(option.value)
      ),
    [t, supportedTriggerTypes]
  )

  // Debounced backend validation
  const [validationResult, setValidationResult] = useState<ValidationResult | null>(null)
  const validationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const actionTypeOptions = useMemo(
    () => [
      { value: "execute_script", label: t("actionScript") || "Script" },
      { value: "run_command", label: t("actionCommand") || "Command" },
      { value: "launch_app", label: t("actionApp") || "App" },
    ],
    [t]
  )

  const buildTrigger = useCallback((): SystemTaskTrigger | null => {
    switch (f.triggerType) {
      case "cron":
        if (!f.cronExpression.trim()) return null
        return {
          type: "cron",
          expression: f.cronExpression.trim(),
          timezone: f.cronTimezone || undefined,
        }
      case "interval":
        if (f.intervalSeconds <= 0) return null
        return { type: "interval", seconds: f.intervalSeconds }
      case "once":
        if (!f.runAtDate || !f.runAtTime) return null
        return { type: "once", run_at: new Date(`${f.runAtDate}T${f.runAtTime}`).toISOString() }
      case "on_boot":
        return { type: "on_boot", delay_seconds: f.bootDelaySeconds || 0 }
      case "on_logon":
        return { type: "on_logon", user: f.logonUser.trim() || undefined }
      case "on_event":
        if (!f.eventSource.trim() || !f.eventId) return null
        return { type: "on_event", source: f.eventSource.trim(), event_id: f.eventId }
      default:
        return null
    }
  }, [f])

  const buildAction = useCallback((): SystemTaskAction | null => {
    switch (f.actionType) {
      case "execute_script":
        if (workflowManagedScript) {
          return {
            ...f.scriptAction,
            language: "workflow",
          }
        }
        if (!f.scriptAction.code.trim()) return null
        return f.scriptAction
      case "run_command":
        if (!f.command.trim()) return null
        return {
          type: "run_command",
          command: f.command.trim(),
          args: f.commandArgs.split(" ").filter(Boolean),
          working_dir: f.commandWorkingDir.trim() || undefined,
        }
      case "launch_app":
        if (!f.appPath.trim()) return null
        return {
          type: "launch_app",
          path: f.appPath.trim(),
          args: f.appArgs.split(" ").filter(Boolean),
        }
      default:
        return null
    }
  }, [f, workflowManagedScript])

  useEffect(() => {
    if (!onValidate) return
    if (validationTimerRef.current) clearTimeout(validationTimerRef.current)
    validationTimerRef.current = setTimeout(() => {
      const trigger = buildTrigger()
      const action = buildAction()
      if (!f.name.trim() || !trigger || !action) {
        setValidationResult(null)
        return
      }
      void onValidate({
        name: f.name.trim(),
        description: f.description.trim() || undefined,
        trigger,
        action,
        run_level: f.runLevel,
      })
        .then(setValidationResult)
        .catch(() => setValidationResult(null))
    }, 500)
    return () => {
      if (validationTimerRef.current) clearTimeout(validationTimerRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    f.triggerType,
    f.cronExpression,
    f.intervalSeconds,
    f.runAtDate,
    f.runAtTime,
    f.bootDelaySeconds,
    f.name,
    f.runLevel,
    f.actionType,
    buildTrigger,
    buildAction,
  ])

  const handleSubmit = useCallback(async () => {
    const trigger = buildTrigger()
    const action = buildAction()
    if (!f.name.trim() || !trigger || !action) return

    await onSubmit({
      name: f.name.trim(),
      description: f.description.trim() || undefined,
      trigger,
      action,
      run_level: f.runLevel,
    })
  }, [buildTrigger, buildAction, f.name, f.description, f.runLevel, onSubmit])

  const isSubmitDisabled = useMemo(() => {
    return isSubmitting || !f.name.trim() || buildTrigger() === null || buildAction() === null
  }, [isSubmitting, f.name, buildTrigger, buildAction])

  return (
    <div className="space-y-4">
      {initialTriggerWasUnsupported && initialTriggerCapability?.constraint_notes?.length ? (
        <Alert>
          <AlertTitle>{t("systemTriggerType") || "Trigger Type"}</AlertTitle>
          <AlertDescription>
            <div className="space-y-1">
              {initialTriggerCapability.constraint_notes.map((note) => (
                <p key={note}>{note}</p>
              ))}
            </div>
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="space-y-2">
        <Label>{t("systemTaskName") || "Task Name"}</Label>
        <Input
          value={f.name}
          onChange={(e) => updateForm({ name: e.target.value })}
          placeholder={t("taskNamePlaceholder") || "Enter task name"}
          disabled={isSubmitting}
        />
      </div>

      <div className="space-y-2">
        <Label>{t("systemTaskDescription") || "Task Description"}</Label>
        <Textarea
          value={f.description}
          onChange={(e) => updateForm({ description: e.target.value })}
          placeholder={t("descriptionPlaceholder") || "Describe what this task does"}
          rows={2}
          disabled={isSubmitting}
        />
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="space-y-2">
          <Label>{t("systemRunLevel") || "Run Level"}</Label>
          <Select
            value={f.runLevel}
            onValueChange={(value) => updateForm({ runLevel: value as RunLevel })}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="user">{t("runLevelUser") || "User"}</SelectItem>
              <SelectItem value="administrator">{t("runLevelAdmin") || "Administrator"}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label>{t("systemTriggerType") || "Trigger Type"}</Label>
          <Select
            value={f.triggerType}
            onValueChange={(value) => updateForm({ triggerType: value as SystemTriggerType })}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {triggerTypeOptions.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {currentTriggerCapability?.backend_notes?.length ? (
        <p className="text-xs text-muted-foreground -mt-2">
          {currentTriggerCapability.backend_notes[0]}
        </p>
      ) : null}

      {f.triggerType === "cron" && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="space-y-2">
            <Label>{t("systemCronExpression") || "Cron Expression"}</Label>
            <Input
              value={f.cronExpression}
              onChange={(e) => updateForm({ cronExpression: e.target.value })}
              placeholder="0 9 * * *"
              disabled={isSubmitting}
            />
          </div>
          <div className="space-y-2">
            <Label>{t("timezone") || "Timezone"}</Label>
            <TimezoneSelect
              value={f.cronTimezone}
              onValueChange={(value) => updateForm({ cronTimezone: value })}
              triggerClassName="h-10"
              disabled={isSubmitting}
            />
          </div>
        </div>
      )}

      {f.triggerType === "interval" && (
        <div className="space-y-2">
          <Label>{t("intervalSeconds") || "Interval (seconds)"}</Label>
          <Input
            type="number"
            min={1}
            value={f.intervalSeconds}
            onChange={(e) => updateForm({ intervalSeconds: parseInt(e.target.value) || 0 })}
            disabled={isSubmitting}
          />
        </div>
      )}

      {f.triggerType === "once" && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="space-y-2">
            <Label>{t("date") || "Date"}</Label>
            <Input
              type="date"
              value={f.runAtDate}
              onChange={(e) => updateForm({ runAtDate: e.target.value })}
              disabled={isSubmitting}
            />
          </div>
          <div className="space-y-2">
            <Label>{t("time") || "Time"}</Label>
            <Input
              type="time"
              value={f.runAtTime}
              onChange={(e) => updateForm({ runAtTime: e.target.value })}
              disabled={isSubmitting}
            />
          </div>
        </div>
      )}

      {f.triggerType === "on_boot" && (
        <div className="space-y-2">
          <Label>{t("onBootDelaySeconds") || "Boot Delay (seconds)"}</Label>
          <Input
            type="number"
            min={0}
            value={f.bootDelaySeconds}
            onChange={(e) => updateForm({ bootDelaySeconds: parseInt(e.target.value) || 0 })}
            disabled={isSubmitting}
          />
        </div>
      )}

      {f.triggerType === "on_logon" && (
        <div className="space-y-2">
          <Label>{t("onLogonUser") || "Logon User (optional)"}</Label>
          <Input
            value={f.logonUser}
            onChange={(e) => updateForm({ logonUser: e.target.value })}
            placeholder="username"
            disabled={isSubmitting}
          />
        </div>
      )}

      {f.triggerType === "on_event" && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="space-y-2">
            <Label>{t("onEventSource") || "Event Source"}</Label>
            <Input
              value={f.eventSource}
              onChange={(e) => updateForm({ eventSource: e.target.value })}
              placeholder={t("eventSourceLiteralPlaceholder")}
              disabled={isSubmitting}
            />
          </div>
          <div className="space-y-2">
            <Label>{t("onEventId") || "Event ID"}</Label>
            <Input
              type="number"
              min={0}
              value={f.eventId}
              onChange={(e) => updateForm({ eventId: parseInt(e.target.value) || 0 })}
              disabled={isSubmitting}
            />
          </div>
        </div>
      )}

      <div className="space-y-2">
        <Label>{t("systemActionType") || "Action Type"}</Label>
        <Select
          value={f.actionType}
          onValueChange={(value) => updateForm({ actionType: value as SystemActionType })}
        >
          <SelectTrigger disabled={workflowManagedScript}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {actionTypeOptions.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {f.actionType === "execute_script" && (
        <div className="space-y-3">
          {workflowManagedScript && (
            <Alert>
              <AlertTitle>{t("workflowScriptReadOnlyTitle") || "Workflow-managed task"}</AlertTitle>
              <AlertDescription>
                {t("workflowScriptReadOnlyDescription") ||
                  "Script content is managed by workflow trigger sync and is read-only in this form."}
              </AlertDescription>
            </Alert>
          )}
          <ScriptTaskEditor
            value={f.scriptAction}
            onChange={(v) => updateForm({ scriptAction: v })}
            disabled={isSubmitting || workflowManagedScript}
          />
        </div>
      )}

      {f.actionType === "run_command" && (
        <div className="space-y-3">
          <div className="space-y-2">
            <Label>{t("command") || "Command"}</Label>
            <Input
              value={f.command}
              onChange={(e) => updateForm({ command: e.target.value })}
              placeholder="/usr/bin/echo"
              disabled={isSubmitting}
            />
          </div>
          <div className="space-y-2">
            <Label>{t("commandArgs") || "Command Arguments"}</Label>
            <Input
              value={f.commandArgs}
              onChange={(e) => updateForm({ commandArgs: e.target.value })}
              placeholder="arg1 arg2"
              disabled={isSubmitting}
            />
          </div>
          <div className="space-y-2">
            <Label>{t("workingDir") || "Working Directory"}</Label>
            <Input
              value={f.commandWorkingDir}
              onChange={(e) => updateForm({ commandWorkingDir: e.target.value })}
              placeholder="/path/to/dir"
              disabled={isSubmitting}
            />
          </div>
        </div>
      )}

      {f.actionType === "launch_app" && (
        <div className="space-y-3">
          <div className="space-y-2">
            <Label>{t("appPath") || "Application Path"}</Label>
            <Input
              value={f.appPath}
              onChange={(e) => updateForm({ appPath: e.target.value })}
              placeholder="/Applications/MyApp.app"
              disabled={isSubmitting}
            />
          </div>
          <div className="space-y-2">
            <Label>{t("appArgs") || "Application Arguments"}</Label>
            <Input
              value={f.appArgs}
              onChange={(e) => updateForm({ appArgs: e.target.value })}
              placeholder="--flag value"
              disabled={isSubmitting}
            />
          </div>
        </div>
      )}

      {validationResult?.translation && (
        <div className="space-y-1.5">
          {validationResult.translation.errors.map((err, i) => (
            <p key={i} className="text-xs text-destructive">
              {err}
            </p>
          ))}
          {validationResult.translation.warnings.map((warn, i) => (
            <p key={i} className="text-xs text-amber-600">
              {warn}
            </p>
          ))}
          {validationResult.translation.native_representation && (
            <div className="rounded-md border bg-muted/30 px-2.5 py-1.5 text-xs font-mono text-muted-foreground">
              {validationResult.translation.native_representation}
            </div>
          )}
        </div>
      )}

      <div className="flex flex-col-reverse gap-2 pt-2 sm:flex-row">
        <Button variant="outline" onClick={onCancel} disabled={isSubmitting} className="flex-1">
          {t("cancel") || "Cancel"}
        </Button>
        <Button onClick={handleSubmit} disabled={isSubmitDisabled} className="flex-1">
          {isSubmitting ? t("saving") || "Saving..." : t("save") || "Save Task"}
        </Button>
      </div>
    </div>
  )
}
