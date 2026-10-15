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

import { parseRequiredChecks, WorktreesSection } from "./section-worktrees"
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

  it("shows the integration controls only in merge-all mode", () => {
    const { rerender } = render(
      <WorktreesSection team={makeTeam({ enabled: true, reconcile: "manual" })} />
    )
    expect(
      screen.queryByRole("combobox", { name: "integration.target.label" })
    ).not.toBeInTheDocument()

    rerender(<WorktreesSection team={makeTeam({ enabled: true, reconcile: "merge-all" })} />)
    expect(screen.getByRole("combobox", { name: "integration.target.label" })).toBeInTheDocument()
    expect(screen.getByRole("combobox", { name: "integration.strategy.label" })).toBeInTheDocument()
    expect(
      screen.getByRole("combobox", { name: "integration.onConflict.label" })
    ).toBeInTheDocument()
    // The default target never moves the user's branch, and says so.
    expect(screen.getByText("integration.target.hint.branch")).toBeInTheDocument()
  })

  it("saves required checks on blur, keeping the rest of the integration block", () => {
    render(
      <WorktreesSection
        team={makeTeam({
          enabled: true,
          reconcile: "merge-all",
          integration: { target: "base", onConflict: "stop" },
        })}
      />
    )
    const input = screen.getByLabelText("integration.requiredChecks.label")
    fireEvent.change(input, { target: { value: "unit, lint unit" } })
    fireEvent.blur(input)
    expect(updateTeamConfigMock).toHaveBeenCalledWith(
      "team1",
      expect.objectContaining({
        workspaceIsolation: expect.objectContaining({
          reconcile: "merge-all",
          integration: { target: "base", onConflict: "stop", requiredChecks: ["unit", "lint"] },
        }),
      })
    )
  })

  it("does not save when the required checks did not change", () => {
    render(
      <WorktreesSection
        team={makeTeam({
          enabled: true,
          reconcile: "merge-all",
          integration: { requiredChecks: ["unit"] },
        })}
      />
    )
    const input = screen.getByLabelText("integration.requiredChecks.label")
    expect(input).toHaveValue("unit")
    fireEvent.blur(input)
    expect(updateTeamConfigMock).not.toHaveBeenCalled()
  })
})

describe("WorktreesSection — required checks draft", () => {
  it("follows a save made elsewhere", () => {
    const team = (ids: string[]) =>
      makeTeam({ enabled: true, reconcile: "merge-all", integration: { requiredChecks: ids } })
    const { rerender } = render(<WorktreesSection team={team(["unit"])} />)
    rerender(<WorktreesSection team={team(["unit", "e2e"])} />)
    expect(screen.getByLabelText("integration.requiredChecks.label")).toHaveValue("unit, e2e")
  })
})

describe("parseRequiredChecks", () => {
  it("splits on commas and whitespace, dropping blanks and duplicates", () => {
    expect(parseRequiredChecks(" unit,, lint\n unit ")).toEqual(["unit", "lint"])
    expect(parseRequiredChecks("")).toEqual([])
  })
})
