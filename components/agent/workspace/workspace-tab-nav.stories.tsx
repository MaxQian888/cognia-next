import type { Meta, StoryObj } from "@storybook/nextjs"

import { Tabs, TabsContent } from "@/components/ui/tabs"
import { WorkspaceTabNav } from "./workspace-tab-nav"

const meta = {
  title: "Agent/Workspace/WorkspaceTabNav",
  component: WorkspaceTabNav,
  parameters: { layout: "fullscreen" },
  // Presentational only — must render inside a Radix <Tabs> for the active
  // value + onValueChange context.
  decorators: [
    (Story) => (
      <Tabs defaultValue="overview" className="p-4">
        <Story />
        <TabsContent value="overview" className="pt-3 text-sm text-muted-foreground">
          Overview panel
        </TabsContent>
      </Tabs>
    ),
  ],
} satisfies Meta<typeof WorkspaceTabNav>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
