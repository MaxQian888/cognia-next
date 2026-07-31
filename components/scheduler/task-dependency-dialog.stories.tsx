import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { TaskDependencyDialog } from "./task-dependency-dialog"
import { makeScheduledTask } from "@/lib/storybook/fixtures/scheduler"
import type { ScheduledTask } from "@/types/scheduler"

// `TaskDependencyDialog` is a pure, props-only modal that builds the full task
// DAG from `trigger.dependsOn[]` and renders it in a scrollable graph. Stories
// vary the dependency topology; rendered `open` so the graph is visible.

// A → B → C linear pipeline.
function chainTasks(): ScheduledTask[] {
  return [
    makeScheduledTask({
      id: "extract",
      name: "Extract",
      trigger: { type: "cron", cronExpression: "0 1 * * *", timezone: "UTC" },
    }),
    makeScheduledTask({
      id: "transform",
      name: "Transform",
      trigger: {
        type: "cron",
        cronExpression: "0 2 * * *",
        timezone: "UTC",
        dependsOn: ["extract"],
      },
    }),
    makeScheduledTask({
      id: "load",
      name: "Load",
      trigger: {
        type: "cron",
        cronExpression: "0 3 * * *",
        timezone: "UTC",
        dependsOn: ["transform"],
      },
    }),
  ]
}

// One root fanning out into three dependents.
function fanOutTasks(): ScheduledTask[] {
  return [
    makeScheduledTask({
      id: "build",
      name: "Build artifact",
      trigger: { type: "cron", cronExpression: "0 0 * * *", timezone: "UTC" },
    }),
    makeScheduledTask({
      id: "deploy-web",
      name: "Deploy web",
      trigger: { type: "event", eventType: "build.completed", dependsOn: ["build"] },
    }),
    makeScheduledTask({
      id: "deploy-api",
      name: "Deploy API",
      trigger: { type: "event", eventType: "build.completed", dependsOn: ["build"] },
    }),
    makeScheduledTask({
      id: "notify",
      name: "Notify team",
      trigger: {
        type: "event",
        eventType: "deploy.completed",
        dependsOn: ["deploy-web", "deploy-api"],
      },
    }),
  ]
}

const meta = {
  title: "Scheduler/TaskDependencyDialog",
  component: TaskDependencyDialog,
  parameters: { layout: "fullscreen" },
  args: {
    open: true,
    onOpenChange: fn(),
    onSelectTask: fn(),
  },
} satisfies Meta<typeof TaskDependencyDialog>

export default meta
type Story = StoryObj<typeof meta>

export const Chain: Story = {
  args: {
    tasks: chainTasks(),
  },
}

export const FanOut: Story = {
  args: {
    tasks: fanOutTasks(),
  },
}

// The fan-out graph with one node highlighted (e.g. the task the dialog was
// opened from).
export const FocusedNode: Story = {
  args: {
    tasks: fanOutTasks(),
    focusTaskId: "build",
  },
}
