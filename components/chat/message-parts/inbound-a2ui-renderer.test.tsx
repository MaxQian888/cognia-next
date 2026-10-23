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

  it("renders callback buttons inert, with a hint naming the platform", () => {
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
    expect(btn).toHaveAttribute("data-inert", "true")
    expect(btn).toHaveAttribute("title", "This action can only be used in Slack")
  })

  it("keeps a button inert when it carries both a callback and a URL", () => {
    wrap({
      v: 1,
      source: "lark",
      body: [{ kind: "button", label: "Both", actionId: "a", url: "https://x.test" }],
    })
    expect(screen.getByTestId("inbound-a2ui-button-a")).toBeDisabled()
    expect(screen.queryByRole("link", { name: /Both/ })).not.toBeInTheDocument()
  })

  it("opens URL-only buttons as external links", () => {
    wrap({
      v: 1,
      source: "telegram",
      body: [{ kind: "button", label: "Docs", url: "https://x.test/docs" }],
    })
    const link = screen.getByTestId("inbound-a2ui-link-button")
    expect(link.tagName).toBe("A")
    expect(link).toHaveAttribute("href", "https://x.test/docs")
    expect(link).toHaveTextContent("Docs")
  })

  it("does not navigate to non-web URL buttons or links", () => {
    wrap({
      v: 1,
      source: "telegram",
      body: [
        { kind: "button", label: "Script", url: "javascript:alert(1)" },
        { kind: "link", href: "telegram-file:abc", label: "report.pdf" },
      ],
    })
    expect(screen.queryByRole("link")).not.toBeInTheDocument()
    expect(screen.getByText("report.pdf")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /Script/ })).toBeDisabled()
  })

  it("shows a placeholder for platform-only image references", () => {
    wrap({
      v: 1,
      source: "lark",
      body: [{ kind: "image", url: "lark-img:img_v3_x", alt: "chart" }],
    })
    expect(screen.getByTestId("inbound-a2ui-image-unavailable")).toHaveTextContent(
      "chart · Image available in Lark"
    )
    expect(screen.queryByRole("img")).not.toBeInTheDocument()
  })

  it("renders Markdown text nodes formatted and keeps plain text line breaks", () => {
    wrap({
      v: 1,
      source: "slack",
      body: [
        { kind: "text", text: "**Build** passed", format: "markdown" },
        { kind: "text", text: "line one\nline two" },
      ],
    })
    // react-markdown is stubbed under Jest; assert the Markdown pipeline got
    // the text rather than a plain paragraph.
    expect(screen.getByText("**Build** passed").closest(".markdown-renderer")).not.toBeNull()
    expect(screen.getByText(/line one/)).toHaveClass("whitespace-pre-wrap")
    expect(screen.getByText(/line one/).closest(".markdown-renderer")).toBeNull()
  })

  it("shows a title repeated as the first heading only once", () => {
    wrap({
      v: 1,
      source: "lark",
      title: "Deploy",
      body: [{ kind: "heading", level: 2, text: "Deploy" }],
    })
    expect(screen.getAllByText("Deploy")).toHaveLength(1)
  })

  it("contains a render failure to the block", () => {
    const spy = jest.spyOn(console, "error").mockImplementation(() => {})
    wrap({
      v: 1,
      source: "lark",
      body: [{ kind: "list", children: null as never }],
    })
    expect(screen.queryByTestId("inbound-a2ui")).not.toBeInTheDocument()
    spy.mockRestore()
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
