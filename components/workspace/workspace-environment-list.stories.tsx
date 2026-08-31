import type { Meta, StoryObj } from "@storybook/nextjs"

import { WorkspaceEnvironmentList } from "./workspace-environment-list"
import { setTransport } from "@/lib/tauri/transport-instance"
import type { WorkspaceEnvironmentSummary } from "@/lib/task-workspace/types"

const ROWS: WorkspaceEnvironmentSummary[] = [
  {
    environmentId: "e1",
    workspaceId: "w1",
    path: "/Users/dev/repos/cognia",
    sourceRoot: "/Users/dev/repos/cognia",
    ownership: "main",
    ownerType: "user",
    ownerRef: null,
    state: null,
    branch: "dev",
    head: "abc1234",
    locked: false,
    lockReason: null,
    prunable: false,
    pruneReason: null,
    base: null,
    pinned: false,
    allowedActions: ["open"],
  },
  {
    environmentId: "e2",
    workspaceId: "w2",
    path: "/Users/dev/.cognia/workspaces/task-4821",
    sourceRoot: "/Users/dev/repos/cognia",
    ownership: "managed",
    ownerType: "session",
    ownerRef: "Refactor the composer",
    state: "active",
    branch: "agent/4821/alice",
    head: "def5678",
    locked: true,
    lockReason: "A run is holding this directory",
    prunable: false,
    pruneReason: null,
    base: { kind: "remoteDefault" },
    pinned: true,
    allowedActions: ["open", "pin", "archive", "createBranchHere", "makePermanent", "delete"],
  },
  {
    environmentId: "e3",
    workspaceId: null,
    path: "/Users/dev/repos/cognia-hotfix",
    sourceRoot: "/Users/dev/repos/cognia",
    ownership: "imported",
    ownerType: null,
    ownerRef: null,
    state: null,
    branch: "hotfix/login",
    head: "9911aa2",
    locked: false,
    lockReason: null,
    prunable: true,
    pruneReason: "The directory is gone",
    base: null,
    pinned: false,
    allowedActions: ["adopt", "remove", "prune"],
  },
]

/**
 * Drives the real component through the documented transport seam rather than
 * a module mock, so the story exercises the same `listWorkspaceEnvironments`
 * path production does.
 */
function installStubTransport() {
  setTransport({
    call: async (command: string) =>
      command === "task_workspace_environment_list" ? (ROWS as never) : (undefined as never),
    subscribe: () => () => {},
  } as never)
}

const meta: Meta<typeof WorkspaceEnvironmentList> = {
  title: "Workspace/WorkspaceEnvironmentList",
  component: WorkspaceEnvironmentList,
  parameters: { layout: "fullscreen" },
}
export default meta

type Story = StoryObj<typeof WorkspaceEnvironmentList>

/** Wide pane: the five-column table. */
export const Wide: Story = {
  decorators: [
    (Story) => {
      installStubTransport()
      return (
        <div className="w-[1000px] p-4">
          <Story />
        </div>
      )
    },
  ],
  args: { presentation: "page", rootDir: "/Users/dev/repos/cognia", showCreate: true },
}

/**
 * Phone-width pane: one card per row.
 *
 * The table's action column used to slide off the end here, so every control on
 * a row was unreachable rather than merely cramped.
 */
export const Narrow: Story = {
  decorators: [
    (Story) => {
      installStubTransport()
      return (
        <div className="w-[375px] p-3">
          <Story />
        </div>
      )
    },
  ],
  args: { presentation: "page", rootDir: "/Users/dev/repos/cognia", showCreate: true },
}
