/**
 * @jest-environment jsdom
 */
import React from "react"
import { fireEvent, render, screen, within } from "@testing-library/react"

import { UltracodeSection } from "./section-ultracode"
import type { AgentTeam } from "@/types/agent/agent-team"

const markSavedMock = jest.fn()
jest.mock("./settings-save-indicator", () => ({
  markSettingsSaved: () => markSavedMock(),
}))

const updateTeamConfigMock = jest.fn()
jest.mock("@/stores/agent/agent-team-store", () => ({
  useAgentTeamStore: (sel: (s: { updateTeamConfig: jest.Mock }) => unknown) =>
    sel({ updateTeamConfig: updateTeamConfigMock }),
}))

function team(ultracode?: AgentTeam["config"]["ultracode"], workingDir?: string): AgentTeam {
  return {
    id: "team-1",
    name: "Team",
    description: "",
    task: "t",
    status: "idle",
    config: {
      maxTeammates: 5,
      maxConcurrentTeammates: 3,
      executionMode: "coordinated",
      displayMode: "expanded",
      ultracode,
      workingDir,
    },
    leadId: "lead",
    teammateIds: [],
    taskIds: [],
    messageIds: [],
    progress: 0,
    totalTokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    createdAt: new Date(0),
  } as AgentTeam
}

beforeEach(() => {
  markSavedMock.mockReset()
  updateTeamConfigMock.mockReset()
})

describe("UltracodeSection", () => {
  it("enables ultracode via the switch", () => {
    render(<UltracodeSection team={team({ enabled: false })} />)
    const sw = screen.getByRole("switch")
    expect(sw).not.toBeChecked()
    fireEvent.click(sw)
    expect(updateTeamConfigMock).toHaveBeenCalledWith(
      "team-1",
      expect.objectContaining({ ultracode: expect.objectContaining({ enabled: true }) })
    )
    expect(markSavedMock).toHaveBeenCalled()
  })

  it("disables the knobs when ultracode is off", () => {
    render(<UltracodeSection team={team({ enabled: false })} />)
    for (const input of screen.getAllByRole("spinbutton")) {
      expect(input).toBeDisabled()
    }
    expect(screen.getByRole("combobox")).toHaveAttribute("data-disabled")
  })

  it("patches each fan-out knob when enabled", () => {
    render(<UltracodeSection team={team({ enabled: true, autoMode: "auto" })} />)
    const [skeptics, judges, rounds, dry] = screen.getAllByRole("spinbutton")

    fireEvent.change(skeptics, { target: { value: "5" } })
    expect(updateTeamConfigMock).toHaveBeenLastCalledWith(
      "team-1",
      expect.objectContaining({ ultracode: expect.objectContaining({ skepticsPerFinding: 5 }) })
    )

    fireEvent.change(judges, { target: { value: "4" } })
    expect(updateTeamConfigMock).toHaveBeenLastCalledWith(
      "team-1",
      expect.objectContaining({ ultracode: expect.objectContaining({ judgesPerAttempt: 4 }) })
    )

    fireEvent.change(rounds, { target: { value: "6" } })
    expect(updateTeamConfigMock).toHaveBeenLastCalledWith(
      "team-1",
      expect.objectContaining({ ultracode: expect.objectContaining({ maxFinderRounds: 6 }) })
    )

    fireEvent.change(dry, { target: { value: "3" } })
    expect(updateTeamConfigMock).toHaveBeenLastCalledWith(
      "team-1",
      expect.objectContaining({ ultracode: expect.objectContaining({ dryRoundsToStop: 3 }) })
    )
  })

  it("clamps an out-of-range knob to its bounds", () => {
    render(<UltracodeSection team={team({ enabled: true })} />)
    const [skeptics] = screen.getAllByRole("spinbutton")
    fireEvent.change(skeptics, { target: { value: "999" } })
    expect(updateTeamConfigMock).toHaveBeenLastCalledWith(
      "team-1",
      expect.objectContaining({ ultracode: expect.objectContaining({ skepticsPerFinding: 16 }) })
    )
  })

  it("updates the working directory (clearing to undefined when blank)", () => {
    render(<UltracodeSection team={team({ enabled: true }, "/old")} />)
    const dir = screen.getByRole("textbox")
    fireEvent.change(dir, { target: { value: "/repo" } })
    expect(updateTeamConfigMock).toHaveBeenLastCalledWith(
      "team-1",
      expect.objectContaining({ workingDir: "/repo" })
    )
    fireEvent.change(dir, { target: { value: "  " } })
    expect(updateTeamConfigMock).toHaveBeenLastCalledWith(
      "team-1",
      expect.objectContaining({ workingDir: undefined })
    )
  })

  it("renders defaults when ultracode config is entirely absent", () => {
    render(<UltracodeSection team={team(undefined)} />)
    expect(screen.getByRole("switch")).not.toBeChecked()
    // Default knob values surface (3 / 3 / 4 / 2).
    const [skeptics, judges, rounds, dry] = screen.getAllByRole("spinbutton")
    expect(skeptics).toHaveValue(3)
    expect(judges).toHaveValue(3)
    expect(rounds).toHaveValue(4)
    expect(dry).toHaveValue(2)
  })

  it("clamps a non-numeric knob value to its fallback", () => {
    render(<UltracodeSection team={team({ enabled: true })} />)
    const [skeptics] = screen.getAllByRole("spinbutton")
    fireEvent.change(skeptics, { target: { value: "abc" } })
    expect(updateTeamConfigMock).toHaveBeenLastCalledWith(
      "team-1",
      expect.objectContaining({ ultracode: expect.objectContaining({ skepticsPerFinding: 3 }) })
    )
  })

  it("changes the auto-trigger mode via the select", () => {
    render(<UltracodeSection team={team({ enabled: true, autoMode: "auto" })} />)
    fireEvent.click(screen.getByRole("combobox"))
    const listbox = screen.getByRole("listbox")
    fireEvent.click(within(listbox).getByText("Always"))
    expect(updateTeamConfigMock).toHaveBeenLastCalledWith(
      "team-1",
      expect.objectContaining({ ultracode: expect.objectContaining({ autoMode: "always" }) })
    )
  })
})
