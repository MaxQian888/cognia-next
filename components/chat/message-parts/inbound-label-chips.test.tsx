/** @jest-environment jsdom */
import { render, screen } from "@testing-library/react"
import { TooltipProvider } from "@/components/ui/tooltip"
import { InboundLabelChips } from "./inbound-label-chips"

jest.mock("next-intl", () => ({
  useTranslations: (ns?: string) => {
    const t = (key: string, values?: Record<string, unknown>) =>
      `${ns ? `${ns}.` : ""}${key}${values ? JSON.stringify(values) : ""}`
    t.has = (key: string) => key === "plugin.acme.labels.promo"
    return t
  },
}))

function renderChips(metadata: Record<string, unknown> | undefined) {
  return render(
    <TooltipProvider>
      <InboundLabelChips metadata={metadata} />
    </TooltipProvider>
  )
}

const spam = {
  key: "spam",
  score: 0.97,
  severity: "high",
  label: "Spam",
  source: "cognia-laya-guard",
  at: 1,
}

describe("InboundLabelChips", () => {
  it("renders host-translated known keys with the score", () => {
    renderChips({ inboundLabels: [spam] })
    const chips = screen.getAllByRole("listitem")
    expect(chips).toHaveLength(1)
    expect(chips[0]).toHaveTextContent("inboundLabels.keys.spam · 97%")
  })

  it("uses the plugin label key when loaded, the literal otherwise", () => {
    renderChips({
      inboundLabels: [
        {
          key: "promo",
          score: 0.4,
          severity: "info",
          label: "Promo",
          labelKey: "labels.promo",
          source: "acme",
          at: 1,
        },
        { key: "mood", score: 0.5, severity: "info", label: "Grumpy", source: "other", at: 1 },
      ],
    })
    const chips = screen.getAllByRole("listitem")
    expect(chips[0]).toHaveTextContent("plugin.acme.labels.promo · 40%")
    expect(chips[1]).toHaveTextContent("Grumpy · 50%")
  })

  it("renders nothing without labels, for malformed data, or on a deleted row", () => {
    const { container, rerender } = renderChips(undefined)
    expect(container).toBeEmptyDOMElement()
    rerender(
      <TooltipProvider>
        <InboundLabelChips metadata={{ inboundLabels: [{ key: "x" }] }} />
      </TooltipProvider>
    )
    expect(screen.queryByTestId("inbound-label-chips")).not.toBeInTheDocument()
    rerender(
      <TooltipProvider>
        <InboundLabelChips metadata={{ inboundLabels: [spam], deletedAt: 2 }} />
      </TooltipProvider>
    )
    expect(screen.queryByTestId("inbound-label-chips")).not.toBeInTheDocument()
  })
})
