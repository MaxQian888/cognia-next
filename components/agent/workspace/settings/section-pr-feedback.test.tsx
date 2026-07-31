/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

const markSavedMock = jest.fn()
jest.mock("./settings-save-indicator", () => ({
  markSettingsSaved: () => markSavedMock(),
}))

const updateTeamConfigMock = jest.fn()
jest.mock("@/stores/agent/agent-team-store", () => ({
  useAgentTeamStore: (sel: (s: { updateTeamConfig: jest.Mock }) => unknown) =>
    sel({ updateTeamConfig: updateTeamConfigMock }),
}))

import { PrFeedbackSection } from "./section-pr-feedback"
import type { AgentTeam, AgentTeamConfig } from "@/types/agent/agent-team"

function makeTeam(prFeedback?: AgentTeamConfig["prFeedback"]): AgentTeam {
  return {
    id: "team1",
    name: "T",
    config: {
      maxTeammates: 5,
      maxConcurrentTeammates: 3,
      executionMode: "coordinated",
      displayMode: "expanded",
      ...(prFeedback ? { prFeedback } : {}),
    },
  } as unknown as AgentTeam
}

beforeEach(() => {
  updateTeamConfigMock.mockReset()
  markSavedMock.mockReset()
})

describe("PrFeedbackSection", () => {
  it("enabling the switch patches prFeedback.enabled and marks saved", () => {
    render(<PrFeedbackSection team={makeTeam()} />)
    // The first switch is the master enable toggle.
    fireEvent.click(screen.getAllByRole("switch")[0])
    expect(updateTeamConfigMock).toHaveBeenCalledWith(
      "team1",
      expect.objectContaining({ prFeedback: expect.objectContaining({ enabled: true }) })
    )
    expect(markSavedMock).toHaveBeenCalled()
  })

  it("disables publishPr, reviewer, and the observe-window select until enabled", () => {
    render(<PrFeedbackSection team={makeTeam()} />)
    const switches = screen.getAllByRole("switch")
    expect(switches[1]).toBeDisabled() // publishPr
    expect(switches[2]).toBeDisabled() // reviewer
    expect(screen.getByRole("combobox")).toHaveAttribute("data-disabled")
  })

  it("renders the observe-window select enabled once PR feedback is on", () => {
    render(<PrFeedbackSection team={makeTeam({ enabled: true, observeWindowMs: 300_000 })} />)
    expect(screen.getByRole("combobox")).not.toHaveAttribute("data-disabled")
  })

  it("reflects checked publishPr and reviewer states", () => {
    render(
      <PrFeedbackSection
        team={makeTeam({ enabled: true, publishPr: true, reviewer: { enabled: true } })}
      />
    )
    const switches = screen.getAllByRole("switch")
    expect(switches[0]).toBeChecked() // enabled
    expect(switches[1]).toBeChecked() // publishPr
    expect(switches[2]).toBeChecked() // reviewer
  })

  it("patches the reviewer toggle when enabled", () => {
    render(<PrFeedbackSection team={makeTeam({ enabled: true })} />)
    const switches = screen.getAllByRole("switch")
    expect(switches[2]).not.toBeDisabled()
    fireEvent.click(switches[2])
    expect(updateTeamConfigMock).toHaveBeenCalledWith(
      "team1",
      expect.objectContaining({
        prFeedback: expect.objectContaining({ reviewer: { enabled: true } }),
      })
    )
  })
})
