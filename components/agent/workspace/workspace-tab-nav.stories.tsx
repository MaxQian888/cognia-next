import type { Meta, StoryObj } from "@storybook/nextjs"
import { useState, type CSSProperties } from "react"

import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"
import { WorkspaceTabNav } from "./workspace-tab-nav"

const meta = {
  title: "Agent/Workspace/WorkspaceTabNav",
  component: WorkspaceTabNav,
  parameters: { layout: "fullscreen" },
  // Must render inside a SidebarProvider (the real shadcn sidebar context).
  decorators: [
    (Story) => (
      <SidebarProvider
        className="h-[520px] min-h-0"
        style={{ "--sidebar-width": "14rem", "--sidebar-width-icon": "3rem" } as CSSProperties}
      >
        <Story />
        <SidebarInset className="p-6 text-sm text-muted-foreground">Panel content</SidebarInset>
      </SidebarProvider>
    ),
  ],
} satisfies Meta<typeof WorkspaceTabNav>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  args: {
    value: "overview",
    onValueChange: () => {},
    onBack: () => {},
    teamName: "Demo Research Squad",
    counts: { members: 4 },
  },
  render: (args) => {
    const [value, setValue] = useState(args.value)
    return <WorkspaceTabNav {...args} value={value} onValueChange={setValue} />
  },
}
