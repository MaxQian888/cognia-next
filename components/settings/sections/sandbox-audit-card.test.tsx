/** @jest-environment jsdom */

import { render, screen, waitFor } from "@testing-library/react"

const listAuditRows = jest.fn()
jest.mock("@/lib/automation/audit", () => ({
  listAuditRows: (...args: unknown[]) => listAuditRows(...args),
}))

import { SandboxAuditCard } from "./sandbox-audit-card"

describe("SandboxAuditCard", () => {
  it("queries the shared audit store with the sandbox surface filter", async () => {
    listAuditRows.mockResolvedValue([
      {
        id: "sandbox-row",
        ts: 1,
        surface: "sandbox",
        command: "sandbox_bash",
        decision: "allow",
      },
    ])

    render(<SandboxAuditCard />)

    await waitFor(() => {
      expect(listAuditRows).toHaveBeenCalledWith({ surface: "sandbox", limit: 50 })
    })
    expect(screen.getByText("sandbox_bash")).toBeInTheDocument()
  })
})
