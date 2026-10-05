/**
 * DuplicateAgentDialog — the copy is a choice, not a click (ADR-0216): its
 * name, where it keeps its runtime state and whether it starts on, with what
 * carries over said before the copy exists.
 */

import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { DuplicateAgentDialog } from "./duplicate-agent-dialog"
import type { ExternalAgentConfig } from "@/types/agent/external-agent"

function source(overrides: Partial<ExternalAgentConfig> = {}): ExternalAgentConfig {
  return {
    id: "codex-1",
    name: "Codex",
    protocol: "codex-app-server",
    transport: "stdio",
    enabled: true,
    process: { command: "codex", args: ["app-server"] },
    defaultPermissionMode: "default",
    timeout: 1000,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  } as ExternalAgentConfig
}

function renderDialog(props: Partial<React.ComponentProps<typeof DuplicateAgentDialog>> = {}) {
  const onDuplicate = jest.fn(async () => true)
  const onOpenChange = jest.fn()
  render(
    <DuplicateAgentDialog
      open
      onOpenChange={onOpenChange}
      source={source()}
      existingNames={["Codex"]}
      onDuplicate={onDuplicate}
      {...props}
    />
  )
  return { onDuplicate: props.onDuplicate ?? onDuplicate, onOpenChange }
}

describe("DuplicateAgentDialog", () => {
  it("suggests a free name and gives an isolatable runtime its own state by default", async () => {
    const user = userEvent.setup()
    const { onDuplicate, onOpenChange } = renderDialog()
    expect(screen.getByTestId("duplicate-agent-name")).toHaveValue("Codex (copy)")
    expect(screen.getByTestId("state-isolation-isolated")).toBeChecked()
    // Starting signed out is said before the copy exists.
    expect(screen.getByTestId("duplicate-agent-sign-in-note")).toBeInTheDocument()

    await user.click(screen.getByTestId("duplicate-agent-submit"))
    expect(onDuplicate).toHaveBeenCalledWith({
      name: "Codex (copy)",
      stateIsolation: "isolated",
      enabled: true,
    })
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
  })

  it("numbers the suggestion past names already in use", () => {
    renderDialog({ existingNames: ["Codex", "Codex (copy)", "Codex (copy 2)"] })
    expect(screen.getByTestId("duplicate-agent-name")).toHaveValue("Codex (copy 3)")
  })

  it("sends the user's name, shared state and a switched-off start", async () => {
    const user = userEvent.setup()
    const { onDuplicate } = renderDialog()
    const name = screen.getByTestId("duplicate-agent-name")
    await user.clear(name)
    await user.type(name, "  Codex work  ")
    await user.click(screen.getByTestId("state-isolation-shared"))
    await user.click(screen.getByTestId("duplicate-agent-enabled"))
    // A shared copy keeps the runtime's login, so there is nothing to sign into.
    expect(screen.queryByTestId("duplicate-agent-sign-in-note")).not.toBeInTheDocument()

    await user.click(screen.getByTestId("duplicate-agent-submit"))
    expect(onDuplicate).toHaveBeenCalledWith({
      name: "Codex work",
      stateIsolation: "shared",
      enabled: false,
    })
  })

  it("starts the enabled switch where the source is", () => {
    renderDialog({ source: source({ enabled: false }) })
    expect(screen.getByTestId("duplicate-agent-enabled")).not.toBeChecked()
  })

  it("refuses an empty name without asking for the copy", async () => {
    const user = userEvent.setup()
    const { onDuplicate } = renderDialog()
    await user.clear(screen.getByTestId("duplicate-agent-name"))
    await user.click(screen.getByTestId("duplicate-agent-submit"))
    expect(onDuplicate).not.toHaveBeenCalled()
    expect(screen.getByRole("alert")).toHaveTextContent("Give the copy a name.")
    expect(screen.getByTestId("duplicate-agent-name")).toHaveAttribute("aria-invalid", "true")
  })

  it("warns, without refusing, when the name is already taken", async () => {
    const user = userEvent.setup()
    const { onDuplicate } = renderDialog({ existingNames: ["Codex", "Work"] })
    const name = screen.getByTestId("duplicate-agent-name")
    await user.clear(name)
    await user.type(name, "work")
    expect(screen.getByText(/Another agent already has this name/)).toBeInTheDocument()
    await user.click(screen.getByTestId("duplicate-agent-submit"))
    expect(onDuplicate).toHaveBeenCalledWith(expect.objectContaining({ name: "work" }))
  })

  it("submits on Enter in the name field", async () => {
    const user = userEvent.setup()
    const { onDuplicate } = renderDialog()
    await user.type(screen.getByTestId("duplicate-agent-name"), "{Enter}")
    expect(onDuplicate).toHaveBeenCalledTimes(1)
  })

  it("stays open when the copy is refused", async () => {
    const user = userEvent.setup()
    const onDuplicate = jest.fn(async () => false)
    const { onOpenChange } = renderDialog({ onDuplicate })
    await user.click(screen.getByTestId("duplicate-agent-submit"))
    await waitFor(() => expect(onDuplicate).toHaveBeenCalled())
    expect(onOpenChange).not.toHaveBeenCalledWith(false)
    expect(screen.getByTestId("duplicate-agent-submit")).toBeEnabled()
  })

  it("never offers own state to a runtime that has no separate home", () => {
    renderDialog({ source: source({ process: { command: "goose", args: ["acp"] } }) })
    expect(screen.getByTestId("state-isolation-unsupported")).toBeInTheDocument()
    expect(screen.queryByTestId("duplicate-agent-sign-in-note")).not.toBeInTheDocument()
  })

  it("lists the variables that pointed at the original's state folder", () => {
    renderDialog({
      source: source({
        process: {
          command: "codex",
          args: ["app-server"],
          env: { CODEX_HOME: "/Users/me/.codex", OTHER: "1" },
        },
      }),
    })
    const note = screen.getByTestId("duplicate-agent-dropped-env")
    expect(note).toHaveTextContent("CODEX_HOME")
    expect(note).not.toHaveTextContent("OTHER")
  })

  it("asks nothing about local state for a network agent", () => {
    renderDialog({
      source: source({
        transport: "http",
        protocol: "acp",
        process: undefined,
        network: { endpoint: "https://agents.example.com" },
      }),
    })
    expect(screen.queryByTestId("state-isolation-field")).not.toBeInTheDocument()
    expect(screen.queryByTestId("duplicate-agent-sign-in-note")).not.toBeInTheDocument()
  })
})
