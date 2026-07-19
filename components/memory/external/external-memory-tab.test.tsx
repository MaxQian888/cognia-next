/**
 * @jest-environment jsdom
 */
import { render, screen, fireEvent, within } from "@testing-library/react"
import type { ExternalMemoryFile } from "@/lib/memory/external/types"
import type { UseExternalMemory } from "@/hooks/memory/use-external-memory"

const mockHook = jest.fn<UseExternalMemory, []>()
jest.mock("@/hooks/memory/use-external-memory", () => ({
  useExternalMemory: () => mockHook(),
}))

// Stub the editor dialog — it pulls in CodeMirror which can't run in jsdom.
const mockEditor = jest.fn()
jest.mock("./external-memory-editor", () => ({
  ExternalMemoryEditor: (props: { open: boolean; file: ExternalMemoryFile | null }) => {
    mockEditor(props)
    return props.open && props.file ? <div data-testid="editor-open">{props.file.label}</div> : null
  },
}))

import { ExternalMemoryTab } from "./external-memory-tab"

const file = (over: Partial<ExternalMemoryFile> = {}): ExternalMemoryFile => ({
  id: over.absPath ?? "id1",
  agent: "claude-code",
  scope: "user",
  absPath: "/Users/x/.claude/CLAUDE.md",
  label: "~/.claude/CLAUDE.md",
  editable: true,
  exists: true,
  bytes: 1,
  ...over,
})

function hookValue(over: Partial<UseExternalMemory> = {}): UseExternalMemory {
  return {
    files: [],
    loading: false,
    error: null,
    unsupported: false,
    allowedRoots: ["/Users/x/.claude"],
    refresh: jest.fn(),
    ...over,
  }
}

beforeEach(() => jest.clearAllMocks())

describe("ExternalMemoryTab", () => {
  it("shows the desktop-only notice when unsupported", () => {
    mockHook.mockReturnValue(hookValue({ unsupported: true }))
    render(<ExternalMemoryTab />)
    expect(screen.getByTestId("external-memory-unsupported")).toBeTruthy()
  })

  it("renders an empty state when no files are found", () => {
    mockHook.mockReturnValue(hookValue({ files: [] }))
    render(<ExternalMemoryTab />)
    expect(screen.getByText("empty.title")).toBeTruthy()
  })

  it("groups files by agent and counts present files", () => {
    mockHook.mockReturnValue(
      hookValue({
        files: [
          file({ absPath: "/Users/x/.claude/CLAUDE.md", agent: "claude-code" }),
          file({
            absPath: "/Users/x/.codex/AGENTS.md",
            agent: "codex",
            scope: "global",
            label: "~/.codex/AGENTS.md",
          }),
        ],
      })
    )
    render(<ExternalMemoryTab />)
    expect(screen.getAllByTestId("external-memory-row")).toHaveLength(2)
    expect(screen.getByRole("heading", { name: "agents.claude-code" })).toBeTruthy()
    expect(screen.getByRole("heading", { name: "agents.codex" })).toBeTruthy()
    expect(within(screen.getByTestId("external-stat-total")).getByText("2")).toBeTruthy()
  })

  it("opens the editor when a row is clicked", () => {
    mockHook.mockReturnValue(hookValue({ files: [file()] }))
    render(<ExternalMemoryTab />)
    fireEvent.click(screen.getByTestId("external-memory-row"))
    expect(screen.getByTestId("editor-open").textContent).toContain("~/.claude/CLAUDE.md")
  })

  it("wires the refresh button", () => {
    const refresh = jest.fn()
    mockHook.mockReturnValue(hookValue({ files: [file()], refresh }))
    render(<ExternalMemoryTab />)
    fireEvent.click(screen.getByRole("button", { name: /refresh/i }))
    expect(refresh).toHaveBeenCalled()
  })
})
