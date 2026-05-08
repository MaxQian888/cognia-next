// Coverage for the custom slash-command editor dialog (Stage 3 / Phase 7c).

import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

const mockSave = jest.fn()
const mockBuildFile = jest.fn(
  (input: { name: string; body: string; description?: string | null }) =>
    `---\nname: ${input.name}\n${input.description ? `description: ${input.description}\n` : ""}---\n\n${input.body}\n`
)

jest.mock("@/lib/slash-commands/custom", () => ({
  saveCustomSlashCommand: (...args: unknown[]) => mockSave(...args),
  buildCommandFile: (input: unknown) => mockBuildFile(input as never),
  assertValidCommandName: (name: string) => {
    if (!name || name.includes("..") || /\s/.test(name)) throw new Error("invalid name")
  },
}))

const isTauriMock = jest.fn(() => true)
jest.mock("@/lib/tauri", () => ({
  isTauri: () => isTauriMock(),
}))

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key} ${JSON.stringify(vars)}` : key,
}))

jest.mock("sonner", () => ({
  toast: {
    success: jest.fn(),
    error: jest.fn(),
  },
}))

import { CommandEditorDialog } from "./command-editor-dialog"
import { toast } from "sonner"

beforeEach(() => {
  mockSave.mockReset().mockResolvedValue("/Users/me/.claude/commands/refactor.md")
  mockBuildFile.mockClear()
  isTauriMock.mockReturnValue(true)
  ;(toast.success as jest.Mock).mockClear()
  ;(toast.error as jest.Mock).mockClear()
})

describe("CommandEditorDialog — open / form prefill", () => {
  it("renders a fresh form when open with no initial", () => {
    render(<CommandEditorDialog open onOpenChange={() => {}} />)
    expect(screen.getByText("titleCreate")).toBeInTheDocument()
    expect(screen.getByTestId("command-editor-name")).toHaveValue("")
    expect(screen.getByTestId("command-editor-body")).toHaveValue("")
  })

  it("prefills fields when editing an existing command", () => {
    render(
      <CommandEditorDialog
        open
        onOpenChange={() => {}}
        initial={{
          name: "refactor",
          scope: "user",
          description: "Refactor things",
          argumentHint: "<file>",
          allowedTools: ["Read", "Edit"],
          template: "Refactor $1",
        }}
      />
    )
    expect(screen.getByText("titleEdit")).toBeInTheDocument()
    expect(screen.getByTestId("command-editor-name")).toHaveValue("refactor")
    expect(screen.getByTestId("command-editor-name")).toBeDisabled()
    expect(screen.getByTestId("command-editor-description")).toHaveValue("Refactor things")
    expect(screen.getByTestId("command-editor-arg-hint")).toHaveValue("<file>")
    expect(screen.getByTestId("command-editor-body")).toHaveValue("Refactor $1")
    expect(screen.getByTestId("command-editor-tools")).toHaveTextContent("Read")
    expect(screen.getByTestId("command-editor-tools")).toHaveTextContent("Edit")
  })

  it("re-syncs from `initial` each time the dialog reopens", () => {
    const onOpenChange = jest.fn()
    const { rerender } = render(
      <CommandEditorDialog open onOpenChange={onOpenChange} initial={null} />
    )
    fireEvent.change(screen.getByTestId("command-editor-name"), {
      target: { value: "draft" },
    })
    rerender(<CommandEditorDialog open={false} onOpenChange={onOpenChange} initial={null} />)
    rerender(
      <CommandEditorDialog
        open
        onOpenChange={onOpenChange}
        initial={{
          name: "fresh",
          scope: "user",
          description: "fresh",
          template: "body",
        }}
      />
    )
    expect(screen.getByTestId("command-editor-name")).toHaveValue("fresh")
  })
})

describe("CommandEditorDialog — allowed-tools chip group", () => {
  it("adds a tool with Enter and removes via the X button", async () => {
    const user = userEvent.setup()
    render(<CommandEditorDialog open onOpenChange={() => {}} />)
    const draft = screen.getByTestId("command-editor-tool-draft")
    await user.type(draft, "Bash{Enter}")
    expect(screen.getByTestId("command-editor-tools")).toHaveTextContent("Bash")
    await user.click(screen.getByTestId("command-editor-remove-tool-Bash"))
    expect(screen.getByTestId("command-editor-tools")).not.toHaveTextContent("Bash")
  })

  it("Add button is disabled until a non-empty draft is typed", () => {
    render(<CommandEditorDialog open onOpenChange={() => {}} />)
    expect(screen.getByTestId("command-editor-add-tool")).toBeDisabled()
  })

  it("ignores duplicate tool entries", async () => {
    const user = userEvent.setup()
    render(<CommandEditorDialog open onOpenChange={() => {}} />)
    await user.type(screen.getByTestId("command-editor-tool-draft"), "Read{Enter}")
    await user.type(screen.getByTestId("command-editor-tool-draft"), "Read{Enter}")
    const matches = screen.getAllByText(/^Read$/)
    expect(matches).toHaveLength(1)
  })
})

describe("CommandEditorDialog — save flow", () => {
  it("blocks save until validation passes", () => {
    render(<CommandEditorDialog open onOpenChange={() => {}} />)
    expect(screen.getByTestId("command-editor-save")).toBeDisabled()
  })

  it("calls saveCustomSlashCommand with the assembled input + closes the dialog", async () => {
    const onOpenChange = jest.fn()
    const onSaved = jest.fn()
    const user = userEvent.setup()
    render(
      <CommandEditorDialog open onOpenChange={onOpenChange} cwd="/work/repo" onSaved={onSaved} />
    )
    await user.type(screen.getByTestId("command-editor-name"), "refactor")
    await user.type(screen.getByTestId("command-editor-body"), "Body $1")
    await user.click(screen.getByTestId("command-editor-save"))
    await waitFor(() => expect(mockSave).toHaveBeenCalled())
    const call = mockSave.mock.calls[0][0] as Record<string, unknown>
    expect(call.name).toBe("refactor")
    expect(call.scope).toBe("user")
    expect(call.body).toBe("Body $1")
    expect(onSaved).toHaveBeenCalledWith("/Users/me/.claude/commands/refactor.md")
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("surfaces save errors via toast and keeps the dialog open", async () => {
    mockSave.mockRejectedValueOnce(new Error("disk full"))
    const onOpenChange = jest.fn()
    const user = userEvent.setup()
    render(<CommandEditorDialog open onOpenChange={onOpenChange} />)
    await user.type(screen.getByTestId("command-editor-name"), "x")
    await user.type(screen.getByTestId("command-editor-body"), "body")
    await user.click(screen.getByTestId("command-editor-save"))
    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    expect(onOpenChange).not.toHaveBeenCalledWith(false)
  })
})

describe("CommandEditorDialog — web mode", () => {
  it("shows the read-only banner and disables the form", () => {
    isTauriMock.mockReturnValue(false)
    render(<CommandEditorDialog open onOpenChange={() => {}} />)
    expect(screen.getByTestId("command-editor-web-banner")).toBeInTheDocument()
    expect(screen.getByTestId("command-editor-name")).toBeDisabled()
    expect(screen.getByTestId("command-editor-body")).toBeDisabled()
    expect(screen.getByTestId("command-editor-save")).toBeDisabled()
  })
})

describe("CommandEditorDialog — preview", () => {
  it("calls buildCommandFile with the live form state on every render", async () => {
    const user = userEvent.setup()
    render(<CommandEditorDialog open onOpenChange={() => {}} />)
    await user.type(screen.getByTestId("command-editor-name"), "hi")
    await user.type(screen.getByTestId("command-editor-body"), "body")
    expect(mockBuildFile).toHaveBeenCalled()
    const lastCall = mockBuildFile.mock.calls[mockBuildFile.mock.calls.length - 1][0]
    expect(lastCall).toMatchObject({ name: "hi", body: "body" })
  })
})
