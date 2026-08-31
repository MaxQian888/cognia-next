/**
 * @jest-environment jsdom
 */

const mockDeveloperMode = jest.fn(() => false)
jest.mock("@/lib/plugin/devtools/developer-mode", () => ({
  useDeveloperMode: () => mockDeveloperMode(),
}))

jest.mock("./library/plugin-library-pane", () => ({
  PluginLibraryPane: () => <div data-testid="pane-library" />,
}))
jest.mock("./discover/plugin-discover-pane", () => ({
  PluginDiscoverPane: () => <div data-testid="pane-discover" />,
}))
jest.mock("./agent-packages/agent-packages-pane", () => ({
  AgentPackagesPane: () => <div data-testid="pane-agent-packages" />,
}))
jest.mock("./governance/plugin-governance-pane", () => ({
  PluginGovernancePane: () => <div data-testid="pane-governance" />,
}))
jest.mock("./devtools/plugin-devtools-pane", () => ({
  PluginDevtoolsPane: () => <div data-testid="pane-devtools" />,
}))
jest.mock("./library/plugin-library-header", () => ({
  PluginLibraryHeader: ({ layout }: { layout?: string }) => (
    <div data-testid="controls-library" data-layout={layout} />
  ),
}))
jest.mock("./governance/plugin-governance-header", () => ({
  PluginGovernanceHeader: ({ layout }: { layout?: string }) => (
    <div data-testid="controls-governance" data-layout={layout} />
  ),
}))
jest.mock("./discover/plugin-discover-header", () => ({
  PluginDiscoverHeader: ({ layout }: { layout?: string }) => (
    <div data-testid="controls-discover" data-layout={layout} />
  ),
}))

import { render, renderHook, screen } from "@testing-library/react"

import {
  PluginSectionControls,
  PluginSectionPane,
  pluginSectionHasControls,
  useVisiblePluginSection,
} from "./plugin-section-pane"

beforeEach(() => {
  mockDeveloperMode.mockReturnValue(false)
})

// The desktop shell and the phone body both render sections from here, so a
// section that renders one thing on one shell and another on the other is the
// defect this file exists to make impossible.
describe("PluginSectionPane", () => {
  it.each([
    ["library", "pane-library"],
    ["discover", "pane-discover"],
    ["agent-packages", "pane-agent-packages"],
    ["governance", "pane-governance"],
    ["devtools", "pane-devtools"],
  ] as const)("renders the %s pane", (section, testId) => {
    render(<PluginSectionPane section={section} />)
    expect(screen.getByTestId(testId)).toBeInTheDocument()
  })
})

describe("PluginSectionControls", () => {
  it("renders the library controls and forwards the layout", () => {
    render(<PluginSectionControls section="library" layout="stacked" />)
    expect(screen.getByTestId("controls-library")).toHaveAttribute("data-layout", "stacked")
  })

  it("renders the governance controls and forwards the layout", () => {
    render(<PluginSectionControls section="governance" layout="stacked" />)
    expect(screen.getByTestId("controls-governance")).toHaveAttribute("data-layout", "stacked")
  })

  // Discover drew its own toolbar inside the center pane until now, which is
  // the migration `plugin-section-toolbar.tsx` was written for and never got.
  it("renders the discover controls and forwards the layout", () => {
    render(<PluginSectionControls section="discover" layout="stacked" />)
    expect(screen.getByTestId("controls-discover")).toHaveAttribute("data-layout", "stacked")
  })

  it.each(["agent-packages", "devtools"] as const)(
    "renders nothing for %s, which carries its own controls",
    (section) => {
      const { container } = render(<PluginSectionControls section={section} />)
      expect(container).toBeEmptyDOMElement()
      expect(pluginSectionHasControls(section)).toBe(false)
    }
  )
})

describe("useVisiblePluginSection", () => {
  // The devtools flag is a Settings toggle, so the section can vanish while
  // the user is standing in it. Every shell has to answer that the same way.
  it("falls back to library when devtools is selected but the flag is off", () => {
    const { result } = renderHook(() => useVisiblePluginSection("devtools"))
    expect(result.current).toBe("library")
  })

  it("keeps devtools once the flag is on", () => {
    mockDeveloperMode.mockReturnValue(true)
    const { result } = renderHook(() => useVisiblePluginSection("devtools"))
    expect(result.current).toBe("devtools")
  })

  it("passes every other section through untouched", () => {
    const { result } = renderHook(() => useVisiblePluginSection("governance"))
    expect(result.current).toBe("governance")
  })
})
