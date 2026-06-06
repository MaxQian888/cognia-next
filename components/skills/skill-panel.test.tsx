/**
 * @jest-environment jsdom
 */

// The panel is a composition root over ~15 stores / hooks / children. We
// don't try to exercise the full tree — instead we mock each direct child
// to a sentinel, mock the hook/store reads to controlled values, and
// verify (a) the right children mount for each `activeTab`, (b) the
// master-detail behavior (auto-select, inline detail, mobile gate),
// (c) the editor host wires `createSkill` / `updateSkill` to the store
// callbacks, (d) the delete host wires `deleteSkill`.

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

jest.mock("sonner", () => ({
  toast: { success: jest.fn(), error: jest.fn() },
}))

jest.mock("motion/react", () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  motion: {
    div: ({ children, ...rest }: { children: React.ReactNode } & Record<string, unknown>) => (
      <div {...rest}>{children}</div>
    ),
  },
  useReducedMotion: () => false,
}))

const liveQueryRef: { current: unknown } = { current: undefined }
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: jest.fn(() => liveQueryRef.current),
}))

const createSkill = jest.fn(async (draft: { name: string }) => ({ id: "new-1", ...draft }))
const updateSkill = jest.fn(async (_id: string, _patch: unknown) => undefined)
const deleteSkill = jest.fn(async () => undefined)
const getSkill = jest.fn(async () => undefined)

jest.mock("@/lib/db/skills", () => ({
  createSkill: (...args: unknown[]) => createSkill(...(args as Parameters<typeof createSkill>)),
  updateSkill: (...args: unknown[]) => updateSkill(...(args as Parameters<typeof updateSkill>)),
  deleteSkill: (...args: unknown[]) => deleteSkill(...(args as Parameters<typeof deleteSkill>)),
  getSkill: (...args: unknown[]) => getSkill(...(args as Parameters<typeof getSkill>)),
}))

type ViewSkill = { id: string; name: string; status?: string }
const viewRef: { all: ViewSkill[]; filtered: ViewSkill[] } = { all: [], filtered: [] }

const aiRun = jest.fn(async () => null)
jest.mock("@/hooks/skills", () => ({
  useSkills: () => ({
    all: viewRef.all,
    filtered: viewRef.filtered,
    countsByCategory: {},
    countsBySource: {},
    allTags: [],
  }),
  useSkillAi: () => ({ run: aiRun }),
  useSkillShortcuts: () => {},
  URL_INSTALL_INVALID: "invalid",
  useUrlInstall: () => ({
    run: jest.fn(),
    busy: false,
    error: null,
    clearError: jest.fn(),
  }),
}))

const mobileRef = { current: false }
jest.mock("@/hooks/ui/use-mobile", () => ({
  useIsMobile: () => mobileRef.current,
}))

const storeState: {
  activeTab: "my-skills" | "browse" | "editor" | "analytics"
  editorTarget: null | { mode: "create" | "edit"; skillId?: string }
  importStaging: null | object
  deleteTarget: null | { skillId: string; name: string }
  detailSkillId: string | null
  createSeed: null
  closeEditor: jest.Mock
  setImportStaging: jest.Mock
  setDeleteTarget: jest.Mock
  openDetail: jest.Mock
  closeDetail: jest.Mock
  openCreate: jest.Mock
} = {
  activeTab: "my-skills",
  editorTarget: null,
  importStaging: null,
  deleteTarget: null,
  detailSkillId: null,
  createSeed: null,
  closeEditor: jest.fn(),
  setImportStaging: jest.fn(),
  setDeleteTarget: jest.fn(),
  openDetail: jest.fn(),
  closeDetail: jest.fn(),
  openCreate: jest.fn(),
}

jest.mock("@/stores/skills", () => ({
  useSkillsStore: (selector: (s: typeof storeState) => unknown) => selector(storeState),
}))

const tauriRef = { current: false }
jest.mock("@/lib/tauri", () => ({
  isTauri: jest.fn(() => tauriRef.current),
}))

jest.mock("./skill-panel-header", () => ({
  SkillPanelHeader: ({
    totalCount,
    filteredCount,
    tabsSlot,
  }: {
    totalCount: number
    filteredCount: number
    tabsSlot?: React.ReactNode
  }) => (
    <div data-testid="header">
      {`${totalCount}/${filteredCount}`}
      {tabsSlot}
    </div>
  ),
}))
jest.mock("./skill-panel-tabs", () => ({
  SkillPanelTabs: () => <div data-testid="tabs" />,
}))
jest.mock("./skill-list-pane", () => ({
  SkillListPane: ({ onCreate }: { onCreate: () => void }) => (
    <div data-testid="list-pane">
      <button data-testid="list-pane-create" onClick={onCreate}>
        create
      </button>
    </div>
  ),
}))
jest.mock("./skill-detail", () => ({
  SkillDetail: ({ skill }: { skill: { name: string } }) => (
    <div data-testid="detail-inline">{skill.name}</div>
  ),
}))
jest.mock("./skill-category-sheet", () => ({
  SkillCategorySheet: () => <div data-testid="cat-sheet" />,
}))
jest.mock("./skill-filter-sheet", () => ({
  SkillFilterSheet: () => <div data-testid="filter-sheet" />,
}))
jest.mock("./skill-batch-actions-bar", () => ({
  SkillBatchActionsBar: () => <div data-testid="batch-bar" />,
}))
jest.mock("./skill-detail-panel", () => ({
  SkillDetailPanel: () => <div data-testid="detail-panel" />,
}))
jest.mock("./skill-import-dialog", () => ({
  SkillImportDialog: ({
    onComplete,
    onCancel,
  }: {
    onComplete: (report: {
      created: number
      updated: number
      skipped: number
      errored: unknown[]
    }) => void
    onCancel: () => void
  }) => (
    <div data-testid="import-dialog">
      <button
        data-testid="import-complete"
        onClick={() => onComplete({ created: 1, updated: 0, skipped: 0, errored: [] })}
      >
        complete
      </button>
      <button
        data-testid="import-complete-empty"
        onClick={() => onComplete({ created: 0, updated: 0, skipped: 0, errored: [] })}
      >
        complete-empty
      </button>
      <button data-testid="import-cancel" onClick={onCancel}>
        cancel
      </button>
    </div>
  ),
}))
jest.mock("./skill-delete-dialog", () => ({
  SkillDeleteDialog: ({ onConfirm }: { onConfirm: () => void }) => (
    <button data-testid="delete-confirm" onClick={onConfirm}>
      delete-confirm
    </button>
  ),
}))
jest.mock("./skill-editor", () => ({
  SkillEditor: ({
    onSave,
    onCancel,
    onAiAssist,
  }: {
    onSave: (d: { name: string; content: string }) => Promise<void>
    onCancel: () => void
    onAiAssist?: (intent: string, current: unknown) => Promise<unknown>
  }) => (
    <div>
      <button data-testid="editor-save" onClick={() => onSave({ name: "Saved", content: "body" })}>
        save
      </button>
      <button data-testid="editor-cancel" onClick={onCancel}>
        cancel
      </button>
      {onAiAssist && (
        <button data-testid="editor-ai" onClick={() => void onAiAssist("improve", null)}>
          ai
        </button>
      )}
    </div>
  ),
}))
jest.mock("./skill-marketplace", () => ({
  SkillMarketplace: () => <div data-testid="marketplace" />,
}))
jest.mock("./skill-analytics", () => ({
  SkillAnalytics: () => <div data-testid="analytics" />,
}))
jest.mock("./editor/skill-editor-workspace", () => ({
  SkillEditorWorkspace: () => <div data-testid="editor-workspace" />,
}))

import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { SkillPanel } from "./skill-panel"

beforeEach(() => {
  jest.clearAllMocks()
  liveQueryRef.current = undefined
  viewRef.all = []
  viewRef.filtered = []
  mobileRef.current = false
  tauriRef.current = false
  storeState.activeTab = "my-skills"
  storeState.editorTarget = null
  storeState.importStaging = null
  storeState.deleteTarget = null
  storeState.detailSkillId = null
  storeState.closeEditor = jest.fn()
  storeState.setImportStaging = jest.fn()
  storeState.setDeleteTarget = jest.fn()
  storeState.openDetail = jest.fn()
  storeState.closeDetail = jest.fn()
  storeState.openCreate = jest.fn()
})

describe("SkillPanel", () => {
  it("renders header (with tabs slot), list pane and the empty detail pane for 'my-skills'", () => {
    render(<SkillPanel />)
    expect(screen.getByTestId("header")).toBeInTheDocument()
    // Tabs render twice: once inside the header slot (lg+), once standalone (below lg).
    expect(screen.getAllByTestId("tabs")).toHaveLength(2)
    expect(screen.getByTestId("list-pane")).toBeInTheDocument()
    expect(screen.getByText("panel.selectSkillTitle")).toBeInTheDocument()
    expect(screen.queryByTestId("marketplace")).not.toBeInTheDocument()
  })

  it("auto-selects the first filtered skill on desktop when none is selected", () => {
    viewRef.all = [{ id: "s1", name: "Alpha" }]
    viewRef.filtered = [{ id: "s1", name: "Alpha" }]
    render(<SkillPanel />)
    expect(storeState.openDetail).toHaveBeenCalledWith("s1")
  })

  it("re-selects when the current detail target falls out of the filtered list", () => {
    storeState.detailSkillId = "gone"
    viewRef.filtered = [{ id: "s2", name: "Beta" }]
    render(<SkillPanel />)
    expect(storeState.openDetail).toHaveBeenCalledWith("s2")
  })

  it("clears the selection when the filtered list is empty", () => {
    storeState.detailSkillId = "s1"
    viewRef.filtered = []
    render(<SkillPanel />)
    expect(storeState.closeDetail).toHaveBeenCalled()
  })

  it("keeps a still-visible selection untouched", () => {
    storeState.detailSkillId = "s1"
    viewRef.filtered = [{ id: "s1", name: "Alpha" }]
    render(<SkillPanel />)
    expect(storeState.openDetail).not.toHaveBeenCalled()
    expect(storeState.closeDetail).not.toHaveBeenCalled()
  })

  it("renders the loaded skill inline in the detail pane on desktop", () => {
    storeState.detailSkillId = "s1"
    viewRef.filtered = [{ id: "s1", name: "Alpha" }]
    liveQueryRef.current = { id: "s1", name: "Alpha" }
    render(<SkillPanel />)
    expect(screen.getByTestId("detail-inline")).toHaveTextContent("Alpha")
  })

  it("does not auto-select or render the inline detail pane on mobile", () => {
    mobileRef.current = true
    viewRef.filtered = [{ id: "s1", name: "Alpha" }]
    render(<SkillPanel />)
    expect(storeState.openDetail).not.toHaveBeenCalled()
    expect(screen.queryByText("panel.selectSkillTitle")).not.toBeInTheDocument()
    expect(screen.queryByTestId("detail-inline")).not.toBeInTheDocument()
  })

  it("opens the create editor without a seed from the list pane empty state", () => {
    render(<SkillPanel />)
    fireEvent.click(screen.getByTestId("list-pane-create"))
    expect(storeState.openCreate).toHaveBeenCalledWith()
  })

  it("renders the marketplace surface for the 'browse' tab", () => {
    storeState.activeTab = "browse"
    render(<SkillPanel />)
    expect(screen.getByTestId("marketplace")).toBeInTheDocument()
    expect(screen.queryByTestId("list-pane")).not.toBeInTheDocument()
  })

  it("renders the editor workspace for the 'editor' tab", () => {
    storeState.activeTab = "editor"
    render(<SkillPanel />)
    expect(screen.getByTestId("editor-workspace")).toBeInTheDocument()
  })

  it("renders the analytics surface for the 'analytics' tab", () => {
    storeState.activeTab = "analytics"
    render(<SkillPanel />)
    expect(screen.getByTestId("analytics")).toBeInTheDocument()
  })

  it("calls createSkill when the editor host saves in create mode", async () => {
    storeState.editorTarget = { mode: "create" }
    render(<SkillPanel />)
    fireEvent.click(screen.getByTestId("editor-save"))
    await waitFor(() => expect(createSkill).toHaveBeenCalled())
    expect(storeState.closeEditor).toHaveBeenCalled()
  })

  it("calls deleteSkill and clears the target when the delete dialog confirms", async () => {
    storeState.deleteTarget = { skillId: "s1", name: "Doomed" }
    render(<SkillPanel />)
    fireEvent.click(screen.getByTestId("delete-confirm"))
    await waitFor(() => expect(deleteSkill).toHaveBeenCalledWith("s1"))
    expect(storeState.setDeleteTarget).toHaveBeenCalledWith(null)
  })

  it("still clears the target when deleteSkill fails", async () => {
    deleteSkill.mockRejectedValueOnce(new Error("locked"))
    storeState.deleteTarget = { skillId: "s1", name: "Doomed" }
    render(<SkillPanel />)
    fireEvent.click(screen.getByTestId("delete-confirm"))
    await waitFor(() => expect(storeState.setDeleteTarget).toHaveBeenCalledWith(null))
  })

  it("calls updateSkill when the editor host saves in edit mode", async () => {
    storeState.editorTarget = { mode: "edit", skillId: "s1" }
    liveQueryRef.current = { id: "s1", name: "Old", description: "d", content: "c" }
    render(<SkillPanel />)
    fireEvent.click(screen.getByTestId("editor-save"))
    await waitFor(() => expect(updateSkill).toHaveBeenCalled())
    expect(updateSkill.mock.calls[0][0]).toBe("s1")
    expect(storeState.closeEditor).toHaveBeenCalled()
  })

  it("closes the editor when the editor cancels", () => {
    storeState.editorTarget = { mode: "create" }
    render(<SkillPanel />)
    fireEvent.click(screen.getByTestId("editor-cancel"))
    expect(storeState.closeEditor).toHaveBeenCalled()
  })

  it("keeps the editor open and surfaces the error when save fails", async () => {
    createSkill.mockRejectedValueOnce(new Error("disk full"))
    storeState.editorTarget = { mode: "create" }
    render(<SkillPanel />)
    fireEvent.click(screen.getByTestId("editor-save"))
    await waitFor(() => expect(createSkill).toHaveBeenCalled())
    expect(storeState.closeEditor).not.toHaveBeenCalled()
  })

  it("closes the editor when its sheet is dismissed", () => {
    storeState.editorTarget = { mode: "create" }
    render(<SkillPanel />)
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" })
    expect(storeState.closeEditor).toHaveBeenCalled()
  })

  it("wires AI assist through to the skill AI hook in Tauri", async () => {
    tauriRef.current = true
    storeState.editorTarget = { mode: "create" }
    render(<SkillPanel />)
    fireEvent.click(screen.getByTestId("editor-ai"))
    await waitFor(() => expect(aiRun).toHaveBeenCalledWith("improve", null))
  })

  it("returns null and surfaces a toast when AI assist fails", async () => {
    tauriRef.current = true
    aiRun.mockRejectedValueOnce(new Error("model offline"))
    storeState.editorTarget = { mode: "create" }
    render(<SkillPanel />)
    fireEvent.click(screen.getByTestId("editor-ai"))
    await waitFor(() => expect(aiRun).toHaveBeenCalled())
  })

  it("does not offer AI assist outside Tauri", () => {
    storeState.editorTarget = { mode: "create" }
    render(<SkillPanel />)
    expect(screen.queryByTestId("editor-ai")).not.toBeInTheDocument()
  })

  it("renders the import dialog when staging is set and clears it on completion", () => {
    storeState.importStaging = { drafts: [], sourceLabel: "x", parseErrors: [] }
    render(<SkillPanel />)
    fireEvent.click(screen.getByTestId("import-complete"))
    expect(storeState.setImportStaging).toHaveBeenCalledWith(null)
  })

  it("reports a no-changes import summary", () => {
    storeState.importStaging = { drafts: [], sourceLabel: "x", parseErrors: [] }
    render(<SkillPanel />)
    fireEvent.click(screen.getByTestId("import-complete-empty"))
    expect(storeState.setImportStaging).toHaveBeenCalledWith(null)
  })

  it("clears the staging when the import dialog cancels", () => {
    storeState.importStaging = { drafts: [], sourceLabel: "x", parseErrors: [] }
    render(<SkillPanel />)
    fireEvent.click(screen.getByTestId("import-cancel"))
    expect(storeState.setImportStaging).toHaveBeenCalledWith(null)
  })

  it("shows a loading fallback in the detail pane while the skill resolves", () => {
    storeState.detailSkillId = "s1"
    viewRef.filtered = [{ id: "s1", name: "Alpha" }]
    liveQueryRef.current = undefined
    render(<SkillPanel />)
    expect(screen.getByText("loading")).toBeInTheDocument()
  })
})
