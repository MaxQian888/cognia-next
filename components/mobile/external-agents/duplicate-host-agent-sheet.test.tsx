/** @jest-environment jsdom */

import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { toast } from "sonner"

import type { ExternalAgentConfigRecord } from "@/types/agent/external-agent-config-store"

import { DuplicateHostAgentSheet } from "./duplicate-host-agent-sheet"

jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))

beforeAll(() => {
  Element.prototype.scrollIntoView = jest.fn()
  Element.prototype.hasPointerCapture = jest.fn(() => false)
  Element.prototype.setPointerCapture = jest.fn()
  Element.prototype.releasePointerCapture = jest.fn()
})

function record(
  configId: string,
  config: Partial<ExternalAgentConfigRecord["config"]>,
  over: Partial<ExternalAgentConfigRecord> = {}
): ExternalAgentConfigRecord {
  return {
    configId,
    revision: `${configId}_r`,
    lifecycleGeneration: 1,
    seq: 1,
    enabled: true,
    lifecycleStatus: "ready",
    createdAt: 1,
    updatedAt: 1,
    config: { protocol: "acp", transport: "stdio", ...config },
    ...over,
  } as ExternalAgentConfigRecord
}

const codex = record("eac_1", {
  name: "Codex",
  process: { command: "codex-acp", env: { CODEX_HOME: "/Users/me/.codex", PLAIN: "1" } },
  metadata: { preset: "codex" },
})
const existingCopy = record("eac_2", { name: "Codex (copy)" })

beforeEach(() => jest.clearAllMocks())

describe("DuplicateHostAgentSheet", () => {
  it("stays closed without a source", () => {
    render(
      <DuplicateHostAgentSheet
        record={null}
        records={[]}
        duplicate={jest.fn()}
        onClose={jest.fn()}
        onDuplicated={jest.fn()}
      />
    )
    expect(screen.queryByTestId("duplicate-host-agent-form")).toBeNull()
  })

  it("prefills the first free copy name, own state, and the source's enabled state", () => {
    render(
      <DuplicateHostAgentSheet
        record={codex}
        records={[codex, existingCopy]}
        duplicate={jest.fn()}
        onClose={jest.fn()}
        onDuplicated={jest.fn()}
      />
    )
    expect(screen.getByText("Duplicate Codex")).toBeInTheDocument()
    expect(screen.getByTestId("duplicate-name")).toHaveValue("Codex (copy 2)")
    expect(screen.getByRole("radio", { name: /Own state/ })).toBeChecked()
    expect(screen.getByTestId("duplicate-enabled")).toBeChecked()
  })

  it("names the env keys the copy will not carry", () => {
    render(
      <DuplicateHostAgentSheet
        record={codex}
        records={[codex]}
        duplicate={jest.fn()}
        onClose={jest.fn()}
        onDuplicated={jest.fn()}
      />
    )
    expect(screen.getByTestId("duplicate-dropped-env")).toHaveTextContent("Not copied: CODEX_HOME")
  })

  it("defaults to shared state for a runtime that cannot be isolated", () => {
    const custom = record("eac_3", { name: "Mine", process: { command: "some-unknown-cli" } })
    render(
      <DuplicateHostAgentSheet
        record={custom}
        records={[custom]}
        duplicate={jest.fn()}
        onClose={jest.fn()}
        onDuplicated={jest.fn()}
      />
    )
    expect(screen.getByRole("radio", { name: /Shared state/ })).toBeChecked()
    expect(screen.getByRole("radio", { name: /Own state/ })).toBeDisabled()
    expect(screen.queryByTestId("duplicate-dropped-env")).toBeNull()
  })

  it("sends the choices to the Host and hands back the copy", async () => {
    const user = userEvent.setup()
    const created = record("eac_9", { name: "Codex RO" })
    const duplicate = jest.fn(async () => ({ ok: true as const, record: created }))
    const onDuplicated = jest.fn()
    render(
      <DuplicateHostAgentSheet
        record={codex}
        records={[codex]}
        duplicate={duplicate}
        onClose={jest.fn()}
        onDuplicated={onDuplicated}
      />
    )
    await user.clear(screen.getByTestId("duplicate-name"))
    await user.type(screen.getByTestId("duplicate-name"), "Codex RO")
    await user.click(screen.getByRole("radio", { name: /Shared state/ }))
    await user.click(screen.getByTestId("duplicate-enabled"))
    await user.click(screen.getByRole("button", { name: "Duplicate Codex" }))

    await waitFor(() =>
      expect(duplicate).toHaveBeenCalledWith(codex, {
        name: "Codex RO",
        stateIsolation: "shared",
        enabled: false,
      })
    )
    expect(onDuplicated).toHaveBeenCalledWith(created)
    expect(toast.success).toHaveBeenCalledWith("Codex RO was created on your Host.")
  })

  it("refuses an empty name without calling the Host", async () => {
    const user = userEvent.setup()
    const duplicate = jest.fn()
    render(
      <DuplicateHostAgentSheet
        record={codex}
        records={[codex]}
        duplicate={duplicate}
        onClose={jest.fn()}
        onDuplicated={jest.fn()}
      />
    )
    await user.clear(screen.getByTestId("duplicate-name"))
    await user.click(screen.getByTestId("duplicate-submit"))
    expect(screen.getByTestId("duplicate-problem")).toHaveTextContent("Enter a name for the copy.")
    expect(duplicate).not.toHaveBeenCalled()
  })

  it("shows the Host's refusal in place and stays open", async () => {
    const user = userEvent.setup()
    const duplicate = jest.fn(async () => ({ ok: false as const, error: "credential_missing" }))
    const onDuplicated = jest.fn()
    render(
      <DuplicateHostAgentSheet
        record={codex}
        records={[codex]}
        duplicate={duplicate}
        onClose={jest.fn()}
        onDuplicated={onDuplicated}
      />
    )
    await user.click(screen.getByTestId("duplicate-submit"))
    expect(await screen.findByTestId("duplicate-problem")).toHaveTextContent(
      "Could not duplicate the agent: credential_missing"
    )
    expect(toast.error).toHaveBeenCalled()
    expect(onDuplicated).not.toHaveBeenCalled()
  })

  it("closes on cancel", async () => {
    const user = userEvent.setup()
    const onClose = jest.fn()
    render(
      <DuplicateHostAgentSheet
        record={codex}
        records={[codex]}
        duplicate={jest.fn()}
        onClose={onClose}
        onDuplicated={jest.fn()}
      />
    )
    await user.click(screen.getByRole("button", { name: "Cancel" }))
    expect(onClose).toHaveBeenCalled()
  })
})
