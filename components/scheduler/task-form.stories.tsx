import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { TaskForm } from "./task-form"
import { makeScheduledTask } from "@/lib/storybook/fixtures/scheduler"
import type { CreateScheduledTaskInput } from "@/types/scheduler"

// `TaskForm` is the full create/edit form for an app-level scheduled task. It's
// props-only (`onSubmit` / `onCancel` callbacks, optional `initialValues` and
// `existingTasks`). Structured payload editors read characters/skills/teams
// from the local DB in effects (empty in Storybook) — no Tauri at render.
// Stories cover create vs edit, the structured chat editor vs the raw-JSON
// editor (non-structured task types), and the dependency-chain selectors.
const meta = {
  title: "Scheduler/TaskForm",
  component: TaskForm,
  parameters: { layout: "padded" },
  args: {
    onSubmit: fn(async () => {}),
    onCancel: fn(),
  },
  decorators: [
    (Story) => (
      <div className="w-[680px] max-w-full">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof TaskForm>

export default meta
type Story = StoryObj<typeof meta>

// Fresh create form — defaults to a chat task with the structured payload
// editor and shows the "Quick Create from Template" affordance.
export const CreateChat: Story = {}

// A non-structured task type (workflow) falls back to the raw-JSON payload
// editor.
export const CreateWorkflowJson: Story = {
  args: {
    initialValues: {
      type: "workflow",
      payload: { workflowId: "wf-nightly-etl" },
    } satisfies Partial<CreateScheduledTaskInput>,
  },
}

// Edit mode — a named task hides the template picker and prefills the form.
export const EditCronTask: Story = {
  args: {
    initialValues: {
      name: "Daily standup digest",
      description: "Summarize overnight activity and post a digest.",
      type: "chat",
      trigger: { type: "cron", cronExpression: "0 9 * * 1-5", timezone: "UTC" },
      payload: { prompt: "Summarize the overnight activity in three bullet points." },
    } satisfies Partial<CreateScheduledTaskInput>,
  },
}

// With existing tasks available, the advanced "run on success / failure"
// chains can reference them.
export const WithDependencyChains: Story = {
  args: {
    initialValues: {
      name: "Nightly ETL",
      type: "workflow",
      trigger: { type: "cron", cronExpression: "0 1 * * *", timezone: "UTC" },
      payload: { workflowId: "wf-etl" },
    } satisfies Partial<CreateScheduledTaskInput>,
    existingTasks: [
      makeScheduledTask({ id: "notify", name: "Notify team", type: "chat" }),
      makeScheduledTask({ id: "rollup", name: "Roll up metrics", type: "workflow" }),
      makeScheduledTask({ id: "cleanup", name: "Cleanup temp files", type: "script" }),
    ],
  },
}

// Submitting state — submit button reflects the in-flight save.
export const Submitting: Story = {
  args: {
    initialValues: {
      name: "Daily standup digest",
      type: "chat",
      payload: { prompt: "Summarize." },
    } satisfies Partial<CreateScheduledTaskInput>,
    isSubmitting: true,
  },
}
