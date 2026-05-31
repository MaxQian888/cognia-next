/**
 * @jest-environment jsdom
 */

// The panel is a composition root over ~15 stores / hooks / children. We
// don't try to exercise the full tree — instead we mock each direct child
// to a sentinel, mock the hook/store reads to controlled values, and
// verify (a) the right children mount for each `activeTab`, (b) the
// editor host wires `createSkill` / `updateSkill` to the store callbacks,
// (c) the delete host wires `deleteSkill`.

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

jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: jest.fn(() => undefined),
}))

const createSkill = jest.fn(async (draft: { name: string }) => ({ id: "new-1", ...draft }))
const updateSkill = jest.fn(async () => undefined)
const deleteSkill = jest.fn(async () => undefined)
const getSkill = jest.fn(async () => undefined)

jest.mock("@/lib/db/skills", () => ({
  createSkill: (...args: unknown[]) => createSkill(...(args as Parameters<typeof createSkill>)),
  updateSkill: (...args: unknown[]) => updateSkill(...(args as Parameters<typeof updateSkill>)),
  deleteSkill: (...args: unknown[]) => deleteSkill(...(args as Parameters<typeof deleteSkill>)),
  getSkill: (...args: unknown[]) => getSkill(...(args as Parameters<typeof getSkill>)),
}))

jest.mock("@/hooks/skills", () => ({
  useSkills: () => ({
    all: [],
    filtered: [],
    countsByCategory: {},
    countsBySource: {},
    allTags: [],
  }),
  useSkillAi: () => ({ run: jest.fn(async () => null) }),
  useSkillShortcuts: () => {},
}))

const storeState: {
  activeTab: "my-skills" | "browse" | "editor" | "analytics"
  editorTarget: null | { mode: "create" | "edit"; skillId?: string }
  importStaging: null
  deleteTarget: null | { skillId: string; name: string }
  closeEditor: jest.Mock
  setImportStaging: jest.Mock
  setDeleteTarget: jest.Mock
} = {
  activeTab: "my-skills",
  editorTarget: null,
  importStaging: null,
  deleteTarget: null,
  closeEditor: jest.fn(),
  setImportStaging: jest.fn(),
  setDeleteTarget: jest.fn(),
}

jest.mock("@/stores/skills", () => ({
  useSkillsStore: (selector: (s: typeof storeState) => unknown) => selector(storeState),
}))

jest.mock("@/lib/tauri", () => ({
  isTauri: jest.fn(() => false),
}))

jest.mock("./skill-panel-header", () => ({
  SkillPanelHeader: ({
    totalCount,
    filteredCount,
  }: {
    totalCount: number
    filteredCount: number
  }) => <div data-testid="header">{`${totalCount}/${filteredCount}`}</div>,
}))
jest.mock("./skill-panel-tabs", () => ({
  SkillPanelTabs: () => <div data-testid="tabs" />,
}))
jest.mock("./skill-panel-grid", () => ({
  SkillPanelGrid: () => <div data-testid="grid" />,
}))
jest.mock("./skill-category-sidebar", () => ({
  SkillCategorySidebar: () => <div data-testid="sidebar" />,
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
  SkillImportDialog: () => <div data-testid="import-dialog" />,
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
  }: {
    onSave: (d: { name: string; content: string }) => Promise<void>
    onCancel: () => void
  }) => (
    <div>
      <button data-testid="editor-save" onClick={() => onSave({ name: "Saved", content: "body" })}>
        save
      </button>
      <button data-testid="editor-cancel" onClick={onCancel}>
        cancel
      </button>
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
  storeState.activeTab = "my-skills"
  storeState.editorTarget = null
  storeState.importStaging = null
  storeState.deleteTarget = null
  storeState.closeEditor = jest.fn()
  storeState.setImportStaging = jest.fn()
  storeState.setDeleteTarget = jest.fn()
})

describe("SkillPanel", () => {
  it("renders header, tabs, sidebar and grid for the 'my-skills' tab", () => {
    render(<SkillPanel />)
    expect(screen.getByTestId("header")).toBeInTheDocument()
    expect(screen.getByTestId("tabs")).toBeInTheDocument()
    expect(screen.getByTestId("sidebar")).toBeInTheDocument()
    expect(screen.getByTestId("grid")).toBeInTheDocument()
    expect(screen.queryByTestId("marketplace")).not.toBeInTheDocument()
  })

  it("renders the marketplace surface for the 'browse' tab", () => {
    storeState.activeTab = "browse"
    render(<SkillPanel />)
    expect(screen.getByTestId("marketplace")).toBeInTheDocument()
    expect(screen.queryByTestId("grid")).not.toBeInTheDocument()
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
})
