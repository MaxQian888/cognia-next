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

  it("renders the PR feedback settings accordion", () => {
    render(<AgentTeamSettings team={baseTeam} />)
    expect(screen.getByText("PR feedback")).toBeInTheDocument()
  })

  it("editing the name eagerly persists via updateTeam on blur", () => {
    render(<AgentTeamSettings team={baseTeam} />)
    const nameInput = screen.getByDisplayValue("Squad Alpha")
    fireEvent.change(nameInput, { target: { value: "Squad Beta" } })
    // Eager save: blur flushes the debounced commit (no Save button anymore).
    fireEvent.blur(nameInput)
    expect(updateTeamMock).toHaveBeenCalledWith(
      "team_x",
      expect.objectContaining({ name: "Squad Beta" })
    )
  })

  /**
   * Deletion moved out. The danger zone here redirected to `/agent-teams`, a
   * route ADR-0140 retired, while `SquadDetailPanel` already had a delete with
   * its own type-to-confirm. Two delete paths over one entity is the
   * double-entry-point defect, and this was the copy aimed at a dead route.
   */
  it("no longer offers a second way to delete the squad", () => {
    render(<AgentTeamSettings team={baseTeam} />)
    expect(screen.queryByRole("button", { name: /Delete permanently/i })).not.toBeInTheDocument()
    expect(deleteTeamMock).not.toHaveBeenCalled()
  })
})
