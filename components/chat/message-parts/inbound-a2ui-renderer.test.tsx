/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import enMessages from "@/i18n/messages/en.json"
import type { InboundA2UIBlock } from "@/lib/connectors/adapters/_shared/inbound-a2ui-types"
import { InboundA2UIRenderer } from "./inbound-a2ui-renderer"

function wrap(block: InboundA2UIBlock) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages as unknown as Record<string, unknown>}>
      <InboundA2UIRenderer block={block} />
    </NextIntlClientProvider>
  )
}

describe("InboundA2UIRenderer", () => {
  it("renders the source label", () => {
    wrap({ v: 1, source: "slack", body: [{ kind: "text", text: "x" }] })
    expect(screen.getByText("Slack Block Kit")).toBeInTheDocument()
  })

  it("renders heading and text nodes", () => {
    wrap({
      v: 1,
      source: "discord",
      body: [
        { kind: "heading", level: 2, text: "Title" },
        { kind: "text", text: "Body" },
      ],
    })
    expect(screen.getByRole("heading", { name: "Title" })).toBeInTheDocument()
    expect(screen.getByText("Body")).toBeInTheDocument()
  })

  it("renders buttons with disabled state and actionId data attribute", () => {
    wrap({
      v: 1,
      source: "slack",
      body: [
        {
          kind: "row",
          children: [{ kind: "button", label: "Approve", actionId: "approve" }],
        },
      ],
    })
    const btn = screen.getByTestId("inbound-a2ui-button-approve")
    expect(btn).toBeDisabled()
    expect(btn).toHaveTextContent("Approve")
  })

  it("links render with rel/noopener and target=_blank", () => {
    wrap({
      v: 1,
      source: "discord",
      body: [{ kind: "link", href: "https://example.com", label: "docs" }],
    })
    const link = screen.getByText("docs").closest("a")!
    expect(link).toHaveAttribute("href", "https://example.com")
    expect(link).toHaveAttribute("target", "_blank")
    expect(link.getAttribute("rel")).toMatch(/noopener/)
  })

  it("toggles the raw JSON details on click", () => {
    wrap({
      v: 1,
      source: "lark",
      body: [{ kind: "text", text: "hi" }],
      raw: { hidden: 1 },
    })
    expect(screen.queryByText(/hidden/)).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId("inbound-a2ui-raw-toggle"))
    expect(screen.getByText(/hidden/)).toBeInTheDocument()
  })

  it("renders mention nodes as @badges", () => {
    wrap({
      v: 1,
      source: "onebot",
      body: [{ kind: "mention", handle: "1234", resolved: "Alice" }],
    })
    expect(screen.getByText("@Alice")).toBeInTheDocument()
  })

  it("renders alerts in the correct tonal styling", () => {
    wrap({
      v: 1,
      source: "slack",
      body: [
        {
          kind: "alert",
          tone: "warning",
          children: [{ kind: "text", text: "careful" }],
        },
      ],
    })
    expect(screen.getByText("careful")).toBeInTheDocument()
  })
})
