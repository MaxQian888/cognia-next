import type { Meta, StoryObj } from "@storybook/nextjs"

import { A2UITabs } from "./a2ui-tabs"
import type { A2UITabsComponent } from "@/types/a2ui/schema"
import { makeA2UIProps } from "@/lib/storybook/fixtures/a2ui"
import { childStub, withA2UISurface } from "@/lib/storybook/fixtures/a2ui-surface"

const tabs = (over: Partial<A2UITabsComponent> = {}): A2UITabsComponent => ({
  id: "tabs",
  component: "Tabs",
  tabs: [
    { id: "overview", label: "Overview", children: ["overview-body"] },
    { id: "activity", label: "Activity", children: ["activity-body"] },
    { id: "settings", label: "Settings", children: ["settings-body"] },
  ],
  ...over,
})

const meta = {
  title: "A2UI/Layout/Tabs",
  component: A2UITabs,
  decorators: [
    withA2UISurface({
      children: [
        childStub("overview-body", "A high-level summary of the workspace."),
        childStub("activity-body", "Recent edits, runs, and connector events."),
        childStub("settings-body", "Per-surface configuration lives here."),
      ],
    }),
  ],
  parameters: { layout: "padded" },
} satisfies Meta<typeof A2UITabs>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = { args: makeA2UIProps(tabs()) }

export const SecondTabActive: Story = {
  args: makeA2UIProps(tabs({ defaultTab: "activity" })),
}

export const WithDisabledTab: Story = {
  args: makeA2UIProps(
    tabs({
      tabs: [
        { id: "overview", label: "Overview", children: ["overview-body"] },
        { id: "activity", label: "Activity", children: ["activity-body"] },
        { id: "settings", label: "Settings (locked)", children: ["settings-body"], disabled: true },
      ],
    })
  ),
}
