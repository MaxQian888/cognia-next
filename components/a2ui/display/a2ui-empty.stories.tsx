import type { Meta, StoryObj } from "@storybook/nextjs"

import { A2UIEmpty, type A2UIEmptyComponent } from "./a2ui-empty"
import { makeA2UIProps } from "@/lib/storybook/fixtures/a2ui"

const empty = (over: Partial<A2UIEmptyComponent> = {}): A2UIEmptyComponent => ({
  id: "empty",
  component: "Empty",
  ...over,
})

const meta = {
  title: "A2UI/Display/Empty",
  component: A2UIEmpty,
  parameters: { layout: "centered" },
} satisfies Meta<typeof A2UIEmpty>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = { args: makeA2UIProps(empty()) }

export const WithTitle: Story = {
  args: makeA2UIProps(empty({ title: "No results found" })),
}

export const TitleAndMessage: Story = {
  args: makeA2UIProps(
    empty({
      title: "Your inbox is empty",
      message: "Messages from your connected platforms will appear here.",
    })
  ),
}

export const WithAction: Story = {
  args: makeA2UIProps(
    empty({
      title: "No projects yet",
      message: "Create your first project to get started.",
      actionLabel: "New project",
      action: "create-project",
    })
  ),
}

export const ActionWithoutLabel: Story = {
  args: makeA2UIProps(
    empty({
      title: "No projects yet",
      message: "The action button only appears when both action and actionLabel are set.",
      action: "create-project",
    })
  ),
}
