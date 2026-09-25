/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
  // Members and activity format dates through the app's locale.
  useFormatter: () => ({
    dateTime: (value: Date | number) => new Date(value).toISOString(),
    relativeTime: (value: Date | number) => new Date(value).toISOString(),
  }),
  useNow: () => new Date("2026-09-25T00:00:00Z"),
}))
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
  // `controls` is rendered because the workspace switcher lives there now, and
  // the secondary actions because Manage does.
  FeaturePageHeader: ({
    title,
    summary,
    controls,
    secondaryActions,
  }: {
    title: string
    summary?: React.ReactNode
    controls?: React.ReactNode
    secondaryActions?: Array<{ id: string; label: string; onSelect?: () => void; testId?: string }>
  }) => (
    <>
      <h1>{title}</h1>
      <p data-testid="header-summary">{summary}</p>
      {secondaryActions?.map((action) => (
        <button key={action.id} type="button" onClick={action.onSelect} data-testid={action.testId}>
          {action.label}
        </button>
      ))}
      {controls}
    </>
  ),
}))
jest.mock("@/components/shared/responsive-picker", () => ({
  ResponsivePicker: ({
    trigger,
    children,
    open,
  }: {
    trigger: React.ReactNode
    children: React.ReactNode
    open: boolean
  }) => (
    <>
      {trigger}
      {open ? children : null}
    </>
  ),
}))
jest.mock("@/hooks/ui/use-mobile", () => ({ useIsMobile: () => false }))
const routerPush = jest.fn()
jest.mock("next/navigation", () => ({ useRouter: () => ({ push: routerPush }) }))
const pickerActions = {
  openFolder: jest.fn(),
  newWorkspace: jest.fn(),
  adopt: jest.fn(),
  manage: jest.fn(),
  canOpenFolder: true,
}
const pickerDialogsHook = jest.fn()
jest.mock("./workspace-picker-list", () => ({
  useWorkspacePickerDialogs: () => pickerDialogsHook(),
  useWorkspacePickerRequests: () => pickerActions,
  WorkspacePickerList: () => <div data-testid="workspace-picker-list" />,
}))
jest.mock("./workspace-recent-conversations", () => ({
  WorkspaceRecentConversations: ({ workspaceId }: { workspaceId: string | null }) => (
    <section data-testid="recent-conversations-stub">{workspaceId}</section>
  ),
}))
jest.mock("./workspace-schedules", () => ({
  WorkspaceSchedules: ({ workspaceId }: { workspaceId: string | null }) => (
    <section data-testid="schedules-stub">{workspaceId}</section>
  ),
}))
jest.mock("./workspace-context-summary", () => ({
  WorkspaceContextSummary: ({ onEdit }: { onEdit: () => void }) => (
    <button type="button" data-testid="context-edit-stub" onClick={onEdit}>
      edit
    </button>
  ),
}))
let repoVerdict: { kind: string } = { kind: "absent" }
jest.mock("@/hooks/workspace/use-repo-workspace-config", () => ({
  useRepoWorkspaceConfig: () => ({ verdict: repoVerdict }),
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
jest.mock("./workspace-capabilities", () => ({
  WorkspaceCapabilities: () => <section data-testid="workspace-capabilities-stub" />,
}))

let projectsResult: unknown[] | undefined = []
let issuesResult: unknown[] | undefined = []
let runningResult: unknown[] | undefined = []
let trustedResult: Array<{ path: string; trustedAt: number }> = []
jest.mock("@/hooks/data", () => ({
  useClientLiveQuery: (fn: () => Promise<unknown>) => {
    // Distinguish the queries by which db module the caller reached for.
    const source = fn.toString()
    if (source.includes("listIssueProjects")) return projectsResult
    if (source.includes("listActiveAgentRuns")) return runningResult
    if (source.includes("listTrustedWorkspaces")) return trustedResult
    return issuesResult
  },
}))
jest.mock("@/lib/db/issues", () => ({ listIssues: jest.fn() }))
jest.mock("@/lib/db/issue-projects", () => ({ listIssueProjects: jest.fn() }))
jest.mock("@/lib/workspace/active-agent-runs", () => ({ listActiveAgentRuns: jest.fn() }))
jest.mock("./workspace-agents-working", () => ({
  AGENTS_WORKING_REGION_ID: "workspace-section-agents-working",
  WorkspaceAgentsWorking: ({ runs }: { runs: Array<{ runId: string }> }) => (
    <section id="workspace-section-agents-working" data-testid="agents-working-stub">
      {runs.map((run) => run.runId).join(",")}
    </section>
  ),
}))
jest.mock("@/lib/db/trusted-workspaces", () => ({ listTrustedWorkspaces: jest.fn() }))

let storeState: { activeProjectId: string | null; projects: unknown[] } = {
  activeProjectId: "w1",
  projects: [],
}
jest.mock("@/stores/project/project-store", () => ({
  useProjectStore: (selector: (s: typeof storeState) => unknown) => selector(storeState),
}))

import { useState } from "react"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { WorkspaceOverview, type WorkspaceTab } from "./workspace-overview"

function issue(status: string) {
  return { id: `i-${status}-${Math.random()}`, status, issueProjectId: "p1" }
}

beforeEach(() => {
  projectsResult = []
  issuesResult = []
  runningResult = []
  trustedResult = []
  repoVerdict = { kind: "absent" }
  routerPush.mockClear()
  pickerActions.manage.mockClear()
  pickerDialogsHook.mockClear()
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

  it("switches between Overview, Environments and Capabilities", async () => {
    const user = userEvent.setup()
    render(<ControlledOverview />)
    await user.click(screen.getByRole("tab", { name: "workspace.environments" }))
    expect(screen.getByTestId("workspace-environments-stub")).toBeInTheDocument()
    // Capabilities labels itself through a SCOPED translator, so the intl mock
    // renders its name as the bare key "tab". Positional is the stable read.
    await user.click(screen.getAllByRole("tab")[2] as HTMLElement)
    expect(screen.getByTestId("workspace-capabilities-stub")).toBeInTheDocument()
  })

  /**
   * Source Control left this page: mounting the whole panel here put a
   * `FeaturePageHeader` inside a `FeaturePageShell`, and bound a
   * one-repository panel to a page that can own several roots. Removing a
   * surface without leaving its entry point behind is how a feature becomes
   * unreachable, so the strip keeps a link.
   */
  it("links out to Source Control instead of mounting it", () => {
    render(<ControlledOverview />)
    expect(screen.queryByRole("tab", { name: "workspace.sourceControl" })).not.toBeInTheDocument()
    const link = screen.getByTestId("workspace-source-control-link")
    expect(link).toHaveAttribute("href", "/source-control")
    // Beside the tab strip, not in it: a tablist admits only tabs.
    expect(screen.getByRole("tablist")).not.toContainElement(link)
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
    runningResult = [{ runId: "r1" }, { runId: "r2" }]
    render(<WorkspaceOverview />)
    expect(screen.getByTestId("workspace-stat-agents-working")).toHaveTextContent("2")
  })

  /**
   * Audit finding: "Agents working 2" with no way to see which two. The tile
   * toggles the list, fed by the same array as the number.
   */
  it("opens the list of the agents it counts, from the same source", async () => {
    const user = userEvent.setup()
    runningResult = [{ runId: "r1" }, { runId: "r2" }]
    render(<WorkspaceOverview />)

    const tile = screen.getByTestId("workspace-stat-agents-working")
    expect(tile.tagName).toBe("BUTTON")
    expect(tile).toHaveAttribute("aria-expanded", "false")
    expect(tile).toHaveTextContent("workspace.agentsWorkingShow")
    expect(screen.queryByTestId("agents-working-stub")).not.toBeInTheDocument()

    await user.click(tile)
    expect(tile).toHaveAttribute("aria-expanded", "true")
    expect(tile).toHaveAttribute("aria-controls", "workspace-section-agents-working")
    expect(screen.getByTestId("agents-working-stub")).toHaveTextContent("r1,r2")

    await user.click(tile)
    expect(screen.queryByTestId("agents-working-stub")).not.toBeInTheDocument()
  })

  /**
   * A count the reader cannot drill into is a dead end. Issues and projects
   * open the pages scoped to this workspace; Environments opens its own tab.
   */
  it("makes every tile open what it counts", () => {
    const onTabChange = jest.fn()
    render(<WorkspaceOverview tab="overview" onTabChange={onTabChange} />)

    fireEvent.click(screen.getByTestId("workspace-stat-open-issues"))
    expect(routerPush).toHaveBeenLastCalledWith("/issues")
    fireEvent.click(screen.getByTestId("workspace-stat-projects"))
    expect(routerPush).toHaveBeenLastCalledWith("/projects")
    fireEvent.click(screen.getByTestId("workspace-stat-environments"))
    expect(onTabChange).toHaveBeenCalledWith("environments")
  })

  it("says a count is unknown while its query is in flight, rather than zero", () => {
    issuesResult = undefined
    projectsResult = undefined
    runningResult = undefined
    render(<WorkspaceOverview />)
    expect(screen.getByTestId("workspace-stat-open-issues")).toHaveTextContent(
      "workspace.unknownValue"
    )
    expect(screen.getByTestId("workspace-stat-projects")).toHaveTextContent(
      "workspace.unknownValue"
    )
    expect(screen.getByTestId("workspace-stat-agents-working")).toHaveTextContent(
      "workspace.unknownValue"
    )
    // And the sections wait too, instead of claiming there is nothing.
    expect(screen.queryByTestId("workspace-no-projects")).not.toBeInTheDocument()
    expect(screen.getByTestId("workspace-projects-loading")).toBeInTheDocument()
    expect(screen.getByTestId("workspace-issues-loading")).toBeInTheDocument()
  })

  it("opens the ONE workspace editor, on this workspace, from every door", () => {
    storeState = { activeProjectId: "w1", projects: [{ id: "w1", name: "Repo", roots: [] }] }
    render(<WorkspaceOverview />)
    // Two editors over one row is the double-entry-point defect this page must
    // not reintroduce; each door asks the shell's host for the same manager.
    fireEvent.click(screen.getByTestId("workspace-manage-link"))
    fireEvent.click(screen.getByTestId("workspace-header-manage"))
    fireEvent.click(screen.getByTestId("context-edit-stub"))
    expect(pickerActions.manage.mock.calls).toEqual([["w1"], ["w1"], ["w1"]])
  })

  it("summarises the workspace with its own description when it has one", () => {
    storeState = {
      activeProjectId: "w1",
      projects: [{ id: "w1", name: "Repo", roots: [], description: "Billing API" }],
    }
    render(<WorkspaceOverview />)
    expect(screen.getByTestId("header-summary")).toHaveTextContent("Billing API")
  })

  it("carries this workspace's conversations, schedules and context", () => {
    render(<WorkspaceOverview />)
    expect(screen.getByTestId("recent-conversations-stub")).toHaveTextContent("w1")
    expect(screen.getByTestId("schedules-stub")).toHaveTextContent("w1")
    expect(screen.getByTestId("context-edit-stub")).toBeInTheDocument()
  })

  it("names the primary root in words, not as a bare '1'", () => {
    storeState = {
      activeProjectId: "w1",
      projects: [
        { id: "w1", name: "Repo", roots: [{ id: "r1", path: "/tmp/repo", isPrimary: true }] },
      ],
    }
    render(<WorkspaceOverview />)
    expect(screen.getByTestId("workspace-root-primary")).toHaveTextContent("primaryBadge")
  })

  /**
   * Every ancestor down to the shell's centre column clips, so a tab body that
   * does not scroll itself hides whatever falls below the fold.
   */
  it("gives each tab body its own scroll container", () => {
    render(<WorkspaceOverview />)
    expect(screen.getByTestId("workspace-overview")).toHaveClass("min-h-0", "overflow-y-auto")
  })

  it("flags the Environments tab when the repository config needs a decision", () => {
    repoVerdict = { kind: "unapproved" }
    render(<WorkspaceOverview />)
    expect(screen.getByTestId("workspace-environments-attention")).toBeInTheDocument()
  })

  it("keeps the Environments tab quiet when the repository asks for nothing", () => {
    render(<WorkspaceOverview />)
    expect(screen.queryByTestId("workspace-environments-attention")).not.toBeInTheDocument()
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
   * A Drawer or Popover unmounts its children on close, so what the picker
   * opens cannot live inside it. It belongs to the shell's dialog host, and
   * this page mounting a copy of its own was the second instance of one editor.
   */
  it("mounts no workspace dialogs of its own", () => {
    render(<WorkspaceOverview />)
    expect(pickerDialogsHook).not.toHaveBeenCalled()
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
    await user.click(screen.getAllByRole("tab")[2] as HTMLElement)
    expect(onTabChange).toHaveBeenCalledWith("capabilities")
    // And it did NOT switch on its own. FeaturePageShell remounts this subtree
    // when the breakpoint resolves, so an internally-owned tab snaps back.
    expect(screen.getByTestId("workspace-overview")).toHaveAttribute("data-state", "active")
  })
})
