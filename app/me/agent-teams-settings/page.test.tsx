/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"

import MobileAgentTeamsSettingsPage from "./page"
import { useCompanionConfig } from "@/hooks/companion/use-companion-config"
import { useAgentTeamStore } from "@/stores/agent/agent-team-store"

jest.mock("@/hooks/companion/use-companion-config")
jest.mock("@/stores/agent/agent-team-store", () => ({
  useAgentTeamStore: jest.fn(),
}))

const mockPaired = (paired: boolean) =>
  (useCompanionConfig as jest.Mock).mockReturnValue({
    config: null,
    paired,
    shortDeviceId: null,
    loading: false,
    reload: jest.fn(),
  })

const mockTemplates = (templates: Record<string, unknown>) =>
  (useAgentTeamStore as unknown as jest.Mock).mockImplementation(
    (selector: (s: { templates: unknown }) => unknown) => selector({ templates })
  )

beforeEach(() => {
  jest.clearAllMocks()
  mockPaired(true)
  mockTemplates({
    "parallel-review": {
      id: "parallel-review",
      name: "Parallel Code Review",
      description: "Split code review across multiple specialized reviewers",
      category: "review",
      teammates: [{ name: "A" }, { name: "B" }],
    },
    research: {
      id: "research",
      name: "Research Squad",
      description: "",
      category: "research",
      teammates: [{ name: "X" }],
    },
  })
})

describe("MobileAgentTeamsSettingsPage", () => {
  it("shows the paired placeholder when unpaired", () => {
    mockPaired(false)
    render(<MobileAgentTeamsSettingsPage />)
    expect(screen.getByTestId("paired-only-placeholder")).toBeInTheDocument()
    expect(screen.queryByTestId("agent-team-row-parallel-review")).toBeNull()
  })

  it("lists the available team templates when paired", () => {
    render(<MobileAgentTeamsSettingsPage />)
    expect(screen.getByTestId("mobile-agent-teams-page")).toBeInTheDocument()
    expect(screen.getByTestId("agent-team-row-parallel-review")).toBeInTheDocument()
    expect(screen.getByTestId("agent-team-row-research")).toBeInTheDocument()
    expect(screen.getByText("Parallel Code Review")).toBeInTheDocument()
  })

  it("renders the empty state when there are no templates", () => {
    mockTemplates({})
    render(<MobileAgentTeamsSettingsPage />)
    expect(screen.getByTestId("me-section-agent-teams")).toBeInTheDocument()
    expect(screen.queryByTestId("agent-team-row-parallel-review")).toBeNull()
  })

  it("surfaces the manage-on-desktop guidance and no runtime controls", () => {
    render(<MobileAgentTeamsSettingsPage />)
    expect(screen.getByTestId("agent-teams-manage-note")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /create|launch|run|new/i })).toBeNull()
  })
})
