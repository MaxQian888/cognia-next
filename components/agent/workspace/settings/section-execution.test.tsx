/**
 * @jest-environment jsdom
 */
import { render, screen, fireEvent } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { ExecutionSection } from "./section-execution"
import en from "@/i18n/messages/en.json"
import type { AgentTeam } from "@/types/agent/agent-team"

const updateTeamConfigMock = jest.fn()
jest.mock("@/stores/agent/agent-team-store", () => ({
  useAgentTeamStore: (selector: (s: unknown) => unknown) =>
    selector({ updateTeamConfig: (...a: unknown[]) => updateTeamConfigMock(...a) }),
}))
jest.mock("./settings-save-indicator", () => ({ markSettingsSaved: jest.fn() }))

function makeTeam(config: Partial<AgentTeam["config"]> = {}): AgentTeam {
  return {
    id: "team-1",
    name: "Team",
    teammateIds: [],
    status: "idle",
    config: {
      maxTeammates: 5,
      maxConcurrentTeammates: 3,
      executionMode: "coordinated",
      displayMode: "expanded",
      ...config,
    },
  } as unknown as AgentTeam
}

const renderSection = (team: AgentTeam) =>
  render(
    <NextIntlClientProvider locale="en" messages={en}>
      <ExecutionSection team={team} />
    </NextIntlClientProvider>
  )

beforeEach(() => jest.clearAllMocks())

describe("ExecutionSection", () => {
  it("renders the team default binding field and the depth input with its default", () => {
    renderSection(makeTeam())
    expect(screen.getByTestId("execution-section")).toBeInTheDocument()
    expect(screen.getByTestId("execution-binding-mode")).toBeInTheDocument()
    expect(screen.getByLabelText("Max team delegation depth")).toHaveValue(2)
  })

  it("saves the TEAM defaultExecution through the full-config update (no field loss)", async () => {
    renderSection(makeTeam({ defaultTimeout: 9_000 }))
    fireEvent.click(screen.getByTestId("execution-binding-mode"))
    fireEvent.click(await screen.findByRole("option", { name: "Pinned" }))
    expect(updateTeamConfigMock).toHaveBeenCalledWith(
      "team-1",
      expect.objectContaining({ defaultTimeout: 9_000, defaultExecution: { mode: "pinned" } })
    )
  })

  it("saves maxTeamDelegationDepth on blur and falls back to the default for garbage", () => {
    renderSection(makeTeam({ maxTeamDelegationDepth: 1 }))
    const input = screen.getByLabelText("Max team delegation depth")
    expect(input).toHaveValue(1)

    fireEvent.change(input, { target: { value: "3" } })
    fireEvent.blur(input)
    expect(updateTeamConfigMock).toHaveBeenCalledWith(
      "team-1",
      expect.objectContaining({ maxTeamDelegationDepth: 3 })
    )

    fireEvent.change(input, { target: { value: "-5" } })
    fireEvent.blur(input)
    expect(updateTeamConfigMock).toHaveBeenLastCalledWith(
      "team-1",
      expect.objectContaining({ maxTeamDelegationDepth: 2 })
    )
  })
})
