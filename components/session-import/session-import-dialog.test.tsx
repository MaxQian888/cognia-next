import { render, screen, fireEvent } from "@testing-library/react"
import { SessionImportDialog } from "./session-import-dialog"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vals?: Record<string, unknown>) =>
    vals ? `${key}:${JSON.stringify(vals)}` : key,
}))
jest.mock("@/lib/tauri", () => ({ isTauri: () => true }))
jest.mock("@/stores/project/project-store", () => ({
  useProjectStore: (sel: (s: unknown) => unknown) => sel({ activeProjectId: "proj-1" }),
}))
jest.mock("sonner", () => ({ toast: { success: jest.fn() } }))

const hookState: { current: Record<string, unknown> } = { current: {} }
jest.mock("@/hooks/session-import/use-session-import", () => ({
  summaryKey: (ref: { sourceId: string; locator: string }) => `${ref.sourceId}::${ref.locator}`,
  useSessionImport: () => hookState.current,
}))

function setHook(over: Record<string, unknown>) {
  hookState.current = {
    state: { status: "idle" },
    selected: new Set(),
    selectedCount: 0,
    scan: jest.fn(),
    pickFiles: jest.fn(),
    toggle: jest.fn(),
    setAll: jest.fn(),
    importSelected: jest.fn(async () => {}),
    cancelImport: jest.fn(),
    reset: jest.fn(),
    ...over,
  }
}

describe("SessionImportDialog", () => {
  it("shows scan + pick actions on idle when opened", () => {
    setHook({})
    render(<SessionImportDialog trigger={<button>open</button>} />)
    fireEvent.click(screen.getByText("open"))
    expect(screen.getByText("scanButton")).toBeInTheDocument()
    expect(screen.getByText("pickButton")).toBeInTheDocument()
  })

  it("triggers a scan on click", () => {
    const scan = jest.fn()
    setHook({ scan })
    render(<SessionImportDialog trigger={<button>open</button>} />)
    fireEvent.click(screen.getByText("open"))
    fireEvent.click(screen.getByText("scanButton"))
    expect(scan).toHaveBeenCalled()
  })

  it("renders the session list and imports the selection", () => {
    const importSelected = jest.fn(async () => {})
    const summaries = [
      {
        ref: { sourceId: "codex", originalSessionId: "a", locator: "/p/a.jsonl" },
        title: "Fix bug",
        sourceId: "codex",
        messageCount: 3,
        updatedAt: 1,
        cwd: "/repo",
      },
    ]
    setHook({
      state: { status: "list", summaries },
      selected: new Set(["codex::/p/a.jsonl"]),
      selectedCount: 1,
      importSelected,
    })
    render(<SessionImportDialog trigger={<button>open</button>} />)
    fireEvent.click(screen.getByText("open"))
    expect(screen.getByText("Fix bug")).toBeInTheDocument()
    fireEvent.click(screen.getByText(/importSelected/))
    expect(importSelected).toHaveBeenCalledWith("proj-1")
  })

  it("shows import progress with a cancel button, and cancels", () => {
    const cancelImport = jest.fn()
    setHook({
      state: { status: "importing", phase: "parsing", done: 1, total: 3 },
      cancelImport,
    })
    render(<SessionImportDialog trigger={<button>open</button>} />)
    fireEvent.click(screen.getByText("open"))
    expect(screen.getByText(/parsingProgress/)).toBeInTheDocument()
    fireEvent.click(screen.getByText("cancel"))
    expect(cancelImport).toHaveBeenCalled()
  })

  it("shows the done summary", () => {
    setHook({ state: { status: "done", sessionsAdded: 2, messagesAdded: 6 } })
    render(<SessionImportDialog trigger={<button>open</button>} />)
    fireEvent.click(screen.getByText("open"))
    expect(screen.getByText("doneTitle")).toBeInTheDocument()
  })

  it("labels a cancelled import distinctly from a completed one", () => {
    setHook({ state: { status: "done", sessionsAdded: 1, messagesAdded: 2, cancelled: true } })
    render(<SessionImportDialog trigger={<button>open</button>} />)
    fireEvent.click(screen.getByText("open"))
    expect(screen.getByText("cancelledTitle")).toBeInTheDocument()
    expect(screen.queryByText("doneTitle")).not.toBeInTheDocument()
  })

  it("pages a long session list behind a show-more control", () => {
    const summaries = Array.from({ length: 60 }, (_, i) => ({
      ref: { sourceId: "codex", originalSessionId: `s${i}`, locator: `/p/s${i}.jsonl` },
      title: `Session ${i}`,
      sourceId: "codex",
      messageCount: 1,
      updatedAt: i,
    }))
    setHook({ state: { status: "list", summaries }, selected: new Set(), selectedCount: 0 })
    render(<SessionImportDialog trigger={<button>open</button>} />)
    fireEvent.click(screen.getByText("open"))
    // First page renders the initial window only.
    expect(screen.getByText("Session 0")).toBeInTheDocument()
    expect(screen.queryByText("Session 55")).not.toBeInTheDocument()
    fireEvent.click(screen.getByText(/loadMore/))
    expect(screen.getByText("Session 55")).toBeInTheDocument()
  })

  it("maps the unrecognized error to a friendly message", () => {
    setHook({ state: { status: "error", message: "unrecognized" } })
    render(<SessionImportDialog trigger={<button>open</button>} />)
    fireEvent.click(screen.getByText("open"))
    expect(screen.getByText("unrecognized")).toBeInTheDocument()
  })
})
