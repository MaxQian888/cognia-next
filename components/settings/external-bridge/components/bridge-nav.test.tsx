/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen } from "@testing-library/react"

import { BridgeNav } from "./bridge-nav"
import { BRIDGE_NAV_GROUPS } from "../nav-config"

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

describe("BridgeNav", () => {
  it("renders every group and item", () => {
    render(<BridgeNav groups={BRIDGE_NAV_GROUPS} activeId="server" onSelect={jest.fn()} />)

    expect(screen.getByTestId("bridge-nav-group-serviceGroup")).toBeInTheDocument()
    for (const item of BRIDGE_NAV_GROUPS.flatMap((g) => g.items)) {
      expect(screen.getByTestId(`bridge-nav-item-${item.id}`)).toBeInTheDocument()
    }
  })

  it("marks the active item and selects another panel", () => {
    const onSelect = jest.fn()
    render(<BridgeNav groups={BRIDGE_NAV_GROUPS} activeId="server" onSelect={onSelect} />)

    expect(screen.getByTestId("bridge-nav-item-server")).toHaveAttribute("aria-current", "true")
    fireEvent.click(screen.getByTestId("bridge-nav-item-audit"))
    expect(onSelect).toHaveBeenCalledWith("audit")
  })

  it("renders a supplied badge", () => {
    render(
      <BridgeNav
        groups={BRIDGE_NAV_GROUPS}
        activeId="server"
        onSelect={jest.fn()}
        badges={{ scopes: { text: "2/19", ariaLabel: "2 of 19 permission scopes granted" } }}
      />
    )

    expect(screen.getByTestId("bridge-nav-badge-scopes")).toHaveTextContent("2/19")
  })

  it("paints the active row's own background when motion is reduced", () => {
    reduce = true
    render(<BridgeNav groups={BRIDGE_NAV_GROUPS} activeId="server" onSelect={jest.fn()} />)

    expect(screen.getByTestId("bridge-nav-item-server").className).toContain("bg-accent")
  })
})
