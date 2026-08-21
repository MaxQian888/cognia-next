/** @jest-environment jsdom */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${Object.values(vars).join(",")}` : key,
}))

let shellProps: Record<string, unknown> = {}
jest.mock("@/components/feature-shell/feature-page-shell", () => ({
  FeaturePageShell: (props: Record<string, unknown>) => {
    shellProps = props
    const { header, children, rightPane } = props as {
      header: React.ReactNode
      children: React.ReactNode
      rightPane?: { content: React.ReactNode }
    }
    return (
      <div>
        {header}
        {children}
        {rightPane?.content}
      </div>
    )
  },
}))
let headerProps: Record<string, unknown> = {}
jest.mock("@/components/feature-shell/feature-page-header", () => ({
  FeaturePageHeader: (props: Record<string, unknown>) => {
    headerProps = props
    return <div data-testid="header-stub" />
  },
}))

let tableProps: Record<string, unknown> = {}
jest.mock("./project-table", () => ({
  ProjectTable: (props: Record<string, unknown>) => {
    tableProps = props
    return <div data-testid="table-stub" />
  },
}))
let inspectorProps: Record<string, unknown> = {}
jest.mock("./project-inspector", () => ({
  ProjectInspector: (props: Record<string, unknown>) => {
    inspectorProps = props
    return <div data-testid="inspector-stub" />
  },
}))
let createProps: Record<string, unknown> = {}
jest.mock("./create-project-dialog", () => ({
  CreateProjectDialog: (props: Record<string, unknown>) => {
    createProps = props
    return props.open ? <div data-testid="create-stub" /> : null
  },
}))
let deleteProps: Record<string, unknown> = {}
jest.mock("./delete-project-dialog", () => ({
  DeleteProjectDialog: (props: Record<string, unknown>) => {
    deleteProps = props
    return props.open ? <div data-testid="delete-stub" /> : null
  },
}))
jest.mock("../project-resource-dialog", () => ({
  ProjectResourceDialog: () => <div data-testid="resource-stub" />,
}))

const mockUpdate = jest.fn().mockResolvedValue(undefined)
const mockDelete = jest.fn().mockResolvedValue(undefined)
const mockRemoveResource = jest.fn().mockResolvedValue(undefined)
jest.mock("@/lib/db/issue-projects", () => ({
  listIssueProjects: jest.fn(),
  updateIssueProject: (...a: unknown[]) => mockUpdate(...a),
  deleteIssueProject: (...a: unknown[]) => mockDelete(...a),
  removeIssueProjectResource: (...a: unknown[]) => mockRemoveResource(...a),
}))
jest.mock("@/lib/db/issues", () => ({ listIssues: jest.fn() }))

const mockSyncSchedule = jest.fn().mockResolvedValue(undefined)
jest.mock("@/lib/issues/github-sync-schedule", () => ({
  syncGithubIssueSchedule: (...a: unknown[]) => mockSyncSchedule(...a),
}))
const mockRunSync = jest.fn()
jest.mock("@/lib/issues/sync-runner", () => ({
  runWorkspaceGithubSync: (...a: unknown[]) => mockRunSync(...a),
  isMissingGithubCredential: () => false,
}))

const toastCalls: Array<[string, unknown]> = []
jest.mock("sonner", () => ({
  toast: {
    error: (m: unknown) => toastCalls.push(["error", m]),
    success: (m: unknown) => toastCalls.push(["success", m]),
    info: (m: unknown) => toastCalls.push(["info", m]),
  },
}))

const mockPush = jest.fn()
jest.mock("next/navigation", () => ({ useRouter: () => ({ push: mockPush }) }))

let projectsForTest: unknown[] = []
let issuesForTest: unknown[] = []
jest.mock("@/hooks/data", () => ({
  useClientLiveQuery: (query: unknown) =>
    String(query).includes("listIssueProjects") ? projectsForTest : issuesForTest,
}))

let activeProjectId: string | null = "w1"
jest.mock("@/stores/project/project-store", () => ({
  useProjectStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ activeProjectId, projects: [{ id: "w1", roots: [] }] }),
}))

import { act, render, screen, waitFor } from "@testing-library/react"
import type { IssueProject } from "@/types/issues"
import { ProjectConsole } from "./project-console"

const project = (over: Partial<IssueProject> = {}): IssueProject => ({
  id: "p1",
  projectId: "w1",
  key: "MERC",
  name: "Mercury",
  status: "in_progress",
  priority: "medium",
  resources: [],
  createdAt: 0,
  updatedAt: 0,
  ...over,
})

function callProp(props: Record<string, unknown>, name: string, ...args: unknown[]) {
  act(() => {
    ;(props[name] as (...a: unknown[]) => void)(...args)
  })
}

beforeEach(() => {
  jest.clearAllMocks()
  shellProps = {}
  headerProps = {}
  tableProps = {}
  inspectorProps = {}
  createProps = {}
  deleteProps = {}
  toastCalls.length = 0
  activeProjectId = "w1"
  projectsForTest = []
  issuesForTest = []
  mockRunSync.mockResolvedValue({ repoCount: 0, results: [], failures: [] })
})

describe("ProjectConsole", () => {
  describe("empty", () => {
    it("shows the shared empty state rather than a bare paragraph", () => {
      render(<ProjectConsole />)
      expect(screen.getByTestId("project-console-empty")).toBeInTheDocument()
      expect(screen.queryByTestId("table-stub")).not.toBeInTheDocument()
    })
  })

  describe("table", () => {
    it("renders once there is a container", () => {
      projectsForTest = [project()]
      render(<ProjectConsole />)
      expect(screen.getByTestId("table-stub")).toBeInTheDocument()
    })

    it("computes progress in one pass over the issues it already holds", () => {
      projectsForTest = [project()]
      issuesForTest = [
        { issueProjectId: "p1", status: "done" },
        { issueProjectId: "p1", status: "todo" },
      ]
      render(<ProjectConsole />)
      const progress = tableProps.progressById as Map<string, { completed: number }>
      expect(progress.get("p1")?.completed).toBe(1)
    })
  })

  describe("create", () => {
    it("offers create as the header's primary action", () => {
      render(<ProjectConsole />)
      expect(headerProps.primaryAction).toMatchObject({ id: "create", disabled: false })
    })

    it("disables it without a workspace", () => {
      activeProjectId = null
      render(<ProjectConsole />)
      expect(headerProps.primaryAction).toMatchObject({ disabled: true })
    })

    it("opens the dialog and selects what it creates", async () => {
      render(<ProjectConsole />)
      act(() => {
        ;(headerProps.primaryAction as { onSelect: () => void }).onSelect()
      })
      expect(await screen.findByTestId("create-stub")).toBeInTheDocument()

      projectsForTest = [project({ id: "p9" })]
      callProp(createProps, "onCreated", { id: "p9" })
      await waitFor(() => expect(screen.getByTestId("inspector-stub")).toBeInTheDocument())
    })
  })

  describe("inspector", () => {
    it("stays shut until a row is selected", () => {
      projectsForTest = [project()]
      render(<ProjectConsole />)
      expect(screen.queryByTestId("inspector-stub")).not.toBeInTheDocument()
      expect(shellProps.rightPane).toBeUndefined()
    })

    it("opens on selection", async () => {
      projectsForTest = [project()]
      render(<ProjectConsole />)
      callProp(tableProps, "onSelect", "p1")
      expect(await screen.findByTestId("inspector-stub")).toBeInTheDocument()
    })

    it("writes a patch through updateIssueProject, which had no caller before", async () => {
      projectsForTest = [project()]
      render(<ProjectConsole />)
      callProp(tableProps, "onSelect", "p1")
      await screen.findByTestId("inspector-stub")
      callProp(inspectorProps, "onPatch", { status: "completed" })
      await waitFor(() => expect(mockUpdate).toHaveBeenCalledWith("p1", { status: "completed" }))
    })

    it("reports a failed patch instead of silently dropping it", async () => {
      mockUpdate.mockRejectedValueOnce(new Error("nope"))
      projectsForTest = [project()]
      render(<ProjectConsole />)
      callProp(tableProps, "onSelect", "p1")
      await screen.findByTestId("inspector-stub")
      callProp(inspectorProps, "onPatch", { status: "completed" })
      await waitFor(() => expect(toastCalls).toContainEqual(["error", "nope"]))
    })

    it("links through to the container's issues, pre-filtered", async () => {
      projectsForTest = [project()]
      render(<ProjectConsole />)
      callProp(tableProps, "onSelect", "p1")
      await screen.findByTestId("inspector-stub")
      callProp(inspectorProps, "onOpenIssues")
      expect(mockPush).toHaveBeenCalledWith("/issues?project=p1")
    })
  })

  describe("delete", () => {
    async function openDelete() {
      projectsForTest = [project()]
      render(<ProjectConsole />)
      callProp(tableProps, "onSelect", "p1")
      await screen.findByTestId("inspector-stub")
      callProp(inspectorProps, "onRequestDelete")
      await screen.findByTestId("delete-stub")
    }

    it("passes the issue count so the confirmation is not made blind", async () => {
      issuesForTest = [
        { issueProjectId: "p1", status: "done" },
        { issueProjectId: "p1", status: "canceled" },
      ]
      await openDelete()
      // The count is the container's INVENTORY, cancelled work included.
      expect(deleteProps.issueCount).toBe(2)
    })

    it("cascades, clears the selection and retires the sync schedule", async () => {
      await openDelete()
      await act(async () => {
        await (deleteProps.onConfirm as () => Promise<void>)()
      })
      expect(mockDelete).toHaveBeenCalledWith("p1")
      expect(mockSyncSchedule).toHaveBeenCalled()
      await waitFor(() => expect(screen.queryByTestId("inspector-stub")).not.toBeInTheDocument())
    })

    it("reports a failed cascade", async () => {
      mockDelete.mockRejectedValueOnce(new Error("busy"))
      await openDelete()
      await act(async () => {
        await (deleteProps.onConfirm as () => Promise<void>)()
      })
      expect(toastCalls).toContainEqual(["error", "busy"])
    })
  })

  describe("sync", () => {
    it("is disabled until a repo is bound somewhere in the workspace", () => {
      projectsForTest = [project()]
      render(<ProjectConsole />)
      const [sync] = headerProps.secondaryActions as Array<{ disabled: boolean }>
      expect(sync.disabled).toBe(true)
    })

    it("enables once a repo is bound", () => {
      projectsForTest = [
        project({ resources: [{ kind: "github-repo", repoFullName: "o/r", addedAt: 0 }] }),
      ]
      render(<ProjectConsole />)
      const [sync] = headerProps.secondaryActions as Array<{ disabled: boolean }>
      expect(sync.disabled).toBe(false)
    })

    it("bypasses the watermark, because that is why a user reaches for it", async () => {
      projectsForTest = [
        project({ resources: [{ kind: "github-repo", repoFullName: "o/r", addedAt: 0 }] }),
      ]
      mockRunSync.mockResolvedValue({
        repoCount: 1,
        results: [{ written: 4 }],
        failures: [],
      })
      render(<ProjectConsole />)
      const [sync] = headerProps.secondaryActions as Array<{ onSelect: () => void }>
      await act(async () => {
        sync.onSelect()
      })
      await waitFor(() => expect(mockRunSync).toHaveBeenCalledWith({ projectId: "w1", full: true }))
      expect(toastCalls).toContainEqual(["success", "sync.done:4"])
    })
  })
})
