import { render, screen, fireEvent } from "@testing-library/react"
import { SourceControlWorkbenchPanel } from "./source-control-workbench-panel"

// Mock next-intl
jest.mock("next-intl", () => ({
  useTranslations: (namespace: string) => {
    const keys: Record<string, string> = {
      "contextWorkbench.sourceControlPanel.noRepo": "No repository",
      "contextWorkbench.sourceControlPanel.noRepoDescription":
        "Open a project with a Git repository.",
      "contextWorkbench.sourceControlPanel.detached": "HEAD detached",
      "contextWorkbench.sourceControlPanel.changeCount": "{count} changes",
      "contextWorkbench.sourceControlPanel.commitPlaceholder": "Commit message…",
      "contextWorkbench.sourceControlPanel.commitLabel": "Commit message",
      "contextWorkbench.sourceControlPanel.commit": "Commit",
      "contextWorkbench.sourceControlPanel.clean": "Working tree clean",
      "contextWorkbench.sourceControlPanel.cleanDescription": "No uncommitted changes.",
      "contextWorkbench.sourceControlPanel.staged": "{count} staged",
      "contextWorkbench.sourceControlPanel.unstaged": "{count} changes",
      "contextWorkbench.sourceControlPanel.openFullPage": "Open full source control",
      "sourceControl.errors.commitFailed": "Commit failed",
    }
    return (key: string, params?: Record<string, unknown>) => {
      const fullKey = `${namespace}.${key}`
      const value = keys[fullKey] ?? key
      if (params && "count" in params) return value.replace("{count}", String(params.count))
      return value
    }
  },
}))

// Mock git store
const mockGitState = {
  rootDir: "/project",
  status: null as null | {
    branch: string | null
    upstream: string | null
    ahead: number
    behind: number
    staged: Array<{ path: string; origPath: null; status: string; staged: boolean; group: string }>
    changes: Array<{ path: string; origPath: null; status: string; staged: boolean; group: string }>
    merge: []
    isRebasing: boolean
    isMerging: boolean
  },
  commitDraft: {} as Record<string, string>,
  ops: {
    commit: false,
    status: false,
    push: false,
    pull: false,
    checkout: false,
    fetch: false,
    stage: false,
    unstage: false,
    discard: false,
    stash: false,
    merge: false,
    rebase: false,
    sync: false,
    cherryPick: false,
    revert: false,
    reset: false,
    restore: false,
    "sequencer-continue": false,
    "sequencer-abort": false,
    "interactive-rebase": false,
    tag: false,
    remote: false,
    ignore: false,
    branch: false,
  },
  setCommitDraft: jest.fn(),
}

jest.mock("@/stores/git/git-store", () => ({
  useGitStore: (selector: (s: typeof mockGitState) => unknown) => selector(mockGitState),
  useGitStatus: () => mockGitState.status,
}))

// Mock git actions
const mockActions = {
  stage: jest.fn().mockResolvedValue(null),
  unstage: jest.fn().mockResolvedValue(null),
  discard: jest.fn().mockResolvedValue(null),
  commit: jest.fn().mockResolvedValue(null),
}

jest.mock("@/hooks/git/use-git-actions", () => ({
  useGitActions: () => mockActions,
}))

// Mock status-decoration
jest.mock("@/components/source-control/status-decoration", () => ({
  splitPath: (path: string) => {
    const idx = path.lastIndexOf("/")
    return idx < 0
      ? { dir: "", file: path }
      : { dir: path.slice(0, idx), file: path.slice(idx + 1) }
  },
  statusDecoration: (status: string) => ({
    letter: status[0]?.toUpperCase() ?? "?",
    color: "text-yellow-500",
  }),
}))

// Mock ScrollArea
jest.mock("@/components/ui/scroll-area", () => ({
  ScrollArea: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <div data-testid="scroll-area" className={className}>
      {children}
    </div>
  ),
}))

describe("SourceControlWorkbenchPanel", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGitState.status = null
    mockGitState.commitDraft = {}
  })

  it("shows empty state when no git repo is active", () => {
    mockGitState.status = null
    render(<SourceControlWorkbenchPanel />)
    expect(screen.getByText("No repository")).toBeInTheDocument()
  })

  it("shows clean state when no changes exist", () => {
    mockGitState.status = {
      branch: "main",
      upstream: "origin/main",
      ahead: 0,
      behind: 0,
      staged: [],
      changes: [],
      merge: [],
      isRebasing: false,
      isMerging: false,
    }
    render(<SourceControlWorkbenchPanel />)
    expect(screen.getByText("Working tree clean")).toBeInTheDocument()
  })

  it("displays the current branch name", () => {
    mockGitState.status = {
      branch: "feature/cool",
      upstream: "origin/feature/cool",
      ahead: 2,
      behind: 1,
      staged: [],
      changes: [
        { path: "src/app.ts", origPath: null, status: "modified", staged: false, group: "changes" },
      ],
      merge: [],
      isRebasing: false,
      isMerging: false,
    }
    render(<SourceControlWorkbenchPanel />)
    expect(screen.getByText("feature/cool")).toBeInTheDocument()
    expect(screen.getByText("↑2↓1")).toBeInTheDocument()
  })

  it("renders change rows for unstaged files", () => {
    mockGitState.status = {
      branch: "main",
      upstream: null,
      ahead: 0,
      behind: 0,
      staged: [],
      changes: [
        {
          path: "src/index.ts",
          origPath: null,
          status: "modified",
          staged: false,
          group: "changes",
        },
        { path: "README.md", origPath: null, status: "added", staged: false, group: "changes" },
      ],
      merge: [],
      isRebasing: false,
      isMerging: false,
    }
    render(<SourceControlWorkbenchPanel />)
    expect(screen.getByTestId("change-row-src/index.ts")).toBeInTheDocument()
    expect(screen.getByTestId("change-row-README.md")).toBeInTheDocument()
  })

  it("shows commit box when staged files exist", () => {
    mockGitState.status = {
      branch: "main",
      upstream: null,
      ahead: 0,
      behind: 0,
      staged: [
        { path: "src/app.ts", origPath: null, status: "modified", staged: true, group: "staged" },
      ],
      changes: [],
      merge: [],
      isRebasing: false,
      isMerging: false,
    }
    render(<SourceControlWorkbenchPanel />)
    expect(screen.getByPlaceholderText("Commit message…")).toBeInTheDocument()
    expect(screen.getByText("Commit")).toBeInTheDocument()
  })

  it("calls stage action when stage button is clicked on unstaged file", () => {
    mockGitState.status = {
      branch: "main",
      upstream: null,
      ahead: 0,
      behind: 0,
      staged: [],
      changes: [
        { path: "src/app.ts", origPath: null, status: "modified", staged: false, group: "changes" },
      ],
      merge: [],
      isRebasing: false,
      isMerging: false,
    }
    render(<SourceControlWorkbenchPanel />)
    // The first button in the change row group (stage = CheckIcon)
    const row = screen.getByTestId("change-row-src/app.ts")
    const buttons = row.querySelectorAll("button")
    fireEvent.click(buttons[0]) // stage button
    expect(mockActions.stage).toHaveBeenCalledWith(["src/app.ts"])
  })

  it("renders link to full source control page", () => {
    mockGitState.status = {
      branch: "main",
      upstream: null,
      ahead: 0,
      behind: 0,
      staged: [],
      changes: [],
      merge: [],
      isRebasing: false,
      isMerging: false,
    }
    render(<SourceControlWorkbenchPanel />)
    expect(screen.getByText("Open full source control")).toBeInTheDocument()
    const link = screen.getByText("Open full source control").closest("a")
    expect(link).toHaveAttribute("href", "/source-control")
  })
})
