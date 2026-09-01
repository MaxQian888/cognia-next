/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))
jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}))
jest.mock("@/components/feature-shell/feature-page-shell", () => ({
  FeaturePageShell: ({
    header,
    children,
  }: {
    header: React.ReactNode
    children: React.ReactNode
  }) => (
    <div>
      {header}
      {children}
    </div>
  ),
}))
jest.mock("@/components/feature-shell/feature-page-header", () => ({
  // `controls` is rendered because the workspace switcher lives there now.
  FeaturePageHeader: ({ title, controls }: { title: string; controls?: React.ReactNode }) => (
    <>
      <h1>{title}</h1>
      {controls}
    </>
  ),
}))
jest.mock("./workspace-picker-list", () => ({
  useWorkspacePickerDialogs: () => ({
    actions: {},
    element: <div data-testid="workspace-picker-dialogs" />,
  }),
  WorkspacePickerList: () => <div data-testid="workspace-picker-list" />,
}))
jest.mock("@/components/settings/project-environment-manager", () => ({
  ProjectEnvironmentManager: () => <section data-testid="project-environment-manager-stub" />,
}))
const listWorkspaceEnvironmentsMock = jest.fn()
jest.mock("@/lib/task-workspace/client", () => ({
  listWorkspaceEnvironments: (...args: unknown[]) => listWorkspaceEnvironmentsMock(...args),
}))
jest.mock("./workspace-environment-list", () => ({
  WorkspaceEnvironmentList: () => <section data-testid="workspace-environments-stub" />,
}))
jest.mock("@/components/source-control/source-control-panel", () => ({
  SourceControlPanel: () => <section data-testid="workspace-source-control-stub" />,
}))

let projectsResult: unknown[] = []
let issuesResult: unknown[] = []
let runningResult: ReadonlySet<string> = new Set()
let trustedResult: Array<{ path: string; trustedAt: number }> = []
jest.mock("@/hooks/data", () => ({
  useClientLiveQuery: (fn: () => Promise<unknown>) => {
    // Distinguish the queries by which db module the caller reached for.
    const source = fn.toString()
    if (source.includes("listIssueProjects")) return projectsResult
    if (source.includes("listActiveIssueRunIssueIds")) return runningResult
    if (source.includes("listTrustedWorkspaces")) return trustedResult
    return issuesResult
  },
}))
jest.mock("@/lib/db/issues", () => ({ listIssues: jest.fn() }))
jest.mock("@/lib/db/issue-projects", () => ({ listIssueProjects: jest.fn() }))
jest.mock("@/lib/db/issue-runs", () => ({ listActiveIssueRunIssueIds: jest.fn() }))
jest.mock("@/lib/db/trusted-workspaces", () => ({ listTrustedWorkspaces: jest.fn() }))
let manageDialogProps: { open: boolean; onOpenChange: (open: boolean) => void } | null = null
jest.mock("@/components/shell/workspace-manage-dialog", () => ({
  WorkspaceManageDialog: (props: { open: boolean; onOpenChange: (open: boolean) => void }) => {
    manageDialogProps = props
    return props.open ? <div data-testid="manage-dialog-stub" /> : null
  },
}))

let storeState: { activeProjectId: string | null; projects: unknown[] } = {
  activeProjectId: "w1",
  projects: [],
}
jest.mock("@/stores/project/project-store", () => ({
  useProjectStore: (selector: (s: typeof storeState) => unknown) => selector(storeState),
}))

import { useState } from "react"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { WorkspaceOverview, type WorkspaceTab } from "./workspace-overview"

function issue(status: string) {
  return { id: `i-${status}-${Math.random()}`, status, issueProjectId: "p1" }
}

beforeEach(() => {
  projectsResult = []
  issuesResult = []
  runningResult = new Set()
  trustedResult = []
  manageDialogProps = null
  storeState = { activeProjectId: "w1", projects: [] }
  listWorkspaceEnvironmentsMock.mockReset()
  listWorkspaceEnvironmentsMock.mockResolvedValue([])
})

/**
 * The tab is a prop now (driven by `?tab=` on the page), so a click only moves
 * the strip if something owns the value. This is the page's job in production,
 * and this harness is the smallest stand-in for it.
 */
function ControlledOverview() {
  const [tab, setTab] = useState<WorkspaceTab>("overview")
  return <WorkspaceOverview tab={tab} onTabChange={setTab} />
}

describe("WorkspaceOverview", () => {
  it("titles itself with the active workspace name", () => {
    storeState = {
      activeProjectId: "w1",
      projects: [{ id: "w1", name: "Cognia", roots: [] }],
    }
    render(<WorkspaceOverview />)
    expect(screen.getByRole("heading", { name: "Cognia" })).toBeInTheDocument()
    expect(screen.getByTestId("workspace-overview")).toBeInTheDocument()
  })

  it("switches between Overview, Environments, and Source Control", async () => {
    const user = userEvent.setup()
    render(<ControlledOverview />)
    await user.click(screen.getByRole("tab", { name: "workspace.environments" }))
    expect(screen.getByTestId("workspace-environments-stub")).toBeInTheDocument()
    await user.click(screen.getByRole("tab", { name: "workspace.sourceControl" }))
    expect(screen.getByTestId("workspace-source-control-stub")).toBeInTheDocument()
  })

  it("counts only unstarted and started issues as open", () => {
    issuesResult = [issue("todo"), issue("in_progress"), issue("done"), issue("canceled")]
    render(<WorkspaceOverview />)
    expect(screen.getByTestId("workspace-stat-open-issues")).toHaveTextContent("2")
  })

  it("breaks issues down across every status, including empty ones", () => {
    issuesResult = [issue("todo")]
    render(<WorkspaceOverview />)
    expect(screen.getByTestId("workspace-status-todo")).toHaveTextContent("1")
    expect(screen.getByTestId("workspace-status-done")).toHaveTextContent("0")
  })

  it("says so when the workspace has no projects", () => {
    render(<WorkspaceOverview />)
    expect(screen.getByTestId("workspace-no-projects")).toBeInTheDocument()
  })

  it("links each project to its deep link", () => {
    projectsResult = [{ id: "p1", name: "Mercury", key: "MERC", status: "planned", resources: [] }]
    render(<WorkspaceOverview />)
    const link = screen.getByTestId("workspace-project-p1")
    expect(link).toHaveAttribute("href", "/projects?id=p1")
    expect(link).toHaveTextContent("MERC")
    expect(screen.getByTestId("workspace-stat-projects")).toHaveTextContent("1")
  })

  it("lists the workspace's mounted roots with their trust state", () => {
    storeState = {
      activeProjectId: "w1",
      projects: [
        {
          id: "w1",
          name: "Cognia",
          roots: [
            { id: "r1", path: "/tmp/repo/", isPrimary: true },
            { id: "r2", path: "/tmp/other" },
          ],
        },
      ],
    }
    trustedResult = [{ path: "/tmp/repo", trustedAt: 1 }]
    render(<WorkspaceOverview />)
    expect(screen.getByTestId("workspace-roots")).toHaveTextContent("/tmp/repo")
    expect(screen.getAllByTestId("workspace-root-trust-trusted")).toHaveLength(1)
    expect(screen.getAllByTestId("workspace-root-trust-untrusted")).toHaveLength(1)
  })

  it("counts issues with an active run as agents working", () => {
    runningResult = new Set(["i1", "i2"])
    render(<WorkspaceOverview />)
    expect(screen.getByTestId("workspace-stat-agents-working")).toHaveTextContent("2")
  })

  it("opens the ONE root editor (the manage dialog) instead of editing roots here", () => {
    render(<WorkspaceOverview />)
    // Two editors over one row is the double-entry-point defect this page must
    // not reintroduce; it mounts the existing manager dialog instead.
    expect(screen.queryByTestId("manage-dialog-stub")).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId("workspace-manage-link"))
    expect(screen.getByTestId("manage-dialog-stub")).toBeInTheDocument()
    act(() => manageDialogProps!.onOpenChange(false))
  })

  /**
   * The rail switcher lives inside a nav sheet that only `/` mounts on a
   * phone, so this page could describe a workspace with no way to change
   * which one it was describing.
   */
  it("carries the workspace switcher in its header", () => {
    render(<WorkspaceOverview />)
    expect(screen.getByTestId("workspace-switcher-trigger")).toBeInTheDocument()
  })

  /**
   * A Drawer or Popover unmounts its children on close, so the picker's
   * dialogs have to be mounted by the page, not inside the trigger.
   */
  it("mounts the picker's dialogs outside the popover", () => {
    render(<WorkspaceOverview />)
    expect(screen.getByTestId("workspace-picker-dialogs")).toBeInTheDocument()
  })

  it("counts this workspace's environments, ignoring rows another project owns", async () => {
    listWorkspaceEnvironmentsMock.mockResolvedValue([
      { environmentId: "a", projectId: "w1" },
      { environmentId: "b", projectId: "w1" },
      { environmentId: "c", projectId: "other" },
    ])
    render(<WorkspaceOverview />)
    await waitFor(() =>
      expect(screen.getByTestId("workspace-stat-environments")).toHaveTextContent("2")
    )
  })

  /**
   * A host that cannot answer must leave the tile unknown. Reporting 0 would
   * say "this workspace has no worktrees", which is a different claim.
   */
  it("leaves the environment tile unknown when the host cannot answer", async () => {
    listWorkspaceEnvironmentsMock.mockRejectedValue(new Error("no host"))
    render(<WorkspaceOverview />)
    await waitFor(() =>
      expect(screen.getByTestId("workspace-stat-environments")).not.toHaveTextContent("0")
    )
  })

  /**
   * `ProjectEnvironmentManager` was reachable only from chat, through the
   * session settings sheet, so the repo-config and provisioning offers had no
   * entry from the page about the workspace they configure.
   */
  it("offers the repo config and provisioning rules beside the environments", async () => {
    const user = userEvent.setup()
    storeState = {
      activeProjectId: "w1",
      projects: [
        { id: "w1", name: "Repo", roots: [{ id: "r1", path: "/tmp/repo", isPrimary: true }] },
      ],
    }
    render(<ControlledOverview />)
    await user.click(screen.getByRole("tab", { name: "workspace.environments" }))
    expect(screen.getByTestId("project-environment-manager-stub")).toBeInTheDocument()
  })

  it("does not offer provisioning rules for a workspace with no root", async () => {
    const user = userEvent.setup()
    render(<ControlledOverview />)
    await user.click(screen.getByRole("tab", { name: "workspace.environments" }))
    expect(screen.queryByTestId("project-environment-manager-stub")).not.toBeInTheDocument()
  })
})

describe("WorkspaceOverview tab addressing", () => {
  it("opens on the tab it is told to, so a deep link lands where it points", () => {
    render(<WorkspaceOverview tab="environments" onTabChange={() => {}} />)
    expect(screen.getByTestId("workspace-environments-stub")).toBeInTheDocument()
    // Radix keeps the other panel mounted and hidden rather than unmounting it.
    expect(screen.getByTestId("workspace-overview")).toHaveAttribute("data-state", "inactive")
  })

  it("reports a tab change instead of owning it", async () => {
    const user = userEvent.setup()
    const onTabChange = jest.fn()
    render(<WorkspaceOverview tab="overview" onTabChange={onTabChange} />)
    await user.click(screen.getByRole("tab", { name: "workspace.sourceControl" }))
    expect(onTabChange).toHaveBeenCalledWith("source-control")
    // And it did NOT switch on its own. FeaturePageShell remounts this subtree
    // when the breakpoint resolves, so an internally-owned tab snaps back.
    expect(screen.getByTestId("workspace-overview")).toHaveAttribute("data-state", "active")
  })
})
