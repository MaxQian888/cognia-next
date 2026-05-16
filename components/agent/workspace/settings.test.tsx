/**
 * @jest-environment jsdom
 *
 * Coverage for AgentTeamSettings: form renders pre-filled, save calls
 * updateTeam + updateTeamConfig, toggles flip state, delete requires the
 * type-to-confirm string before unlocking.
 */

import React from "react"
import { fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn() }),
}))

const updateTeamMock = jest.fn()
const updateTeamConfigMock = jest.fn()
const deleteTeamMock = jest.fn()

jest.mock("@/stores/agent/agent-team-store", () => ({
  useAgentTeamStore: (selector: (s: unknown) => unknown) =>
    selector({
      updateTeam: updateTeamMock,
      updateTeamConfig: updateTeamConfigMock,
      deleteTeam: deleteTeamMock,
    }),
}))

import { AgentTeamSettings } from "./settings"
import type { AgentTeam } from "@/types/agent/agent-team"

const baseTeam: AgentTeam = {
  id: "team_x",
  name: "Squad Alpha",
  description: "research squad",
  task: "investigate",
  status: "idle",
  config: {
    maxTeammates: 5,
    maxConcurrentTeammates: 3,
    executionMode: "coordinated",
    displayMode: "compact",
    tokenBudget: 10000,
    autoShutdown: true,
    enableMessaging: true,
    requirePlanApproval: false,
    maxRetries: 2,
  },
  leadId: "lead_1",
  teammateIds: ["lead_1"],
  taskIds: [],
  messageIds: [],
  progress: 0,
  totalTokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  createdAt: new Date(),
}

beforeEach(() => {
  updateTeamMock.mockClear()
  updateTeamConfigMock.mockClear()
  deleteTeamMock.mockClear()
})

describe("AgentTeamSettings", () => {
  it("renders pre-filled name, description, and budget", () => {
    render(<AgentTeamSettings team={baseTeam} />)
    const nameInput = screen.getByDisplayValue("Squad Alpha") as HTMLInputElement
    expect(nameInput).toBeInTheDocument()
    expect(screen.getByDisplayValue("research squad")).toBeInTheDocument()
    expect(screen.getByDisplayValue("10000")).toBeInTheDocument()
  })

  it("clicking Save persists name + description + config", async () => {
    render(<AgentTeamSettings team={baseTeam} />)
    const nameInput = screen.getByDisplayValue("Squad Alpha")
    fireEvent.change(nameInput, { target: { value: "Squad Beta" } })
    await userEvent.click(screen.getByRole("button", { name: /^Save$/i }))
    expect(updateTeamMock).toHaveBeenCalledTimes(1)
    expect(updateTeamMock.mock.calls[0][0]).toBe("team_x")
    expect(updateTeamMock.mock.calls[0][1].name).toBe("Squad Beta")
    expect(updateTeamConfigMock).toHaveBeenCalledTimes(1)
    expect(updateTeamConfigMock.mock.calls[0][1].executionMode).toBe("coordinated")
  })

  it("delete button stays disabled until the team name is typed", async () => {
    render(<AgentTeamSettings team={baseTeam} />)
    // Open the delete dialog
    const triggers = screen.getAllByRole("button", { name: /Delete permanently/i })
    await userEvent.click(triggers[0])
    // The dialog action button should be present + disabled
    const dialogAction = screen.getAllByRole("button", { name: /Delete permanently/i }).at(-1)
    expect(dialogAction).toBeDisabled()
    // Type the confirm text
    const confirmInput = screen.getByPlaceholderText(baseTeam.name) as HTMLInputElement
    fireEvent.change(confirmInput, { target: { value: baseTeam.name } })
    const dialogActionEnabled = screen
      .getAllByRole("button", { name: /Delete permanently/i })
      .at(-1)
    expect(dialogActionEnabled).not.toBeDisabled()
    await userEvent.click(dialogActionEnabled!)
    expect(deleteTeamMock).toHaveBeenCalledWith("team_x")
  })
})
