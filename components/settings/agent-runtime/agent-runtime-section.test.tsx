/**
 * @jest-environment jsdom
 */
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

// The nav's selection pill uses shared-layout motion; pin it to the reduced
// branch so the rows render without a layout animation in jsdom.
jest.mock("@/components/chat/motion/motion-reveal", () => ({
  useFlowMotion: () => ({ reduce: true, durationScale: 1 }),
}))

// Stub each panel body so the section tests stay focused on routing.
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

  it("defaults to the Defaults panel when no query param is set", () => {
    render(<AgentRuntimeSection />)
    expect(screen.getByTestId("defaults-tab")).toBeInTheDocument()
  })

  it("splits the section into a nav rail and a detail pane, with no cards", () => {
    const { container } = render(<AgentRuntimeSection />)
    expect(screen.getByTestId("agent-runtime-section")).toBeInTheDocument()
    expect(screen.getByTestId("agent-runtime-panel-body")).toBeInTheDocument()
    expect(container.querySelector("[data-slot='card']")).toBeNull()
  })

  it("lists all five panels as nav rows, not tabs", () => {
    render(<AgentRuntimeSection />)
    // Deliberately `role=list`, not `role=tablist` — this drives a detail pane.
    expect(screen.queryAllByRole("tab")).toHaveLength(0)
    for (const id of ["defaults", "permissions", "sessions", "sidecar", "a2ui"]) {
      expect(screen.getByTestId(`agent-runtime-nav-item-${id}`)).toBeInTheDocument()
    }
  })

  it("groups the rows under the behavior and runtime headings", () => {
    render(<AgentRuntimeSection />)
    expect(screen.getByTestId("agent-runtime-nav-group-behaviorGroup")).toBeInTheDocument()
    expect(screen.getByTestId("agent-runtime-nav-group-runtimeGroup")).toBeInTheDocument()
  })

  it("selecting a panel pushes ?agentRuntimeTab= via router.replace", async () => {
    const user = userEvent.setup()
    render(<AgentRuntimeSection />)
    await user.click(screen.getByTestId("agent-runtime-nav-item-permissions"))
    expect(replace).toHaveBeenCalledWith(
      expect.stringContaining("agentRuntimeTab=permissions"),
      expect.objectContaining({ scroll: false })
    )
  })

  it("loads the right panel when ?agentRuntimeTab= is set", () => {
    paramsRef.current = new URLSearchParams("agentRuntimeTab=sidecar")
    render(<AgentRuntimeSection />)
    expect(screen.getByTestId("sidecar-tab")).toBeInTheDocument()
  })

  it("renders every panel body from its own deep link", () => {
    for (const [param, testid] of [
      ["agentRuntimeTab=permissions", "permissions-tab"],
      ["agentRuntimeTab=sessions", "sessions-tab"],
      ["agentRuntimeTab=a2ui", "a2ui-tab"],
    ] as const) {
      paramsRef.current = new URLSearchParams(param)
      const { unmount } = render(<AgentRuntimeSection />)
      expect(screen.getByTestId(testid)).toBeInTheDocument()
      unmount()
    }
  })

  it("falls back to defaults when the param value is not a known panel", () => {
    paramsRef.current = new URLSearchParams("agentRuntimeTab=bogus")
    render(<AgentRuntimeSection />)
    expect(screen.getByTestId("defaults-tab")).toBeInTheDocument()
  })

  it("offers the same nav through a sheet on narrow viewports", async () => {
    const user = userEvent.setup()
    render(<AgentRuntimeSection />)
    await user.click(screen.getByTestId("agent-runtime-mobile-nav-trigger"))

    // The desktop rail is only `display:none` below md, so both copies are
    // mounted — under their OWN prefixes, so each owns its shared-layout pill
    // instead of Motion arbitrating between two elements with one layoutId
    // (which lit the pill on a second, unselected row).
    expect(screen.getByTestId("agent-runtime-nav-item-sessions")).toBeInTheDocument()
    const sheetRow = screen.getByTestId("agent-runtime-sheet-nav-item-sessions")

    await user.click(sheetRow)
    expect(replace).toHaveBeenCalledWith(
      expect.stringContaining("agentRuntimeTab=sessions"),
      expect.objectContaining({ scroll: false })
    )
  })
})
