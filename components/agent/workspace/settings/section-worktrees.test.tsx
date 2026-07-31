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

import { WorktreesSection } from "./section-worktrees"
import type { AgentTeam } from "@/types/agent/agent-team"

function makeTeam(iso?: Record<string, unknown>): AgentTeam {
  return {
    id: "team1",
    name: "T",
    config: {
      maxTeammates: 5,
      maxConcurrentTeammates: 3,
      executionMode: "coordinated",
      displayMode: "expanded",
      ...(iso ? { workspaceIsolation: iso } : {}),
    },
  } as unknown as AgentTeam
}

beforeEach(() => {
  updateTeamConfigMock.mockReset()
  markSavedMock.mockReset()
})

describe("WorktreesSection", () => {
  it("enabling the switch patches workspaceIsolation.enabled and marks saved", () => {
    render(<WorktreesSection team={makeTeam()} />)
    fireEvent.click(screen.getByRole("switch"))
    expect(updateTeamConfigMock).toHaveBeenCalledWith(
      "team1",
      expect.objectContaining({ workspaceIsolation: expect.objectContaining({ enabled: true }) })
    )
    expect(markSavedMock).toHaveBeenCalled()
  })

  it("shows the select-strategy control only in select mode", () => {
    const { rerender } = render(<WorktreesSection team={makeTeam({ reconcile: "manual" })} />)
    expect(screen.queryByRole("combobox", { name: "selectStrategy.label" })).not.toBeInTheDocument()

    rerender(<WorktreesSection team={makeTeam({ reconcile: "select" })} />)
    expect(screen.getByRole("combobox", { name: "selectStrategy.label" })).toBeInTheDocument()
  })

  it("renders the HEAD-not-WIP caveat", () => {
    render(<WorktreesSection team={makeTeam({ enabled: true })} />)
    expect(screen.getByText("caveat")).toBeInTheDocument()
  })
})
