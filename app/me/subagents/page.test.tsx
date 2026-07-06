/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"

import MobileSubagentsPage from "./page"
import { useCompanionConfig } from "@/hooks/companion/use-companion-config"
import { useSubagentRuntimeStore } from "@/stores/agent/subagent-runtime-store"

jest.mock("@/hooks/companion/use-companion-config")
jest.mock("@/stores/agent/subagent-runtime-store", () => ({
  useSubagentRuntimeStore: jest.fn(),
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
  (useSubagentRuntimeStore as unknown as jest.Mock).mockImplementation(
    (selector: (s: { templates: unknown }) => unknown) => selector({ templates })
  )

beforeEach(() => {
  jest.clearAllMocks()
  mockPaired(true)
  mockTemplates({
    "web-research": {
      id: "web-research",
      name: "Web Research",
      description: "Search and analyze web content",
      category: "research",
      taskTemplate: "",
      config: { model: "claude-haiku" },
      isBuiltIn: true,
    },
    "my-fork": {
      id: "my-fork",
      name: "My Fork",
      description: "",
      category: "coding",
      taskTemplate: "",
      config: {},
      isBuiltIn: false,
    },
  })
})

describe("MobileSubagentsPage", () => {
  it("shows the paired placeholder when unpaired", () => {
    mockPaired(false)
    render(<MobileSubagentsPage />)
    expect(screen.getByTestId("paired-only-placeholder")).toBeInTheDocument()
    expect(screen.queryByTestId("subagent-row-web-research")).toBeNull()
  })

  it("lists available subagent templates when paired", () => {
    render(<MobileSubagentsPage />)
    expect(screen.getByTestId("mobile-subagents-page")).toBeInTheDocument()
    expect(screen.getByTestId("subagent-row-web-research")).toBeInTheDocument()
    expect(screen.getByTestId("subagent-row-my-fork")).toBeInTheDocument()
    // Built-in badge + model badge render for the built-in template.
    expect(screen.getByText("claude-haiku")).toBeInTheDocument()
  })

  it("renders the empty state when there are no templates", () => {
    mockTemplates({})
    render(<MobileSubagentsPage />)
    expect(screen.getByTestId("me-section-subagents")).toBeInTheDocument()
    expect(screen.queryByTestId("subagent-row-web-research")).toBeNull()
  })
})
