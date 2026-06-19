/**
 * @jest-environment jsdom
 */
import React from "react"
import { fireEvent, render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

const markSavedMock = jest.fn()
jest.mock("./settings-save-indicator", () => ({
  markSettingsSaved: () => markSavedMock(),
}))

const updateTeamMock = jest.fn()
const updateTeamConfigMock = jest.fn()
jest.mock("@/stores/agent/agent-team-store", () => ({
  useAgentTeamStore: (
    sel: (s: { updateTeam: jest.Mock; updateTeamConfig: jest.Mock }) => unknown
  ) => sel({ updateTeam: updateTeamMock, updateTeamConfig: updateTeamConfigMock }),
}))

// EditableSettingRow uses debounceMs, stub ConfirmActionDialog just in case.
jest.mock("./confirm-action-dialog", () => ({
  ConfirmActionDialog: () => null,
}))

import { OverviewSection } from "./section-overview"
import type { AgentTeam } from "@/types/agent/agent-team"
import { within } from "@testing-library/react"

function makeTeam(overrides: Partial<AgentTeam["config"]> = {}): AgentTeam {
  return {
    id: "t1",
    name: "Alpha",
    description: "desc",
    task: "do stuff",
    status: "idle",
    config: {
      maxTeammates: 10,
      maxConcurrentTeammates: 5,
      executionMode: "coordinated",
      displayMode: "expanded",
      autoShutdown: true,
      enableMessaging: true,
      requirePlanApproval: false,
      maxRetries: 3,
      tokenBudget: 0,
      ...overrides,
    },
    leadId: "lead-1",
    teammateIds: [],
    taskIds: [],
    messageIds: [],
    progress: 0,
    totalTokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    createdAt: new Date(0),
  } as AgentTeam
}

beforeEach(() => {
  updateTeamMock.mockReset()
  updateTeamConfigMock.mockReset()
  markSavedMock.mockReset()
})

describe("OverviewSection", () => {
  it("renders the team name and description fields", () => {
    render(<OverviewSection team={makeTeam()} />)
    // The overview-name testid is plumbed through EditableSettingRow to the wrapper div.
    expect(screen.getByDisplayValue("Alpha")).toBeInTheDocument()
    expect(screen.getByDisplayValue("desc")).toBeInTheDocument()
  })

  it("calls updateTeam when the name field is blurred with a new value", () => {
    render(<OverviewSection team={makeTeam()} />)
    const nameInput = screen.getByDisplayValue("Alpha")
    fireEvent.change(nameInput, { target: { value: "Beta" } })
    fireEvent.blur(nameInput)
    expect(updateTeamMock).toHaveBeenCalledWith("t1", { name: "Beta" })
  })

  it("falls back to the current name when blurred with blank", () => {
    render(<OverviewSection team={makeTeam()} />)
    const nameInput = screen.getByDisplayValue("Alpha")
    fireEvent.change(nameInput, { target: { value: "   " } })
    fireEvent.blur(nameInput)
    // Trim-or-fallback logic: "   ".trim() === "" so uses team.name
    expect(updateTeamMock).toHaveBeenCalledWith("t1", { name: "Alpha" })
  })

  it("calls updateTeam when the description field is blurred", () => {
    render(<OverviewSection team={makeTeam()} />)
    const descInput = screen.getByDisplayValue("desc")
    fireEvent.change(descInput, { target: { value: "new desc" } })
    fireEvent.blur(descInput)
    expect(updateTeamMock).toHaveBeenCalledWith("t1", { description: "new desc" })
  })

  it("sets description to undefined when blurred with blank", () => {
    render(<OverviewSection team={makeTeam()} />)
    const descInput = screen.getByDisplayValue("desc")
    fireEvent.change(descInput, { target: { value: "" } })
    fireEvent.blur(descInput)
    expect(updateTeamMock).toHaveBeenCalledWith("t1", { description: undefined })
  })

  it("renders default switch states (autoShutdown=true, enableMessaging=true, streamProgress=true, requirePlanApproval=false)", () => {
    render(<OverviewSection team={makeTeam()} />)
    const switches = screen.getAllByRole("switch")
    // autoShutdown(true), enableMessaging(true), streamProgress(true), requirePlanApproval(false)
    expect(switches.length).toBeGreaterThanOrEqual(4)
    const [autoShutdown, enableMessaging, streamProgress, requirePlanApproval] = switches
    expect(autoShutdown).toBeChecked()
    expect(enableMessaging).toBeChecked()
    expect(streamProgress).toBeChecked()
    expect(requirePlanApproval).not.toBeChecked()
  })

  it("toggles autoShutdown switch and calls updateTeamConfig", () => {
    render(<OverviewSection team={makeTeam({ autoShutdown: true })} />)
    const [autoShutdown] = screen.getAllByRole("switch")
    fireEvent.click(autoShutdown)
    expect(updateTeamConfigMock).toHaveBeenCalledWith(
      "t1",
      expect.objectContaining({ autoShutdown: false })
    )
  })

  it("toggles enableMessaging switch and calls updateTeamConfig", () => {
    render(<OverviewSection team={makeTeam({ enableMessaging: true })} />)
    const [, enableMessaging] = screen.getAllByRole("switch")
    fireEvent.click(enableMessaging)
    expect(updateTeamConfigMock).toHaveBeenCalledWith(
      "t1",
      expect.objectContaining({ enableMessaging: false })
    )
  })

  it("toggles streamProgress switch and calls updateTeamConfig", () => {
    render(<OverviewSection team={makeTeam({ streamProgress: true })} />)
    const [, , streamProgress] = screen.getAllByRole("switch")
    fireEvent.click(streamProgress)
    expect(updateTeamConfigMock).toHaveBeenCalledWith(
      "t1",
      expect.objectContaining({ streamProgress: false })
    )
  })

  it("toggles requirePlanApproval switch and calls updateTeamConfig", () => {
    render(<OverviewSection team={makeTeam({ requirePlanApproval: false })} />)
    const [, , , requirePlanApproval] = screen.getAllByRole("switch")
    fireEvent.click(requirePlanApproval)
    expect(updateTeamConfigMock).toHaveBeenCalledWith(
      "t1",
      expect.objectContaining({ requirePlanApproval: true })
    )
  })

  it("renders maxConcurrentTeammates and tokenBudget number inputs", () => {
    render(
      <OverviewSection
        team={makeTeam({ maxConcurrentTeammates: 8, tokenBudget: 1000, maxRetries: 2 })}
      />
    )
    expect(screen.getByDisplayValue("8")).toBeInTheDocument()
    expect(screen.getByDisplayValue("1000")).toBeInTheDocument()
  })

  it("commits maxConcurrentTeammates on blur", () => {
    render(<OverviewSection team={makeTeam({ maxConcurrentTeammates: 6, maxRetries: 2 })} />)
    const input = screen.getByDisplayValue("6")
    fireEvent.change(input, { target: { value: "7" } })
    fireEvent.blur(input)
    expect(updateTeamConfigMock).toHaveBeenCalledWith(
      "t1",
      expect.objectContaining({ maxConcurrentTeammates: 7 })
    )
  })

  it("commits maxConcurrentTeammates and clamps via fallback for non-numeric", () => {
    render(<OverviewSection team={makeTeam({ maxConcurrentTeammates: 6, maxRetries: 2 })} />)
    const input = screen.getByDisplayValue("6")
    fireEvent.change(input, { target: { value: "abc" } })
    fireEvent.blur(input)
    // Math.max(1, parseInt("abc",10) || 5) = Math.max(1,5) = 5
    expect(updateTeamConfigMock).toHaveBeenCalledWith(
      "t1",
      expect.objectContaining({ maxConcurrentTeammates: 5 })
    )
  })

  it("commits maxRetries and clamps to 0 for non-numeric", () => {
    // Use a unique value (9) so getByDisplayValue is unambiguous.
    render(<OverviewSection team={makeTeam({ maxRetries: 9, maxConcurrentTeammates: 4 })} />)
    const input = screen.getByDisplayValue("9")
    fireEvent.change(input, { target: { value: "xyz" } })
    fireEvent.blur(input)
    expect(updateTeamConfigMock).toHaveBeenCalledWith(
      "t1",
      expect.objectContaining({ maxRetries: 0 })
    )
  })

  it("uses default config values when optional fields are absent", () => {
    const team = makeTeam()
    // Remove optional fields
    delete (team.config as Partial<AgentTeam["config"]>).autoShutdown
    delete (team.config as Partial<AgentTeam["config"]>).enableMessaging
    delete (team.config as Partial<AgentTeam["config"]>).requirePlanApproval
    delete (team.config as Partial<AgentTeam["config"]>).maxRetries
    delete (team.config as Partial<AgentTeam["config"]>).tokenBudget
    render(<OverviewSection team={team} />)
    // autoShutdown ?? true → checked
    const switches = screen.getAllByRole("switch")
    expect(switches[0]).toBeChecked()
    // tokenBudget ?? 0
    expect(screen.getByDisplayValue("0")).toBeInTheDocument()
    // maxRetries ?? 3
    expect(screen.getByDisplayValue("3")).toBeInTheDocument()
  })

  it("renders section headings", () => {
    render(<OverviewSection team={makeTeam()} />)
    // t("title"), t("sectionExecution"), t("sectionControls") — all return key
    expect(screen.getByText("title")).toBeInTheDocument()
    expect(screen.getByText("sectionExecution")).toBeInTheDocument()
    expect(screen.getByText("sectionControls")).toBeInTheDocument()
  })

  it("executionMode select calls updateTeamConfig via onValueChange", () => {
    render(<OverviewSection team={makeTeam()} />)
    // There are two comboboxes: executionMode and executionPattern.
    const [executionModeSelect] = screen.getAllByRole("combobox")
    fireEvent.click(executionModeSelect)
    const listbox = screen.getByRole("listbox")
    // t("autonomous") = "autonomous" (key passthrough)
    fireEvent.click(within(listbox).getByText("autonomous"))
    expect(updateTeamConfigMock).toHaveBeenCalledWith(
      "t1",
      expect.objectContaining({ executionMode: "autonomous" })
    )
  })

  it("executionPattern select calls updateTeamConfig via onValueChange", () => {
    render(<OverviewSection team={makeTeam()} />)
    const comboboxes = screen.getAllByRole("combobox")
    const executionPatternSelect = comboboxes[1]
    fireEvent.click(executionPatternSelect)
    const listbox = screen.getByRole("listbox")
    // tPattern("parallelSpecialists") = "parallelSpecialists"
    fireEvent.click(within(listbox).getByText("parallelSpecialists"))
    expect(updateTeamConfigMock).toHaveBeenCalledWith(
      "t1",
      expect.objectContaining({ preferredExecutionPattern: "parallel_specialists" })
    )
  })

  it("tokenBudget input commits on blur", () => {
    render(
      <OverviewSection
        team={makeTeam({ tokenBudget: 500, maxConcurrentTeammates: 4, maxRetries: 1 })}
      />
    )
    const input = screen.getByDisplayValue("500")
    fireEvent.change(input, { target: { value: "2000" } })
    fireEvent.blur(input)
    expect(updateTeamConfigMock).toHaveBeenCalledWith(
      "t1",
      expect.objectContaining({ tokenBudget: 2000 })
    )
  })

  it('renders with description undefined (covers ?? "" branch)', () => {
    const team = makeTeam()
    team.description = undefined as unknown as string
    render(<OverviewSection team={team} />)
    // The description textarea is a <textarea> role=textbox.
    // We find it among the textboxes (the only one with rows=3).
    const textareas = screen.getAllByRole("textbox")
    // The description textarea is the only <textarea> (name input is <input>).
    const descriptionTextarea = textareas.find((el) => el.tagName.toLowerCase() === "textarea")
    expect(descriptionTextarea).toHaveValue("")
  })

  it("renders with executionMode undefined (covers ?? coordinated branch)", () => {
    const team = makeTeam()
    delete (team.config as Partial<AgentTeam["config"]>).executionMode
    render(<OverviewSection team={team} />)
    // Should still render without error.
    expect(screen.getByText("sectionExecution")).toBeInTheDocument()
  })

  it("renders with maxConcurrentTeammates undefined (covers ?? 5 branch)", () => {
    const team = makeTeam()
    delete (team.config as Partial<AgentTeam["config"]>).maxConcurrentTeammates
    render(<OverviewSection team={team} />)
    // Defaults to 5.
    expect(screen.getByDisplayValue("5")).toBeInTheDocument()
  })

  it("renders with tokenBudget undefined (covers ?? 0 branch)", () => {
    const team = makeTeam({ maxConcurrentTeammates: 4, maxRetries: 1 })
    delete (team.config as Partial<AgentTeam["config"]>).tokenBudget
    render(<OverviewSection team={team} />)
    // Defaults to 0.
    expect(screen.getByDisplayValue("0")).toBeInTheDocument()
  })

  it("commits tokenBudget with non-numeric → falls back to 0 via || 0", () => {
    // Use unique values so the input is unambiguous.
    render(
      <OverviewSection
        team={makeTeam({ tokenBudget: 777, maxConcurrentTeammates: 4, maxRetries: 1 })}
      />
    )
    const input = screen.getByDisplayValue("777")
    fireEvent.change(input, { target: { value: "abc" } })
    fireEvent.blur(input)
    // parseInt("abc") = NaN → NaN || 0 = 0
    expect(updateTeamConfigMock).toHaveBeenCalledWith(
      "t1",
      expect.objectContaining({ tokenBudget: 0 })
    )
  })
})
