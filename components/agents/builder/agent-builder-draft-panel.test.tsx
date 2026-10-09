/** @jest-environment jsdom */

// The live draft beside the builder conversation (ADR-0220). The agent form is
// stubbed to a probe that records its props, so each case proves what the
// panel feeds it and what it does with the form's edits and save.

import { act, render, screen } from "@testing-library/react"

import type {
  AgentBuilderDraft,
  AgentBuilderSessionState,
  Character,
} from "@cognia/agent-config-types"
import type { AgentCatalogs } from "@/hooks/agents/use-agent-catalogs"
import {
  characterToEditorState,
  editorStateToOutput,
  type EditorOutput,
  type EditorState,
} from "@/lib/agents/editor-state"

jest.mock("sonner", () => ({ toast: { error: jest.fn(), success: jest.fn() } }))
jest.mock("@/lib/agents/builder/builder-session", () => ({
  ...jest.requireActual("@/lib/agents/builder/builder-session"),
  writeBuilderDraft: jest.fn(),
  createAgentFromBuilder: jest.fn(),
}))

interface EditorProps {
  initial: EditorState
  value: EditorState
  onValueChange: (next: EditorState) => void
  skillsCatalog: unknown
  mcpCatalog: unknown
  knowledgeBaseCatalog: unknown
  chrome: string
  submitLabel: string
  cancelLabel: string
  onCancel: () => void
  footerStart: React.ReactNode
  onSave: (output: EditorOutput) => Promise<void>
}
let editorProps: EditorProps
jest.mock("@/components/agents/editor/character-editor", () => ({
  CharacterEditor: (props: EditorProps) => {
    editorProps = props
    return (
      <div data-testid="character-editor" data-name={props.value.name}>
        <div data-testid="footer-start">{props.footerStart}</div>
      </div>
    )
  },
}))

import { toast } from "sonner"
import {
  AgentBuilderSessionError,
  createAgentFromBuilder,
  writeBuilderDraft,
} from "@/lib/agents/builder/builder-session"
import {
  AgentBuilderDraftPanel,
  type AgentBuilderDraftPanelProps,
} from "./agent-builder-draft-panel"

type DraftUpdater = (draft: AgentBuilderDraft) => AgentBuilderDraft
const writeMock = writeBuilderDraft as unknown as jest.Mock<
  Promise<void>,
  [string, DraftUpdater, "user" | "agent", { baseRevision?: number }?]
>
const createMock = createAgentFromBuilder as jest.Mock
const toastError = toast.error as jest.Mock
const toastSuccess = toast.success as jest.Mock

const catalogs = {
  skills: [{ id: "skill" }],
  mcpServers: [{ id: "mcp" }],
  knowledgeBases: [{ id: "kb" }],
} as unknown as AgentCatalogs

function builderState(over: Partial<AgentBuilderSessionState> = {}): AgentBuilderSessionState {
  return {
    draft: { name: "Reviewer" },
    revision: 1,
    editedBy: "agent",
    status: "drafting",
    updatedAt: 10,
    ...over,
  }
}

function props(over: Partial<AgentBuilderDraftPanelProps> = {}): AgentBuilderDraftPanelProps {
  return {
    sessionId: "s1",
    state: builderState(),
    catalogs,
    onCreated: jest.fn(),
    onDiscard: jest.fn(),
    ...over,
  }
}

function edited(name: string): EditorState {
  return { ...editorProps.value, name }
}

beforeEach(() => {
  jest.useFakeTimers()
  jest.clearAllMocks()
  writeMock.mockResolvedValue(undefined)
})

afterEach(() => {
  jest.useRealTimers()
})

describe("rendering", () => {
  it("opens the form on the draft, with the catalogs and builder labels", () => {
    const p = props()
    render(<AgentBuilderDraftPanel {...p} />)
    expect(screen.getByTestId("agent-builder-draft-panel")).toBeInTheDocument()
    expect(screen.getByRole("heading", { name: "Agent configuration" })).toBeInTheDocument()
    expect(
      screen.getByText("Updated as you talk. You can edit the draft directly.")
    ).toBeInTheDocument()
    const expected = characterToEditorState({ name: "Reviewer" })
    expect(editorProps.initial).toEqual(expected)
    expect(editorProps.value).toEqual(expected)
    expect(editorProps.skillsCatalog).toBe(catalogs.skills)
    expect(editorProps.mcpCatalog).toBe(catalogs.mcpServers)
    expect(editorProps.knowledgeBaseCatalog).toBe(catalogs.knowledgeBases)
    expect(editorProps.chrome).toBe("plain")
    expect(editorProps.submitLabel).toBe("Create & open agent")
    expect(editorProps.cancelLabel).toBe("Discard")
    expect(screen.getByTestId("footer-start")).toBeEmptyDOMElement()
  })

  it("asks the host to discard from the form's cancel", () => {
    const p = props()
    render(<AgentBuilderDraftPanel {...p} />)
    editorProps.onCancel()
    expect(p.onDiscard).toHaveBeenCalledTimes(1)
  })
})

describe("builder revisions", () => {
  it("adopts a revision the builder wrote and says so", () => {
    const p = props()
    const { rerender } = render(<AgentBuilderDraftPanel {...p} />)
    const initial = editorProps.initial
    rerender(
      <AgentBuilderDraftPanel
        {...p}
        state={builderState({ draft: { name: "Researcher" }, revision: 2, editedBy: "agent" })}
      />
    )
    expect(screen.getByTestId("character-editor")).toHaveAttribute("data-name", "Researcher")
    expect(screen.getByTestId("footer-start")).toHaveTextContent(
      "Updated by the builder (revision 2)"
    )
    // The secret baseline stays the draft as the panel opened.
    expect(editorProps.initial).toBe(initial)
  })

  it("ignores the echo of its own write", () => {
    const p = props()
    const { rerender } = render(<AgentBuilderDraftPanel {...p} />)
    act(() => editorProps.onValueChange(edited("Mine")))
    rerender(
      <AgentBuilderDraftPanel
        {...p}
        state={builderState({ draft: { name: "Stale" }, revision: 2, editedBy: "user" })}
      />
    )
    expect(screen.getByTestId("character-editor")).toHaveAttribute("data-name", "Mine")
    expect(screen.getByTestId("footer-start")).toBeEmptyDOMElement()
  })

  it("does not re-adopt an unchanged revision", () => {
    const p = props()
    const { rerender } = render(<AgentBuilderDraftPanel {...p} />)
    act(() => editorProps.onValueChange(edited("Mine")))
    rerender(
      <AgentBuilderDraftPanel
        {...p}
        state={builderState({ draft: { name: "Other" }, revision: 1 })}
      />
    )
    expect(screen.getByTestId("character-editor")).toHaveAttribute("data-name", "Mine")
  })
})

describe("writing the person's edits", () => {
  it("shows an edit at once and writes it back after a pause", async () => {
    render(<AgentBuilderDraftPanel {...props()} />)
    const next = edited("Typed")
    act(() => editorProps.onValueChange(next))
    expect(screen.getByTestId("character-editor")).toHaveAttribute("data-name", "Typed")
    expect(writeMock).not.toHaveBeenCalled()
    await act(async () => {
      jest.advanceTimersByTime(400)
    })
    expect(writeMock).toHaveBeenCalledTimes(1)
    const [sessionId, update, by] = writeMock.mock.calls[0]!
    expect(sessionId).toBe("s1")
    expect(by).toBe("user")
    expect(update({})).toEqual(editorStateToOutput(next))
  })

  it("tags each edit with the revision it was made on top of", async () => {
    const p = props({ state: builderState({ revision: 3, editedBy: "user" }) })
    render(<AgentBuilderDraftPanel {...p} />)
    act(() => editorProps.onValueChange(edited("Typed")))
    await act(async () => {
      jest.advanceTimersByTime(400)
    })
    expect(writeMock.mock.calls[0]![3]).toEqual({ baseRevision: 3 })
  })

  it("lets a builder write that lands mid-debounce mark the waiting edit as stale", async () => {
    const p = props({ state: builderState({ revision: 1 }) })
    const { rerender } = render(<AgentBuilderDraftPanel {...p} />)
    act(() => editorProps.onValueChange(edited("Mine")))
    // The builder writes revision 2 before the edit is flushed: the panel
    // shows the builder's draft, and the waiting edit still names revision 1,
    // which the writer drops instead of writing over the builder.
    rerender(
      <AgentBuilderDraftPanel
        {...p}
        state={builderState({ revision: 2, draft: { name: "Builder" } })}
      />
    )
    expect(screen.getByTestId("character-editor")).toHaveAttribute("data-name", "Builder")
    await act(async () => {
      jest.advanceTimersByTime(400)
    })
    expect(writeMock.mock.calls[0]![3]).toEqual({ baseRevision: 1 })

    // An edit made after adopting it builds on revision 2 and is written.
    act(() => editorProps.onValueChange(edited("Builder+mine")))
    await act(async () => {
      jest.advanceTimersByTime(400)
    })
    expect(writeMock.mock.calls[1]![3]).toEqual({ baseRevision: 2 })
  })

  it("writes only the latest of several quick edits", async () => {
    render(<AgentBuilderDraftPanel {...props()} />)
    act(() => editorProps.onValueChange(edited("A")))
    await act(async () => {
      jest.advanceTimersByTime(300)
    })
    act(() => editorProps.onValueChange(edited("AB")))
    await act(async () => {
      jest.advanceTimersByTime(300)
    })
    expect(writeMock).not.toHaveBeenCalled()
    await act(async () => {
      jest.advanceTimersByTime(100)
    })
    expect(writeMock).toHaveBeenCalledTimes(1)
    expect(writeMock.mock.calls[0]![1]({}).name).toBe("AB")
  })

  it("flushes a pending edit when the panel closes", async () => {
    const { unmount } = render(<AgentBuilderDraftPanel {...props()} />)
    act(() => editorProps.onValueChange(edited("Leaving")))
    await act(async () => unmount())
    expect(writeMock).toHaveBeenCalledTimes(1)
    expect(writeMock.mock.calls[0]![1]({}).name).toBe("Leaving")
    jest.advanceTimersByTime(1000)
    expect(writeMock).toHaveBeenCalledTimes(1)
  })

  it("writes nothing on close when nothing is pending", async () => {
    const { unmount } = render(<AgentBuilderDraftPanel {...props()} />)
    await act(async () => unmount())
    expect(writeMock).not.toHaveBeenCalled()
  })

  it.each([["not-a-builder" as const], ["already-created" as const]])(
    "stays quiet when the draft is gone (%s)",
    async (code) => {
      writeMock.mockRejectedValue(new AgentBuilderSessionError(code, "gone"))
      render(<AgentBuilderDraftPanel {...props()} />)
      act(() => editorProps.onValueChange(edited("X")))
      await act(async () => {
        jest.advanceTimersByTime(400)
      })
      expect(writeMock).toHaveBeenCalled()
      expect(toastError).not.toHaveBeenCalled()
    }
  )

  it.each([
    [
      "an invalid draft",
      new AgentBuilderSessionError("invalid-draft", "Name is required"),
      "Name is required",
    ],
    ["any other Error", new Error("disk full"), "disk full"],
    ["a non-Error", "weird", "weird"],
  ])("toasts a write that fails with %s", async (_n, err, message) => {
    writeMock.mockRejectedValue(err)
    render(<AgentBuilderDraftPanel {...props()} />)
    act(() => editorProps.onValueChange(edited("X")))
    await act(async () => {
      jest.advanceTimersByTime(400)
    })
    expect(toastError).toHaveBeenCalledWith(message)
  })
})

describe("create", () => {
  const output = { name: "Final" } as unknown as EditorOutput
  const agent = { id: "char_new", name: "Final" } as Character

  it("writes the form's values, creates the agent and hands it to the host", async () => {
    createMock.mockResolvedValue(agent)
    const p = props()
    render(<AgentBuilderDraftPanel {...p} />)
    await act(() => editorProps.onSave(output))
    expect(writeMock).toHaveBeenCalledTimes(1)
    const [sessionId, update, by] = writeMock.mock.calls[0]!
    expect(sessionId).toBe("s1")
    expect(by).toBe("user")
    expect(update({ name: "old" })).toBe(output)
    expect(createMock).toHaveBeenCalledWith("s1")
    expect(toastSuccess).toHaveBeenCalledWith("Created Final")
    expect(p.onCreated).toHaveBeenCalledWith(agent)
  })

  it("supersedes an edit still waiting to be written", async () => {
    createMock.mockResolvedValue(agent)
    const { unmount } = render(<AgentBuilderDraftPanel {...props()} />)
    act(() => editorProps.onValueChange(edited("Pending")))
    await act(() => editorProps.onSave(output))
    await act(async () => {
      jest.advanceTimersByTime(1000)
    })
    await act(async () => unmount())
    expect(writeMock).toHaveBeenCalledTimes(1)
    expect(writeMock.mock.calls[0]![1]({})).toBe(output)
  })

  it.each([
    ["the draft write", "write"],
    ["the create", "create"],
  ])("toasts when %s fails and does not open anything", async (_n, which) => {
    if (which === "write") writeMock.mockRejectedValue(new Error("write failed"))
    else createMock.mockRejectedValue("create failed")
    const p = props()
    render(<AgentBuilderDraftPanel {...p} />)
    await act(() => editorProps.onSave(output))
    expect(toastError).toHaveBeenCalledWith(which === "write" ? "write failed" : "create failed")
    expect(toastSuccess).not.toHaveBeenCalled()
    expect(p.onCreated).not.toHaveBeenCalled()
  })
})
