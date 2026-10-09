/** @jest-environment jsdom */

// "Start blank" (ADR-0220): the agent form, empty, in create mode. The form
// is stubbed to a probe; the cases prove what it is fed and what saving does.

import { act, render, screen } from "@testing-library/react"

import type { Character } from "@cognia/agent-config-types"
import type { AgentCatalogs } from "@/hooks/agents/use-agent-catalogs"
import { emptyEditorState, type EditorOutput, type EditorState } from "@/lib/agents/editor-state"

jest.mock("sonner", () => ({ toast: { error: jest.fn(), success: jest.fn() } }))
jest.mock("@/lib/db/characters", () => ({ createCharacter: jest.fn() }))
jest.mock("@cognia/logging", () => {
  const logger = { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() }
  return { createLogger: jest.fn(() => logger) }
})

interface EditorProps {
  initial: EditorState
  skillsCatalog: unknown
  mcpCatalog: unknown
  knowledgeBaseCatalog: unknown
  submitLabel: string
  chrome: string
  onCancel: () => void
  onSave: (data: EditorOutput) => Promise<void>
}
let editorProps: EditorProps
jest.mock("@/components/agents/editor/character-editor", () => ({
  CharacterEditor: (props: EditorProps) => {
    editorProps = props
    return <div data-testid="character-editor" />
  },
}))

import { toast } from "sonner"
import { createLogger } from "@cognia/logging"
import { createCharacter } from "@/lib/db/characters"
import { AgentBlankCreate, type AgentBlankCreateProps } from "./agent-blank-create"

const createMock = createCharacter as jest.Mock
const toastError = toast.error as jest.Mock
const toastSuccess = toast.success as jest.Mock
// Captured before `clearAllMocks` wipes the module-load call.
const loggerScope = (createLogger as jest.Mock).mock.calls[0]?.[0] as string | undefined
const log = (createLogger as jest.Mock).mock.results[0]!.value as {
  info: jest.Mock
  error: jest.Mock
}

const catalogs = {
  skills: [{ id: "skill" }],
  mcpServers: [{ id: "mcp" }],
  knowledgeBases: [{ id: "kb" }],
} as unknown as AgentCatalogs

const data = { name: "Scout", systemPrompt: "Find things" } as unknown as EditorOutput
const created = { id: "char_scout", name: "Scout" } as Character

function props(over: Partial<AgentBlankCreateProps> = {}): AgentBlankCreateProps {
  return { catalogs, onCreated: jest.fn(), onCancel: jest.fn(), ...over }
}

beforeEach(() => {
  jest.clearAllMocks()
})

describe("AgentBlankCreate", () => {
  it("logs under the agents.create scope", () => {
    expect(loggerScope).toBe("agents.create")
  })

  it("opens an empty form in create mode with the catalogs", () => {
    render(<AgentBlankCreate {...props()} />)
    expect(screen.getByTestId("agent-blank-create")).toContainElement(
      screen.getByTestId("character-editor")
    )
    expect(editorProps.initial).toEqual(emptyEditorState())
    expect(editorProps.skillsCatalog).toBe(catalogs.skills)
    expect(editorProps.mcpCatalog).toBe(catalogs.mcpServers)
    expect(editorProps.knowledgeBaseCatalog).toBe(catalogs.knowledgeBases)
    expect(editorProps.submitLabel).toBe("Create")
    expect(editorProps.chrome).toBe("plain")
  })

  it("keeps the same initial state across renders", () => {
    const p = props()
    const { rerender } = render(<AgentBlankCreate {...p} />)
    const first = editorProps.initial
    rerender(<AgentBlankCreate {...p} />)
    expect(editorProps.initial).toBe(first)
  })

  it("cancels through the host", () => {
    const p = props()
    render(<AgentBlankCreate {...p} />)
    editorProps.onCancel()
    expect(p.onCancel).toHaveBeenCalledTimes(1)
  })

  it("creates the agent, confirms it and hands it to the host", async () => {
    createMock.mockResolvedValue(created)
    const p = props()
    render(<AgentBlankCreate {...p} />)
    await act(() => editorProps.onSave(data))
    expect(createMock).toHaveBeenCalledWith(data)
    expect(log.info).toHaveBeenCalledWith("character_created", { name: "Scout" })
    expect(toastSuccess).toHaveBeenCalledWith('Added "Scout".')
    expect(p.onCreated).toHaveBeenCalledWith(created)
    expect(toastError).not.toHaveBeenCalled()
  })

  it.each([
    ["an Error", new Error("Name taken"), "Name taken"],
    ["a non-Error", "quota", "quota"],
  ])("toasts a create that fails with %s and opens nothing", async (_n, err, message) => {
    createMock.mockRejectedValue(err)
    const p = props()
    render(<AgentBlankCreate {...p} />)
    await act(() => editorProps.onSave(data))
    expect(log.error).toHaveBeenCalledWith("character_create_failed", err)
    expect(toastError).toHaveBeenCalledWith(message)
    expect(toastSuccess).not.toHaveBeenCalled()
    expect(p.onCreated).not.toHaveBeenCalled()
  })
})
