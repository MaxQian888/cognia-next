import type { Meta, StoryObj } from "@storybook/nextjs"
import { expect, userEvent, within } from "storybook/test"

import { GoalQuickCreateDialog } from "./goal-quick-create-dialog"

// Renders its own "+ New Goal" trigger; clicking it opens a dialog that spins
// up a fresh chat session and attaches a goal. In Storybook the Dexie template
// list is empty, so only the free-text objective field shows.
const meta = {
  title: "Goal/GoalQuickCreateDialog",
  component: GoalQuickCreateDialog,
  parameters: { layout: "padded" },
} satisfies Meta<typeof GoalQuickCreateDialog>

export default meta
type Story = StoryObj<typeof meta>

export const Trigger: Story = {}

export const Opened: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(await canvas.findByTestId("goal-quick-create-trigger"))
    // The dialog portals to the document body, so assert against the screen.
    await expect(await within(document.body).findByTestId("goal-quick-create-dialog")).toBeVisible()
  },
}
