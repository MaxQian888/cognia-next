/**
 * AgentEditorDialog — extracted from the settings shell; the deep editor.
 * Verifies the dialog opens in create vs edit mode, runs preset seeding,
 * and produces a CreateExternalAgentInput on save.
 */

import { render, screen, act } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { AgentEditorDialog } from "./agent-editor-dialog"
import type { ExternalAgentConfig } from "@/types/agent/external-agent"

const existingAgent: ExternalAgentConfig = {
  id: "agent-1",
  name: "My Codex",
  description: "Codex via stdio",
  protocol: "acp",
  transport: "stdio",
  enabled: true,
  process: { command: "npx", args: ["@anthropics/claude-code", "--stdio"] },
  defaultPermissionMode: "default",
  tags: ["coding"],
  timeout: 300000,
  metadata: { preset: "codex" },
  createdAt: new Date(0),
  updatedAt: new Date(0),
}

jest.mock("@/stores/agent/external-agent-store", () => ({
  useExternalAgentStore: (sel?: (s: Record<string, unknown>) => unknown) => {
    const s = { getAgent: (id: string) => (id === "agent-1" ? existingAgent : undefined) }
    return sel ? sel(s) : s
  },
}))

jest.mock("@/components/agent/external-agent/cognia-model-picker", () => ({
  CogniaModelPicker: () => <div data-testid="cognia-model-picker" />,
}))

jest.mock("@/lib/files/file-bridge", () => ({
  pickDirectory: () => Promise.resolve(null),
}))

describe("AgentEditorDialog", () => {
  it("opens in create mode with the preset picker and blank name", () => {
    render(<AgentEditorDialog open onOpenChange={jest.fn()} onSave={jest.fn()} />)
    expect(screen.getByTestId("preset-picker")).toBeInTheDocument()
    expect(screen.getByLabelText(/agent name/i)).toHaveValue("")
  })

  it("opens in edit mode seeded from the stored agent, without the preset picker", () => {
    render(
      <AgentEditorDialog
        open
        onOpenChange={jest.fn()}
        editingAgentId="agent-1"
        onSave={jest.fn()}
      />
    )
    expect(screen.queryByTestId("preset-picker")).not.toBeInTheDocument()
    expect(screen.getByDisplayValue("My Codex")).toBeInTheDocument()
    expect(screen.getByDisplayValue("npx")).toBeInTheDocument()
  })

  it("validates the name and produces a create input on save", async () => {
    const user = userEvent.setup()
    const onSave = jest.fn()
    render(<AgentEditorDialog open onOpenChange={jest.fn()} onSave={onSave} />)

    await act(async () => {
      await user.click(screen.getByRole("button", { name: /^add$/i }))
    })
    expect(onSave).not.toHaveBeenCalled()

    await user.type(screen.getByLabelText(/agent name/i), "Local Claude")
    await user.type(screen.getByLabelText(/^command$/i), "claude")
    await act(async () => {
      await user.click(screen.getByRole("button", { name: /^add$/i }))
    })
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Local Claude",
        protocol: "acp",
        process: expect.objectContaining({ command: "claude" }),
      })
    )
  })

  it("seeds fields from a preset id", () => {
    render(
      <AgentEditorDialog open onOpenChange={jest.fn()} initialPreset="devin" onSave={jest.fn()} />
    )
    expect(screen.getByDisplayValue("Devin CLI")).toBeInTheDocument()
  })
})
