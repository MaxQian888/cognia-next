/**
 * @jest-environment jsdom
 */
import { render, screen, fireEvent } from "@testing-library/react"
import type { ExternalMemoryFile } from "@/lib/memory/external/types"
import { ExternalMemoryRow } from "./external-memory-row"

const file = (over: Partial<ExternalMemoryFile> = {}): ExternalMemoryFile => ({
  id: "id1",
  agent: "claude-code",
  scope: "user",
  absPath: "/Users/x/.claude/CLAUDE.md",
  label: "~/.claude/CLAUDE.md",
  editable: true,
  exists: true,
  bytes: 42,
  ...over,
})

describe("ExternalMemoryRow", () => {
  it("renders label, scope badge and path", () => {
    render(<ExternalMemoryRow file={file()} onOpen={jest.fn()} />)
    expect(screen.getByText("~/.claude/CLAUDE.md")).toBeTruthy()
    expect(screen.getByText("User")).toBeTruthy()
    expect(screen.getByText("/Users/x/.claude/CLAUDE.md")).toBeTruthy()
  })

  it("shows a read-only badge for non-editable files", () => {
    render(<ExternalMemoryRow file={file({ editable: false })} onOpen={jest.fn()} />)
    expect(screen.getByText(/read-only/i)).toBeTruthy()
  })

  it("omits the read-only badge for editable files", () => {
    render(<ExternalMemoryRow file={file()} onOpen={jest.fn()} />)
    expect(screen.queryByText(/read-only/i)).toBeNull()
  })

  it("shows a not-created hint for absent files", () => {
    render(<ExternalMemoryRow file={file({ exists: false })} onOpen={jest.fn()} />)
    expect(screen.getByText(/not created/i)).toBeTruthy()
  })

  it("renders a zero size when bytes are unknown", () => {
    render(<ExternalMemoryRow file={file({ bytes: undefined })} onOpen={jest.fn()} />)
    expect(screen.getByText("0")).toBeTruthy()
  })

  it("calls onOpen with the file when clicked", () => {
    const onOpen = jest.fn()
    const f = file()
    render(<ExternalMemoryRow file={f} onOpen={onOpen} />)
    fireEvent.click(screen.getByTestId("external-memory-row"))
    expect(onOpen).toHaveBeenCalledWith(f)
  })
})
