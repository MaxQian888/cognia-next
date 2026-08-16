import { z } from "zod"

const stringArray = z.array(z.string())
const emptyRequest = z.object({})
const browserSession = z.object({ browserSessionId: z.string().min(1) })

const browserWaitOptions = z.object({
  mode: z.enum(["appear", "disappear"]).optional(),
  timeoutMs: z.number().int().nonnegative().optional(),
  intervalMs: z.number().int().nonnegative().optional(),
})

const browserNetworkIdleOptions = z.object({
  timeoutMs: z.number().int().nonnegative().optional(),
  idleMs: z.number().int().nonnegative().optional(),
  intervalMs: z.number().int().nonnegative().optional(),
})

const browserLoadOptions = z.object({
  targetUrl: z.string().optional(),
  fromUrl: z.string().optional(),
  timeoutMs: z.number().int().nonnegative().optional(),
  intervalMs: z.number().int().nonnegative().optional(),
  initialDelayMs: z.number().int().nonnegative().optional(),
})

const jobOwner = z.union([
  z.object({ session: z.object({ sessionId: z.string().min(1) }) }),
  z.object({ scheduledTask: z.object({ taskId: z.string().min(1) }) }),
  z.literal("app"),
])

const monitorCondition = z.union([
  z.object({ jobExit: z.object({ jobId: z.string().min(1) }) }),
  z.object({
    jobOutput: z.object({ jobId: z.string().min(1), pattern: z.string() }),
  }),
  z.object({
    shellPredicate: z.object({
      command: z.string().min(1),
      program: z.string().min(1),
      args: stringArray,
      cwd: z.string().min(1),
      env: z.record(z.string(), z.string()).optional(),
      intervalMs: z.number().int().positive().optional(),
    }),
  }),
  z.object({ upstream: z.object({ source: z.string().min(1), id: z.string().min(1) }) }),
])

const jsonArrayItem = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(
    z.union([
      z.string(),
      z.number(),
      z.boolean(),
      z.null(),
      z.record(z.string(), z.unknown()),
    ])
  ),
  z.record(z.string(), z.unknown()),
])

const profileEntity = z.object({
  name: z.string().min(1),
  aliases: stringArray,
  role: z.enum(["person", "team", "project", "system", "concept"]),
  relation: z.string().optional(),
  firstSeenChunkId: z.string().min(1),
  pinned: z.boolean().optional(),
})

const playbook = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  trigger: z.string().min(1),
  steps: z.array(
    z.object({ order: z.number().int().nonnegative(), action: z.string(), rationale: z.string().optional() })
  ),
  examples: z.array(z.object({ sourceChunkIds: stringArray, outcome: z.string() })),
  confidence: z.number().min(0).max(1),
  promotedToSkillId: z.string().optional(),
  pinned: z.boolean().optional(),
})

const styleSample = z.object({
  id: z.string().min(1),
  contextLabel: z.string(),
  original: z.string(),
  summary: z.string(),
  sourceChunkId: z.string().min(1),
  tone: stringArray,
  addedAt: z.number(),
  addedBy: z.enum(["distill", "manual"]),
  embedding: z.number().array().optional(),
  pinned: z.boolean().optional(),
})

const scheduledTaskTypes = [
  "workflow",
  "agent",
  "sync",
  "backup",
  "custom",
  "plugin",
  "script",
  "background-command",
  "monitor",
  "test",
  "ai-generation",
  "chat",
  "im-push",
  "skill",
  "external-agent",
  "agent-team",
  "goal",
  "plan",
  "twin",
  "connection:scheduled:digest",
  "connection:outbound:send",
  "connection:housekeeping:clock",
  "connection:housekeeping:outbound-retention",
  "connection:housekeeping:callback-bindings",
  "connection:housekeeping:execution-runs",
  "connection:presence:refresh",
  "wiki-rebuild",
  "wiki-lint",
  "radar-report",
  "provider-diagnostics-refresh",
]

const scheduledTaskType = z.enum(scheduledTaskTypes)
const scheduledTaskStatus = z.enum(["active", "paused", "disabled", "expired"])
const taskTriggerSource = z.enum([
  "schedule",
  "run-now",
  "retry",
  "event",
  "dependency",
  "catch-up",
  "remote",
  "backfill",
])

const triggerCommon = {
  timezone: z.string().optional(),
  dependsOn: stringArray.optional(),
  jitterMs: z.number().int().nonnegative().optional(),
}

const taskTrigger = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("cron"),
    cronExpression: z.string().min(1),
    ...triggerCommon,
  }),
  z.object({
    type: z.literal("interval"),
    intervalMs: z.number().int().positive(),
    ...triggerCommon,
  }),
  z.object({ type: z.literal("once"), runAt: z.string().min(1), ...triggerCommon }),
  z.object({
    type: z.literal("event"),
    eventType: z.string().min(1),
    eventSource: z.string().optional(),
    ...triggerCommon,
  }),
])

const taskExecutionConfig = z.object({
  timeout: z.number().int().positive().optional(),
  maxRetries: z.number().int().nonnegative().optional(),
  retryDelay: z.number().int().nonnegative().optional(),
  maxRetryDelay: z.number().int().nonnegative().optional(),
  runMissedOnStartup: z.boolean().optional(),
  maxMissedRuns: z.number().int().nonnegative().optional(),
  allowConcurrent: z.boolean().optional(),
  overlapPolicy: z.enum(["allow", "skip", "queue-one", "queue-all", "cancel-previous"]).optional(),
  maxQueueSize: z.number().int().positive().optional(),
  maxRuns: z.number().int().positive().optional(),
  pauseAfterConsecutiveFailures: z.number().int().positive().optional(),
  catchupWindowMs: z.number().int().nonnegative().optional(),
})

const taskNotification = z.object({
  onStart: z.boolean().optional(),
  onComplete: z.boolean().optional(),
  onError: z.boolean().optional(),
  onProgress: z.boolean().optional(),
  channels: z.enum(["desktop", "toast", "webhook", "im", "none"]).array().optional(),
  webhookUrl: z.string().optional(),
  imTarget: z.object({ conversationKey: z.string().min(1) }).optional(),
})

const taskCreator = z.object({
  kind: z.enum(["user", "agent", "plugin"]),
  sessionId: z.string().optional(),
  pluginId: z.string().optional(),
})

const taskPayload = z.record(z.string(), z.unknown())
const createScheduledTaskInput = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  type: scheduledTaskType,
  trigger: taskTrigger,
  payload: taskPayload.optional(),
  config: taskExecutionConfig.optional(),
  notification: taskNotification.optional(),
  createdBy: taskCreator.optional(),
  tags: stringArray.optional(),
  endAt: z.string().optional(),
  onSuccessTaskIds: stringArray.optional(),
  onFailureTaskIds: stringArray.optional(),
})

const updateScheduledTaskInput = z.object({
  name: z.string().optional(),
  description: z.string().optional(),
  trigger: taskTrigger.optional(),
  payload: taskPayload.optional(),
  config: taskExecutionConfig.optional(),
  notification: taskNotification.optional(),
  status: scheduledTaskStatus.optional(),
  tags: stringArray.optional(),
  endAt: z.string().nullable().optional(),
  onSuccessTaskIds: stringArray.optional(),
  onFailureTaskIds: stringArray.optional(),
})

const scheduledTask = createScheduledTaskInput.extend({
  id: z.string().min(1),
  config: taskExecutionConfig.extend({
    timeout: z.number().int().positive(),
    maxRetries: z.number().int().nonnegative(),
    retryDelay: z.number().int().nonnegative(),
    runMissedOnStartup: z.boolean(),
  }),
  notification: taskNotification.extend({
    onStart: z.boolean(),
    onComplete: z.boolean(),
    onError: z.boolean(),
  }),
  status: scheduledTaskStatus,
  runCount: z.number().int().nonnegative(),
  successCount: z.number().int().nonnegative(),
  failureCount: z.number().int().nonnegative(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  lastRunAt: z.string().optional(),
  nextRunAt: z.string().optional(),
  lastError: z.string().optional(),
  lastTerminalReason: z.string().optional(),
  lastTerminalAt: z.string().optional(),
  consecutiveFailures: z.number().int().nonnegative().optional(),
})

const schemas = {
  background_job_list: z.object({ owner: jobOwner.optional() }),
  background_job_read: z.object({
    jobId: z.string().min(1),
    fromOffset: z.number().int().nonnegative().optional(),
    maxBytes: z.number().int().positive().optional(),
  }),
  background_job_kill: z.object({ jobId: z.string().min(1) }),
  background_monitor_list: z.object({ owner: jobOwner.optional() }),
  background_monitor_cancel: z.object({ monitorId: z.string().min(1) }),
  background_job_spawn_scheduled: z.object({
    taskId: z.string().min(1),
    command: z.string().min(1),
    cwd: z.string().min(1),
    label: z.string().optional(),
  }),
  background_monitor_register_scheduled: z.object({
    taskId: z.string().min(1),
    condition: monitorCondition,
    expiresAtMs: z.number().int().optional(),
    label: z.string().optional(),
  }),

  browser_capability: z.object({ workspaceId: z.string().min(1), userEnabled: z.boolean() }),
  browser_session_ensure: z.object({
    chatSessionId: z.string().min(1),
    parentChatSessionId: z.string().optional(),
    workspaceId: z.string().min(1),
    backendPreference: z.enum(["embedded", "remote-chromium"]).optional(),
    userEnabled: z.boolean(),
    profileId: z.string().optional(),
    domainGrants: stringArray.optional(),
  }),
  browser_session_get: browserSession,
  browser_session_close: browserSession,
  browser_navigate: browserSession.extend({ url: z.string().min(1) }),
  browser_snapshot: browserSession.extend({
    options: z.object({ includeText: z.boolean().optional() }).optional(),
  }),
  browser_new_page: browserSession.extend({ url: z.string().min(1).optional() }),
  browser_act: browserSession.extend({
    ref: z.string().min(1),
    action: z.string().min(1),
    args: z.record(z.string(), z.unknown()),
  }),
  browser_drag: browserSession.extend({
    sourceRef: z.string().min(1),
    targetRef: z.string().min(1),
  }),
  browser_handle_dialog: browserSession.extend({
    accept: z.boolean(),
    promptText: z.string().optional(),
  }),
  browser_press_key: browserSession.extend({
    key: z.string().min(1),
    ref: z.string().optional(),
  }),
  browser_scroll: browserSession.extend({
    reference: z.string().optional(),
    direction: z.enum(["up", "down", "left", "right", "top", "bottom"]).optional(),
    amount: z.number().optional(),
  }),
  browser_evaluate: browserSession.extend({ expression: z.string().min(1) }),
  browser_read_console: browserSession,
  browser_read_network: browserSession,
  browser_back: browserSession,
  browser_forward: browserSession,
  browser_reload: browserSession,
  browser_stop: browserSession,
  browser_get_page: browserSession,
  browser_pages: browserSession,
  browser_switch_page: browserSession.extend({ pageId: z.string().min(1) }),
  browser_close_page: browserSession.extend({ pageId: z.string().min(1) }),
  browser_wait_for: browserSession.extend({
    text: z.string().optional(),
    selector: z.string().optional(),
    networkIdle: z.boolean().optional(),
    options: z.union([browserWaitOptions, browserNetworkIdleOptions]).optional(),
  }),
  browser_wait_for_load: browserSession.extend({ options: browserLoadOptions.optional() }),
  browser_screenshot: browserSession.extend({
    options: z
      .object({
        scope: z.enum(["viewport", "fullPage", "element"]).optional(),
        ref: z.string().min(1).optional(),
      })
      .optional(),
  }),
  browser_set_files: browserSession.extend({
    ref: z.string().min(1),
    paths: stringArray,
  }),
  browser_downloads: browserSession,
  browser_set_zoom: browserSession.extend({ zoom: z.number().positive() }),
  browser_find: browserSession.extend({
    query: z.string(),
    options: z
      .object({ forward: z.boolean().optional(), matchCase: z.boolean().optional() })
      .optional(),
  }),
  browser_find_clear: browserSession,

  external_bridge_relay_disable: emptyRequest,
  host_capabilities: emptyRequest,
  host_feature_manifest: emptyRequest,
  integration_ingress_nack: z.object({
    route_id: z.string().min(1).describe("Also accepted as routeId."),
    delivery_id: z.string().min(1).describe("Also accepted as deliveryId."),
  }),

  provider_diagnostics_status: z.object({ providerId: z.string().optional() }),
  provider_diagnostics_history: z.object({
    providerId: z.string().optional(),
    limit: z.number().int().min(1).max(200).optional(),
  }),
  provider_diagnostics_start: z.object({
    targets: z
      .array(
        z.object({
          providerId: z.string().min(1),
          modelId: z.string().min(1).optional(),
          capability: z.enum(["probe", "text-generation", "embedding"]),
        })
      )
      .min(1)
      .max(20),
    mode: z.enum(["quick", "precise"]).optional(),
    costConfirmed: z.boolean().optional(),
    confirmedRequestLimit: z.number().int().positive(),
    confirmedMaxEstimatedCostUsd: z.number().nonnegative(),
  }),
  provider_diagnostics_cancel: z.object({ jobId: z.string().min(1) }),

  // `generation` is required by both arms (rpc/plugins.rs) so the host can
  // reject a call aimed at a since-reloaded Python runtime. It was declared in
  // protocol/companion-request-schemas.json but not here, and these Zod
  // contracts override that file — so the generated schema forbade the one
  // field the arm demands, leaving both commands uncallable by any payload.
  plugin_python_call: z.object({
    pluginId: z.string().min(1),
    functionName: z.string().min(1),
    args: jsonArrayItem.array(),
    generation: z.string().min(1),
  }),
  plugin_python_module_call: z.object({
    pluginId: z.string().min(1),
    moduleName: z.string().min(1),
    functionName: z.string().min(1),
    args: jsonArrayItem.array(),
    generation: z.string().min(1),
  }),

  // Both arms read an optional field the published schema never modelled, and
  // because these contracts are enforced at runtime with
  // `additionalProperties: false`, sending it was a 422 rather than a
  // no-op. `generatedFiles` carries the manifest/entry files the installer
  // synthesises for a repo that ships none; `rules` carries the per-domain
  // method and path restrictions that narrow the flat `domains` allowlist —
  // so without it the caller could widen network access but never constrain it.
  plugin_install_from_github: z.object({
    repo: z.string().min(1),
    gitRef: z.string().min(1).optional(),
    subdir: z.string().min(1).optional(),
    generatedFiles: z.record(z.string(), z.string()).optional(),
  }),
  plugin_set_network_allowlist: z.object({
    pluginId: z.string().min(1),
    domains: z.string().array(),
    rules: z
      .object({
        domain: z.string().min(1),
        methods: z.string().array(),
        paths: z.string().array(),
      })
      .array()
      .optional(),
  }),

  twin_profile_update: z.discriminatedUnion("op", [
    z.object({ twinId: z.string().min(1), op: z.literal("setVoiceSummary"), voiceSummary: z.string() }),
    z.object({ twinId: z.string().min(1), op: z.literal("reset") }),
    z.object({ twinId: z.string().min(1), op: z.literal("addEntity"), entity: profileEntity }),
    z.object({ twinId: z.string().min(1), op: z.literal("updateEntity"), name: z.string().min(1), entity: profileEntity }),
    z.object({ twinId: z.string().min(1), op: z.literal("removeEntity"), name: z.string().min(1) }),
    z.object({ twinId: z.string().min(1), op: z.literal("setEntityPinned"), name: z.string().min(1), pinned: z.boolean() }),
    z.object({ twinId: z.string().min(1), op: z.literal("addPlaybook"), playbook }),
    z.object({ twinId: z.string().min(1), op: z.literal("updatePlaybook"), playbookId: z.string().min(1), playbook }),
    z.object({ twinId: z.string().min(1), op: z.literal("removePlaybook"), playbookId: z.string().min(1) }),
    z.object({ twinId: z.string().min(1), op: z.literal("setPlaybookPinned"), playbookId: z.string().min(1), pinned: z.boolean() }),
    z.object({ twinId: z.string().min(1), op: z.literal("addStyleSample"), sample: styleSample }),
    z.object({ twinId: z.string().min(1), op: z.literal("updateStyleSample"), sampleId: z.string().min(1), sample: styleSample }),
    z.object({ twinId: z.string().min(1), op: z.literal("removeStyleSample"), sampleId: z.string().min(1) }),
    z.object({ twinId: z.string().min(1), op: z.literal("setStyleSamplePinned"), sampleId: z.string().min(1), pinned: z.boolean() }),
  ]),

  scheduled_task_list: z.object({
    filter: z
      .object({
        types: scheduledTaskType.array().optional(),
        statuses: scheduledTaskStatus.array().optional(),
        status: scheduledTaskStatus.optional(),
        tags: stringArray.optional(),
        search: z.string().optional(),
      })
      .optional(),
  }),
  scheduled_task_get: z.object({ taskId: z.string().min(1) }),
  scheduled_task_runs: z.object({
    taskId: z.string().optional(),
    limit: z.number().int().min(1).max(200).optional(),
    beforeStartedAt: z.string().optional(),
  }),
  scheduled_task_statistics: emptyRequest,
  scheduled_task_upcoming: z.object({ limit: z.number().int().min(1).max(100).optional() }),
  scheduled_task_export: z.object({ taskIds: stringArray.optional() }),
  scheduled_task_create: z.object({ input: createScheduledTaskInput }),
  scheduled_task_update: z.object({
    taskId: z.string().min(1),
    input: updateScheduledTaskInput,
  }),
  scheduled_task_delete: z.object({ taskId: z.string().min(1) }),
  scheduled_task_pause: z.object({ taskId: z.string().min(1) }),
  scheduled_task_resume: z.object({ taskId: z.string().min(1) }),
  scheduled_task_run_now: z.object({
    taskId: z.string().min(1),
    triggerSource: taskTriggerSource.optional(),
  }),
  scheduled_task_backfill: z.object({
    taskId: z.string().min(1),
    start: z.string().min(1),
    end: z.string().min(1),
  }),
  scheduled_task_import: z.object({
    data: z.object({ version: z.number().int(), tasks: scheduledTask.array() }),
    mode: z.enum(["merge", "replace"]).optional(),
  }),
  scheduled_task_cleanup: z.object({ maxAgeDays: z.number().int().positive().optional() }),
  scheduled_task_emit_event: z.object({
    eventType: z.string().min(1),
    eventSource: z.string().optional(),
    data: z.record(z.string(), z.unknown()).optional(),
  }),
}

function withoutDialect(schema) {
  const { $schema: _dialect, ...result } = schema
  return result
}

export function buildCompanionRequestSchemaContracts() {
  return new Map(
    Object.entries(schemas).map(([name, schema]) => [
      name,
      withoutDialect(z.toJSONSchema(schema, { io: "output" })),
    ])
  )
}
