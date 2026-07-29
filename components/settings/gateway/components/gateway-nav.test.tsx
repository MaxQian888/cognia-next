/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen } from "@testing-library/react"

import { GatewayNav } from "./gateway-nav"
import { GATEWAY_NAV_GROUPS } from "../nav-config"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

let reduce = true
jest.mock("@/components/chat/motion/motion-reveal", () => ({
  useFlowMotion: () => ({ reduce, speed: 1 }),
}))

beforeEach(() => {
  reduce = true
})

function renderNav(props: Partial<React.ComponentProps<typeof GatewayNav>> = {}) {
  const onSelect = jest.fn()
  render(
    <GatewayNav groups={GATEWAY_NAV_GROUPS} activeId="overview" onSelect={onSelect} {...props} />
  )
  return { onSelect }
}

describe("GatewayNav", () => {
  it("renders every group header and item", () => {
    renderNav()

    expect(screen.getByTestId("gateway-nav-group-serviceGroup")).toBeInTheDocument()
    expect(screen.getByTestId("gateway-nav-group-routingGroup")).toBeInTheDocument()
    expect(screen.getByTestId("gateway-nav-group-observabilityGroup")).toBeInTheDocument()
    for (const item of GATEWAY_NAV_GROUPS.flatMap((g) => g.items)) {
      expect(screen.getByTestId(`gateway-nav-item-${item.id}`)).toBeInTheDocument()
    }
  })

  it("marks the active item and selects another panel", () => {
    const { onSelect } = renderNav()

    expect(screen.getByTestId("gateway-nav-item-overview")).toHaveAttribute("aria-current", "true")
    fireEvent.click(screen.getByTestId("gateway-nav-item-upstream"))
    expect(onSelect).toHaveBeenCalledWith("upstream")
  })

  it("renders badges only where supplied", () => {
    renderNav({
      badges: {
        upstream: { text: "2", ariaLabel: "2 parked upstream keys" },
        keys: { text: "!", variant: "destructive", ariaLabel: "No usable API key" },
      },
    })

    expect(screen.getByTestId("gateway-nav-badge-upstream")).toHaveTextContent("2")
    expect(screen.getByTestId("gateway-nav-badge-keys")).toHaveTextContent("!")
    expect(screen.queryByTestId("gateway-nav-badge-overview")).not.toBeInTheDocument()
  })

  it("gives every badge a name that says what it means", () => {
    // The keys badge is a bare `!` — a screen reader announced "exclamation
    // mark" and nothing else, so the one state the badge exists to warn about
    // was the one state it could not communicate.
    renderNav({
      badges: {
        upstream: { text: "2", ariaLabel: "2 parked upstream keys" },
        keys: { text: "!", variant: "destructive", ariaLabel: "No usable API key" },
      },
    })

    expect(screen.getByLabelText("No usable API key")).toBeInTheDocument()
    expect(screen.getByLabelText("2 parked upstream keys")).toBeInTheDocument()
  })

  it("paints the active row's own background when motion is reduced", () => {
    // Under `reduce` the shared-layout pill is dropped entirely (only one
    // element may ever carry a layoutId), so the row must supply the highlight
    // itself or the selection becomes invisible.
    reduce = true
    renderNav()

    expect(screen.getByTestId("gateway-nav-item-overview").className).toContain("bg-accent")
  })

  it("defers the highlight to the sliding pill when motion is allowed", () => {
    reduce = false
    renderNav()

    const row = screen.getByTestId("gateway-nav-item-overview")
    expect(row.className).not.toContain("bg-accent ")
    expect(row.className).toContain("text-accent-foreground")
  })
})
