/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import type { ExternalAgentConfigRecord } from "@/types/agent/external-agent-config-store"

import { RemoveHostAgentDialog } from "./remove-host-agent-dialog"

const row = {
  configId: "eac_1",
  revision: "eacr_1",
  lifecycleGeneration: 1,
  seq: 1,
  enabled: true,
  lifecycleStatus: "ready",
  createdAt: 1,
  updatedAt: 1,
  config: { name: "Codex RO", protocol: "acp", transport: "stdio" },
} as ExternalAgentConfigRecord

describe("RemoveHostAgentDialog", () => {
  it("stays closed without a pending record", () => {
    render(<RemoveHostAgentDialog record={null} onCancel={jest.fn()} onConfirm={jest.fn()} />)
    expect(screen.queryByRole("alertdialog")).toBeNull()
  })

  it("names the agent and confirms with that record", async () => {
    const user = userEvent.setup()
    const onConfirm = jest.fn()
    render(<RemoveHostAgentDialog record={row} onCancel={jest.fn()} onConfirm={onConfirm} />)
    expect(screen.getByText("Remove Codex RO?")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Remove Codex RO" }))
    expect(onConfirm).toHaveBeenCalledWith(row)
  })

  it("cancels without confirming", async () => {
    const user = userEvent.setup()
    const onCancel = jest.fn()
    const onConfirm = jest.fn()
    render(<RemoveHostAgentDialog record={row} onCancel={onCancel} onConfirm={onConfirm} />)
    await user.click(screen.getByRole("button", { name: "Cancel" }))
    expect(onCancel).toHaveBeenCalled()
    expect(onConfirm).not.toHaveBeenCalled()
  })
})
