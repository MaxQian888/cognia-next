import type { Meta, StoryObj } from "@storybook/nextjs"
import * as React from "react"

import { A2UISidebar, type A2UISidebarComponent } from "./a2ui-sidebar"
import { makeA2UIProps } from "@/lib/storybook/fixtures/a2ui"

const sidebar = (over: Partial<A2UISidebarComponent> = {}): A2UISidebarComponent => ({
  id: "sidebar",
  component: "Sidebar",
  header: "Cognia",
  footer: "v2.9.0",
  groups: [
    {
      id: "workspace",
      label: "Workspace",
      items: [
        { id: "home", label: "Home", action: "nav", active: true },
        { id: "projects", label: "Projects", action: "nav" },
        { id: "inbox", label: "Inbox", action: "nav" },
      ],
    },
    {
      id: "system",
      label: "System",
      items: [
        { id: "settings", label: "Settings", action: "nav" },
        { id: "help", label: "Help", action: "nav" },
      ],
    },
  ],
  ...over,
})

const meta = {
  title: "A2UI/Navigation/Sidebar",
  component: A2UISidebar,
  decorators: [
    (Story: React.ComponentType) => (
      <div className="relative h-[480px] w-full overflow-hidden rounded-lg border">{<Story />}</div>
    ),
  ],
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof A2UISidebar>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = { args: makeA2UIProps(sidebar()) }

export const RightSide: Story = { args: makeA2UIProps(sidebar({ side: "right" })) }

export const Collapsed: Story = { args: makeA2UIProps(sidebar({ collapsed: true })) }
