import type { Meta, StoryObj } from "@storybook/nextjs"

import { TitleBarWorkspace } from "./title-bar-workspace"
import { resetStores } from "@/lib/storybook/seed-stores"
import { useProjectStore } from "@/stores/project/project-store"

// Active-workspace indicator. Seeds one active project so the name renders;
// clicking would open the command palette in the real shell.
const meta = {
  title: "Desktop/TitleBar/Workspace",
  component: TitleBarWorkspace,
  parameters: { layout: "centered" },
  beforeEach: () => {
    resetStores(useProjectStore)
    useProjectStore.setState({
      projects: [{ id: "p1", name: "cognia-next", roots: [] }] as never,
      activeProjectId: "p1",
    })
  },
  decorators: [
    (Story) => (
      <div className="flex h-8 items-center bg-muted/40 text-xs">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof TitleBarWorkspace>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
