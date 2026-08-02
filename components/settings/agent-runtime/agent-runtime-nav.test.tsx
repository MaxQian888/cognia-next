/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen } from "@testing-library/react"

import { AgentRuntimeNav } from "./agent-runtime-nav"
import { AGENT_RUNTIME_NAV_GROUPS } from "./nav-config"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

let reduce = true
jest.mock("@/components/chat/motion/motion-reveal", () => ({
  useFlowMotion: () => ({ reduce, durationScale: 1 }),
}))

beforeEach(() => {
  reduce = true
})

function renderNav(props: Partial<React.ComponentProps<typeof AgentRuntimeNav>> = {}) {
  const onSelect = jest.fn()
  render(
    <AgentRuntimeNav
      groups={AGENT_RUNTIME_NAV_GROUPS}
      activeId="defaults"
      onSelect={onSelect}
      {...props}
    />
  )
  return { onSelect }
}

describe("AgentRuntimeNav", () => {
  it("renders every group header and item", () => {
    renderNav()

    expect(screen.getByTestId("agent-runtime-nav-group-behaviorGroup")).toBeInTheDocument()
    expect(screen.getByTestId("agent-runtime-nav-group-runtimeGroup")).toBeInTheDocument()
    for (const item of AGENT_RUNTIME_NAV_GROUPS.flatMap((g) => g.items)) {
      expect(screen.getByTestId(`agent-runtime-nav-item-${item.id}`)).toBeInTheDocument()
    }
  })

  it("marks the active item and selects another panel", () => {
    const { onSelect } = renderNav()

    expect(screen.getByTestId("agent-runtime-nav-item-defaults")).toHaveAttribute(
      "aria-current",
      "true"
    )
    fireEvent.click(screen.getByTestId("agent-runtime-nav-item-sidecar"))
    expect(onSelect).toHaveBeenCalledWith("sidecar")
  })

  it("renders a badge only where one is supplied, with a name that says what it means", () => {
    renderNav({
      badges: { sessions: { text: "3", ariaLabel: "3 running sessions" } },
    })

    expect(screen.getByTestId("agent-runtime-nav-badge-sessions")).toHaveTextContent("3")
    expect(screen.getByLabelText("3 running sessions")).toBeInTheDocument()
    expect(screen.queryByTestId("agent-runtime-nav-badge-defaults")).not.toBeInTheDocument()
  })

  it("paints the active row's own background when motion is reduced", () => {
    // Under `reduce` the shared-layout pill is dropped (only one element may
    // carry a layoutId), so the row must supply the highlight itself.
    reduce = true
    renderNav()

    expect(screen.getByTestId("agent-runtime-nav-item-defaults").className).toContain("bg-accent")
  })

  it("defers the highlight to the sliding pill when motion is allowed", () => {
    reduce = false
    renderNav()

    const row = screen.getByTestId("agent-runtime-nav-item-defaults")
    expect(row.className).not.toContain("bg-accent ")
    expect(row.className).toContain("text-accent-foreground")
  })
})
