/**
 * @jest-environment jsdom
 */
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import type { ExternalMemoryFile } from "@/lib/memory/external/types"

const mockLoad = jest.fn()
const mockSave = jest.fn()
jest.mock("@/lib/memory/external/edit", () => ({
  loadExternalFile: (...a: unknown[]) => mockLoad(...a),
  saveExternalFile: (...a: unknown[]) => mockSave(...a),
}))

const mockToastSuccess = jest.fn()
const mockToastError = jest.fn()
jest.mock("sonner", () => ({
  toast: {
    success: (...a: unknown[]) => mockToastSuccess(...a),
    error: (...a: unknown[]) => mockToastError(...a),
  },
}))

// CodeMirror doesn't run in jsdom — swap for a plain textarea that honors the
// same value / onChange / readOnly contract.
jest.mock("@/components/editor/light-code-editor", () => ({
  LightCodeEditor: ({
    value,
    onChange,
    readOnly,
    "data-testid": testid,
  }: {
    value: string
    onChange: (v: string) => void
    readOnly?: boolean
    "data-testid"?: string
  }) => (
    <textarea
      data-testid={testid}
      value={value}
      readOnly={readOnly}
      onChange={(e) => onChange(e.target.value)}
    />
  ),
}))

import { ExternalMemoryEditor } from "./external-memory-editor"

const file = (over: Partial<ExternalMemoryFile> = {}): ExternalMemoryFile => ({
  id: "id1",
  agent: "claude-code",
  scope: "user",
  absPath: "/Users/x/.claude/CLAUDE.md",
  label: "~/.claude/CLAUDE.md",
  editable: true,
  exists: true,
  ...over,
})

beforeEach(() => {
  jest.clearAllMocks()
  mockLoad.mockResolvedValue("original")
  mockSave.mockResolvedValue({ backupPath: "/Users/x/.claude/CLAUDE.md.bak" })
})

const ROOTS = ["/Users/x/.claude"]

describe("ExternalMemoryEditor", () => {
  it("loads and shows file content", async () => {
    render(
      <ExternalMemoryEditor file={file()} open onOpenChange={jest.fn()} allowedRoots={ROOTS} />
    )
    await waitFor(() =>
      expect((screen.getByTestId("external-memory-editor") as HTMLTextAreaElement).value).toBe(
        "original"
      )
    )
  })

  it("hides the edit affordance for read-only files", async () => {
    render(
      <ExternalMemoryEditor
        file={file({ editable: false })}
        open
        onOpenChange={jest.fn()}
        allowedRoots={ROOTS}
      />
    )
    await waitFor(() => expect(screen.getByTestId("external-memory-editor")).toBeTruthy())
    expect(screen.queryByTestId("external-edit")).toBeNull()
  })

  it("edits, confirms backup, and saves", async () => {
    const onSaved = jest.fn()
    render(
      <ExternalMemoryEditor
        file={file()}
        open
        onOpenChange={jest.fn()}
        allowedRoots={ROOTS}
        onSaved={onSaved}
      />
    )
    await waitFor(() => expect(screen.getByTestId("external-edit")).toBeTruthy())
    fireEvent.click(screen.getByTestId("external-edit"))
    const editor = screen.getByTestId("external-memory-editor") as HTMLTextAreaElement
    expect(editor.readOnly).toBe(false)
    fireEvent.change(editor, { target: { value: "edited body" } })
    fireEvent.click(screen.getByTestId("external-save"))
    // Confirmation dialog → confirm the write.
    fireEvent.click(await screen.findByRole("button", { name: /back up & save/i }))
    await waitFor(() => expect(mockSave).toHaveBeenCalledTimes(1))
    expect(mockSave).toHaveBeenCalledWith("/Users/x/.claude/CLAUDE.md", "edited body", {
      allowedRoots: ROOTS,
    })
    expect(mockToastSuccess).toHaveBeenCalled()
    expect(onSaved).toHaveBeenCalled()
  })

  it("surfaces a toast on save failure", async () => {
    mockSave.mockRejectedValue(new Error("denied"))
    render(
      <ExternalMemoryEditor file={file()} open onOpenChange={jest.fn()} allowedRoots={ROOTS} />
    )
    await waitFor(() => expect(screen.getByTestId("external-edit")).toBeTruthy())
    fireEvent.click(screen.getByTestId("external-edit"))
    fireEvent.change(screen.getByTestId("external-memory-editor"), {
      target: { value: "x" },
    })
    fireEvent.click(screen.getByTestId("external-save"))
    fireEvent.click(await screen.findByRole("button", { name: /back up & save/i }))
    await waitFor(() => expect(mockToastError).toHaveBeenCalled())
  })

  it("shows an error when the file cannot be read", async () => {
    mockLoad.mockRejectedValue(new Error("nope"))
    render(
      <ExternalMemoryEditor file={file()} open onOpenChange={jest.fn()} allowedRoots={ROOTS} />
    )
    await waitFor(() => expect(screen.getByText(/could not read/i)).toBeTruthy())
  })

  it("starts from an empty buffer for a not-yet-created file and saves without a backup", async () => {
    mockSave.mockResolvedValue({ backupPath: null })
    render(
      <ExternalMemoryEditor
        file={file({ exists: false })}
        open
        onOpenChange={jest.fn()}
        allowedRoots={ROOTS}
      />
    )
    await waitFor(() => expect(screen.getByTestId("external-edit")).toBeTruthy())
    expect(mockLoad).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId("external-edit"))
    fireEvent.change(screen.getByTestId("external-memory-editor"), { target: { value: "new" } })
    fireEvent.click(screen.getByTestId("external-save"))
    fireEvent.click(await screen.findByRole("button", { name: /back up & save/i }))
    await waitFor(() => expect(mockSave).toHaveBeenCalled())
    expect(mockToastSuccess).toHaveBeenCalled()
  })

  it("reverts the draft when editing is cancelled", async () => {
    render(
      <ExternalMemoryEditor file={file()} open onOpenChange={jest.fn()} allowedRoots={ROOTS} />
    )
    await waitFor(() => expect(screen.getByTestId("external-edit")).toBeTruthy())
    fireEvent.click(screen.getByTestId("external-edit"))
    const editor = screen.getByTestId("external-memory-editor") as HTMLTextAreaElement
    fireEvent.change(editor, { target: { value: "changed" } })
    fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }))
    // Back to read-only with the original content restored.
    expect((screen.getByTestId("external-memory-editor") as HTMLTextAreaElement).value).toBe(
      "original"
    )
    expect(screen.getByTestId("external-edit")).toBeTruthy()
  })

  it("renders nothing without a file", () => {
    const { container } = render(
      <ExternalMemoryEditor file={null} open onOpenChange={jest.fn()} allowedRoots={ROOTS} />
    )
    expect(container.querySelector("[data-testid='external-memory-editor']")).toBeNull()
  })
})
