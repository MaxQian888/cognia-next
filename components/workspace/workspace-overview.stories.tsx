import type { Meta, StoryObj } from "@storybook/nextjs"

import { WorkspaceOverview } from "./workspace-overview"
import { setTransport } from "@/lib/tauri/transport-instance"
import { useProjectStore } from "@/stores/project/project-store"
import type { WorkspaceEnvironmentSummary } from "@/lib/task-workspace/types"

const ENVIRONMENTS: WorkspaceEnvironmentSummary[] = [
  {
    environmentId: "e1",
    workspaceId: "w1",
    projectId: "w1",
    path: "/Users/dev/.cognia/workspaces/task-4821",
    sourceRoot: "/Users/dev/repos/cognia",
    ownership: "managed",
    ownerType: "team",
    ownerRef: "squad-7",
    state: "active",
    branch: "agent/4821/alice",
    head: "def5678",
    locked: false,
    lockReason: null,
    prunable: false,
    pruneReason: null,
    base: { kind: "remoteDefault" },
    pinned: false,
    sizeBytes: 1024 * 1024 * 412,
    lastUsedAt: Date.parse("2026-08-30T09:00:00Z"),
    allowedActions: ["open", "pin", "archive"],
  },
  {
    environmentId: "e2",
    workspaceId: "w2",
    projectId: "w1",
    path: "/Users/dev/repos/cognia-hotfix",
    sourceRoot: "/Users/dev/repos/cognia",
    ownership: "manual",
    ownerType: "user",
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
    allowedActions: ["prune"],
  },
]

/**
 * Drives the real page through the documented transport seam rather than a
 * module mock, so the environment count on the masthead comes from the same
 * `listWorkspaceEnvironments` call production makes.
 */
function installStubs() {
  setTransport({
    call: async (command: string) =>
      command === "task_workspace_environment_list"
        ? (ENVIRONMENTS as never)
        : (undefined as never),
    subscribe: () => () => {},
  } as never)
  useProjectStore.setState({
    activeProjectId: "w1",
    projects: [
      {
        id: "w1",
        name: "cognia-next",
        roots: [
          { id: "r1", path: "/Users/dev/repos/cognia", isPrimary: true },
          { id: "r2", path: "/Users/dev/repos/cognia-docs" },
        ],
        createdAt: new Date(),
        updatedAt: new Date(),
        lastAccessedAt: new Date(),
      },
      {
        id: "w2",
        name: "marketing-site",
        roots: [{ id: "r3", path: "/Users/dev/repos/site", isPrimary: true }],
        createdAt: new Date(),
        updatedAt: new Date(),
        lastAccessedAt: new Date(),
      },
    ],
  } as never)
}

const meta: Meta<typeof WorkspaceOverview> = {
  title: "Workspace/WorkspaceOverview",
  component: WorkspaceOverview,
  parameters: { layout: "fullscreen" },
}
export default meta

type Story = StoryObj<typeof WorkspaceOverview>

/** Wide pane: the masthead strip over a two-column card grid. */
export const Wide: Story = {
  decorators: [
    (Story) => {
      installStubs()
      return (
        <div style={{ height: "100vh", width: "100%" }}>
          <Story />
        </div>
      )
    },
  ],
}

/** Phone width: one column, and the tab strip scrolls rather than clipping. */
export const Narrow: Story = {
  decorators: [
    (Story) => {
      installStubs()
      return (
        <div style={{ height: "100vh", width: 390 }}>
          <Story />
        </div>
      )
    },
  ],
}
