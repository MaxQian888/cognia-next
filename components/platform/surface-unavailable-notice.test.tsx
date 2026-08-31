/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"

import enMessages from "@/i18n/messages/en/surfaceReach.json"
import zhMessages from "@/i18n/messages/zh-CN/surfaceReach.json"
import { SurfaceUnavailableNotice } from "./surface-unavailable-notice"
import { SURFACE_BLOCKS } from "@/lib/platform/surface-reach"

jest.mock("next-intl", () => ({
  useTranslations: (ns: string) => (key: string) => `${ns}.${key}`,
}))

describe("<SurfaceUnavailableNotice />", () => {
  it("renders nothing when the surface can run", () => {
    const { container } = render(<SurfaceUnavailableNotice reach={{ available: true }} />)
    expect(container).toBeEmptyDOMElement()
  })

  it("names the cause so tests and styling can key off it", () => {
    render(
      <SurfaceUnavailableNotice reach={{ available: false, block: "no-host", remedy: "/pair" }} />
    )
    const notice = screen.getByTestId("surface-unavailable-notice")
    expect(notice).toHaveAttribute("data-cause", "no-host")
    expect(notice).toHaveTextContent("surfaceReach.block.no-host")
    expect(notice).toHaveTextContent("surfaceReach.nextStep.no-host")
  })

  it("omits the next step for a cause that has none", () => {
    // A build that cannot do the thing on this machine has nowhere to send
    // the user, and a padded read-out would make a terminal cause look
    // actionable.
    render(
      <SurfaceUnavailableNotice reach={{ available: false, block: "local-lacks-capability" }} />
    )
    const notice = screen.getByTestId("surface-unavailable-notice")
    expect(notice).toHaveTextContent("surfaceReach.block.local-lacks-capability")
    expect(notice).not.toHaveTextContent("surfaceReach.nextStep")
  })

  it("renders the action slot after the text", () => {
    render(
      <SurfaceUnavailableNotice
        reach={{ available: false, block: "no-host" }}
        action={<button data-testid="pair-action">pair</button>}
      />
    )
    expect(screen.getByTestId("pair-action")).toBeInTheDocument()
  })
})

describe("surfaceReach message catalogue", () => {
  // `pnpm lint:i18n` cannot see a dynamic key like `t(`block.${block}`)`, so a
  // block added to the vocabulary without copy would ship as a raw key on
  // screen. Pin the coverage here instead.
  it("has a `block` string in both locales for every declared block", () => {
    for (const block of SURFACE_BLOCKS) {
      expect(typeof (enMessages.block as Record<string, string>)[block]).toBe("string")
      expect(typeof (zhMessages.block as Record<string, string>)[block]).toBe("string")
    }
  })

  it("keeps the two locales at exact key parity", () => {
    expect(Object.keys(enMessages.block).sort()).toEqual(Object.keys(zhMessages.block).sort())
    expect(Object.keys(enMessages.nextStep).sort()).toEqual(Object.keys(zhMessages.nextStep).sort())
  })

  it("declares a next step for every block except the terminal one", () => {
    // Encodes the rule the component implements, so the two cannot drift: a
    // block gains copy here and a next step there, or neither.
    expect(Object.keys(enMessages.nextStep).sort()).toEqual(
      SURFACE_BLOCKS.filter((block) => block !== "local-lacks-capability")
        .slice()
        .sort()
    )
  })
})
