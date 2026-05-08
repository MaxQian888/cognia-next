import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { AgentRuntimeSection } from "./agent-runtime-section"

const replace = jest.fn()
const paramsRef = { current: new URLSearchParams() }

jest.mock("next/navigation", () => ({
  useRouter: () => ({ replace: (...args: unknown[]) => replace(...args) }),
  useSearchParams: () => paramsRef.current,
}))

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

// Stub each tab body so the section tests stay focused on routing.
jest.mock("./tabs/defaults-tab", () => ({
  DefaultsTab: () => <div data-testid="defaults-tab" />,
}))
jest.mock("./tabs/permissions-tools-tab", () => ({
  PermissionsToolsTab: () => <div data-testid="permissions-tab" />,
}))
jest.mock("./tabs/sidecar-tab", () => ({
  SidecarTab: () => <div data-testid="sidecar-tab" />,
}))
jest.mock("./tabs/a2ui-bridge-tab", () => ({
  A2UIBridgeTab: () => <div data-testid="a2ui-tab" />,
}))
jest.mock("./tabs/sessions-tab", () => ({
  SessionsTab: () => <div data-testid="sessions-tab" />,
}))
jest.mock("@/components/settings/common/related-sections-strip", () => ({
  RelatedSectionsStrip: () => <div data-testid="related-strip-stub" />,
  CLAUDE_CODE_RELATED: [],
}))

describe("AgentRuntimeSection", () => {
  beforeEach(() => {
    replace.mockClear()
    paramsRef.current = new URLSearchParams()
  })

  it("defaults to the Defaults tab when no query param is set", () => {
    render(<AgentRuntimeSection />)
    expect(screen.getByTestId("defaults-tab")).toBeInTheDocument()
  })

  it("renders 5 trigger buttons with translated labels", () => {
    render(<AgentRuntimeSection />)
    expect(screen.getAllByRole("tab")).toHaveLength(5)
    expect(screen.getByRole("tab", { name: "tabs.defaults" })).toBeInTheDocument()
    expect(screen.getByRole("tab", { name: "tabs.permissions" })).toBeInTheDocument()
    expect(screen.getByRole("tab", { name: "tabs.sessions" })).toBeInTheDocument()
    expect(screen.getByRole("tab", { name: "tabs.sidecar" })).toBeInTheDocument()
    expect(screen.getByRole("tab", { name: "tabs.a2ui" })).toBeInTheDocument()
  })

  it("clicking a tab pushes ?agentRuntimeTab= via router.replace", async () => {
    const user = userEvent.setup()
    render(<AgentRuntimeSection />)
    await user.click(screen.getByRole("tab", { name: "tabs.permissions" }))
    expect(replace).toHaveBeenCalledWith(
      expect.stringContaining("agentRuntimeTab=permissions"),
      expect.objectContaining({ scroll: false })
    )
  })

  it("loads the right tab when ?agentRuntimeTab= is set", () => {
    paramsRef.current = new URLSearchParams("agentRuntimeTab=sidecar")
    render(<AgentRuntimeSection />)
    expect(screen.getByTestId("sidecar-tab")).toBeInTheDocument()
  })

  it("falls back to defaults when the param value is not a known tab", () => {
    paramsRef.current = new URLSearchParams("agentRuntimeTab=bogus")
    render(<AgentRuntimeSection />)
    expect(screen.getByTestId("defaults-tab")).toBeInTheDocument()
  })
})
