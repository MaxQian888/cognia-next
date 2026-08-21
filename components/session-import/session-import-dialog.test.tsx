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
const pickerOnlySources: Array<{ id: string }> = []
jest.mock("@/lib/session-import", () => ({
  getSessionSource: (id: string) =>
    id === "acme:cursor" ? { id, displayName: "Cursor (Acme)" } : undefined,
  getPickerOnlySources: () => pickerOnlySources,
}))

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

  describe("source badge", () => {
    const summaryFor = (sourceId: string) => ({
      ref: { sourceId, originalSessionId: "a", locator: "/p/a.jsonl" },
      title: "Some session",
      sourceId,
      messageCount: 1,
      updatedAt: 1,
    })

    it("translates a built-in source", () => {
      setHook({ state: { status: "list", summaries: [summaryFor("codex")] } })
      render(<SessionImportDialog trigger={<button>open</button>} />)
      fireEvent.click(screen.getByText("open"))
      expect(screen.getByText("sources.codex")).toBeInTheDocument()
    })

    it("uses a plugin source's displayName instead of a raw translation key", () => {
      // `t("sources.acme:cursor")` has no catalog entry, so translating would
      // print the key path into the badge.
      setHook({ state: { status: "list", summaries: [summaryFor("acme:cursor")] } })
      render(<SessionImportDialog trigger={<button>open</button>} />)
      fireEvent.click(screen.getByText("open"))
      expect(screen.getByText("Cursor (Acme)")).toBeInTheDocument()
      expect(screen.queryByText("sources.acme:cursor")).not.toBeInTheDocument()
    })

    it("falls back to the id when the plugin source is already gone", () => {
      setHook({ state: { status: "list", summaries: [summaryFor("ghost:x")] } })
      render(<SessionImportDialog trigger={<button>open</button>} />)
      fireEvent.click(screen.getByText("open"))
      expect(screen.getByText("ghost:x")).toBeInTheDocument()
    })
  })

  it("maps the unrecognized error to a friendly message", () => {
    setHook({ state: { status: "error", message: "unrecognized" } })
    render(<SessionImportDialog trigger={<button>open</button>} />)
    fireEvent.click(screen.getByText("open"))
    expect(screen.getByText("unrecognized")).toBeInTheDocument()
  })

  describe("dead ends", () => {
    it("offers the picker and a hint when a scan finds nothing", () => {
      // An empty list used to render one line and a disabled Import button —
      // no hint, no way to reach a picker-only source (Aider), no way back.
      setHook({ state: { status: "list", summaries: [] } })
      render(<SessionImportDialog trigger={<button>open</button>} />)
      fireEvent.click(screen.getByText("open"))
      expect(screen.getByText("empty")).toBeInTheDocument()
      expect(screen.getByText("emptyHint")).toBeInTheDocument()
    })

    it("the empty state's picker button starts a pick", () => {
      const pickFiles = jest.fn()
      setHook({ state: { status: "list", summaries: [] }, pickFiles })
      render(<SessionImportDialog trigger={<button>open</button>} />)
      fireEvent.click(screen.getByText("open"))
      fireEvent.click(screen.getByText("pickButton"))
      expect(pickFiles).toHaveBeenCalled()
    })

    it("a list can be backed out of without closing the dialog", () => {
      const reset = jest.fn()
      setHook({ state: { status: "list", summaries: [] }, reset })
      render(<SessionImportDialog trigger={<button>open</button>} />)
      fireEvent.click(screen.getByText("open"))
      fireEvent.click(screen.getByText("back"))
      expect(reset).toHaveBeenCalled()
    })

    it("an error offers a retry instead of only Close", () => {
      const reset = jest.fn()
      setHook({ state: { status: "error", message: "unrecognized" }, reset })
      render(<SessionImportDialog trigger={<button>open</button>} />)
      fireEvent.click(screen.getByText("open"))
      fireEvent.click(screen.getByText("retry"))
      expect(reset).toHaveBeenCalled()
    })
  })

  it("narrows the pick to a given source instead of auto-detecting", () => {
    // `pickFiles(sourceId)` existed from the start and no caller could pass one,
    // because the dialog had no prop for it.
    const pickFiles = jest.fn()
    setHook({ pickFiles })
    render(<SessionImportDialog trigger={<button>open</button>} sourceId="codex" />)
    fireEvent.click(screen.getByText("open"))
    fireEvent.click(screen.getByText("pickButton"))
    expect(pickFiles).toHaveBeenCalledWith("codex")
  })

  it("auto-detects when no source is given", () => {
    const pickFiles = jest.fn()
    setHook({ pickFiles })
    render(<SessionImportDialog trigger={<button>open</button>} />)
    fireEvent.click(screen.getByText("open"))
    fireEvent.click(screen.getByText("pickButton"))
    expect(pickFiles).toHaveBeenCalledWith(undefined)
  })

  describe("picker-only sources", () => {
    afterEach(() => {
      pickerOnlySources.length = 0
    })

    it("names a source the scan can never reach", () => {
      // Aider keeps its history per repository, so "Scan installed agents" can
      // never surface it. Without this line an empty scan reads as "Aider isn't
      // installed" — the fact was only inferable from an empty `scanRoots()`.
      pickerOnlySources.push({ id: "aider" })
      setHook({})
      render(<SessionImportDialog trigger={<button>open</button>} />)
      fireEvent.click(screen.getByText("open"))
      expect(screen.getByTestId("session-import-picker-only")).toHaveTextContent("sources.aider")
    })

    it("says nothing when every source is scannable", () => {
      setHook({})
      render(<SessionImportDialog trigger={<button>open</button>} />)
      fireEvent.click(screen.getByText("open"))
      expect(screen.queryByTestId("session-import-picker-only")).toBeNull()
    })
  })
})
