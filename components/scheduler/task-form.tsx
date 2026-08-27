"use client"

/**
 * TaskForm - Create or edit a scheduled task
 */

import { useReducer, useCallback } from "react"
import { useLocale, useTranslations } from "next-intl"
import { Clock, Calendar, Zap, Bell, Settings, ChevronDown, ChevronUp } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { TimezoneSelect } from "@/components/scheduler/timezone-select"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Switch } from "@/components/ui/switch"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { cn } from "@/lib/utils"
import {
  type CreateScheduledTaskInput,
  type ScheduledTask,
  type ScheduledTaskType,
  type TaskOverlapPolicy,
  type TaskTriggerType,
  type NotificationChannel,
  CRON_PRESETS,
  DEFAULT_EXECUTION_CONFIG,
} from "@/types/scheduler"
import {
  getTaskTypeHostSupport,
  isCardAuthoredTaskType,
  type SchedulerHostDescriptor,
} from "@/lib/scheduler/host-support"
import { useSchedulerTargetHost } from "@/hooks/scheduler/use-scheduler-host-target"
import {
  ChatPayloadEditor,
  ExternalAgentPayloadEditor,
  TeamPayloadEditor,
  GoalPayloadEditor,
  PlanPayloadEditor,
  WorkflowPayloadEditor,
  ImPushPayloadEditor,
  EMPTY_CHAT_LIKE_DRAFT,
  EMPTY_EXTERNAL_AGENT_DRAFT,
  EMPTY_AGENT_TEAM_DRAFT,
  EMPTY_GOAL_DRAFT,
  EMPTY_PLAN_DRAFT,
  EMPTY_WORKFLOW_DRAFT,
  EMPTY_IM_PUSH_DRAFT,
  payloadToChatLikeDraft,
  payloadToExternalAgentDraft,
  payloadToAgentTeamDraft,
  payloadToGoalDraft,
  payloadToPlanDraft,
  payloadToWorkflowDraft,
  payloadToImPushDraft,
  chatLikeDraftToPayload,
  externalAgentDraftToPayload,
  agentTeamDraftToPayload,
  goalDraftToPayload,
  planDraftToPayload,
  workflowDraftToPayload,
  imPushDraftToPayload,
  isChatLikeTaskType,
  isStructuredEditableTaskType,
  DraftValidationError,
  type ChatLikeDraft,
  type ExternalAgentDraft,
  type AgentTeamDraft,
  type GoalDraft,
  type PlanDraft,
  type WorkflowDraft,
  type ImPushDraft,
} from "@/components/scheduler/payload-editors"
import {
  validateCronExpression,
  describeCronExpression,
  formatCronExpression,
  parseCronExpression,
} from "@/lib/scheduler/cron-parser"
import { testNotificationChannel } from "@/lib/scheduler/notification-integration"
import {
  TASK_TEMPLATES,
  TEMPLATE_CATEGORIES,
  type TaskTemplate,
} from "@/lib/scheduler/task-templates"

interface TaskFormProps {
  initialValues?: Partial<CreateScheduledTaskInput>
  onSubmit: (input: CreateScheduledTaskInput) => Promise<void>
  onCancel: () => void
  isSubmitting?: boolean
  existingTasks?: ScheduledTask[]
  /** Test seam: host descriptor used for the type-availability gate. */
  hostForTesting?: SchedulerHostDescriptor
}

// Display labels are sourced from i18n keys `scheduler.taskTypes.*` and
// `scheduler.triggerTypes.*` — only the value (and icon for triggers) lives here.
// Types a user may author from the form. Card-authored types (twin,
// connection:*, wiki-lint, github-issue-sync, …) are created by their own
// subsystem and must never appear here — pinned by the filter below and by
// `task-form.test.tsx`.
const TASK_TYPES: Array<{ value: ScheduledTaskType }> = (
  [
    { value: "chat" },
    { value: "agent" },
    { value: "skill" },
    { value: "external-agent" },
    { value: "agent-team" },
    { value: "goal" },
    { value: "plan" },
    { value: "workflow" },
    { value: "backup" },
    { value: "script" },
    { value: "background-command" },
    { value: "monitor" },
    { value: "im-push" },
    { value: "test" },
    { value: "custom" },
    { value: "plugin" },
  ] satisfies Array<{ value: ScheduledTaskType }>
).filter((type) => !isCardAuthoredTaskType(type.value))

const TRIGGER_TYPES: Array<{ value: TaskTriggerType; icon: React.ReactNode }> = [
  { value: "cron", icon: <Clock className="h-4 w-4" /> },
  { value: "interval", icon: <Calendar className="h-4 w-4" /> },
  { value: "once", icon: <Zap className="h-4 w-4" /> },
  { value: "event", icon: <Bell className="h-4 w-4" /> },
]

type PayloadEditorMode = "structured" | "json"

const OVERLAP_POLICIES: TaskOverlapPolicy[] = [
  "skip",
  "allow",
  "queue-one",
  "queue-all",
  "cancel-previous",
]

/** i18n sub-keys under `scheduler.overlapPolicies.*` per policy value. */
const OVERLAP_POLICY_KEYS: Record<TaskOverlapPolicy, string> = {
  skip: "skip",
  allow: "allow",
  "queue-one": "queueOne",
  "queue-all": "queueAll",
  "cancel-previous": "cancelPrevious",
}

function toLocalDateInput(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, "0")
  const d = String(date.getDate()).padStart(2, "0")
  return `${y}-${m}-${d}`
}

function toLocalTimeInput(date: Date): string {
  const h = String(date.getHours()).padStart(2, "0")
  const min = String(date.getMinutes()).padStart(2, "0")
  return `${h}:${min}`
}

/** Chip-style multi-select over existing tasks (used by the forward chains). */
function TaskChipSelect({
  label,
  description,
  placeholder,
  emptyText,
  testId,
  selected,
  onChange,
  existingTasks,
}: {
  label: string
  description: string
  placeholder: string
  emptyText: string
  testId: string
  selected: string[]
  onChange: (ids: string[]) => void
  existingTasks: ScheduledTask[]
}) {
  return (
    <div className="mt-3 space-y-2" data-testid={testId}>
      <Label className="text-xs font-medium text-muted-foreground">{label}</Label>
      <p className="text-[11px] text-muted-foreground">{description}</p>
      <Select
        value=""
        onValueChange={(taskId) => {
          if (taskId && !selected.includes(taskId)) {
            onChange([...selected, taskId])
          }
        }}
      >
        <SelectTrigger className="h-9 text-xs" data-testid={`${testId}-trigger`}>
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          {existingTasks
            .filter((task) => !selected.includes(task.id))
            .map((task) => (
              <SelectItem key={task.id} value={task.id}>
                <span className="flex items-center gap-2">
                  <span
                    className={cn(
                      "h-1.5 w-1.5 rounded-full",
                      task.status === "active"
                        ? "bg-green-500"
                        : task.status === "paused"
                          ? "bg-yellow-500"
                          : "bg-gray-400"
                    )}
                  />
                  {task.name}
                </span>
              </SelectItem>
            ))}
        </SelectContent>
      </Select>
      {selected.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {selected.map((id) => {
            const task = existingTasks.find((t) => t.id === id)
            return (
              <Badge key={id} variant="secondary" className="gap-1 rounded-full py-1 text-[11px]">
                {task?.name || id}
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  onClick={() => onChange(selected.filter((x) => x !== id))}
                  className="ml-0.5 text-muted-foreground hover:text-destructive"
                >
                  ×
                </Button>
              </Badge>
            )
          })}
        </div>
      ) : (
        <p className="text-[11px] text-muted-foreground/70">{emptyText}</p>
      )}
    </div>
  )
}

interface TaskFormState {
  name: string
  description: string
  taskType: ScheduledTaskType
  triggerType: TaskTriggerType
  cronExpression: string
  cronPreset: string
  useCustomCron: boolean
  intervalMinutes: number
  runAtDate: string
  runAtTime: string
  eventType: string
  timezone: string
  payloadJson: string
  /** Structured-mode draft for chat / agent / skill task types. */
  chatLikeDraft: ChatLikeDraft
  /** Structured-mode draft for external-agent task type. */
  externalAgentDraft: ExternalAgentDraft
  /** Structured-mode draft for agent-team task type. */
  agentTeamDraft: AgentTeamDraft
  /** Structured-mode draft for goal task type. */
  goalDraft: GoalDraft
  /** Structured-mode draft for plan task type. */
  planDraft: PlanDraft
  /** Structured-mode draft for workflow task type. */
  workflowDraft: WorkflowDraft
  /** Structured-mode draft for im-push task type. */
  imPushDraft: ImPushDraft
  /**
   * Which editor to render. Toggling structured → JSON serializes the draft
   * into payloadJson; toggling back parses payloadJson into the draft. Free-
   * form JSON edits stick when the user explicitly stays in JSON mode.
   */
  payloadEditorMode: PayloadEditorMode
  /** Per-field validation messages for the structured editor. */
  payloadFieldErrors: Record<string, string>
  notifyOnStart: boolean
  notifyOnComplete: boolean
  notifyOnError: boolean
  notifyOnProgress: boolean
  notificationChannels: NotificationChannel[]
  /**
   * Conversation the `im` channel delivers to. Empty means "use the global ops
   * channel from settings" — the second layer of the two-layer fallback, so an
   * operator who wants everything in one place configures it once.
   */
  notificationImConversationKey: string
  taskTimeout: number
  maxRetries: number
  retryDelay: number
  maxRetryDelay: number
  runMissedOnStartup: boolean
  maxMissedRuns: number
  /** Overlap policy — replaces the legacy allowConcurrent switch. */
  overlapPolicy: TaskOverlapPolicy
  /** Max buffered starts; only meaningful for the queue-all policy. */
  maxQueueSize: number
  /** 0 = unlimited runs. */
  maxRuns: number
  /** 0 = never auto-pause. */
  pauseAfterConsecutiveFailures: number
  /** 0 = unlimited catch-up window (minutes in the UI, ms in the model). */
  catchupWindowMinutes: number
  /** 0 = no scheduling jitter (seconds in the UI, ms in the model). */
  jitterSeconds: number
  /** Empty strings = no end bound. */
  endAtDate: string
  endAtTime: string
  onSuccessTaskIds: string[]
  onFailureTaskIds: string[]
  showAdvanced: boolean
  cronError: string | null
  payloadError: string | null
  nameError: string | null
  triggerError: string | null
  notificationTestResult: { channel: string; success: boolean; error?: string } | null
  isTestingNotification: boolean
  dependsOn: string[]
}

function formReducer(state: TaskFormState, update: Partial<TaskFormState>): TaskFormState {
  return { ...state, ...update }
}

/**
 * Build the typed payload for whichever structured task type is active.
 * Throws `DraftValidationError` (surfaced as per-field messages) on invalid
 * input — same contract as the individual `*DraftToPayload` converters.
 */
function buildStructuredPayload(f: TaskFormState): Record<string, unknown> {
  switch (f.taskType) {
    case "external-agent":
      return externalAgentDraftToPayload(f.externalAgentDraft) as Record<string, unknown>
    case "agent-team":
      return agentTeamDraftToPayload(f.agentTeamDraft) as Record<string, unknown>
    case "goal":
      return goalDraftToPayload(f.goalDraft) as Record<string, unknown>
    case "plan":
      return planDraftToPayload(f.planDraft) as Record<string, unknown>
    case "workflow":
      return workflowDraftToPayload(f.workflowDraft) as Record<string, unknown>
    case "im-push":
      return imPushDraftToPayload(f.imPushDraft) as Record<string, unknown>
    default:
      return chatLikeDraftToPayload(f.taskType, f.chatLikeDraft) as Record<string, unknown>
  }
}

/**
 * Serialize the active structured draft to JSON for the "Edit as JSON" toggle.
 * Best-effort: when validation fails we dump the raw draft so the user keeps
 * what they typed.
 */
function serializeStructuredDraft(f: TaskFormState): string {
  try {
    return JSON.stringify(buildStructuredPayload(f), null, 2)
  } catch {
    const raw =
      f.taskType === "external-agent"
        ? f.externalAgentDraft
        : f.taskType === "agent-team"
          ? f.agentTeamDraft
          : f.taskType === "goal"
            ? f.goalDraft
            : f.taskType === "plan"
              ? f.planDraft
              : f.taskType === "workflow"
                ? f.workflowDraft
                : f.taskType === "im-push"
                  ? f.imPushDraft
                  : f.chatLikeDraft
    return JSON.stringify(raw, null, 2)
  }
}

/** Parse a JSON payload into the right structured draft for the given type. */
function parseIntoDraftUpdates(
  taskType: ScheduledTaskType,
  parsed: unknown
): Partial<TaskFormState> {
  switch (taskType) {
    case "external-agent":
      return { externalAgentDraft: payloadToExternalAgentDraft(parsed) }
    case "agent-team":
      return { agentTeamDraft: payloadToAgentTeamDraft(parsed) }
    case "goal":
      return { goalDraft: payloadToGoalDraft(parsed) }
    case "plan":
      return { planDraft: payloadToPlanDraft(parsed) }
    case "workflow":
      return { workflowDraft: payloadToWorkflowDraft(parsed) }
    case "im-push":
      return { imPushDraft: payloadToImPushDraft(parsed) }
    default:
      return isChatLikeTaskType(taskType)
        ? { chatLikeDraft: payloadToChatLikeDraft(taskType, parsed) }
        : {}
  }
}

function createInitialState(initialValues?: Partial<CreateScheduledTaskInput>): TaskFormState {
  const initialType: ScheduledTaskType = initialValues?.type || "chat"
  const startInStructured = isStructuredEditableTaskType(initialType)
  return {
    name: initialValues?.name || "",
    description: initialValues?.description || "",
    taskType: initialType,
    triggerType: initialValues?.trigger?.type || "cron",
    cronExpression: initialValues?.trigger?.cronExpression || "0 9 * * *",
    cronPreset: "",
    useCustomCron: false,
    intervalMinutes: 60,
    runAtDate: "",
    runAtTime: "",
    eventType: "",
    timezone: initialValues?.trigger?.timezone || "UTC",
    payloadJson: initialValues?.payload ? JSON.stringify(initialValues.payload, null, 2) : "{}",
    chatLikeDraft: isChatLikeTaskType(initialType)
      ? payloadToChatLikeDraft(initialType, initialValues?.payload)
      : { ...EMPTY_CHAT_LIKE_DRAFT },
    externalAgentDraft:
      initialType === "external-agent"
        ? payloadToExternalAgentDraft(initialValues?.payload)
        : { ...EMPTY_EXTERNAL_AGENT_DRAFT },
    agentTeamDraft:
      initialType === "agent-team"
        ? payloadToAgentTeamDraft(initialValues?.payload)
        : { ...EMPTY_AGENT_TEAM_DRAFT },
    goalDraft:
      initialType === "goal" ? payloadToGoalDraft(initialValues?.payload) : { ...EMPTY_GOAL_DRAFT },
    planDraft:
      initialType === "plan" ? payloadToPlanDraft(initialValues?.payload) : { ...EMPTY_PLAN_DRAFT },
    workflowDraft:
      initialType === "workflow"
        ? payloadToWorkflowDraft(initialValues?.payload)
        : { ...EMPTY_WORKFLOW_DRAFT },
    imPushDraft:
      initialType === "im-push"
        ? payloadToImPushDraft(initialValues?.payload)
        : { ...EMPTY_IM_PUSH_DRAFT },
    payloadEditorMode: startInStructured ? "structured" : "json",
    payloadFieldErrors: {},
    notifyOnStart: initialValues?.notification?.onStart ?? false,
    notifyOnComplete: initialValues?.notification?.onComplete ?? true,
    notifyOnError: initialValues?.notification?.onError ?? true,
    notifyOnProgress: initialValues?.notification?.onProgress ?? false,
    notificationChannels: initialValues?.notification?.channels || ["toast"],
    notificationImConversationKey: initialValues?.notification?.imTarget?.conversationKey ?? "",
    taskTimeout: initialValues?.config?.timeout || DEFAULT_EXECUTION_CONFIG.timeout,
    maxRetries: initialValues?.config?.maxRetries || DEFAULT_EXECUTION_CONFIG.maxRetries,
    retryDelay: initialValues?.config?.retryDelay || DEFAULT_EXECUTION_CONFIG.retryDelay,
    maxRetryDelay:
      initialValues?.config?.maxRetryDelay ?? DEFAULT_EXECUTION_CONFIG.maxRetryDelay ?? 60_000,
    runMissedOnStartup:
      initialValues?.config?.runMissedOnStartup ?? DEFAULT_EXECUTION_CONFIG.runMissedOnStartup,
    maxMissedRuns:
      initialValues?.config?.maxMissedRuns ?? DEFAULT_EXECUTION_CONFIG.maxMissedRuns ?? 1,
    overlapPolicy:
      initialValues?.config?.overlapPolicy ??
      (initialValues?.config?.allowConcurrent ? "allow" : "skip"),
    maxQueueSize:
      initialValues?.config?.maxQueueSize ?? DEFAULT_EXECUTION_CONFIG.maxQueueSize ?? 10,
    maxRuns: initialValues?.config?.maxRuns ?? 0,
    pauseAfterConsecutiveFailures: initialValues?.config?.pauseAfterConsecutiveFailures ?? 0,
    catchupWindowMinutes: initialValues?.config?.catchupWindowMs
      ? Math.round(initialValues.config.catchupWindowMs / 60_000)
      : 0,
    jitterSeconds: initialValues?.trigger?.jitterMs
      ? Math.round(initialValues.trigger.jitterMs / 1_000)
      : 0,
    endAtDate: initialValues?.endAt ? toLocalDateInput(initialValues.endAt) : "",
    endAtTime: initialValues?.endAt ? toLocalTimeInput(initialValues.endAt) : "",
    onSuccessTaskIds: initialValues?.onSuccessTaskIds || [],
    onFailureTaskIds: initialValues?.onFailureTaskIds || [],
    showAdvanced: false,
    cronError: null,
    payloadError: null,
    nameError: null,
    triggerError: null,
    notificationTestResult: null,
    isTestingNotification: false,
    dependsOn: initialValues?.trigger?.dependsOn || [],
  }
}

export function TaskForm({
  initialValues,
  onSubmit,
  onCancel,
  isSubmitting,
  existingTasks,
  hostForTesting,
}: TaskFormProps) {
  const t = useTranslations("scheduler")
  const tCron = useTranslations("scheduler.cronDescribe")
  const locale = useLocale()
  const isZh = locale.startsWith("zh")
  const [f, updateForm] = useReducer(formReducer, initialValues, createInitialState)
  // The host whose schedule is being edited (this device or the paired host):
  // task types the host cannot run are shown disabled with the reason —
  // never hidden (Working Rule 7).
  const resolvedHost = useSchedulerTargetHost()
  const host: SchedulerHostDescriptor = hostForTesting ?? resolvedHost

  // Validation constants
  const MAX_NAME_LENGTH = 100
  const MIN_INTERVAL_MINUTES = 1
  const MAX_PAYLOAD_SIZE = 64 * 1024 // 64KB

  // Validate cron expression
  const handleCronChange = useCallback((value: string) => {
    const result = validateCronExpression(value)
    updateForm({
      cronExpression: value,
      cronError: result.valid ? null : result.error || "Invalid expression",
    })
  }, [])

  // Format cron expression (normalize whitespace/parts)
  const handleFormatCron = useCallback(() => {
    const parts = parseCronExpression(f.cronExpression)
    if (parts) {
      const formatted = formatCronExpression(parts)
      if (formatted !== f.cronExpression) {
        updateForm({ cronExpression: formatted, cronError: null })
      }
    }
  }, [f.cronExpression])

  // Test notification channel. The IM channel needs the conversation the user
  // just typed (still unsaved), so the test resolves the same two layers a real
  // delivery would instead of only reading persisted config.
  const imConversationKey = f.notificationImConversationKey
  const handleTestNotification = useCallback(
    async (channel: NotificationChannel) => {
      updateForm({ isTestingNotification: true, notificationTestResult: null })
      try {
        const result = await testNotificationChannel(channel, undefined, imConversationKey)
        updateForm({
          notificationTestResult: { channel, success: result.success, error: result.error },
          isTestingNotification: false,
        })
      } catch (err) {
        updateForm({
          notificationTestResult: {
            channel,
            success: false,
            error: err instanceof Error ? err.message : "Test failed",
          },
          isTestingNotification: false,
        })
      }
    },
    [imConversationKey]
  )

  // ---- Payload editor mode + task-type change -----------------------------

  /**
   * Switch between structured and JSON payload editors. We always serialize
   * the current draft into `payloadJson` when leaving structured mode (even
   * if validation would fail) so the user never loses their data — they get
   * back what they typed. Going JSON → structured re-parses `payloadJson`
   * into a draft.
   */
  const togglePayloadEditorMode = useCallback(() => {
    if (f.payloadEditorMode === "structured") {
      // structured → json: serialize the active draft (best-effort).
      updateForm({
        payloadEditorMode: "json",
        payloadJson: serializeStructuredDraft(f),
        payloadError: null,
        payloadFieldErrors: {},
      })
    } else {
      // json → structured: parse JSON into the appropriate draft.
      let parsed: unknown
      try {
        parsed = JSON.parse(f.payloadJson || "{}")
      } catch {
        updateForm({
          payloadError: t("invalidJson") || "Invalid JSON",
        })
        return
      }
      updateForm({
        payloadEditorMode: "structured",
        payloadError: null,
        payloadFieldErrors: {},
        ...parseIntoDraftUpdates(f.taskType, parsed),
      })
    }
  }, [f, t])

  /**
   * Handle the user picking a different task type. We migrate the structured
   * drafts where it makes sense (chat ↔ agent ↔ skill share fields; external
   * agent has its own draft) and force the editor mode to whatever's
   * appropriate for the new type.
   */
  const handleTaskTypeChange = useCallback(
    (next: ScheduledTaskType) => {
      const wasStructured = isStructuredEditableTaskType(f.taskType)
      const willBeStructured = isStructuredEditableTaskType(next)
      const updates: Partial<TaskFormState> = {
        taskType: next,
        payloadFieldErrors: {},
        payloadError: null,
      }

      if (willBeStructured) {
        // chat ↔ agent ↔ skill share one draft shape — keep it as-is.
        if (isChatLikeTaskType(f.taskType) && isChatLikeTaskType(next)) {
          updateForm(updates)
          return
        }
        // Seed the target draft from the current structured draft (when
        // already in a structured type) or from the free-form JSON otherwise.
        let source: unknown = {}
        try {
          source = wasStructured
            ? JSON.parse(serializeStructuredDraft(f))
            : JSON.parse(f.payloadJson || "{}")
        } catch {
          source = {}
        }
        const draftUpdates = parseIntoDraftUpdates(next, source)
        // Carry a free-text prompt across into the goal objective for a smoother
        // switch from a chat-like draft.
        if (
          next === "goal" &&
          draftUpdates.goalDraft &&
          !draftUpdates.goalDraft.objective &&
          isChatLikeTaskType(f.taskType) &&
          f.chatLikeDraft.prompt
        ) {
          draftUpdates.goalDraft = {
            ...draftUpdates.goalDraft,
            objective: f.chatLikeDraft.prompt,
          }
        }
        Object.assign(updates, draftUpdates)
        updates.payloadEditorMode = "structured"
      } else if (wasStructured) {
        // Leaving the structured world entirely — leave payloadJson alone.
        updates.payloadEditorMode = "json"
      }

      updateForm(updates)
    },
    [f]
  )

  // Apply task template to fill form
  const applyTemplate = useCallback((template: TaskTemplate) => {
    const input = template.getInput()
    updateForm({
      name: input.name,
      description: input.description || "",
      taskType: input.type,
      triggerType: input.trigger.type,
      cronExpression: input.trigger.cronExpression || "0 9 * * *",
      timezone: input.trigger.timezone || "UTC",
      intervalMinutes: input.trigger.intervalMs ? input.trigger.intervalMs / 60000 : 60,
      payloadJson: input.payload ? JSON.stringify(input.payload, null, 2) : "{}",
      chatLikeDraft: isChatLikeTaskType(input.type)
        ? payloadToChatLikeDraft(input.type, input.payload)
        : { ...EMPTY_CHAT_LIKE_DRAFT },
      externalAgentDraft:
        input.type === "external-agent"
          ? payloadToExternalAgentDraft(input.payload)
          : { ...EMPTY_EXTERNAL_AGENT_DRAFT },
      agentTeamDraft:
        input.type === "agent-team"
          ? payloadToAgentTeamDraft(input.payload)
          : { ...EMPTY_AGENT_TEAM_DRAFT },
      goalDraft:
        input.type === "goal" ? payloadToGoalDraft(input.payload) : { ...EMPTY_GOAL_DRAFT },
      planDraft:
        input.type === "plan" ? payloadToPlanDraft(input.payload) : { ...EMPTY_PLAN_DRAFT },
      workflowDraft:
        input.type === "workflow"
          ? payloadToWorkflowDraft(input.payload)
          : { ...EMPTY_WORKFLOW_DRAFT },
      imPushDraft:
        input.type === "im-push" ? payloadToImPushDraft(input.payload) : { ...EMPTY_IM_PUSH_DRAFT },
      payloadEditorMode: isStructuredEditableTaskType(input.type) ? "structured" : "json",
      payloadFieldErrors: {},
      notifyOnStart: input.notification?.onStart ?? false,
      notifyOnComplete: input.notification?.onComplete ?? true,
      notifyOnError: input.notification?.onError ?? true,
      notifyOnProgress: input.notification?.onProgress ?? false,
      notificationChannels: input.notification?.channels || ["toast"],
      notificationImConversationKey: input.notification?.imTarget?.conversationKey ?? "",
      taskTimeout: input.config?.timeout || DEFAULT_EXECUTION_CONFIG.timeout,
      maxRetries: input.config?.maxRetries || DEFAULT_EXECUTION_CONFIG.maxRetries,
      retryDelay: input.config?.retryDelay || DEFAULT_EXECUTION_CONFIG.retryDelay,
      maxRetryDelay:
        input.config?.maxRetryDelay ?? DEFAULT_EXECUTION_CONFIG.maxRetryDelay ?? 60_000,
      runMissedOnStartup:
        input.config?.runMissedOnStartup ?? DEFAULT_EXECUTION_CONFIG.runMissedOnStartup,
      maxMissedRuns: input.config?.maxMissedRuns ?? DEFAULT_EXECUTION_CONFIG.maxMissedRuns ?? 1,
      overlapPolicy:
        input.config?.overlapPolicy ?? (input.config?.allowConcurrent ? "allow" : "skip"),
      nameError: null,
      cronError: null,
      payloadError: null,
      triggerError: null,
    })
  }, [])

  // Handle cron preset selection
  const handlePresetSelect = useCallback((presetId: string) => {
    const preset = CRON_PRESETS.find((p) => p.id === presetId)
    updateForm({
      cronPreset: presetId,
      ...(preset ? { cronExpression: preset.expression, cronError: null } : {}),
    })
  }, [])

  // Toggle notification channel
  const toggleChannel = useCallback(
    (channel: NotificationChannel) => {
      updateForm({
        notificationChannels: f.notificationChannels.includes(channel)
          ? f.notificationChannels.filter((c) => c !== channel)
          : [...f.notificationChannels, channel],
      })
    },
    [f.notificationChannels]
  )

  // Validate and submit
  const handleSubmit = async () => {
    let hasErrors = false
    const errors: Partial<TaskFormState> = { triggerError: null }

    // Validate name
    const trimmedName = f.name.trim()
    if (!trimmedName) {
      errors.nameError = t("nameRequired") || "Task name is required"
      hasErrors = true
    } else if (trimmedName.length > MAX_NAME_LENGTH) {
      errors.nameError = t("nameTooLong") || `Name must be ${MAX_NAME_LENGTH} characters or less`
      hasErrors = true
    } else {
      errors.nameError = null
    }

    // Validate payload — structured mode uses the typed draft, JSON mode keeps
    // the existing free-form JSON behaviour.
    let payload: Record<string, unknown> = {}
    let payloadFieldErrors: Record<string, string> | undefined
    if (f.payloadEditorMode === "structured" && isStructuredEditableTaskType(f.taskType)) {
      try {
        payload = buildStructuredPayload(f)
        const serialized = JSON.stringify(payload)
        if (serialized.length > MAX_PAYLOAD_SIZE) {
          errors.payloadError = t("payloadTooLarge") || "Payload exceeds 64KB limit"
          hasErrors = true
        } else {
          errors.payloadError = null
        }
      } catch (err) {
        if (err instanceof DraftValidationError) {
          payloadFieldErrors = err.errors
          errors.payloadError = t("payloadFieldErrors") || "Please fix the highlighted fields"
          hasErrors = true
        } else {
          errors.payloadError = err instanceof Error ? err.message : String(err)
          hasErrors = true
        }
      }
    } else {
      try {
        payload = JSON.parse(f.payloadJson)
        if (f.payloadJson.length > MAX_PAYLOAD_SIZE) {
          errors.payloadError = t("payloadTooLarge") || "Payload exceeds 64KB limit"
          hasErrors = true
        } else {
          errors.payloadError = null
        }
      } catch {
        errors.payloadError = t("invalidJson") || "Invalid JSON"
        hasErrors = true
      }
    }
    if (payloadFieldErrors) {
      ;(errors as Partial<TaskFormState>).payloadFieldErrors = payloadFieldErrors
    } else {
      ;(errors as Partial<TaskFormState>).payloadFieldErrors = {}
    }

    // Build trigger
    const trigger: CreateScheduledTaskInput["trigger"] = {
      type: f.triggerType,
      timezone: f.timezone,
      ...(f.dependsOn.length > 0 ? { dependsOn: f.dependsOn } : {}),
      // Explicit undefined so edit-mode merges clear a previously-set jitter.
      jitterMs:
        (f.triggerType === "cron" || f.triggerType === "interval") && f.jitterSeconds > 0
          ? f.jitterSeconds * 1_000
          : undefined,
    }

    // Lifecycle end bound (recurring triggers only)
    let endAt: Date | undefined
    if ((f.triggerType === "cron" || f.triggerType === "interval") && f.endAtDate) {
      endAt = new Date(`${f.endAtDate}T${f.endAtTime || "23:59"}`)
      if (Number.isNaN(endAt.getTime())) {
        errors.triggerError = t("lifecycle.endAtInvalid") || "Invalid end date"
        hasErrors = true
      } else if (endAt <= new Date()) {
        errors.triggerError = t("lifecycle.endAtInPast") || "End time must be in the future"
        hasErrors = true
      }
    }

    switch (f.triggerType) {
      case "cron":
        if (f.cronError) {
          hasErrors = true
        }
        trigger.cronExpression = f.cronExpression
        break
      case "interval":
        if (f.intervalMinutes < MIN_INTERVAL_MINUTES) {
          errors.triggerError =
            t("intervalTooShort") || `Interval must be at least ${MIN_INTERVAL_MINUTES} minute(s)`
          hasErrors = true
        }
        trigger.intervalMs = f.intervalMinutes * 60 * 1000
        break
      case "once":
        if (!f.runAtDate || !f.runAtTime) {
          errors.triggerError = t("dateTimeRequired") || "Date and time are required"
          hasErrors = true
        } else {
          const runAt = new Date(`${f.runAtDate}T${f.runAtTime}`)
          if (runAt <= new Date()) {
            errors.triggerError = t("dateInPast") || "Scheduled time must be in the future"
            hasErrors = true
          }
          trigger.runAt = runAt
        }
        break
      case "event":
        if (!f.eventType.trim()) {
          errors.triggerError = t("eventTypeRequired") || "Event type is required"
          hasErrors = true
        }
        trigger.eventType = f.eventType
        break
    }

    updateForm(errors)
    if (hasErrors) return

    const input: CreateScheduledTaskInput = {
      name: trimmedName,
      description: f.description.trim() || undefined,
      type: f.taskType,
      trigger,
      payload,
      config: {
        timeout: f.taskTimeout,
        maxRetries: f.maxRetries,
        retryDelay: f.retryDelay,
        maxRetryDelay: f.maxRetryDelay > 0 ? f.maxRetryDelay : undefined,
        runMissedOnStartup: f.runMissedOnStartup,
        maxMissedRuns: Math.max(0, f.maxMissedRuns),
        overlapPolicy: f.overlapPolicy,
        // Mirror the legacy boolean for older readers of persisted configs.
        allowConcurrent: f.overlapPolicy === "allow",
        // Explicit undefined so edit-mode merges clear previously-set limits.
        maxQueueSize: f.overlapPolicy === "queue-all" ? Math.max(1, f.maxQueueSize) : undefined,
        maxRuns: f.maxRuns > 0 ? f.maxRuns : undefined,
        pauseAfterConsecutiveFailures:
          f.pauseAfterConsecutiveFailures > 0 ? f.pauseAfterConsecutiveFailures : undefined,
        catchupWindowMs: f.catchupWindowMinutes > 0 ? f.catchupWindowMinutes * 60_000 : undefined,
      },
      notification: {
        onStart: f.notifyOnStart,
        onComplete: f.notifyOnComplete,
        onError: f.notifyOnError,
        // Producers are executors that report mid-run — plugin handlers today
        // (`PluginTaskContext.reportProgress`). Types with no reporter simply
        // never raise the event; the switch is not a lie, it is unused.
        onProgress: f.notifyOnProgress,
        channels: f.notificationChannels,
        // Only persisted when the channel is actually on and a key was typed;
        // an empty key means "fall back to the global ops channel", which is
        // expressed by the field's absence rather than by an empty string.
        ...(f.notificationChannels.includes("im") && f.notificationImConversationKey.trim()
          ? { imTarget: { conversationKey: f.notificationImConversationKey.trim() } }
          : {}),
      },
      ...(endAt ? { endAt } : {}),
      ...(f.onSuccessTaskIds.length > 0 ? { onSuccessTaskIds: f.onSuccessTaskIds } : {}),
      ...(f.onFailureTaskIds.length > 0 ? { onFailureTaskIds: f.onFailureTaskIds } : {}),
    }

    await onSubmit(input)
  }

  return (
    <div className="space-y-4 sm:space-y-5" data-testid="scheduler-task-form">
      {/* Template Quick Create */}
      {!initialValues?.name && (
        <Collapsible>
          <CollapsibleTrigger asChild>
            <Button
              type="button"
              variant="outline"
              className="h-auto w-full justify-between border-dashed border-primary/30 bg-primary/5 py-3 text-primary hover:bg-primary/10"
            >
              <span>{t("templates") || "Quick Create from Template"}</span>
              <ChevronDown />
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-2">
            <div className="space-y-3">
              {TEMPLATE_CATEGORIES.map((cat) => {
                const templates = TASK_TEMPLATES.filter((tpl) => tpl.category === cat.id)
                if (templates.length === 0) return null
                return (
                  <div key={cat.id}>
                    <p className="mb-1.5 text-xs font-medium text-muted-foreground">{cat.name}</p>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                      {templates.map((tpl) => (
                        <Button
                          key={tpl.id}
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => applyTemplate(tpl)}
                          className="h-auto justify-start gap-2.5 bg-card p-2.5 text-left whitespace-normal hover:border-primary/50"
                        >
                          <span className="text-base">{tpl.icon}</span>
                          <div className="min-w-0 flex-1">
                            <p className="truncate font-medium">{tpl.name}</p>
                            <p className="truncate text-xs text-muted-foreground">
                              {tpl.description}
                            </p>
                          </div>
                        </Button>
                      ))}
                    </div>
                  </div>
                )
              })}
            </div>
          </CollapsibleContent>
        </Collapsible>
      )}

      {/* Basic Info Section */}
      <div className="rounded-xl border bg-gradient-to-br from-card to-card/50 p-3 sm:p-4 shadow-sm">
        <div className="mb-4 flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10">
            <Settings className="h-4 w-4 text-primary" />
          </div>
          <h3 className="font-semibold">{t("basicInfo") || "Basic Information"}</h3>
        </div>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="name" className="text-sm font-medium">
              {t("taskName") || "Task Name"} <span className="text-destructive">*</span>
            </Label>
            <Input
              id="name"
              data-testid="scheduler-task-name-input"
              value={f.name}
              onChange={(e) => updateForm({ name: e.target.value, nameError: null })}
              placeholder={t("taskNamePlaceholder") || "Enter task name"}
              maxLength={MAX_NAME_LENGTH}
              className={cn(
                "h-10 transition-all focus:ring-2 focus:ring-primary/20",
                f.nameError && "border-destructive focus:ring-destructive/20"
              )}
            />
            {f.nameError && <p className="text-xs text-destructive">{f.nameError}</p>}
            {f.name.length > MAX_NAME_LENGTH * 0.8 && (
              <p className="text-xs text-muted-foreground">
                {f.name.length}/{MAX_NAME_LENGTH}
              </p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="description" className="text-sm font-medium">
              {t("description") || "Description"}
            </Label>
            <Textarea
              id="description"
              value={f.description}
              onChange={(e) => updateForm({ description: e.target.value })}
              placeholder={t("descriptionPlaceholder") || "Describe what this task does"}
              rows={2}
              className="resize-none transition-all focus:ring-2 focus:ring-primary/20"
            />
          </div>

          <div className="space-y-2">
            <Label className="text-sm font-medium">{t("taskType") || "Task Type"}</Label>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-1.5">
              {TASK_TYPES.map((type) => {
                const support = getTaskTypeHostSupport(type.value, host)
                const reason = support.supported
                  ? undefined
                  : t(`hostSupport.reason.${support.reason ?? "missing-capability"}`, {
                      missing: support.missing.join(", "),
                    })
                return (
                  <Button
                    key={type.value}
                    type="button"
                    variant={f.taskType === type.value ? "secondary" : "outline"}
                    size="sm"
                    aria-pressed={f.taskType === type.value}
                    aria-disabled={!support.supported}
                    disabled={!support.supported}
                    title={reason}
                    onClick={() => handleTaskTypeChange(type.value)}
                    data-testid={`task-type-${type.value}`}
                    data-host-supported={support.supported ? "true" : "false"}
                    className={cn(
                      "rounded-lg border px-2 py-2 text-xs font-medium transition-all",
                      "hover:border-primary/50 hover:bg-primary/5",
                      f.taskType === type.value
                        ? "border-primary bg-primary/10 text-primary shadow-sm"
                        : "border-border bg-background text-muted-foreground",
                      !support.supported && "opacity-60"
                    )}
                  >
                    {t(`taskTypes.${type.value}`)}
                  </Button>
                )
              })}
            </div>
            {(() => {
              const current = getTaskTypeHostSupport(f.taskType, host)
              if (current.supported) return null
              return (
                <p
                  className="text-xs text-destructive"
                  role="alert"
                  data-testid="task-type-host-warning"
                >
                  {t("hostSupport.unavailableTitle", {
                    host: t(`hostSupport.host.${host.platform}`),
                  })}
                  {" — "}
                  {t(`hostSupport.reason.${current.reason ?? "missing-capability"}`, {
                    missing: current.missing.join(", "),
                  })}
                </p>
              )
            })()}
          </div>
        </div>
      </div>

      {/* Trigger Configuration Section */}
      <div className="rounded-xl border bg-gradient-to-br from-card to-card/50 p-3 sm:p-4 shadow-sm">
        <div className="mb-4 flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-500/10">
            <Clock className="h-4 w-4 text-blue-500" />
          </div>
          <h3 className="font-semibold">{t("triggerConfig") || "Trigger Configuration"}</h3>
        </div>

        <div className="space-y-4">
          {/* Trigger Type Selection */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {TRIGGER_TYPES.map((type) => (
              <Button
                key={type.value}
                type="button"
                variant={f.triggerType === type.value ? "secondary" : "outline"}
                aria-pressed={f.triggerType === type.value}
                onClick={() => updateForm({ triggerType: type.value })}
                className={cn(
                  "flex items-center gap-2.5 rounded-lg border p-3 text-left transition-all",
                  "hover:border-blue-500/50 hover:bg-blue-500/5",
                  f.triggerType === type.value
                    ? "border-blue-500 bg-blue-500/10 shadow-sm"
                    : "border-border bg-background/50"
                )}
              >
                <div
                  className={cn(
                    "flex h-8 w-8 shrink-0 items-center justify-center rounded-md",
                    f.triggerType === type.value
                      ? "bg-blue-500 text-white"
                      : "bg-muted text-muted-foreground"
                  )}
                >
                  {type.icon}
                </div>
                <div className="min-w-0">
                  <div
                    className={cn(
                      "text-sm font-medium truncate",
                      f.triggerType === type.value
                        ? "text-blue-600 dark:text-blue-400"
                        : "text-foreground"
                    )}
                  >
                    {t(`triggerTypes.${type.value}`)}
                  </div>
                </div>
              </Button>
            ))}
          </div>

          {/* Cron Configuration */}
          {f.triggerType === "cron" && (
            <div className="space-y-4 rounded-lg border border-dashed bg-muted/30 p-3">
              <div className="flex items-center justify-between">
                <Label className="text-sm">
                  {t("useCustomCron") || "Use custom cron expression"}
                </Label>
                <Switch
                  checked={f.useCustomCron}
                  onCheckedChange={(v) => updateForm({ useCustomCron: v })}
                />
              </div>

              {f.useCustomCron ? (
                <div className="space-y-2">
                  <Input
                    value={f.cronExpression}
                    onChange={(e) => handleCronChange(e.target.value)}
                    placeholder="* * * * *"
                    className={cn(
                      "h-10 font-mono text-sm transition-all",
                      f.cronError
                        ? "border-destructive focus:ring-destructive/20"
                        : "focus:ring-2 focus:ring-primary/20"
                    )}
                  />
                  {f.cronError ? (
                    <p className="text-xs text-destructive">{f.cronError}</p>
                  ) : (
                    <div className="space-y-1">
                      <p className="rounded-md bg-green-500/10 px-2 py-1 text-xs text-green-600 dark:text-green-400">
                        {describeCronExpression(f.cronExpression, tCron)}
                      </p>
                      <Button
                        type="button"
                        variant="link"
                        size="xs"
                        onClick={handleFormatCron}
                        className="h-auto p-0 text-[10px] text-muted-foreground"
                      >
                        {t("formatExpression") || "Format expression"}
                      </Button>
                    </div>
                  )}
                </div>
              ) : (
                <Select value={f.cronPreset} onValueChange={handlePresetSelect}>
                  <SelectTrigger className="h-10">
                    <SelectValue placeholder={t("selectSchedule") || "Select a schedule"} />
                  </SelectTrigger>
                  <SelectContent>
                    {CRON_PRESETS.map((preset) => (
                      <SelectItem key={preset.id} value={preset.id}>
                        {isZh ? preset.labelZh : preset.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}

              <div className="space-y-2">
                <Label className="text-sm">{t("timezone") || "Timezone"}</Label>
                <TimezoneSelect
                  value={f.timezone}
                  onValueChange={(value) => updateForm({ timezone: value })}
                  testId="scheduler-task-timezone"
                  triggerClassName="h-10"
                  includeOffset
                  disabled={isSubmitting}
                />
              </div>
            </div>
          )}

          {/* Interval Configuration */}
          {f.triggerType === "interval" && (
            <div className="space-y-2 rounded-lg border border-dashed bg-muted/30 p-3">
              <Label className="text-sm">{t("intervalMinutes") || "Interval (minutes)"}</Label>
              <Input
                type="number"
                min={1}
                value={f.intervalMinutes}
                onChange={(e) => updateForm({ intervalMinutes: parseInt(e.target.value) || 1 })}
                className="h-10 transition-all focus:ring-2 focus:ring-primary/20"
              />
            </div>
          )}

          {/* One-time Configuration */}
          {f.triggerType === "once" && (
            <div className="grid grid-cols-2 gap-3 rounded-lg border border-dashed bg-muted/30 p-3">
              <div className="space-y-2">
                <Label className="text-sm">{t("date") || "Date"}</Label>
                <Input
                  type="date"
                  value={f.runAtDate}
                  onChange={(e) => updateForm({ runAtDate: e.target.value })}
                  className="h-10 transition-all focus:ring-2 focus:ring-primary/20"
                />
              </div>
              <div className="space-y-2">
                <Label className="text-sm">{t("time") || "Time"}</Label>
                <Input
                  type="time"
                  value={f.runAtTime}
                  onChange={(e) => updateForm({ runAtTime: e.target.value })}
                  className="h-10 transition-all focus:ring-2 focus:ring-primary/20"
                />
              </div>
            </div>
          )}

          {/* Event Configuration */}
          {f.triggerType === "event" && (
            <div className="space-y-2 rounded-lg border border-dashed bg-muted/30 p-3">
              <Label className="text-sm">{t("eventType") || "Event Type"}</Label>
              <Input
                value={f.eventType}
                onChange={(e) => updateForm({ eventType: e.target.value, triggerError: null })}
                placeholder={t("eventTypePlaceholder")}
                className="h-10 transition-all focus:ring-2 focus:ring-primary/20"
              />
            </div>
          )}

          {/* Scheduling jitter (recurring triggers only) */}
          {(f.triggerType === "cron" || f.triggerType === "interval") && (
            <div className="space-y-2 rounded-lg border border-dashed bg-muted/30 p-3">
              <Label className="text-sm">{t("jitter.label") || "Jitter (seconds)"}</Label>
              <Input
                type="number"
                min={0}
                value={f.jitterSeconds}
                onChange={(e) =>
                  updateForm({ jitterSeconds: Math.max(0, parseInt(e.target.value) || 0) })
                }
                className="h-10 transition-all focus:ring-2 focus:ring-primary/20"
                data-testid="scheduler-jitter-input"
              />
              <p className="text-[11px] text-muted-foreground">
                {t("jitter.help") ||
                  "Random delay (0–N s) added to each fire to avoid load spikes. 0 disables."}
              </p>
            </div>
          )}

          {/* Trigger validation error */}
          {f.triggerError && <p className="text-xs text-destructive">{f.triggerError}</p>}
        </div>
      </div>

      {/* Lifecycle limits (recurring triggers only) */}
      {(f.triggerType === "cron" || f.triggerType === "interval") && (
        <div className="rounded-xl border bg-gradient-to-br from-card to-card/50 p-3 sm:p-4 shadow-sm">
          <div className="mb-3 flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-amber-500/10">
              <Clock className="h-4 w-4 text-amber-500" />
            </div>
            <div>
              <h3 className="font-semibold">{t("lifecycle.title") || "Lifecycle"}</h3>
              <p className="text-xs text-muted-foreground">
                {t("lifecycle.description") ||
                  "Automatically expire the task after a date or a number of runs"}
              </p>
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="space-y-2">
              <Label className="text-sm">{t("lifecycle.endDate") || "End date"}</Label>
              <Input
                type="date"
                value={f.endAtDate}
                onChange={(e) => updateForm({ endAtDate: e.target.value, triggerError: null })}
                className="h-10 transition-all focus:ring-2 focus:ring-primary/20"
                data-testid="scheduler-end-date-input"
              />
            </div>
            <div className="space-y-2">
              <Label className="text-sm">{t("lifecycle.endTime") || "End time"}</Label>
              <Input
                type="time"
                value={f.endAtTime}
                onChange={(e) => updateForm({ endAtTime: e.target.value, triggerError: null })}
                disabled={!f.endAtDate}
                className="h-10 transition-all focus:ring-2 focus:ring-primary/20"
              />
            </div>
            <div className="space-y-2">
              <Label className="text-sm">{t("lifecycle.maxRuns") || "Max runs"}</Label>
              <Input
                type="number"
                min={0}
                value={f.maxRuns}
                onChange={(e) =>
                  updateForm({ maxRuns: Math.max(0, parseInt(e.target.value) || 0) })
                }
                className="h-10 transition-all focus:ring-2 focus:ring-primary/20"
                data-testid="scheduler-max-runs-input"
              />
            </div>
          </div>
          <p className="mt-2 text-[11px] text-muted-foreground">
            {t("lifecycle.help") ||
              "Leave empty / 0 for no limit. Failed runs count toward the run limit."}
          </p>
        </div>
      )}

      {/* Task Payload Section */}
      <div className="rounded-xl border bg-gradient-to-br from-card to-card/50 p-3 sm:p-4 shadow-sm">
        <div className="mb-4 flex items-start justify-between gap-3">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-purple-500/10">
              <Settings className="h-4 w-4 text-purple-500" />
            </div>
            <div>
              <h3 className="font-semibold">{t("taskPayload") || "Task Payload"}</h3>
              <p className="text-xs text-muted-foreground">
                {f.payloadEditorMode === "structured"
                  ? t("payloadStructuredHelp") ||
                    "Pick the agent / tools / MCP servers / built-in tool toggles for this run."
                  : t("payloadHelp") || "JSON configuration passed to the task executor"}
              </p>
            </div>
          </div>
          {isStructuredEditableTaskType(f.taskType) && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={togglePayloadEditorMode}
              data-testid="scheduler-task-payload-mode-toggle"
            >
              {f.payloadEditorMode === "structured"
                ? t("payloadEditorMode.toJson") || "Edit as JSON"
                : t("payloadEditorMode.toStructured") || "Use structured editor"}
            </Button>
          )}
        </div>

        {f.payloadEditorMode === "structured" && isChatLikeTaskType(f.taskType) && (
          <ChatPayloadEditor
            taskType={f.taskType}
            taskName={f.name}
            draft={f.chatLikeDraft}
            onDraftChange={(draft) => {
              updateForm({
                chatLikeDraft: draft,
                payloadError: null,
                payloadFieldErrors: {},
              })
            }}
            errors={f.payloadFieldErrors}
            disabled={isSubmitting}
            testId="scheduler-task-chat-editor"
          />
        )}

        {f.payloadEditorMode === "structured" && f.taskType === "external-agent" && (
          <ExternalAgentPayloadEditor
            draft={f.externalAgentDraft}
            onDraftChange={(draft) =>
              updateForm({
                externalAgentDraft: draft,
                payloadError: null,
                payloadFieldErrors: {},
              })
            }
            errors={f.payloadFieldErrors}
            disabled={isSubmitting}
            testId="scheduler-task-external-agent-editor"
          />
        )}

        {f.payloadEditorMode === "structured" && f.taskType === "agent-team" && (
          <TeamPayloadEditor
            draft={f.agentTeamDraft}
            onDraftChange={(draft) =>
              updateForm({ agentTeamDraft: draft, payloadError: null, payloadFieldErrors: {} })
            }
            errors={f.payloadFieldErrors}
            disabled={isSubmitting}
            testId="scheduler-task-team-editor"
          />
        )}

        {f.payloadEditorMode === "structured" && f.taskType === "goal" && (
          <GoalPayloadEditor
            draft={f.goalDraft}
            onDraftChange={(draft) =>
              updateForm({ goalDraft: draft, payloadError: null, payloadFieldErrors: {} })
            }
            errors={f.payloadFieldErrors}
            disabled={isSubmitting}
            testId="scheduler-task-goal-editor"
          />
        )}

        {f.payloadEditorMode === "structured" && f.taskType === "plan" && (
          <PlanPayloadEditor
            draft={f.planDraft}
            onDraftChange={(draft) =>
              updateForm({ planDraft: draft, payloadError: null, payloadFieldErrors: {} })
            }
            errors={f.payloadFieldErrors}
            disabled={isSubmitting}
            testId="scheduler-task-plan-editor"
          />
        )}

        {f.payloadEditorMode === "structured" && f.taskType === "workflow" && (
          <WorkflowPayloadEditor
            draft={f.workflowDraft}
            onDraftChange={(draft) =>
              updateForm({ workflowDraft: draft, payloadError: null, payloadFieldErrors: {} })
            }
            errors={f.payloadFieldErrors}
            disabled={isSubmitting}
            testId="scheduler-task-workflow-editor"
          />
        )}

        {f.payloadEditorMode === "structured" && f.taskType === "im-push" && (
          <ImPushPayloadEditor
            draft={f.imPushDraft}
            onDraftChange={(draft) =>
              updateForm({ imPushDraft: draft, payloadError: null, payloadFieldErrors: {} })
            }
            errors={f.payloadFieldErrors}
            disabled={isSubmitting}
            testId="scheduler-task-im-push-editor"
          />
        )}

        {(f.payloadEditorMode === "json" || !isStructuredEditableTaskType(f.taskType)) && (
          <div className="space-y-2">
            <Textarea
              value={f.payloadJson}
              onChange={(e) => updateForm({ payloadJson: e.target.value, payloadError: null })}
              placeholder={t("payload.jsonPlaceholder")}
              className={cn(
                "min-h-[100px] resize-none font-mono text-sm transition-all",
                f.payloadError
                  ? "border-destructive focus:ring-destructive/20"
                  : "focus:ring-2 focus:ring-primary/20"
              )}
              rows={4}
              data-testid="scheduler-task-payload-json"
            />
          </div>
        )}
        {f.payloadError && <p className="mt-2 text-xs text-destructive">{f.payloadError}</p>}
      </div>

      {/* Notifications Section */}
      <div className="rounded-xl border bg-gradient-to-br from-card to-card/50 p-3 sm:p-4 shadow-sm">
        <div className="mb-4 flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-amber-500/10">
            <Bell className="h-4 w-4 text-amber-500" />
          </div>
          <h3 className="font-semibold">{t("notifications") || "Notifications"}</h3>
        </div>

        <div className="space-y-4">
          <div className="grid gap-2">
            {[
              {
                key: "start",
                label: t("notifyOnStart") || "Notify on start",
                checked: f.notifyOnStart,
                field: "notifyOnStart" as const,
              },
              {
                key: "complete",
                label: t("notifyOnComplete") || "Notify on complete",
                checked: f.notifyOnComplete,
                field: "notifyOnComplete" as const,
              },
              {
                key: "error",
                label: t("notifyOnError") || "Notify on error",
                checked: f.notifyOnError,
                field: "notifyOnError" as const,
              },
              {
                key: "progress",
                label: t("notifyOnProgress"),
                checked: f.notifyOnProgress,
                field: "notifyOnProgress" as const,
              },
            ].map((item) => (
              <div
                key={item.key}
                className={cn(
                  "flex items-center justify-between rounded-lg border px-3 py-2.5 transition-all",
                  item.checked
                    ? "border-amber-500/30 bg-amber-500/5"
                    : "border-border bg-background/50"
                )}
              >
                <Label className="cursor-pointer text-sm">{item.label}</Label>
                <Switch
                  checked={item.checked}
                  onCheckedChange={(v) => updateForm({ [item.field]: v })}
                />
              </div>
            ))}
          </div>

          {f.notifyOnProgress && (
            <p className="text-[10px] text-muted-foreground" data-testid="notify-on-progress-hint">
              {t("notifyOnProgressHint")}
            </p>
          )}

          <div className="space-y-2">
            <Label className="text-sm font-medium">{t("notificationChannels") || "Channels"}</Label>
            <div className="flex gap-2">
              {(["desktop", "toast", "im"] as NotificationChannel[]).map((channel) => (
                <div key={channel} className="flex-1 space-y-1">
                  <Button
                    type="button"
                    variant={f.notificationChannels.includes(channel) ? "secondary" : "outline"}
                    aria-pressed={f.notificationChannels.includes(channel)}
                    onClick={() => toggleChannel(channel)}
                    className={cn(
                      "w-full rounded-lg border px-3 py-2 text-sm font-medium capitalize transition-all",
                      "hover:border-amber-500/50 hover:bg-amber-500/5",
                      f.notificationChannels.includes(channel)
                        ? "border-amber-500 bg-amber-500/10 text-amber-600 dark:text-amber-400"
                        : "border-border bg-background/50 text-muted-foreground"
                    )}
                  >
                    {channel}
                  </Button>
                  {f.notificationChannels.includes(channel) && (
                    <Button
                      type="button"
                      variant="link"
                      size="xs"
                      onClick={() => handleTestNotification(channel)}
                      disabled={f.isTestingNotification}
                      className="h-auto w-full p-0 text-[10px] text-muted-foreground"
                    >
                      {f.isTestingNotification
                        ? t("testing") || "Testing..."
                        : t("testChannel") || "Test"}
                    </Button>
                  )}
                </div>
              ))}
            </div>
            {f.notificationChannels.includes("im") && (
              <div className="space-y-1">
                <Label
                  htmlFor="notification-im-conversation"
                  className="text-xs font-medium text-muted-foreground"
                >
                  {t("notifyImConversation")}
                </Label>
                <Input
                  id="notification-im-conversation"
                  value={f.notificationImConversationKey}
                  onChange={(e) => updateForm({ notificationImConversationKey: e.target.value })}
                  placeholder={t("notifyImConversationPlaceholder")}
                />
                <p className="text-[10px] text-muted-foreground">{t("notifyImConversationHint")}</p>
              </div>
            )}
            {f.notificationTestResult && (
              <p
                className={cn(
                  "text-xs px-2 py-1 rounded-md",
                  f.notificationTestResult.success
                    ? "bg-green-500/10 text-green-600 dark:text-green-400"
                    : "bg-red-500/10 text-red-600 dark:text-red-400"
                )}
              >
                {f.notificationTestResult.success
                  ? `${f.notificationTestResult.channel}: ${t("testSuccess") || "Test passed"}`
                  : `${f.notificationTestResult.channel}: ${f.notificationTestResult.error || t("testFailed") || "Test failed"}`}
              </p>
            )}
          </div>
        </div>
      </div>

      {/* Advanced Settings */}
      <Collapsible open={f.showAdvanced} onOpenChange={(v) => updateForm({ showAdvanced: v })}>
        <CollapsibleTrigger asChild>
          <Button
            type="button"
            variant="outline"
            className={cn(
              "h-auto w-full justify-between py-3",
              f.showAdvanced ? "bg-muted/30" : "bg-background"
            )}
          >
            <span className="flex items-center gap-2">
              <Settings className="h-4 w-4 text-muted-foreground" />
              {t("advancedSettings") || "Advanced Settings"}
            </span>
            {f.showAdvanced ? (
              <ChevronUp className="h-4 w-4" />
            ) : (
              <ChevronDown className="h-4 w-4" />
            )}
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent className="mt-2 rounded-xl border bg-muted/20 p-3 sm:p-4">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="space-y-2">
              <Label className="text-xs font-medium text-muted-foreground">
                {t("timeoutMs") || "Timeout (ms)"}
              </Label>
              <Input
                type="number"
                min={1000}
                value={f.taskTimeout}
                onChange={(e) => updateForm({ taskTimeout: parseInt(e.target.value) || 300000 })}
                className="h-9 text-sm transition-all focus:ring-2 focus:ring-primary/20"
              />
            </div>
            <div className="space-y-2">
              <Label className="text-xs font-medium text-muted-foreground">
                {t("maxRetries") || "Max Retries"}
              </Label>
              <Input
                type="number"
                min={0}
                max={10}
                value={f.maxRetries}
                onChange={(e) => updateForm({ maxRetries: parseInt(e.target.value) || 0 })}
                className="h-9 text-sm transition-all focus:ring-2 focus:ring-primary/20"
              />
            </div>
            <div className="space-y-2">
              <Label className="text-xs font-medium text-muted-foreground">
                {t("retryDelayMs") || "Retry Delay (ms)"}
              </Label>
              <Input
                type="number"
                min={0}
                value={f.retryDelay}
                onChange={(e) => updateForm({ retryDelay: parseInt(e.target.value) || 0 })}
                className="h-9 text-sm transition-all focus:ring-2 focus:ring-primary/20"
              />
            </div>
            {/* The retry delay grows exponentially and this caps it. The
                scheduler has always honoured it (`applyRetryBackoff`), but the
                only way to set it was to hand-edit the persisted row. */}
            <div className="space-y-2">
              <Label className="text-xs font-medium text-muted-foreground">
                {t("maxRetryDelayMs")}
              </Label>
              <Input
                type="number"
                min={0}
                data-testid="task-max-retry-delay"
                value={f.maxRetryDelay}
                onChange={(e) => updateForm({ maxRetryDelay: parseInt(e.target.value) || 0 })}
                className="h-9 text-sm transition-all focus:ring-2 focus:ring-primary/20"
              />
            </div>
          </div>
          <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label className="text-xs font-medium text-muted-foreground">
                {t("maxMissedRuns") || "Max Missed Runs"}
              </Label>
              <Input
                type="number"
                min={0}
                value={f.maxMissedRuns}
                onChange={(e) => updateForm({ maxMissedRuns: parseInt(e.target.value) || 0 })}
                className="h-9 text-sm transition-all focus:ring-2 focus:ring-primary/20"
              />
            </div>
            <div className="space-y-2 rounded-lg border bg-background/50 px-3 py-2.5">
              <div className="flex items-center justify-between">
                <Label className="text-xs font-medium text-muted-foreground">
                  {t("runMissedOnStartup") || "Run missed on startup"}
                </Label>
                <Switch
                  checked={f.runMissedOnStartup}
                  onCheckedChange={(v) => updateForm({ runMissedOnStartup: v })}
                />
              </div>
            </div>
            <div className="space-y-2 sm:col-span-2">
              <Label className="text-xs font-medium text-muted-foreground">
                {t("overlapPolicies.label") || "Overlap policy"}
              </Label>
              <Select
                value={f.overlapPolicy}
                onValueChange={(v) => updateForm({ overlapPolicy: v as TaskOverlapPolicy })}
              >
                <SelectTrigger
                  className="h-9 text-sm"
                  data-testid="scheduler-overlap-policy-trigger"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {OVERLAP_POLICIES.map((policy) => (
                    <SelectItem key={policy} value={policy}>
                      {t(`overlapPolicies.${OVERLAP_POLICY_KEYS[policy]}.title`) || policy}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-[11px] text-muted-foreground">
                {t(`overlapPolicies.${OVERLAP_POLICY_KEYS[f.overlapPolicy]}.desc`) || ""}
              </p>
            </div>
            {f.overlapPolicy === "queue-all" && (
              <div className="space-y-2">
                <Label className="text-xs font-medium text-muted-foreground">
                  {t("overlapPolicies.maxQueueSize") || "Max queued starts"}
                </Label>
                <Input
                  type="number"
                  min={1}
                  value={f.maxQueueSize}
                  onChange={(e) =>
                    updateForm({ maxQueueSize: Math.max(1, parseInt(e.target.value) || 1) })
                  }
                  className="h-9 text-sm transition-all focus:ring-2 focus:ring-primary/20"
                  data-testid="scheduler-max-queue-size-input"
                />
              </div>
            )}
            <div className="space-y-2">
              <Label className="text-xs font-medium text-muted-foreground">
                {t("pauseAfterFailures.label") || "Auto-pause after consecutive failures"}
              </Label>
              <Input
                type="number"
                min={0}
                value={f.pauseAfterConsecutiveFailures}
                onChange={(e) =>
                  updateForm({
                    pauseAfterConsecutiveFailures: Math.max(0, parseInt(e.target.value) || 0),
                  })
                }
                className="h-9 text-sm transition-all focus:ring-2 focus:ring-primary/20"
                data-testid="scheduler-pause-after-failures-input"
              />
              <p className="text-[11px] text-muted-foreground">
                {t("pauseAfterFailures.help") || "0 disables auto-pause"}
              </p>
            </div>
            <div className="space-y-2">
              <Label className="text-xs font-medium text-muted-foreground">
                {t("catchupWindow.label") || "Catch-up window (minutes)"}
              </Label>
              <Input
                type="number"
                min={0}
                value={f.catchupWindowMinutes}
                onChange={(e) =>
                  updateForm({
                    catchupWindowMinutes: Math.max(0, parseInt(e.target.value) || 0),
                  })
                }
                className="h-9 text-sm transition-all focus:ring-2 focus:ring-primary/20"
                data-testid="scheduler-catchup-window-input"
              />
              <p className="text-[11px] text-muted-foreground">
                {t("catchupWindow.help") ||
                  "Missed runs older than this are skipped instead of re-run. 0 = no limit."}
              </p>
            </div>
          </div>

          {/* Task Dependencies */}
          {existingTasks && existingTasks.length > 0 && (
            <div className="mt-3 space-y-2">
              <Label className="text-xs font-medium text-muted-foreground">
                {t("dependencies.title") || "Task Dependencies"}
              </Label>
              <p className="text-[11px] text-muted-foreground">
                {t("dependencies.description") ||
                  "Tasks that must complete successfully before this task runs"}
              </p>
              <Select
                value=""
                onValueChange={(taskId) => {
                  if (taskId && !f.dependsOn.includes(taskId)) {
                    updateForm({ dependsOn: [...f.dependsOn, taskId] })
                  }
                }}
              >
                <SelectTrigger className="h-9 text-xs">
                  <SelectValue placeholder={t("dependencies.add") || "Add dependency"} />
                </SelectTrigger>
                <SelectContent>
                  {existingTasks
                    .filter((task) => !f.dependsOn.includes(task.id))
                    .map((task) => (
                      <SelectItem key={task.id} value={task.id}>
                        <span className="flex items-center gap-2">
                          <span
                            className={cn(
                              "h-1.5 w-1.5 rounded-full",
                              task.status === "active"
                                ? "bg-green-500"
                                : task.status === "paused"
                                  ? "bg-yellow-500"
                                  : "bg-gray-400"
                            )}
                          />
                          {task.name}
                        </span>
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
              {f.dependsOn.length > 0 ? (
                <div className="flex flex-wrap gap-1.5">
                  {f.dependsOn.map((depId) => {
                    const depTask = existingTasks.find((t) => t.id === depId)
                    return (
                      <Badge
                        key={depId}
                        variant="secondary"
                        className="gap-1 rounded-full py-1 text-[11px]"
                      >
                        {depTask?.name || depId}
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-xs"
                          onClick={() =>
                            updateForm({ dependsOn: f.dependsOn.filter((id) => id !== depId) })
                          }
                          className="ml-0.5 text-muted-foreground hover:text-destructive"
                        >
                          ×
                        </Button>
                      </Badge>
                    )
                  })}
                </div>
              ) : (
                <p className="text-[11px] text-muted-foreground/70">
                  {t("dependencies.none") || "No dependencies configured"}
                </p>
              )}
            </div>
          )}

          {/* Forward chains — run other tasks after this one finishes */}
          {existingTasks && existingTasks.length > 0 && (
            <>
              <TaskChipSelect
                label={t("successChain.title") || "Run on success"}
                description={
                  t("successChain.description") ||
                  "Tasks started after this task completes successfully"
                }
                placeholder={t("successChain.add") || "Add task"}
                emptyText={t("successChain.none") || "No success chain configured"}
                testId="scheduler-success-chain"
                selected={f.onSuccessTaskIds}
                onChange={(ids) => updateForm({ onSuccessTaskIds: ids })}
                existingTasks={existingTasks}
              />
              <TaskChipSelect
                label={t("failureChain.title") || "Run on failure"}
                description={
                  t("failureChain.description") ||
                  "Tasks started after this task fails terminally (all retries exhausted)"
                }
                placeholder={t("failureChain.add") || "Add task"}
                emptyText={t("failureChain.none") || "No failure chain configured"}
                testId="scheduler-failure-chain"
                selected={f.onFailureTaskIds}
                onChange={(ids) => updateForm({ onFailureTaskIds: ids })}
                existingTasks={existingTasks}
              />
            </>
          )}
        </CollapsibleContent>
      </Collapsible>

      {/* Actions */}
      <div className="flex flex-col-reverse sm:flex-row gap-2 sm:gap-3 pt-2">
        <Button
          variant="outline"
          onClick={onCancel}
          disabled={isSubmitting}
          className="flex-1 h-10 sm:h-11"
        >
          {t("cancel") || "Cancel"}
        </Button>
        <Button
          onClick={handleSubmit}
          disabled={isSubmitting || !f.name.trim()}
          data-testid="scheduler-task-submit"
          className="flex-1 h-10 sm:h-11 bg-gradient-to-r from-primary to-primary/80 shadow-md transition-all hover:shadow-lg"
        >
          {isSubmitting ? t("saving") || "Saving..." : t("save") || "Save Task"}
        </Button>
      </div>
    </div>
  )
}
