/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import enMessages from "@/i18n/messages/en.json"

let mockRecent:
  | Array<{
      adapterId: string
      kind: string
      at: number
      fields?: Record<string, unknown>
    }>
  | undefined = []

jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: jest.fn().mockImplementation(() => mockRecent),
}))

jest.mock("@/lib/db/schema", () => ({ getDb: jest.fn() }))

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

import { OutboundSaturationBanner } from "./outbound-saturation-banner"

function wrap(ui: React.ReactElement) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages as unknown as Record<string, unknown>}>
      {ui}
    </NextIntlClientProvider>
  )
}

function capRow(adapterId: string, jobId: string, ageMs = 60_000, at = Date.now()) {
  return {
    adapterId,
    kind: "outbound.queue_capped",
    at,
    fields: { jobId, ageMs },
  }
}

beforeEach(() => {
  if (typeof window !== "undefined") {
    window.sessionStorage.clear()
  }
  mockRecent = []
})

describe("OutboundSaturationBanner", () => {
  it("renders nothing when no queue_capped rows are present", () => {
    mockRecent = []
    const { container } = wrap(<OutboundSaturationBanner />)
    expect(container.querySelector("[data-testid='outbound-saturation-banner']")).toBeNull()
  })

  it("renders nothing below the 100-row threshold", () => {
    // 50 capped rows for a single adapter — still under threshold.
    mockRecent = Array.from({ length: 50 }, (_, i) => capRow("tg-1", `job-${i}`))
    const { container } = wrap(<OutboundSaturationBanner />)
    expect(container.querySelector("[data-testid='outbound-saturation-banner']")).toBeNull()
  })

  it("surfaces an adapter once it crosses the 100-row threshold", () => {
    mockRecent = Array.from({ length: 120 }, (_, i) => capRow("tg-1", `job-${i}`))
    wrap(<OutboundSaturationBanner />)
    expect(screen.getByTestId("outbound-saturation-banner")).toBeInTheDocument()
    expect(screen.getByTestId("outbound-saturation-row-tg-1")).toBeInTheDocument()
  })

  it("groups multiple adapters, ordered by lastAt desc", () => {
    const now = Date.now()
    mockRecent = [
      // tg-1 — 110 rows, oldest lastAt
      ...Array.from({ length: 110 }, (_, i) => capRow("tg-1", `tg-${i}`, 1000, now - 1_000_000)),
      // dc-1 — 105 rows, newer lastAt
      ...Array.from({ length: 105 }, (_, i) => capRow("dc-1", `dc-${i}`, 1000, now)),
    ]
    wrap(<OutboundSaturationBanner />)
    expect(screen.getByTestId("outbound-saturation-row-tg-1")).toBeInTheDocument()
    expect(screen.getByTestId("outbound-saturation-row-dc-1")).toBeInTheDocument()
  })

  it("dismiss button hides the banner for the current failing set", () => {
    mockRecent = Array.from({ length: 200 }, (_, i) => capRow("tg-1", `job-${i}`))
    wrap(<OutboundSaturationBanner />)
    expect(screen.getByTestId("outbound-saturation-banner")).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("outbound-saturation-dismiss"))
    expect(screen.queryByTestId("outbound-saturation-banner")).not.toBeInTheDocument()
  })

  it("CTA link points at the outbound settings tab", () => {
    mockRecent = Array.from({ length: 150 }, (_, i) => capRow("tg-1", `job-${i}`))
    wrap(<OutboundSaturationBanner />)
    const link = screen.getByTestId("outbound-saturation-view").closest("a")
    expect(link?.getAttribute("href")).toBe("/settings/connections?tab=outbound")
  })
})
