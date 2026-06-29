import type { Meta, StoryObj } from "@storybook/nextjs"

import { GoalConsoleViewToggle } from "./goal-console-view-toggle"

// Grid / List toggle bound to `useGoalConsoleView` (persisted to AppSettings).
// Propless aside from `className`; renders against the default settings view.
const meta = {
  title: "Goal/GoalConsoleViewToggle",
  component: GoalConsoleViewToggle,
  parameters: { layout: "padded" },
} satisfies Meta<typeof GoalConsoleViewToggle>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
