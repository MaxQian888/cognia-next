import * as React from "react"
import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import {
  ManualTriggerConfig,
  CronConfig,
  ConnectorInboundConfig,
  ChatMessageTriggerConfig,
  GoalCompletedTriggerConfig,
  GoalCreateConfig,
  GoalListConfig,
  PlanCreateConfig,
  SchedulerTaskCreateConfig,
} from "./index"

// Representative slice of the built-in per-kind inspector forms (the full
// barrel exports ~40). Each takes `{ params, onChange }`; entity pickers
// (CharacterPicker, …) read Dexie and render empty without seeded tables, which
// is fine for these previews. Controlled wrapper keeps inputs interactive.
type ConfigForm = React.ComponentType<{
  params: Record<string, unknown>
  onChange: (next: Record<string, unknown>) => void
}>

function Controlled({
  Form,
  initial = {},
}: {
  Form: ConfigForm
  initial?: Record<string, unknown>
}) {
  const [params, setParams] = React.useState<Record<string, unknown>>(initial)
  return (
    <div className="w-[380px]">
      <Form params={params} onChange={setParams} />
    </div>
  )
}

const meta = {
  title: "Workflow/Editor/Inspector/Forms/BuiltIn",
  component: CronConfig,
  parameters: { layout: "padded" },
  args: { params: {}, onChange: fn() },
} satisfies Meta<typeof CronConfig>

export default meta
type Story = StoryObj<typeof meta>

// trigger.manual — static intro copy, no fields.
export const ManualTrigger: Story = {
  render: () => (
    <div className="w-[380px]">
      <ManualTriggerConfig />
    </div>
  ),
}

// trigger.cron — cron builder + timezone.
export const Cron: Story = {
  render: () => (
    <Controlled Form={CronConfig} initial={{ cron: "0 9 * * 1-5", timezone: "Asia/Shanghai" }} />
  ),
}

// trigger.connector.inbound — adapter + conversation key + character.
export const ConnectorInbound: Story = {
  render: () => (
    <Controlled
      Form={ConnectorInboundConfig}
      initial={{ adapterId: "slack-acme", conversationKey: "C12345" }}
    />
  ),
}

// trigger.chat.message — character + optional session scope.
export const ChatMessageTrigger: Story = {
  render: () => <Controlled Form={ChatMessageTriggerConfig} initial={{ sessionId: "sess_42" }} />,
}

// trigger.goal.completed — goal id + status filter.
export const GoalCompletedTrigger: Story = {
  render: () => (
    <Controlled
      Form={GoalCompletedTriggerConfig}
      initial={{ goalId: "goal_ship", status: "completed" }}
    />
  ),
}

// action.goal.create — objective + config JSON.
export const GoalCreate: Story = {
  render: () => (
    <Controlled
      Form={GoalCreateConfig}
      initial={{
        sessionId: "sess_42",
        rawObjective: "Ship the v2 onboarding flow by Friday",
        startPaused: false,
      }}
    />
  ),
}

// action.goal.list — mode select + limit.
export const GoalList: Story = {
  render: () => (
    <Controlled Form={GoalListConfig} initial={{ mode: "openForSession", limit: 100 }} />
  ),
}

// action.plan.create — multi-field plan authoring form.
export const PlanCreate: Story = {
  render: () => (
    <Controlled
      Form={PlanCreateConfig}
      initial={{
        sessionId: "sess_42",
        title: "Refactor billing module",
        source: "manual",
        executionMode: "orchestrated",
        stepsJson: '[{"title":"Audit"},{"title":"Migrate"}]',
      }}
    />
  ),
}

// action.scheduler.task.create — task type + trigger type + cron.
export const SchedulerTaskCreate: Story = {
  render: () => (
    <Controlled
      Form={SchedulerTaskCreateConfig}
      initial={{
        name: "Nightly backup",
        type: "backup",
        triggerType: "cron",
        cronExpression: "0 3 * * *",
      }}
    />
  ),
}
