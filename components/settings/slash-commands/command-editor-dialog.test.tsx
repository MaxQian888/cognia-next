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
  projectCommandDirOf: (originDir?: string | null) =>
    originDir?.includes("/.cognia/") ? ".cognia/commands" : ".claude/commands",
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

/**
 * Which scopes are writable is now the shell's answer, passed in. Default both
 * on so the existing behaviour tests read the same as before, and set them
 * explicitly in the tests that are about the gate itself.
 */
function Editor(props: React.ComponentProps<typeof CommandEditorDialog>) {
  return <CommandEditorDialog projectWritable globalWritable {...props} />
}

beforeEach(() => {
  mockSave.mockReset().mockResolvedValue("/Users/me/.claude/commands/refactor.md")
  mockBuildFile.mockClear()
  ;(toast.success as jest.Mock).mockClear()
  ;(toast.error as jest.Mock).mockClear()
})

describe("CommandEditorDialog — open / form prefill", () => {
  it("renders a fresh form when open with no initial", () => {
    render(<Editor open onOpenChange={() => {}} />)
    expect(screen.getByText("titleCreate")).toBeInTheDocument()
    expect(screen.getByTestId("command-editor-name")).toHaveValue("")
    expect(screen.getByTestId("command-editor-body")).toHaveValue("")
  })

  it("prefills fields when editing an existing command", () => {
    render(
      <Editor
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
    const { rerender } = render(<Editor open onOpenChange={onOpenChange} initial={null} />)
    fireEvent.change(screen.getByTestId("command-editor-name"), {
      target: { value: "draft" },
    })
    rerender(<Editor open={false} onOpenChange={onOpenChange} initial={null} />)
    rerender(
      <Editor
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
    render(<Editor open onOpenChange={() => {}} />)
    const draft = screen.getByTestId("command-editor-tool-draft")
    await user.type(draft, "Bash{Enter}")
    expect(screen.getByTestId("command-editor-tools")).toHaveTextContent("Bash")
    await user.click(screen.getByTestId("command-editor-remove-tool-Bash"))
    expect(screen.getByTestId("command-editor-tools")).not.toHaveTextContent("Bash")
  })

  it("Add button is disabled until a non-empty draft is typed", () => {
    render(<Editor open onOpenChange={() => {}} />)
    expect(screen.getByTestId("command-editor-add-tool")).toBeDisabled()
  })

  it("ignores duplicate tool entries", async () => {
    const user = userEvent.setup()
    render(<Editor open onOpenChange={() => {}} />)
    await user.type(screen.getByTestId("command-editor-tool-draft"), "Read{Enter}")
    await user.type(screen.getByTestId("command-editor-tool-draft"), "Read{Enter}")
    const matches = screen.getAllByText(/^Read$/)
    expect(matches).toHaveLength(1)
  })
})

describe("CommandEditorDialog — save flow", () => {
  it("blocks save until validation passes", () => {
    render(<Editor open onOpenChange={() => {}} />)
    expect(screen.getByTestId("command-editor-save")).toBeDisabled()
  })

  it("calls saveCustomSlashCommand with the assembled input + closes the dialog", async () => {
    const onOpenChange = jest.fn()
    const onSaved = jest.fn()
    const user = userEvent.setup()
    render(<Editor open onOpenChange={onOpenChange} cwd="/work/repo" onSaved={onSaved} />)
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
    render(<Editor open onOpenChange={onOpenChange} />)
    await user.type(screen.getByTestId("command-editor-name"), "x")
    await user.type(screen.getByTestId("command-editor-body"), "body")
    await user.click(screen.getByTestId("command-editor-save"))
    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    expect(onOpenChange).not.toHaveBeenCalledWith(false)
  })
})

describe("CommandEditorDialog — unreachable scopes", () => {
  it("is read-only only when NEITHER scope can be written", () => {
    render(
      <CommandEditorDialog
        open
        onOpenChange={() => {}}
        projectWritable={false}
        globalWritable={false}
      />
    )
    expect(screen.getByTestId("command-editor-web-banner")).toBeInTheDocument()
    expect(screen.getByTestId("command-editor-name")).toBeDisabled()
    expect(screen.getByTestId("command-editor-body")).toBeDisabled()
    expect(screen.getByTestId("command-editor-save")).toBeDisabled()
  })

  it("keeps the form usable on a companion, which can write the project scope", async () => {
    const user = userEvent.setup()
    render(
      <CommandEditorDialog
        open
        onOpenChange={() => {}}
        cwd="/ws/root"
        projectWritable
        globalWritable={false}
      />
    )
    expect(screen.queryByTestId("command-editor-web-banner")).toBeNull()
    expect(screen.getByTestId("command-editor-body")).toBeEnabled()
    // A new command there defaults to the scope that actually works.
    await user.type(screen.getByTestId("command-editor-name"), "x")
    await user.type(screen.getByTestId("command-editor-body"), "body")
    await user.click(screen.getByTestId("command-editor-save"))
    await waitFor(() => expect(mockSave).toHaveBeenCalled())
    expect(mockSave.mock.calls[0][0]).toMatchObject({ scope: "project", cwd: "/ws/root" })
  })

  it("writes an edit back to the directory it was read from", async () => {
    const user = userEvent.setup()
    render(
      <CommandEditorDialog
        open
        onOpenChange={() => {}}
        cwd="/ws/root"
        projectWritable
        globalWritable={false}
        initial={{
          name: "ship",
          scope: "project",
          description: "d",
          template: "body",
          originDir: "/ws/root/.cognia/commands",
        }}
      />
    )
    await user.click(screen.getByTestId("command-editor-save"))
    await waitFor(() => expect(mockSave).toHaveBeenCalled())
    expect(mockSave.mock.calls[0][0]).toMatchObject({ dir: ".cognia/commands" })
  })
})

describe("CommandEditorDialog — preview", () => {
  it("calls buildCommandFile with the live form state on every render", async () => {
    const user = userEvent.setup()
    render(<Editor open onOpenChange={() => {}} />)
    await user.type(screen.getByTestId("command-editor-name"), "hi")
    await user.type(screen.getByTestId("command-editor-body"), "body")
    expect(mockBuildFile).toHaveBeenCalled()
    const lastCall = mockBuildFile.mock.calls[mockBuildFile.mock.calls.length - 1][0]
    expect(lastCall).toMatchObject({ name: "hi", body: "body" })
  })
})
