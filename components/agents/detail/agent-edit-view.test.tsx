/** @jest-environment jsdom */

// An agent's edit mode (ADR-0220): the locked notice for agents that cannot be
// edited in place, the variant notice, the save path and its failure, and
// re-hydrating the form only when the stored agent actually changes.

import { act, fireEvent, render, screen } from "@testing-library/react"

import type { Character } from "@cognia/agent-config-types"
import type { AgentCatalogs } from "@/hooks/agents/use-agent-catalogs"

const mockUpdate = jest.fn()
jest.mock("@/lib/db/characters", () => ({
  updateCharacter: (...args: unknown[]) => mockUpdate(...args),
}))

const mockToast = { success: jest.fn(), error: jest.fn() }
jest.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => mockToast.success(...args),
    error: (...args: unknown[]) => mockToast.error(...args),
  },
}))

let mockSupport = false
jest.mock("@/lib/support-agent/context", () => ({
  isSupportAgentId: () => mockSupport,
}))
jest.mock("@/components/support/support-diagnostics-consent", () => ({
  SupportDiagnosticsConsent: () => <div data-testid="support-consent" />,
}))

const mockToEditorState = jest.fn((agent: Character) => ({ name: agent.name }))
jest.mock("@/lib/agents/editor-state", () => ({
  characterToEditorState: (agent: Character) => mockToEditorState(agent),
}))

interface EditorProps {
  editingId: string
  initial: { name: string }
  chrome: string
  onCancel: () => void
  onSave: (patch: { name: string }) => Promise<void>
}
let editorProps: EditorProps | undefined
jest.mock("@/components/agents/editor/character-editor", () => ({
  CharacterEditor: (props: EditorProps) => {
    editorProps = props
    return <div data-testid="editor-stub" data-initial={props.initial.name} />
  },
}))

import { AgentEditView } from "./agent-edit-view"

function agent(over: Partial<Character> = {}): Character {
  return {
    id: "char_1",
    name: "Alpha",
    avatarColor: "#123456",
    systemPrompt: "",
    createdAt: 1,
    updatedAt: 2,
    ...over,
  } as Character
}

const catalogs = { skills: [], mcpServers: [], knowledgeBases: [] } as unknown as AgentCatalogs

function renderEdit(props: Partial<React.ComponentProps<typeof AgentEditView>> = {}) {
  const handlers = { onDuplicate: jest.fn(), onDone: jest.fn() }
  const utils = render(
    <AgentEditView agent={agent()} editable catalogs={catalogs} {...handlers} {...props} />
  )
  return { ...utils, ...handlers }
}

beforeEach(() => {
  mockUpdate.mockReset()
  mockToast.success.mockReset()
  mockToast.error.mockReset()
  mockToEditorState.mockClear()
  mockSupport = false
  editorProps = undefined
})

describe("AgentEditView", () => {
  it("locks a built-in agent and offers the copy that can be edited", () => {
    const { onDuplicate } = renderEdit({ editable: false, agent: agent({ isBuiltIn: true }) })
    const locked = screen.getByTestId("agent-edit-locked")
    expect(locked).toHaveTextContent("This agent can't be edited")
    expect(screen.queryByTestId("editor-stub")).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: /Duplicate to edit/ }))
    expect(onDuplicate).toHaveBeenCalledTimes(1)
  })

  it("draws the plain form for an editable agent and cancels back", () => {
    const { onDone } = renderEdit()
    expect(editorProps).toMatchObject({ editingId: "char_1", chrome: "plain" })
    expect(screen.queryByTestId("variant-editor-notice")).not.toBeInTheDocument()
    editorProps?.onCancel()
    expect(onDone).toHaveBeenCalledTimes(1)
  })

  it("says which base a variant follows, by name or by id", () => {
    const variant = agent({ variant: { baseId: "base_1", ownFields: ["model"] } })
    const { rerender, onDone, onDuplicate } = renderEdit({ agent: variant, baseName: "Base Agent" })
    expect(screen.getByTestId("variant-editor-notice")).toHaveTextContent("Base Agent")
    rerender(
      <AgentEditView
        agent={variant}
        editable
        catalogs={catalogs}
        onDone={onDone}
        onDuplicate={onDuplicate}
      />
    )
    expect(screen.getByTestId("variant-editor-notice")).toHaveTextContent("base_1")
  })

  it("saves, toasts and leaves edit mode", async () => {
    mockUpdate.mockResolvedValue(undefined)
    const { onDone } = renderEdit()
    await act(() => editorProps!.onSave({ name: "Renamed" }))
    expect(mockUpdate).toHaveBeenCalledWith("char_1", { name: "Renamed" })
    expect(mockToast.success).toHaveBeenCalledWith(expect.stringContaining("Renamed"))
    expect(onDone).toHaveBeenCalledTimes(1)
  })

  it("keeps the form open and reports a failed save", async () => {
    mockUpdate.mockRejectedValue(new Error("disk full"))
    const { onDone } = renderEdit()
    await act(() => editorProps!.onSave({ name: "" }))
    expect(mockToast.error).toHaveBeenCalledWith("disk full")
    expect(onDone).not.toHaveBeenCalled()
  })

  it("re-hydrates only when the stored agent changes, not on every new object", () => {
    const { rerender, onDone, onDuplicate } = renderEdit()
    const base = { catalogs, editable: true, onDone, onDuplicate }
    expect(mockToEditorState).toHaveBeenCalledTimes(1)
    rerender(<AgentEditView agent={agent({ name: "Same row" })} {...base} />)
    expect(screen.getByTestId("editor-stub")).toHaveAttribute("data-initial", "Alpha")
    rerender(<AgentEditView agent={agent({ name: "Saved elsewhere", updatedAt: 3 })} {...base} />)
    expect(screen.getByTestId("editor-stub")).toHaveAttribute("data-initial", "Saved elsewhere")
  })

  it("asks the support agent's diagnostics consent above its form", () => {
    mockSupport = true
    renderEdit()
    expect(screen.getByTestId("support-consent")).toBeInTheDocument()
  })
})
