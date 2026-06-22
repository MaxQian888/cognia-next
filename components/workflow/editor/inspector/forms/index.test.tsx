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
jest.mock("@/lib/db/workflows", () => ({ listWorkflows: jest.fn(async () => []) }))
jest.mock("@/lib/db/twins", () => ({ listTwins: jest.fn(async () => []) }))

const messages = {
  workflows: {
    forms: {
      pickers: {
        team: "Select a team",
        noResults: "No matches",
        useExpression: "Use expression",
        usePicker: "Pick from list",
        none: "None",
      },
      teamTrigger: { intro: "Fired internally by the agent-team runtime." },
      teamTaskDispatch: {
        teamId: { label: "Team" },
        taskId: { label: "Task id", hint: "Stable id", placeholder: "task_" },
        title: { label: "Title", placeholder: "Title" },
        description: { label: "Description", placeholder: "Detail" },
        expectedOutput: { label: "Expected output", hint: "Used to validate" },
      },
      desktopEventTrigger: {
        desktopOnly: "Desktop only.",
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

describe("TeamTriggerConfig", () => {
  it("renders the informational intro", () => {
    wrap(<TeamTriggerConfig />)
    expect(screen.getByText(/agent-team runtime/i)).toBeInTheDocument()
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
