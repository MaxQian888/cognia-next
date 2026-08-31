/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import enMessages from "@/i18n/messages/en.json"

jest.mock("next/link", () => {
  const Link = ({
    href,
    children,
    ...rest
  }: {
    href: string
    children: React.ReactNode
  } & Record<string, unknown>) => (
    <a href={href} {...rest}>
      {children}
    </a>
  )
  Link.displayName = "MockNextLink"
  return { __esModule: true, default: Link }
})

import { OutboundSaturationNotice } from "./outbound-saturation-banner"
import type { SaturatedAdapter } from "@/hooks/connectors/use-outbound-saturation"

// The audit query, the 100-row threshold and the per-set dismiss live in
// `useOutboundSaturation` and are pinned by its own suite. This component is a
// pure presenter, so every case here is driven by props.
function wrap(adapters: SaturatedAdapter[], onDismiss = jest.fn()) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages as unknown as Record<string, unknown>}>
      <OutboundSaturationNotice adapters={adapters} onDismiss={onDismiss} />
    </NextIntlClientProvider>
  )
}

function saturated(adapterId: string, cappedCount = 120, lastAt = 1_700_000_000_000) {
  return { adapterId, cappedCount, lastAt } satisfies SaturatedAdapter
}

describe("OutboundSaturationNotice", () => {
  it("renders nothing when no adapter is saturated", () => {
    const { container } = wrap([])
    expect(container.querySelector("[data-testid='outbound-saturation-banner']")).toBeNull()
  })

  it("surfaces a saturated adapter with its capped count", () => {
    wrap([saturated("tg-1", 120)])
    expect(screen.getByTestId("outbound-saturation-banner")).toBeInTheDocument()
    expect(screen.getByTestId("outbound-saturation-row-tg-1")).toHaveTextContent("120")
  })

  it("renders one row per adapter in the order given", () => {
    wrap([saturated("dc-1", 105), saturated("tg-1", 110)])
    const rows = screen.getAllByTestId(/^outbound-saturation-row-/)
    expect(rows.map((r) => r.getAttribute("data-testid"))).toEqual([
      "outbound-saturation-row-dc-1",
      "outbound-saturation-row-tg-1",
    ])
  })

  it("hands the dismiss control straight to the caller", () => {
    const onDismiss = jest.fn()
    wrap([saturated("tg-1")], onDismiss)
    fireEvent.click(screen.getByTestId("outbound-saturation-dismiss"))
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it("CTA link points at the outbound settings tab", () => {
    wrap([saturated("tg-1")])
    const link = screen.getByTestId("outbound-saturation-view").closest("a")
    // Was `/settings/connections?tab=outbound`: a route that does not exist
    // under `output: "export"`, carrying a param name nothing reads.
    expect(link?.getAttribute("href")).toBe("/settings?section=connections&connectionsTab=outbound")
  })
})
