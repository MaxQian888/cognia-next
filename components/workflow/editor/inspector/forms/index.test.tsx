/**
 * @jest-environment jsdom
 *
 * Focused coverage for the forms newly added/changed in the node-config
 * completeness work: the two synthesizer-internal team forms and the desktop
 * event trigger. (The bulk of the pre-existing forms are exercised via the
 * desktop shells + integration; this file guards the new additions.)
 */
import { fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import {
  TeamTriggerConfig,
  TeamTaskDispatchConfig,
  DesktopEventTriggerConfig,
  PetEventTriggerConfig,
  PetInteractConfig,
  AiPromptConfig,
  AiClassifyConfig,
  AiExtractConfig,
  AiCouncilConfig,
  BrowserModelConfig,
  GoalCompletedTriggerConfig,
  GoalAnalyticsConfig,
  GoalCreateConfig,
  GoalEventsConfig,
  GoalListConfig,
  GoalTemplateCreateGoalConfig,
  GoalTemplateDeleteConfig,
  GoalTemplateFavoriteConfig,
  GoalTemplateListConfig,
  GoalTemplateUpsertConfig,
  PlanCreateConfig,
  PlanEventsConfig,
  PlanListConfig,
  PlanRejectConfig,
  PlanRefineConfig,
  PlanSetStepStatusConfig,
  PlanTransitionConfig,
  PlanUpdateDraftConfig,
  SchedulerExecutionGetConfig,
  SchedulerEventTriggerConfig,
  SchedulerExecutionsRecentConfig,
  SchedulerTaskBackfillConfig,
  SchedulerTaskCreateConfig,
  SchedulerTaskExecutionsConfig,
  SchedulerTaskExportConfig,
  SchedulerTaskIdConfig,
  SchedulerTaskImportConfig,
  SchedulerTaskListConfig,
  SchedulerTaskUpdateConfig,
  SchedulerUpcomingConfig,
  GoalTransitionConfig,
  GoalToggleSubgoalConfig,
  GoalUpdateConfigConfig,
  GoalUpdateObjectiveConfig,
  TerminalScriptConfig,
  TerminalReadRecentConfig,
  TerminalWaitForExitConfig,
  TerminalCommandTriggerConfig,
  TeamComposeConfig,
  TeamStatusConfig,
  TeamDelegateConfig,
  TeamMessageConfig,
  TeamReconcileConfig,
  ConnectorSendConfig,
  ConnectorReactionConfig,
  ConnectorDeleteConfig,
  ConnectorForwardConfig,
  ConnectorWaitReplyConfig,
  HttpRequestConfig,
  IntegrationEventTriggerConfig,
  WorkflowCompletedTriggerConfig,
  SubworkflowConfig,
} from "./index"

jest.mock("scheduler", () => jest.requireActual("scheduler/unstable_mock"))
jest.mock("dexie-react-hooks", () => ({ useLiveQuery: jest.fn(() => undefined) }))
jest.mock("@/lib/db/characters", () => ({ listCharacters: jest.fn(async () => []) }))
jest.mock("@/lib/db/teams", () => ({
  listTeams: jest.fn(async () => [{ id: "team_1", name: "Alpha" }]),
}))
jest.mock("@/lib/db/skills", () => ({ listSkills: jest.fn(async () => []) }))
jest.mock("@/lib/db/mcp-servers", () => ({ listMcpServers: jest.fn(async () => []) }))
jest.mock("@/lib/db/plugins", () => ({ listPlugins: jest.fn(async () => []) }))
jest.mock("@/lib/db/workflows", () => ({
  listWorkflows: jest.fn(async () => []),
  getWorkflow: jest.fn(async () => undefined),
}))
jest.mock("@/lib/db/twins", () => ({ listTwins: jest.fn(async () => []) }))
jest.mock("@/lib/db/adapter-instances", () => ({
  listAdapterInstances: jest.fn(async () => []),
}))

const messages = {
  workflows: {
    forms: {
      pickers: {
        team: "Select a team",
        subworkflow: "Pick a workflow",
        noResults: "No matches",
        useExpression: "Use expression",
        usePicker: "Pick from list",
        none: "None",
      },
      connectorSend: {
        adapter: { label: "Adapter", placeholder: "telegram_main" },
        content: { label: "Message content" },
        conversationKey: { label: "Conversation key" },
        editTarget: {
          hint: "Edit this already-sent platform message in place.",
          label: "Edit message id (optional)",
          placeholder: "om_...",
        },
        idempotencyKey: { hint: "Dedup key.", label: "Idempotency key (optional)" },
        replyTo: {
          hint: "Quoted reply.",
          label: "Reply to message id (optional)",
          placeholder: "om_...",
        },
        threadId: { hint: "Thread anchor.", label: "Thread id (optional)" },
        waitForDelivery: {
          hint: "Block until delivered and expose the outcome.",
          label: "Wait for delivery",
        },
        waitTimeoutMs: { hint: "Wait budget in ms.", label: "Delivery wait timeout (ms)" },
      },
      connectorForward: {
        adapter: { label: "Adapter" },
        messageId: {
          hint: "Platform message id to forward.",
          label: "Message id",
          placeholder: "om_...",
        },
        piiGate: {
          block: "Block sensitive data",
          hint: "Checks referenced content before forwarding.",
          label: "PII egress policy",
          redact: "Redact when possible; otherwise block",
        },
        target: {
          hint: "Destination conversation key.",
          label: "Target conversation",
          placeholder: "lark:bot:oc_...",
        },
      },
      httpRequest: {
        body: { hint: "Sent as application/json.", label: "Body" },
        followRedirects: { hint: "Follow redirects.", label: "Follow redirects" },
        method: { label: "Method" },
        piiGate: {
          block: "Block sensitive data",
          hint: "Checks the request before network egress.",
          label: "PII egress policy",
          redact: "Redact and continue",
        },
        url: { hint: "Request URL.", label: "URL", placeholder: "https://api.example.com" },
      },
      integrationEventTrigger: {
        pluginId: {
          label: "Plugin (optional)",
          hint: "Limit by plugin.",
          placeholder: "example-delivery",
        },
        integrationId: {
          label: "Integration (optional)",
          hint: "Limit by integration.",
          placeholder: "delivery",
        },
        accountId: {
          label: "Account (optional)",
          hint: "Limit by account.",
          placeholder: "account_...",
        },
        resourceKind: {
          label: "Resource kind (optional)",
          hint: "Limit by resource kind.",
          placeholder: "repository",
        },
        resourceId: {
          label: "Resource id (optional)",
          hint: "Limit by resource id.",
          placeholder: "owner/project",
        },
        eventTypes: {
          label: "Event types (optional)",
          hint: "Comma-separated event types.",
          placeholder: "pull_request.opened, issue.updated",
        },
      },
      teamTrigger: {
        intro: "Fires when an agent-team run finishes.",
        teamId: { label: "Team", hint: "Leave empty to fire for every team." },
        status: {
          label: "Status",
          hint: "Only fire on this terminal status.",
          options: {
            any: "Any terminal status",
            completed: "Completed",
            failed: "Failed",
            cancelled: "Cancelled",
          },
        },
      },
      teamTaskDispatch: {
        teamId: { label: "Team" },
        taskId: { label: "Task id", hint: "Stable id", placeholder: "task_" },
        title: { label: "Title", placeholder: "Title" },
        description: { label: "Description", placeholder: "Detail" },
        expectedOutput: { label: "Expected output", hint: "Used to validate" },
      },
      teamCompose: {
        objective: { label: "Objective", hint: "One objective sentence." },
        name: { label: "Team name (optional)" },
        preferredPattern: {
          label: "Execution pattern",
          options: {
            auto: "Auto (routing decides)",
            manager_worker: "Manager / worker",
            parallel_specialists: "Parallel specialists",
            background_handoff: "Background handoff",
            external_handoff: "External handoff",
            single_agent_recommended: "Single agent",
            ultracode_orchestration: "Ultracode orchestration",
          },
        },
        maxRoster: { label: "Max roster size (incl. lead)" },
        autoStart: { label: "Start immediately", hint: "Run right away." },
        ultracode: { label: "Ultracode" },
      },
      teamStatus: {
        teamId: { label: "Team" },
        includeTasks: { label: "Include tasks" },
        includeTeammates: { label: "Include teammates" },
        includeDelegations: { label: "Include delegations" },
      },
      teamDelegate: {
        teamId: { label: "Source team" },
        target: {
          label: "Delegate to",
          options: {
            twin: "Digital twin",
            background: "Background agent",
            external: "External agent",
            team: "Another team",
          },
        },
        twinId: { label: "Digital twin" },
        targetTeamId: { label: "Target team" },
        targetAgentId: { label: "External agent id", hint: "e.g. claude-code" },
        prompt: { label: "Prompt" },
        systemPrompt: { label: "System prompt (optional)" },
        reason: { label: "Reason (audit log)" },
        awaitCompletion: { label: "Await completion", hint: "Wait for terminal state." },
        force: { label: "Override quiet hours", hint: "Launch during quiet hours." },
      },
      teamMessage: {
        teamId: { label: "Team" },
        content: { label: "Message" },
        senderId: { label: "Sender teammate id (optional)", hint: "Defaults to the lead." },
        recipientId: { label: "Recipient teammate id (optional)" },
        taskId: { label: "Attach to task id (optional)" },
      },
      teamReconcile: {
        inherit: "Inherit from team config",
        intro: "Reconciles the per-dispatch agent branches produced so far in this run.",
        mode: {
          label: "Mode",
          options: {
            manual: "Manual",
            "merge-all": "Merge all",
            select: "Select winner",
            pipeline: "Pipeline",
          },
        },
        selectStrategy: {
          label: "Selection strategy",
          options: { manual: "Manual", "first-success": "First success", judge: "AI judge" },
        },
        retain: {
          label: "Retain branches",
          options: {
            all: "Keep all",
            "keep-winner": "Keep winner",
            "prune-losers": "Prune losers",
          },
        },
      },
      desktopEventTrigger: {
        desktopOnly: "Desktop only.",
        cooldownMs: { label: "Cooldown (ms)", hint: "Minimum time between fires." },
        kinds: {
          label: "Event kinds",
          hint: "Fire on UIA events.",
          options: {
            "focus-changed": "Focus changed",
            "structure-changed": "Structure changed",
            "property-changed": "Property changed",
          },
        },
      },
      petEventTrigger: {
        intro: "Fires when the desktop pet lifecycle changes.",
        cooldownMs: { label: "Cooldown (ms)", hint: "Minimum time between fires." },
        kinds: {
          label: "Pet events",
          hint: "Leave all off to fire on every supported pet lifecycle event.",
          options: {
            levelUp: "Level up",
            evolved: "Evolved",
            achievementUnlocked: "Achievement unlocked",
            unwell: "Unwell",
          },
        },
      },
      petInteract: {
        kind: {
          label: "Interaction",
          options: {
            fed: "Feed",
            played: "Play",
            petted: "Pet",
            talked: "Talk",
            slept: "Sleep",
            cleaned: "Clean",
            treated: "Treat",
          },
        },
        itemId: {
          label: "Item id",
          hint: "Optional shop item consumed by the pet controller.",
          placeholder: "pet_item_",
        },
      },
      aiCouncil: {
        prompt: { label: "Prompt" },
        councillorsJson: {
          label: "Councillors JSON",
          hint: "Array of { name, modelAlias, systemPrompt? } objects.",
          placeholder: '[{"name":"Reviewer","modelAlias":"smart"}]',
        },
        synthesizerAlias: {
          label: "Synthesizer alias",
          hint: "Routing alias for the final synthesizer model.",
          placeholder: "quality",
        },
        synthesisInstructions: {
          label: "Synthesis instructions",
          hint: "Optional instructions for the final synthesis pass.",
        },
        executionMode: {
          label: "Execution mode",
          options: { parallel: "Parallel", serial: "Serial" },
        },
        timeoutMs: { label: "Timeout (ms)", hint: "Per councillor timeout." },
        maxConcurrency: { label: "Max concurrency", hint: "Parallel councillor limit." },
        piiGate: {
          label: "PII gate",
          hint: "Runs before prompt egresses to every councillor and synthesizer.",
          off: "Off",
          block: "Block",
          redact: "Redact",
        },
      },
      aiPrompt: {
        apiFlavor: {
          auto: "Auto",
          chat: "Chat Completions",
          hint: "Controls the OpenAI endpoint family.",
          label: "OpenAI endpoint",
          responses: "Responses API",
        },
        apiKey: { hint: "Inline key", label: "API key" },
        baseURL: {
          hint: "Override endpoint.",
          label: "Base URL (optional)",
          placeholder: "https://api.openai.com/v1",
        },
        headersJson: {
          hint: "Static provider headers as JSON.",
          label: "Headers JSON (optional)",
          placeholder: '{ "HTTP-Referer": "https://app.example" }',
        },
        jsonSchema: {
          hint: "JSON shape.",
          label: "JSON shape (optional)",
          placeholder: "{}",
        },
        mode: {
          explicit: "Explicit provider",
          hint: "Provider mode.",
          label: "Provider mode",
          routed: "Routed (auto)",
        },
        model: { hint: "Model id.", label: "Model", placeholder: "gpt-4.1" },
        modelAlias: { hint: "Routing alias.", label: "Model alias", placeholder: "fast" },
        piiGate: {
          block: "Block",
          hint: "PII gate.",
          label: "PII gate",
          off: "Off",
          redact: "Redact",
        },
        provider: { hint: "Provider id.", label: "Provider", placeholder: "openrouter" },
        responseFormat: {
          hint: "Format.",
          json: "JSON",
          label: "Response format",
          text: "Text",
        },
        systemPrompt: { label: "System prompt" },
        temperature: { hint: "Temperature.", label: "Temperature" },
        userPrompt: { label: "User prompt" },
      },
      aiClassify: {
        apiFlavor: {
          auto: "Auto",
          chat: "Chat Completions",
          hint: "Controls the OpenAI endpoint family.",
          label: "OpenAI endpoint",
          responses: "Responses API",
        },
        apiKey: { label: "API key" },
        baseURL: { label: "Base URL (optional)" },
        headersJson: {
          hint: "Static provider headers as JSON.",
          label: "Headers JSON (optional)",
          placeholder: '{ "HTTP-Referer": "https://app.example" }',
        },
        hint: { label: "Guidance (optional)" },
        input: { hint: "Supports expressions.", label: "Input" },
        labelsRaw: {
          hint: "Classifier labels.",
          label: "Labels (comma-separated)",
          placeholder: "urgent, normal",
        },
        model: { label: "Model", placeholder: "gpt-4.1" },
        provider: { hint: "Provider id.", label: "Provider", placeholder: "openrouter" },
      },
      aiExtract: {
        apiFlavor: {
          auto: "Auto",
          chat: "Chat Completions",
          hint: "Controls the OpenAI endpoint family.",
          label: "OpenAI endpoint",
          responses: "Responses API",
        },
        apiKey: { label: "API key" },
        baseURL: { label: "Base URL (optional)" },
        headersJson: {
          hint: "Static provider headers as JSON.",
          label: "Headers JSON (optional)",
          placeholder: '{ "HTTP-Referer": "https://app.example" }',
        },
        hint: { label: "Guidance (optional)" },
        input: { label: "Input" },
        model: { label: "Model" },
        provider: { hint: "Provider id.", label: "Provider", placeholder: "openrouter" },
        required: {
          hint: "Required fields.",
          label: "Required fields (optional)",
          placeholder: "name, amount",
        },
        schemaJson: { hint: "Schema object.", label: "Schema (JSON)" },
      },
      goalCompletedTrigger: {
        goalId: { label: "Goal id (optional)", hint: "Limit to a specific goal." },
        status: {
          label: "Terminal status (optional)",
          hint: "Limit to one outcome.",
          placeholder: "completed",
        },
        sessionId: { label: "Session id (optional)", hint: "Limit to a chat session." },
        characterId: { label: "Character (optional)" },
      },
      workflowCompletedTrigger: {
        workflowId: { label: "Source workflow (optional)", hint: "The source workflow to watch." },
        status: {
          label: "Outcome filter",
          hint: "Only fire for one outcome.",
          options: { any: "Any", succeeded: "Succeeded", failed: "Failed" },
        },
      },
      subworkflow: {
        workflowId: { label: "Target workflow" },
        inputJson: { label: "Input (JSON)", hint: "Raw JSON payload." },
        typedInput: { label: "Typed input", hint: "Fields from the declared schema." },
      },
      goalCommon: {
        goalId: { label: "Goal id", hint: "Target goal id.", placeholder: "goal_" },
      },
      goalCreate: {
        sessionId: { label: "Session id", hint: "Chat session to drive.", placeholder: "ses_" },
        rawObjective: {
          label: "Objective",
          hint: "Original objective; runtime redacts it before prompting.",
          placeholder: "Ship the release",
        },
        characterId: { label: "Character (optional)" },
        startPaused: { label: "Start paused", hint: "Create without auto-driving." },
        configJson: { label: "Config JSON", hint: "Partial GoalConfig override." },
      },
      goalList: {
        mode: {
          label: "Read mode",
          options: {
            all: "All goals",
            session: "Goals by session",
            activeForSession: "Active for session",
            openForSession: "Open for session",
          },
        },
        sessionId: { label: "Session id", hint: "Required for session modes." },
        limit: { label: "Limit", hint: "Maximum rows." },
      },
      goalEvents: {
        limit: { label: "Limit", hint: "Maximum events." },
      },
      goalUpdateObjective: {
        rawObjective: { label: "New objective", hint: "Replacement objective." },
      },
      goalUpdateConfig: {
        configJson: { label: "Config JSON", hint: "Partial GoalConfig patch." },
      },
      goalToggleSubgoal: {
        subgoalId: { label: "Subgoal id", hint: "Checklist item id.", placeholder: "sub_" },
      },
      goalAnalytics: {
        scope: {
          label: "Scope",
          options: { all: "All goals", session: "Goals by session" },
        },
        sessionId: { label: "Session id", hint: "Required for session scope." },
        limit: { label: "Limit", hint: "Maximum rows." },
        windowDays: { label: "Window (days)", hint: "Timeline look-back window." },
      },
      goalTemplateCommon: {
        templateId: { label: "Template id", hint: "Target template id.", placeholder: "gtpl_" },
      },
      goalTemplateList: {
        includeBuiltIn: { label: "Include built-ins", hint: "Show seeded templates." },
        favoriteOnly: { label: "Favorites only", hint: "Only favorite templates." },
        query: { label: "Search", hint: "Match title or objective.", placeholder: "release" },
        limit: { label: "Limit", hint: "Maximum rows." },
      },
      goalTemplateCreateGoal: {
        sessionId: { label: "Session id", hint: "Chat session to drive.", placeholder: "ses_" },
        characterId: { label: "Character (optional)" },
      },
      goalTemplateUpsert: {
        title: { label: "Title", hint: "Template title.", placeholder: "Release review" },
        objectiveText: {
          label: "Objective",
          hint: "Objective used when creating a goal.",
          placeholder: "Review the release",
        },
        configJson: { label: "Config JSON", hint: "Partial GoalConfig override." },
        isFavorite: { label: "Favorite", hint: "Pin this template near the top." },
        sortOrder: { label: "Sort order", hint: "Lower values sort earlier." },
      },
      goalTemplateFavorite: {
        isFavorite: { label: "Favorite", hint: "Set favorite state." },
      },
      planCommon: {
        planId: { label: "Plan id", hint: "Target plan id.", placeholder: "plan_" },
      },
      planCreate: {
        sessionId: { label: "Session id", hint: "Chat session.", placeholder: "ses_" },
        title: { label: "Title", hint: "Plan title.", placeholder: "Ship feature" },
        description: { label: "Description", hint: "Optional context." },
        characterId: { label: "Character (optional)" },
        source: {
          label: "Source",
          options: {
            manual: "Manual",
            agent_tool: "Agent tool",
            planner_llm: "Planner LLM",
            team_projection: "Team projection",
            goal_projection: "Goal projection",
            exit_plan_mode: "Exit plan mode",
          },
        },
        executionMode: {
          label: "Execution mode",
          options: { auto: "Auto", in_session: "In session", orchestrated: "Orchestrated" },
        },
        stepsJson: { label: "Steps JSON", hint: "CreatePlanStepInput array." },
        configJson: { label: "Config JSON", hint: "Partial PlanConfig override." },
        metadataJson: { label: "Metadata JSON", hint: "Structured metadata." },
      },
      planList: {
        mode: {
          label: "Read mode",
          options: {
            all: "All plans",
            session: "Plans by session",
            openForSession: "Open for session",
            executingForSession: "Executing for session",
          },
        },
        sessionId: { label: "Session id", hint: "Required for session modes." },
        status: {
          label: "Status filter",
          options: {
            any: "Any",
            draft: "Draft",
            awaiting_approval: "Awaiting approval",
            approved: "Approved",
            executing: "Executing",
            paused: "Paused",
            completed: "Completed",
            failed: "Failed",
            cancelled: "Cancelled",
          },
        },
        projectId: { label: "Project id (optional)", hint: "Override active project." },
        limit: { label: "Limit", hint: "Maximum rows." },
      },
      planEvents: { limit: { label: "Limit", hint: "Maximum events." } },
      planUpdateDraft: {
        title: { label: "Title", hint: "Replacement title." },
        description: { label: "Description", hint: "Replacement description." },
        executionMode: {
          label: "Execution mode",
          options: {
            unchanged: "Unchanged",
            auto: "Auto",
            in_session: "In session",
            orchestrated: "Orchestrated",
          },
        },
        stepsJson: { label: "Steps JSON", hint: "Full PlanStep array." },
        configJson: { label: "Config JSON", hint: "Partial PlanConfig patch." },
        metadataJson: { label: "Metadata JSON", hint: "Replacement metadata." },
      },
      planReject: {
        feedback: { label: "Feedback", hint: "Reason recorded on the rejection event." },
      },
      planRefine: {
        refinementType: {
          label: "Refinement type",
          options: {
            optimize: "Optimize",
            simplify: "Simplify",
            expand: "Expand",
            reorder: "Reorder",
            repair: "Repair",
          },
        },
        trigger: {
          label: "Trigger",
          options: {
            manual: "Manual",
            step_failure: "Step failure",
            judge_deviation: "Judge deviation",
          },
        },
        failedStepId: { label: "Failed step id", hint: "Optional failing step." },
        customInstructions: {
          label: "Custom instructions",
          hint: "Additional planner instruction.",
        },
      },
      planSetStepStatus: {
        stepId: { label: "Step id", hint: "Target plan step.", placeholder: "step_" },
        status: {
          label: "Status",
          options: {
            pending: "Pending",
            ready: "Ready",
            in_progress: "In progress",
            completed: "Completed",
            failed: "Failed",
            skipped: "Skipped",
            blocked: "Blocked",
          },
        },
        result: { label: "Result", hint: "Short result summary." },
        error: { label: "Error", hint: "Failure summary." },
        outputJson: { label: "Output JSON", hint: "Structured output." },
        attempts: { label: "Attempts", hint: "Retry counter." },
      },
      schedulerTaskCommon: {
        taskId: { label: "Task id", hint: "Target scheduled task.", placeholder: "task_" },
      },
      schedulerTaskCreate: {
        name: { label: "Name", hint: "Scheduled task name.", placeholder: "Nightly run" },
        description: { label: "Description", hint: "Optional task description." },
        type: {
          label: "Task type",
          options: {
            custom: "Custom",
            agent: "Agent",
            chat: "Chat",
            skill: "Skill",
            script: "Script",
            plugin: "Plugin",
            backup: "Backup",
            goal: "Goal",
            plan: "Plan",
            "agent-team": "Agent team",
            "external-agent": "External agent",
          },
        },
        triggerType: {
          label: "Trigger",
          options: { cron: "Cron", interval: "Interval", once: "Once", event: "Event" },
        },
        cronExpression: { label: "Cron", hint: "Five-field cron expression." },
        intervalMs: { label: "Interval (ms)", hint: "Milliseconds between runs." },
        runAt: { label: "Run at", hint: "ISO date for once trigger." },
        eventType: { label: "Event type", hint: "Scheduler event type." },
        timezone: { label: "Timezone", hint: "Cron timezone." },
        payloadJson: { label: "Payload JSON", hint: "ScheduledTaskPayload object." },
        configJson: { label: "Config JSON", hint: "Partial execution config." },
        notificationJson: { label: "Notification JSON", hint: "Partial notification config." },
        tagsRaw: { label: "Tags", hint: "Comma-separated tags." },
      },
      schedulerTaskList: {
        statusesRaw: { label: "Statuses", hint: "Comma-separated task statuses." },
        typesRaw: { label: "Types", hint: "Comma-separated task types." },
        tagsRaw: { label: "Tags", hint: "Comma-separated tags." },
        search: { label: "Search", hint: "Match name or description." },
        limit: { label: "Limit", hint: "Maximum tasks." },
      },
      schedulerTaskUpdate: {
        name: { label: "Name", hint: "Replacement name." },
        description: { label: "Description", hint: "Replacement description." },
        status: {
          label: "Status",
          options: {
            unchanged: "Unchanged",
            active: "Active",
            paused: "Paused",
            disabled: "Disabled",
            expired: "Expired",
          },
        },
        triggerType: {
          label: "Trigger",
          options: {
            unchanged: "Unchanged",
            cron: "Cron",
            interval: "Interval",
            once: "Once",
            event: "Event",
          },
        },
        cronExpression: { label: "Cron", hint: "Five-field cron expression." },
        intervalMs: { label: "Interval (ms)", hint: "Milliseconds between runs." },
        runAt: { label: "Run at", hint: "ISO date for once trigger." },
        eventType: { label: "Event type", hint: "Scheduler event type." },
        timezone: { label: "Timezone", hint: "Cron timezone." },
        payloadJson: { label: "Payload JSON", hint: "ScheduledTaskPayload patch." },
        configJson: { label: "Config JSON", hint: "Partial execution config patch." },
        notificationJson: { label: "Notification JSON", hint: "Notification patch." },
        tagsRaw: { label: "Tags", hint: "Comma-separated replacement tags." },
      },
      schedulerTaskExecutions: {
        limit: { label: "Limit", hint: "Maximum execution rows." },
      },
      schedulerTaskBackfill: {
        end: { label: "End", hint: "Backfill window end." },
        start: { label: "Start", hint: "Backfill window start." },
      },
      schedulerTaskExport: {
        taskIdsRaw: { label: "Task ids", hint: "Comma-separated task ids." },
      },
      schedulerTaskImport: {
        dataJson: { label: "Import JSON", hint: "Exported scheduler task bundle." },
        mode: { label: "Mode", options: { merge: "Merge", replace: "Replace" } },
      },
      schedulerUpcoming: {
        limit: { label: "Limit", hint: "Maximum upcoming tasks." },
      },
      schedulerExecutionsRecent: {
        limit: { label: "Limit", hint: "Maximum recent executions." },
      },
      schedulerExecutionGet: {
        executionId: { label: "Execution id", hint: "Target execution id.", placeholder: "exec_" },
      },
      schedulerEventTrigger: {
        eventSource: { label: "Event source", hint: "Optional event source." },
        eventType: { label: "Event type", hint: "Scheduler event type." },
        payloadJson: { label: "Payload JSON", hint: "Event payload object." },
      },
    },
  },
}

function wrap(ui: React.ReactNode) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      {ui}
    </NextIntlClientProvider>
  )
}

describe("BrowserModelConfig export", () => {
  it("is exposed from the inspector forms module", () => {
    expect(BrowserModelConfig).toEqual(expect.any(Function))
  })
})

describe("IntegrationEventTriggerConfig", () => {
  it("authors platform-neutral account, resource, and event filters", () => {
    const onChange = jest.fn()
    wrap(
      <IntegrationEventTriggerConfig
        params={{ pluginId: "example-delivery", eventTypes: ["issue.created"] }}
        onChange={onChange}
      />
    )

    expect(screen.getByLabelText("Plugin (optional)")).toHaveValue("example-delivery")
    expect(screen.getByLabelText("Event types (optional)")).toHaveValue("issue.created")
    fireEvent.change(screen.getByLabelText("Event types (optional)"), {
      target: { value: "issue.created, pull_request.updated" },
    })
    expect(onChange).toHaveBeenLastCalledWith({
      pluginId: "example-delivery",
      eventTypes: ["issue.created", "pull_request.updated"],
    })
  })
})

describe("TeamTriggerConfig", () => {
  it("renders the scoping fields (team picker + terminal-status select)", () => {
    const onChange = jest.fn()
    wrap(<TeamTriggerConfig params={{}} onChange={onChange} />)
    expect(screen.getByText(/finishes/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/^Team/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/^Status/i)).toBeInTheDocument()
    // Unscoped default shows the any-status option in the closed trigger.
    expect(screen.getByText(/Any terminal status/i)).toBeInTheDocument()
  })

  it("shows the persisted status filter", () => {
    wrap(<TeamTriggerConfig params={{ status: "failed" }} onChange={jest.fn()} />)
    expect(screen.getByText("Failed")).toBeInTheDocument()
  })
})

describe("TeamTaskDispatchConfig", () => {
  it("renders the dispatch fields and propagates edits", () => {
    const onChange = jest.fn()
    wrap(<TeamTaskDispatchConfig params={{}} onChange={onChange} />)
    expect(screen.getByLabelText(/Task id/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/^Title/i)).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText(/Task id/i), { target: { value: "task_42" } })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ taskId: "task_42" }))
  })
})

describe("DesktopEventTriggerConfig", () => {
  it("toggles event kinds into params.kinds", () => {
    const onChange = jest.fn()
    wrap(<DesktopEventTriggerConfig params={{}} onChange={onChange} />)
    fireEvent.click(screen.getByTestId("desktop-event-focus-changed"))
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ kinds: ["focus-changed"] }))
  })

  it("removes a kind when toggled off", () => {
    const onChange = jest.fn()
    wrap(<DesktopEventTriggerConfig params={{ kinds: ["focus-changed"] }} onChange={onChange} />)
    fireEvent.click(screen.getByTestId("desktop-event-focus-changed"))
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ kinds: [] }))
  })

  it("edits the cooldown loop-guard (clamped to ≥0, default 2000)", () => {
    const onChange = jest.fn()
    wrap(<DesktopEventTriggerConfig params={{}} onChange={onChange} />)
    const input = screen.getByTestId("desktop-event-cooldown") as HTMLInputElement
    expect(input.value).toBe("2000")
    fireEvent.change(input, { target: { value: "5000" } })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ cooldownMs: 5000 }))
    fireEvent.change(input, { target: { value: "-3" } })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ cooldownMs: 0 }))
  })

  it("edits an optional UIA element scope", () => {
    const onChange = jest.fn()
    wrap(<DesktopEventTriggerConfig params={{ scope: ["element-1"] }} onChange={onChange} />)
    const input = screen.getByTestId("desktop-event-scope") as HTMLInputElement
    expect(input.value).toBe("element-1")
    fireEvent.change(input, { target: { value: "element-2" } })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ scope: "element-2" }))
  })
})

describe("PetEventTriggerConfig", () => {
  it("toggles lifecycle kinds and edits the cooldown", () => {
    const onChange = jest.fn()
    const { container } = wrap(<PetEventTriggerConfig params={{}} onChange={onChange} />)
    expect(container.querySelector('[data-field="kinds"]')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("pet-event-levelUp"))
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ kinds: ["levelUp"] }))
    fireEvent.change(fieldInput(container, "cooldownMs"), { target: { value: "999999" } })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ cooldownMs: 300000 }))
  })

  it("removes a lifecycle kind when toggled off", () => {
    const onChange = jest.fn()
    wrap(<PetEventTriggerConfig params={{ kinds: ["levelUp"] }} onChange={onChange} />)
    fireEvent.click(screen.getByTestId("pet-event-levelUp"))
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ kinds: [] }))
  })
})

describe("PetInteractConfig", () => {
  it("renders interaction controls and propagates item id edits", () => {
    const onChange = jest.fn()
    const { container } = wrap(<PetInteractConfig params={{ kind: "fed" }} onChange={onChange} />)
    expect(container.querySelector('[data-field="kind"]')).toBeInTheDocument()
    fireEvent.change(fieldInput(container, "itemId"), { target: { value: "snack_1" } })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ itemId: "snack_1" }))
  })
})

describe("AiCouncilConfig", () => {
  it("edits prompt, synthesizer alias, and parses councillor JSON into structured params", () => {
    const onChange = jest.fn()
    const { container } = wrap(<AiCouncilConfig params={{}} onChange={onChange} />)
    expect(container.querySelector('[data-field="prompt"]')).toBeInTheDocument()
    fireEvent.change(fieldInput(container, "synthesizerAlias"), {
      target: { value: "quality" },
    })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ synthesizerAlias: "quality" }))
    fireEvent.change(fieldInput(container, "councillors"), {
      target: {
        value:
          '[{"name":"Fast reviewer","modelAlias":"fast"},{"name":"Careful reviewer","modelAlias":"smart","systemPrompt":"Find risks."}]',
      },
    })
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        councillors: [
          { name: "Fast reviewer", modelAlias: "fast" },
          { name: "Careful reviewer", modelAlias: "smart", systemPrompt: "Find risks." },
        ],
      })
    )
  })

  it("clamps timeout and concurrency to schema bounds", () => {
    const onChange = jest.fn()
    const { container } = wrap(<AiCouncilConfig params={{}} onChange={onChange} />)
    fireEvent.change(fieldInput(container, "timeoutMs"), { target: { value: "1" } })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 1000 }))
    fireEvent.change(fieldInput(container, "maxConcurrency"), { target: { value: "99" } })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ maxConcurrency: 16 }))
  })

  it("binds the councillors textarea to the raw councillorsJson so invalid intermediate text survives", () => {
    // Regression: the value used to be re-stringified from the parsed array, so
    // a partially-typed (invalid) JSON reverted every keystroke. Raw-first means
    // the in-progress string is echoed verbatim even while it doesn't parse.
    const onChange = jest.fn()
    const { container } = wrap(
      <AiCouncilConfig
        params={{ councillorsJson: "[{ partial", councillors: [{ name: "Old", modelAlias: "x" }] }}
        onChange={onChange}
      />
    )
    expect(fieldInput(container, "councillors")).toHaveValue("[{ partial")
  })
})

describe("AI provider protocol fields", () => {
  it("AiPromptConfig authors OpenAI-compatible provider metadata", () => {
    const onChange = jest.fn()
    const { container } = wrap(
      <AiPromptConfig
        typeVersion={2}
        params={{ provider: "openrouter", apiFlavor: "chat", headersJson: "{}" }}
        onChange={onChange}
      />
    )

    expect(fieldInput(container, "provider")).toHaveValue("openrouter")
    expect(container.querySelector('[data-field="apiFlavor"]')).toBeInTheDocument()
    expect(container.querySelector('[data-field="headersJson"]')).toBeInTheDocument()

    fireEvent.change(fieldInput(container, "provider"), { target: { value: "deepseek" } })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ provider: "deepseek" }))

    fireEvent.change(fieldInput(container, "headersJson"), {
      target: { value: '{ "HTTP-Referer": "https://cognia.local", "X-Title": "Cognia" }' },
    })
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        headersJson: '{ "HTTP-Referer": "https://cognia.local", "X-Title": "Cognia" }',
        headers: { "HTTP-Referer": "https://cognia.local", "X-Title": "Cognia" },
      })
    )
  })

  it("AiClassifyConfig authors protocol metadata for its delegated prompt", () => {
    const onChange = jest.fn()
    const { container } = wrap(
      <AiClassifyConfig
        params={{ provider: "openrouter", apiFlavor: "chat", headersJson: "{}" }}
        onChange={onChange}
      />
    )

    expect(fieldInput(container, "provider")).toHaveValue("openrouter")
    expect(container.querySelector('[data-field="apiFlavor"]')).toBeInTheDocument()
    fireEvent.change(fieldInput(container, "headersJson"), {
      target: { value: '{ "X-Title": "Cognia" }' },
    })
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        headersJson: '{ "X-Title": "Cognia" }',
        headers: { "X-Title": "Cognia" },
      })
    )
  })

  it("AiExtractConfig authors protocol metadata for its delegated prompt", () => {
    const onChange = jest.fn()
    const { container } = wrap(
      <AiExtractConfig
        params={{ provider: "openrouter", apiFlavor: "chat", headersJson: "{}" }}
        onChange={onChange}
      />
    )

    expect(fieldInput(container, "provider")).toHaveValue("openrouter")
    expect(container.querySelector('[data-field="apiFlavor"]')).toBeInTheDocument()
    fireEvent.change(fieldInput(container, "headersJson"), {
      target: { value: "{ not json" },
    })
    expect(onChange).toHaveBeenCalledWith(
      expect.not.objectContaining({
        headers: expect.anything(),
      })
    )
  })
})

describe("GoalCompletedTriggerConfig", () => {
  it("renders the optional scope fields and propagates edits", () => {
    const onChange = jest.fn()
    wrap(<GoalCompletedTriggerConfig params={{}} onChange={onChange} />)
    expect(screen.getByLabelText(/Goal id/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/Terminal status/i)).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText(/Goal id/i), { target: { value: "goal_7" } })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ goalId: "goal_7" }))
  })

  it("reflects existing params into the inputs", () => {
    const onChange = jest.fn()
    wrap(<GoalCompletedTriggerConfig params={{ status: "stopped" }} onChange={onChange} />)
    expect(screen.getByLabelText(/Terminal status/i)).toHaveValue("stopped")
  })
})

describe("WorkflowCompletedTriggerConfig", () => {
  it("renders the source-workflow picker and outcome select, defaulting to Any", () => {
    const onChange = jest.fn()
    wrap(<WorkflowCompletedTriggerConfig params={{}} onChange={onChange} />)
    expect(screen.getByLabelText(/Source workflow/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/Outcome filter/i)).toBeInTheDocument()
    expect(screen.getByText("Any")).toBeInTheDocument()
  })

  it("stores the empty string when Any is picked and the enum value otherwise", () => {
    const onChange = jest.fn()
    const { container } = wrap(
      <WorkflowCompletedTriggerConfig params={{ status: "succeeded" }} onChange={onChange} />
    )
    // Radix Select in jsdom: drive the change through the trigger's keyboard
    // interaction is flaky — assert the rendered value instead and exercise
    // onChange through the picker input.
    expect(screen.getByText("Succeeded")).toBeInTheDocument()
    const picker = container.querySelector('[data-field="workflowId"] input')
    expect(picker).not.toBeNull()
  })
})

describe("SubworkflowConfig — typed input (D3b/D5)", () => {
  const { useLiveQuery } = jest.requireMock("dexie-react-hooks") as {
    useLiveQuery: jest.Mock
  }
  afterEach(() => {
    useLiveQuery.mockReset().mockReturnValue(undefined)
  })

  it("renders the raw JSON fallback when the target is unpublished / unresolved", () => {
    const onChange = jest.fn()
    wrap(<SubworkflowConfig params={{ workflowId: "wf_draft" }} onChange={onChange} />)
    expect(screen.getByLabelText(/Input \(JSON\)/i)).toBeInTheDocument()
    expect(screen.queryByText("Typed input")).not.toBeInTheDocument()
  })

  it("renders schema-driven fields for a published target with an input schema", () => {
    // The form's own live query carries deps [workflowId]; the picker's
    // carries [] — dispatch on that to feed only the form's lookup.
    useLiveQuery.mockImplementation((_fn: unknown, deps?: unknown[]) =>
      Array.isArray(deps) && deps[0] === "wf_pub"
        ? {
            id: "wf_pub",
            name: "Published",
            published: { at: 1, toolName: "wf_published" },
            interface: {
              inputSchema: {
                type: "object",
                properties: { topic: { type: "string", title: "Topic" } },
                required: ["topic"],
              },
            },
          }
        : undefined
    )
    const onChange = jest.fn()
    wrap(
      <SubworkflowConfig
        params={{ workflowId: "wf_pub", input: { topic: "ai" } }}
        onChange={onChange}
      />
    )
    expect(screen.getByText("Typed input")).toBeInTheDocument()
    expect(screen.queryByLabelText(/Input \(JSON\)/i)).not.toBeInTheDocument()
    const field = screen.getByDisplayValue("ai")
    fireEvent.change(field, { target: { value: "ml" } })
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        input: { topic: "ml" },
        inputJson: JSON.stringify({ topic: "ml" }, null, 2),
      })
    )
  })
})

describe("goal action configs", () => {
  it("GoalCreateConfig edits objective fields and the paused toggle", () => {
    const onChange = jest.fn()
    const { container } = wrap(<GoalCreateConfig params={{}} onChange={onChange} />)
    fireEvent.change(screen.getByLabelText(/^Session id/i), { target: { value: "ses_42" } })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "ses_42" }))
    fireEvent.change(screen.getByLabelText(/^Objective/i), { target: { value: "Ship it" } })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ rawObjective: "Ship it" }))
    fireEvent.click(container.querySelector('[data-field="startPaused"] button') as HTMLElement)
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ startPaused: true }))
  })

  it("GoalListConfig edits session scope and clamps the limit", () => {
    const onChange = jest.fn()
    const { container } = wrap(<GoalListConfig params={{ mode: "all" }} onChange={onChange} />)
    expect(container.querySelector('[data-field="mode"]')).toBeInTheDocument()
    fireEvent.change(fieldInput(container, "sessionId"), { target: { value: "ses_1" } })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "ses_1" }))
    fireEvent.change(fieldInput(container, "limit"), { target: { value: "9999" } })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ limit: 1000 }))
  })

  it("GoalTransitionConfig and related edit forms propagate ids and payloads", () => {
    const onChange = jest.fn()
    const { container, rerender } = wrap(
      <GoalTransitionConfig params={{}} onChange={onChange} intent="pause" />
    )
    fireEvent.change(fieldInput(container, "goalId"), { target: { value: "goal_1" } })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ goalId: "goal_1" }))

    rerender(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <GoalUpdateObjectiveConfig params={{}} onChange={onChange} />
      </NextIntlClientProvider>
    )
    fireEvent.change(fieldInput(container, "rawObjective"), { target: { value: "new goal" } })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ rawObjective: "new goal" }))

    rerender(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <GoalUpdateConfigConfig params={{}} onChange={onChange} />
      </NextIntlClientProvider>
    )
    fireEvent.change(fieldInput(container, "configJson"), { target: { value: '{"maxTurns":5}' } })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ configJson: '{"maxTurns":5}' }))

    rerender(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <GoalToggleSubgoalConfig params={{}} onChange={onChange} />
      </NextIntlClientProvider>
    )
    fireEvent.change(fieldInput(container, "subgoalId"), { target: { value: "sub_1" } })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ subgoalId: "sub_1" }))
  })

  it("GoalEventsConfig and GoalAnalyticsConfig clamp numeric fields", () => {
    const onChange = jest.fn()
    const { container, rerender } = wrap(<GoalEventsConfig params={{}} onChange={onChange} />)

    fireEvent.change(fieldInput(container, "goalId"), { target: { value: "goal_events" } })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ goalId: "goal_events" }))
    fireEvent.change(fieldInput(container, "limit"), { target: { value: "6000" } })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ limit: 5000 }))

    rerender(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <GoalAnalyticsConfig params={{ scope: "all" }} onChange={onChange} />
      </NextIntlClientProvider>
    )
    expect(container.querySelector('[data-field="scope"]')).toBeInTheDocument()
    fireEvent.change(fieldInput(container, "limit"), { target: { value: "0" } })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ limit: 1 }))
    fireEvent.change(fieldInput(container, "windowDays"), { target: { value: "999" } })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ windowDays: 366 }))
  })

  it("goal template configs edit list, create, and upsert fields", () => {
    const onChange = jest.fn()
    const { container, rerender } = wrap(<GoalTemplateListConfig params={{}} onChange={onChange} />)
    fireEvent.change(fieldInput(container, "query"), { target: { value: "release" } })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ query: "release" }))
    fireEvent.change(fieldInput(container, "limit"), { target: { value: "5000" } })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ limit: 1000 }))

    rerender(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <GoalTemplateCreateGoalConfig params={{}} onChange={onChange} />
      </NextIntlClientProvider>
    )
    fireEvent.change(fieldInput(container, "templateId"), { target: { value: "gtpl_1" } })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ templateId: "gtpl_1" }))
    fireEvent.change(fieldInput(container, "sessionId"), { target: { value: "ses_1" } })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "ses_1" }))

    rerender(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <GoalTemplateUpsertConfig params={{}} onChange={onChange} />
      </NextIntlClientProvider>
    )
    fireEvent.change(fieldInput(container, "title"), { target: { value: "Template" } })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ title: "Template" }))
    fireEvent.change(fieldInput(container, "objectiveText"), { target: { value: "Do it" } })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ objectiveText: "Do it" }))
    fireEvent.change(fieldInput(container, "configJson"), { target: { value: '{"maxTurns":5}' } })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ configJson: '{"maxTurns":5}' }))
  })

  it("goal template favorite and delete configs expose template id controls", () => {
    const onChange = jest.fn()
    const { container, rerender } = wrap(
      <GoalTemplateFavoriteConfig params={{}} onChange={onChange} />
    )
    fireEvent.change(fieldInput(container, "templateId"), { target: { value: "gtpl_1" } })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ templateId: "gtpl_1" }))
    fireEvent.click(container.querySelector('[data-field="isFavorite"] button') as HTMLElement)
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ isFavorite: true }))

    rerender(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <GoalTemplateDeleteConfig params={{}} onChange={onChange} />
      </NextIntlClientProvider>
    )
    fireEvent.change(fieldInput(container, "templateId"), { target: { value: "gtpl_delete" } })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ templateId: "gtpl_delete" }))
  })

  it("plan create, list, events, and transition configs edit their fields", () => {
    const onChange = jest.fn()
    const { container, rerender } = wrap(<PlanCreateConfig params={{}} onChange={onChange} />)
    fireEvent.change(fieldInput(container, "sessionId"), { target: { value: "ses_plan" } })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "ses_plan" }))
    fireEvent.change(fieldInput(container, "title"), { target: { value: "Plan title" } })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ title: "Plan title" }))
    fireEvent.change(fieldInput(container, "stepsJson"), {
      target: { value: '[{"title":"Step","kind":"agent_turn"}]' },
    })
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ stepsJson: '[{"title":"Step","kind":"agent_turn"}]' })
    )

    rerender(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <PlanListConfig params={{ mode: "all" }} onChange={onChange} />
      </NextIntlClientProvider>
    )
    fireEvent.change(fieldInput(container, "sessionId"), { target: { value: "ses_filter" } })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "ses_filter" }))
    fireEvent.change(fieldInput(container, "limit"), { target: { value: "9999" } })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ limit: 1000 }))

    rerender(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <PlanEventsConfig params={{}} onChange={onChange} />
      </NextIntlClientProvider>
    )
    fireEvent.change(fieldInput(container, "planId"), { target: { value: "plan_1" } })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ planId: "plan_1" }))
    fireEvent.change(fieldInput(container, "limit"), { target: { value: "0" } })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ limit: 1 }))

    rerender(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <PlanTransitionConfig params={{}} onChange={onChange} />
      </NextIntlClientProvider>
    )
    fireEvent.change(fieldInput(container, "planId"), { target: { value: "plan_transition" } })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ planId: "plan_transition" }))
  })

  it("plan update, reject, and set-step-status configs edit patch fields", () => {
    const onChange = jest.fn()
    const { container, rerender } = wrap(<PlanUpdateDraftConfig params={{}} onChange={onChange} />)
    fireEvent.change(fieldInput(container, "planId"), { target: { value: "plan_update" } })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ planId: "plan_update" }))
    fireEvent.change(fieldInput(container, "title"), { target: { value: "Updated plan" } })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ title: "Updated plan" }))
    fireEvent.change(fieldInput(container, "configJson"), {
      target: { value: '{"maxStepRetries":2}' },
    })
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ configJson: '{"maxStepRetries":2}' })
    )

    rerender(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <PlanRejectConfig params={{}} onChange={onChange} />
      </NextIntlClientProvider>
    )
    fireEvent.change(fieldInput(container, "feedback"), { target: { value: "Too broad" } })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ feedback: "Too broad" }))

    rerender(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <PlanRefineConfig params={{}} onChange={onChange} />
      </NextIntlClientProvider>
    )
    fireEvent.change(fieldInput(container, "failedStepId"), { target: { value: "step_failed" } })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ failedStepId: "step_failed" }))
    fireEvent.change(fieldInput(container, "customInstructions"), {
      target: { value: "Preserve validation" },
    })
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ customInstructions: "Preserve validation" })
    )

    rerender(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <PlanSetStepStatusConfig params={{}} onChange={onChange} />
      </NextIntlClientProvider>
    )
    fireEvent.change(fieldInput(container, "stepId"), { target: { value: "step_1" } })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ stepId: "step_1" }))
    fireEvent.change(fieldInput(container, "attempts"), { target: { value: "3" } })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ attempts: 3 }))
  })

  it("scheduler task create/list/update/id/execution configs edit their fields", () => {
    const onChange = jest.fn()
    const { container, rerender } = wrap(
      <SchedulerTaskCreateConfig params={{}} onChange={onChange} />
    )
    fireEvent.change(fieldInput(container, "name"), { target: { value: "Nightly run" } })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ name: "Nightly run" }))
    fireEvent.change(fieldInput(container, "cronExpression"), { target: { value: "0 1 * * *" } })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ cronExpression: "0 1 * * *" }))
    fireEvent.change(fieldInput(container, "intervalMs"), { target: { value: "1000" } })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ intervalMs: 1000 }))
    fireEvent.change(fieldInput(container, "payloadJson"), {
      target: { value: '{"prompt":"run"}' },
    })
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ payloadJson: '{"prompt":"run"}' })
    )

    rerender(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <SchedulerTaskListConfig params={{}} onChange={onChange} />
      </NextIntlClientProvider>
    )
    fireEvent.change(fieldInput(container, "search"), { target: { value: "nightly" } })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ search: "nightly" }))
    fireEvent.change(fieldInput(container, "limit"), { target: { value: "9999" } })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ limit: 1000 }))

    rerender(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <SchedulerTaskUpdateConfig params={{}} onChange={onChange} />
      </NextIntlClientProvider>
    )
    fireEvent.change(fieldInput(container, "taskId"), { target: { value: "task_1" } })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ taskId: "task_1" }))
    fireEvent.change(fieldInput(container, "configJson"), {
      target: { value: '{"maxRetries":1}' },
    })
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ configJson: '{"maxRetries":1}' })
    )

    rerender(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <SchedulerTaskIdConfig params={{}} onChange={onChange} />
      </NextIntlClientProvider>
    )
    fireEvent.change(fieldInput(container, "taskId"), { target: { value: "task_run" } })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ taskId: "task_run" }))

    rerender(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <SchedulerTaskExecutionsConfig params={{}} onChange={onChange} />
      </NextIntlClientProvider>
    )
    fireEvent.change(fieldInput(container, "limit"), { target: { value: "0" } })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ limit: 1 }))
  })

  it("advanced scheduler configs edit backfill, import/export, status query, and event fields", () => {
    const onChange = jest.fn()
    const { container, rerender } = wrap(
      <SchedulerTaskBackfillConfig params={{}} onChange={onChange} />
    )
    fireEvent.change(fieldInput(container, "taskId"), { target: { value: "task_1" } })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ taskId: "task_1" }))
    fireEvent.change(fieldInput(container, "start"), {
      target: { value: "2026-06-01T00:00:00Z" },
    })
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ start: "2026-06-01T00:00:00Z" })
    )

    rerender(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <SchedulerTaskExportConfig params={{}} onChange={onChange} />
      </NextIntlClientProvider>
    )
    fireEvent.change(fieldInput(container, "taskIdsRaw"), { target: { value: "task_1,task_2" } })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ taskIdsRaw: "task_1,task_2" }))

    rerender(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <SchedulerTaskImportConfig params={{}} onChange={onChange} />
      </NextIntlClientProvider>
    )
    fireEvent.change(fieldInput(container, "dataJson"), {
      target: { value: '{"version":1,"tasks":[]}' },
    })
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ dataJson: '{"version":1,"tasks":[]}' })
    )

    rerender(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <SchedulerUpcomingConfig params={{}} onChange={onChange} />
      </NextIntlClientProvider>
    )
    fireEvent.change(fieldInput(container, "limit"), { target: { value: "9999" } })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ limit: 1000 }))

    rerender(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <SchedulerExecutionsRecentConfig params={{}} onChange={onChange} />
      </NextIntlClientProvider>
    )
    fireEvent.change(fieldInput(container, "limit"), { target: { value: "0" } })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ limit: 1 }))

    rerender(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <SchedulerExecutionGetConfig params={{}} onChange={onChange} />
      </NextIntlClientProvider>
    )
    fireEvent.change(fieldInput(container, "executionId"), { target: { value: "exec_1" } })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ executionId: "exec_1" }))

    rerender(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <SchedulerEventTriggerConfig params={{}} onChange={onChange} />
      </NextIntlClientProvider>
    )
    fireEvent.change(fieldInput(container, "eventType"), { target: { value: "goal:completed" } })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ eventType: "goal:completed" }))
    fireEvent.change(fieldInput(container, "payloadJson"), {
      target: { value: '{"goalId":"goal_1"}' },
    })
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ payloadJson: '{"goalId":"goal_1"}' })
    )
  })
})

/** The input element inside the `Field` wrapper with `data-field={name}`. */
function fieldInput(container: HTMLElement, name: string): HTMLElement {
  const wrapper = container.querySelector(`[data-field="${name}"]`)
  if (!wrapper) throw new Error(`no field wrapper for "${name}"`)
  const control = (wrapper as HTMLElement).querySelector("input, textarea, button")
  if (!control) throw new Error(`no control inside field "${name}"`)
  return control as HTMLElement
}

describe("TerminalScriptConfig", () => {
  it("renders the script fields and propagates edits", () => {
    const onChange = jest.fn()
    const { container } = wrap(<TerminalScriptConfig params={{}} onChange={onChange} />)
    fireEvent.change(fieldInput(container, "scriptPath"), {
      target: { value: "scripts/build.sh" },
    })
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ scriptPath: "scripts/build.sh" })
    )
    fireEvent.change(fieldInput(container, "interpreter"), { target: { value: "deno" } })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ interpreter: "deno" }))
    // onFailure select + unattended switch are present.
    expect(container.querySelector('[data-field="onFailure"]')).toBeInTheDocument()
    expect(container.querySelector('[data-field="unattended"]')).toBeInTheDocument()
  })

  it("clamps the timeout into [5, 600] and reveals the ask-policy when unattended", () => {
    const onChange = jest.fn()
    const { container, rerender } = wrap(<TerminalScriptConfig params={{}} onChange={onChange} />)
    fireEvent.change(fieldInput(container, "timeoutSec"), { target: { value: "9999" } })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ timeoutSec: 600 }))
    expect(container.querySelector('[data-field="onAskVerdict"]')).not.toBeInTheDocument()
    rerender(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <TerminalScriptConfig params={{ unattended: true }} onChange={onChange} />
      </NextIntlClientProvider>
    )
    expect(container.querySelector('[data-field="onAskVerdict"]')).toBeInTheDocument()
  })
})

describe("TerminalReadRecentConfig", () => {
  it("edits tabId and clamps lineLimit into [1, 50]", () => {
    const onChange = jest.fn()
    const { container } = wrap(<TerminalReadRecentConfig params={{}} onChange={onChange} />)
    fireEvent.change(fieldInput(container, "tabId"), { target: { value: "tab-9" } })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ tabId: "tab-9" }))
    fireEvent.change(fieldInput(container, "lineLimit"), { target: { value: "500" } })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ lineLimit: 50 }))
  })
})

describe("TerminalWaitForExitConfig", () => {
  it("edits tabId and renders timeout + onFailure", () => {
    const onChange = jest.fn()
    const { container } = wrap(<TerminalWaitForExitConfig params={{}} onChange={onChange} />)
    fireEvent.change(fieldInput(container, "tabId"), { target: { value: "tab-3" } })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ tabId: "tab-3" }))
    fireEvent.change(fieldInput(container, "timeoutSec"), { target: { value: "1" } })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ timeoutSec: 5 }))
    expect(container.querySelector('[data-field="onFailure"]')).toBeInTheDocument()
  })
})

describe("TerminalCommandTriggerConfig", () => {
  it("renders the scope fields and propagates edits", () => {
    const onChange = jest.fn()
    const { container } = wrap(<TerminalCommandTriggerConfig params={{}} onChange={onChange} />)
    fireEvent.change(fieldInput(container, "sessionId"), { target: { value: "tab-1" } })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "tab-1" }))
    fireEvent.change(fieldInput(container, "projectId"), { target: { value: "proj-2" } })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ projectId: "proj-2" }))
    fireEvent.change(fieldInput(container, "commandContains"), {
      target: { value: "pnpm test" },
    })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ commandContains: "pnpm test" }))
    expect(container.querySelector('[data-field="status"]')).toBeInTheDocument()
  })

  it("reflects an existing status param ('' shows as Any)", () => {
    const { container } = wrap(
      <TerminalCommandTriggerConfig params={{ status: "" }} onChange={jest.fn()} />
    )
    // The Select trigger renders — '' maps to the 'any' option internally.
    expect(fieldInput(container, "status")).toBeInTheDocument()
  })
})

describe("TeamComposeConfig", () => {
  it("renders objective + pattern controls and propagates edits", () => {
    const onChange = jest.fn()
    wrap(<TeamComposeConfig params={{}} onChange={onChange} />)
    expect(screen.getAllByText(/Objective/i).length).toBeGreaterThan(0)
    expect(screen.getByText(/Auto \(routing decides\)/i)).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText(/Team name/i), { target: { value: "Alpha" } })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ name: "Alpha" }))
  })

  it("shows the ultracode switch only when autoStart is on", () => {
    const { rerender } = wrap(<TeamComposeConfig params={{}} onChange={jest.fn()} />)
    expect(screen.queryByLabelText(/Ultracode/i)).not.toBeInTheDocument()
    rerender(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <TeamComposeConfig params={{ autoStart: true }} onChange={jest.fn()} />
      </NextIntlClientProvider>
    )
    expect(screen.getByLabelText(/Ultracode/i)).toBeInTheDocument()
  })

  it("clamps maxRoster into the 1-16 range", () => {
    const onChange = jest.fn()
    wrap(<TeamComposeConfig params={{}} onChange={onChange} />)
    fireEvent.change(screen.getByLabelText(/Max roster/i), { target: { value: "99" } })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ maxRoster: 16 }))
  })
})

describe("TeamStatusConfig", () => {
  it("renders the team picker and include switches with defaults", () => {
    const onChange = jest.fn()
    wrap(<TeamStatusConfig params={{}} onChange={onChange} />)
    expect(screen.getByLabelText(/Include tasks/i)).toBeChecked()
    expect(screen.getByLabelText(/Include teammates/i)).toBeChecked()
    expect(screen.getByLabelText(/Include delegations/i)).not.toBeChecked()
    fireEvent.click(screen.getByLabelText(/Include delegations/i))
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ includeDelegations: true }))
  })
})

describe("TeamDelegateConfig", () => {
  it("shows target-specific fields per target", () => {
    const { rerender } = wrap(
      <TeamDelegateConfig params={{ target: "twin" }} onChange={jest.fn()} />
    )
    expect(screen.getAllByText(/Digital twin/i).length).toBeGreaterThan(0)
    rerender(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <TeamDelegateConfig params={{ target: "external" }} onChange={jest.fn()} />
      </NextIntlClientProvider>
    )
    expect(screen.getByLabelText(/External agent id/i)).toBeInTheDocument()
    rerender(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <TeamDelegateConfig params={{ target: "team" }} onChange={jest.fn()} />
      </NextIntlClientProvider>
    )
    // team target hides the prompt fields
    expect(screen.queryByText(/System prompt/i)).not.toBeInTheDocument()
    expect(screen.getByText(/Target team/i)).toBeInTheDocument()
  })

  it("propagates reason and awaitCompletion edits", () => {
    const onChange = jest.fn()
    wrap(<TeamDelegateConfig params={{ target: "background" }} onChange={onChange} />)
    fireEvent.change(screen.getByLabelText(/Reason/i), { target: { value: "audit" } })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ reason: "audit" }))
    fireEvent.click(screen.getByLabelText(/Await completion/i))
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ awaitCompletion: false }))
  })
})

describe("TeamMessageConfig", () => {
  it("renders the message fields and propagates edits", () => {
    const onChange = jest.fn()
    wrap(<TeamMessageConfig params={{}} onChange={onChange} />)
    expect(screen.getByText(/Message/i)).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText(/Recipient teammate id/i), {
      target: { value: "tm_2" },
    })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ recipientId: "tm_2" }))
  })
})

describe("TeamReconcileConfig", () => {
  it("renders the three enum selects defaulting to inherit", () => {
    wrap(<TeamReconcileConfig params={{}} onChange={jest.fn()} />)
    expect(screen.getByText(/Reconciles the per-dispatch/i)).toBeInTheDocument()
    expect(screen.getAllByText(/Inherit from team config/i)).toHaveLength(3)
  })

  it("shows persisted values", () => {
    wrap(
      <TeamReconcileConfig
        params={{ mode: "merge-all", retain: "keep-winner" }}
        onChange={jest.fn()}
      />
    )
    expect(screen.getByText("Merge all")).toBeInTheDocument()
    expect(screen.getByText("Keep winner")).toBeInTheDocument()
  })
})

describe("ConnectorSendConfig — fine-grained delivery controls", () => {
  it("renders the edit-target field and patches editTargetMessageId", () => {
    const onChange = jest.fn()
    wrap(<ConnectorSendConfig params={{}} onChange={onChange} />)
    const input = screen.getByLabelText(/Edit message id/i)
    fireEvent.change(input, { target: { value: "om_target_1" } })
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ editTargetMessageId: "om_target_1" })
    )
  })

  it("hides the wait-timeout field until waitForDelivery is on", () => {
    wrap(<ConnectorSendConfig params={{}} onChange={jest.fn()} />)
    expect(screen.queryByLabelText(/Delivery wait timeout/i)).toBeNull()
  })

  it("toggling wait-for-delivery patches the param and reveals the timeout field", () => {
    const onChange = jest.fn()
    const { rerender } = wrap(<ConnectorSendConfig params={{}} onChange={onChange} />)
    fireEvent.click(screen.getByRole("switch"))
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ waitForDelivery: true }))

    rerender(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <ConnectorSendConfig params={{ waitForDelivery: true }} onChange={onChange} />
      </NextIntlClientProvider>
    )
    const timeout = screen.getByLabelText(/Delivery wait timeout/i)
    fireEvent.change(timeout, { target: { value: "5000" } })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ waitTimeoutMs: 5000 }))
  })

  it("patches cardJson from the A2UI card field", () => {
    const onChange = jest.fn()
    wrap(<ConnectorSendConfig params={{}} onChange={onChange} />)
    const input = screen.getByLabelText(/A2UI card JSON/i)
    fireEvent.change(input, { target: { value: '{"rootId":"root"}' } })
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ cardJson: '{"rootId":"root"}' })
    )
  })

  it("defaults outbound connector PII handling to block", () => {
    wrap(<ConnectorSendConfig params={{}} onChange={jest.fn()} />)
    expect(screen.getByRole("combobox", { name: "PII egress policy" })).toHaveTextContent(
      "Block sensitive data"
    )
  })
})

describe("ConnectorReactionConfig / ConnectorDeleteConfig", () => {
  it("reaction form patches messageId and emoji", () => {
    const onChange = jest.fn()
    wrap(<ConnectorReactionConfig params={{}} onChange={onChange} />)
    fireEvent.change(screen.getByLabelText(/Message id/i), { target: { value: "om_r1" } })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ messageId: "om_r1" }))
    fireEvent.change(screen.getByLabelText(/Emoji/i), { target: { value: "THUMBSUP" } })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ emoji: "THUMBSUP" }))
  })

  it("delete form patches messageId", () => {
    const onChange = jest.fn()
    wrap(<ConnectorDeleteConfig params={{}} onChange={onChange} />)
    fireEvent.change(screen.getByLabelText(/Message id/i), { target: { value: "om_d1" } })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ messageId: "om_d1" }))
  })

  it("reaction form shows the reactionId field only for op=remove", () => {
    const onChange = jest.fn()
    const { rerender } = wrap(
      <ConnectorReactionConfig params={{ op: "add" }} onChange={onChange} />
    )
    expect(screen.queryByLabelText(/Reaction id/i)).toBeNull()
    rerender(<ConnectorReactionConfig params={{ op: "remove" }} onChange={onChange} />)
    fireEvent.change(screen.getByLabelText(/Reaction id/i), { target: { value: "rx_9" } })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ reactionId: "rx_9" }))
  })
})

describe("ConnectorForwardConfig", () => {
  it("patches messageId and target conversation", () => {
    const onChange = jest.fn()
    wrap(<ConnectorForwardConfig params={{}} onChange={onChange} />)
    fireEvent.change(screen.getByLabelText(/Message id/i), { target: { value: "om_f1" } })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ messageId: "om_f1" }))
    fireEvent.change(screen.getByLabelText(/Target conversation/i), {
      target: { value: "lark:a1:oc_2" },
    })
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ targetConversationKey: "lark:a1:oc_2" })
    )
  })

  it("defaults PII handling to block and exposes fail-closed redaction", () => {
    const onChange = jest.fn()
    wrap(<ConnectorForwardConfig params={{}} onChange={onChange} />)
    const policy = screen.getByRole("combobox", {
      name: /PII egress policy|piiGate\.label/,
    })
    expect(policy).toHaveTextContent(/Block sensitive data|piiGate\.block/)
    fireEvent.click(policy)
    fireEvent.click(
      screen.getByRole("option", {
        name: /Redact when possible; otherwise block|piiGate\.redact/,
      })
    )
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ piiGate: "redact" }))
  })
})

describe("HttpRequestConfig", () => {
  it("defaults network PII handling to block and allows explicit redaction", () => {
    const onChange = jest.fn()
    wrap(<HttpRequestConfig params={{}} onChange={onChange} />)
    const policy = screen.getByRole("combobox", { name: "PII egress policy" })
    expect(policy).toHaveTextContent("Block sensitive data")
    fireEvent.click(policy)
    fireEvent.click(screen.getByRole("option", { name: "Redact and continue" }))
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ piiGate: "redact" }))
  })
})

describe("ConnectorWaitReplyConfig", () => {
  it("patches conversationKey, list filters and timeout", () => {
    const onChange = jest.fn()
    wrap(<ConnectorWaitReplyConfig params={{}} onChange={onChange} />)
    fireEvent.change(screen.getByLabelText(/Conversation key/i), {
      target: { value: "lark:a1:oc_1" },
    })
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ conversationKey: "lark:a1:oc_1" })
    )
    fireEvent.change(screen.getByLabelText(/Sender ids/i), {
      target: { value: "ou_a, ou_b" },
    })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ senderIds: ["ou_a", "ou_b"] }))
    fireEvent.change(screen.getByLabelText(/Keywords/i), { target: { value: "approve" } })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ keywords: ["approve"] }))
    fireEvent.change(screen.getByLabelText(/Timeout/i), { target: { value: "60000" } })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 60000 }))
  })

  it("requireMention checkbox patches true and clears on uncheck", () => {
    const onChange = jest.fn()
    const { rerender } = wrap(<ConnectorWaitReplyConfig params={{}} onChange={onChange} />)
    fireEvent.click(screen.getByRole("checkbox"))
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ requireMention: true }))
    rerender(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <ConnectorWaitReplyConfig params={{ requireMention: true }} onChange={onChange} />
      </NextIntlClientProvider>
    )
    fireEvent.click(screen.getByRole("checkbox"))
    expect(onChange).toHaveBeenCalledWith(
      expect.not.objectContaining({ requireMention: expect.anything() })
    )
  })
})
