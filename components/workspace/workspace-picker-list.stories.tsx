import type { Meta, StoryObj } from "@storybook/nextjs"

import { WorkspacePickerList, type WorkspacePickerActions } from "./workspace-picker-list"
import { useProjectStore } from "@/stores/project/project-store"

const ACTIONS: WorkspacePickerActions = {
  openFolder: () => {},
  newWorkspace: () => {},
  adopt: () => {},
  manage: () => {},
  canOpenFolder: true,
  adoptableCount: 2,
}

function seed(count: number) {
  useProjectStore.setState({
    projects: Array.from({ length: count }, (_, i) => ({
      id: `p${i}`,
      name:
        [
          "Cognia",
          "Backend API",
          "Marketing site",
          "Docs",
          "Infra",
          "Mobile",
          "Sandbox",
          "Spike",
          "Archive tools",
        ][i] ?? `Workspace ${i}`,
      roots: [{ id: `r${i}`, path: `/Users/dev/repos/workspace-${i}`, isPrimary: true }],
      pinned: i === 1,
      lastAccessedAt: new Date(2026, 7, 20 + (count - i)),
      updatedAt: new Date(2026, 7, 20 + (count - i)),
    })) as never,
    activeProjectId: "p0",
    loaded: true,
  })
}

const meta: Meta<typeof WorkspacePickerList> = {
  title: "Workspace/WorkspacePickerList",
  component: WorkspacePickerList,
  parameters: { layout: "centered" },
}
export default meta

type Story = StoryObj<typeof WorkspacePickerList>

/** Desktop popover density, the short list that needs no search. */
export const InPopover: Story = {
  decorators: [
    (Story) => {
      seed(4)
      return (
        <div className="w-72 rounded-md border bg-popover p-1 text-popover-foreground shadow-md">
          <Story />
        </div>
      )
    },
  ],
  args: { actions: ACTIONS, density: "compact" },
}

/** Past the threshold where a flat list stops being scannable. */
export const LargeList: Story = {
  decorators: [
    (Story) => {
      seed(9)
      return (
        <div className="w-72 rounded-md border bg-popover p-1 text-popover-foreground shadow-md">
          <Story />
        </div>
      )
    },
  ],
  args: { actions: ACTIONS, density: "compact" },
}

/** Drawer density: the touch targets the mobile header chip opens onto. */
export const InDrawer: Story = {
  decorators: [
    (Story) => {
      seed(5)
      return (
        <div className="w-[375px] rounded-t-xl border bg-background px-2 pt-3 pb-4">
          <Story />
        </div>
      )
    },
  ],
  args: { actions: ACTIONS, density: "comfortable" },
}
