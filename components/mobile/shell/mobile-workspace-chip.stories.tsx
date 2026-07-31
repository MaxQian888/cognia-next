import type { Meta, StoryObj } from "@storybook/nextjs"

import { MobileWorkspaceChip } from "./mobile-workspace-chip"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useProjectStore } from "@/stores/project/project-store"

// Read-only active-workspace indicator. Renders nothing when no workspace is
// active, so the meaningful story seeds an active project into the project store.
const meta = {
  title: "Mobile/Shell/MobileWorkspaceChip",
  component: MobileWorkspaceChip,
  parameters: { layout: "padded" },
  beforeEach: () => {
    resetStore(useProjectStore)
  },
  decorators: [
    (Story) => (
      <div className="w-[360px]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof MobileWorkspaceChip>

export default meta
type Story = StoryObj<typeof meta>

// No active project → renders nothing (the default empty state).
export const NoWorkspace: Story = {}

export const ActiveWorkspace: Story = {
  beforeEach: () => {
    seedStore(useProjectStore, {
      activeProjectId: "proj-1",
      projects: [{ id: "proj-1", name: "Acme Onboarding" }],
    } as never)
  },
}
