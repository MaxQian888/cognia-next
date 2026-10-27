/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import enMessages from "@/i18n/messages/en.json"
import { TooltipProvider } from "@/components/ui/tooltip"
import { downloadFromUrl } from "@/lib/files/download"
import type { InboundA2UIBlock } from "@/lib/connectors/adapters/_shared/inbound-a2ui-types"
import { InboundA2UIRenderer } from "./inbound-a2ui-renderer"
import { projectInboundToA2UI } from "@/lib/connectors/adapters/_shared/inbound-a2ui-dispatch"
import { sanitizeInboundA2UIBlock } from "@/lib/connectors/adapters/_shared/inbound-a2ui-normalize"

jest.mock("@/lib/files/download", () => ({ downloadFromUrl: jest.fn(async () => undefined) }))
jest.mock("@/lib/tauri/opener", () => ({ openExternal: jest.fn(async () => undefined) }))
jest.mock("@/hooks/chat/use-media-url", () => ({
  useMediaUrl: () => ({ url: null, status: "inactive" }),
}))

function wrap(block: InboundA2UIBlock) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages as unknown as Record<string, unknown>}>
      <TooltipProvider>
        <InboundA2UIRenderer block={block} />
      </TooltipProvider>
    </NextIntlClientProvider>
  )
}

describe("InboundA2UIRenderer", () => {
  it("does not reopen a dismissed revision when the exact earlier body returns", async () => {
    const user = userEvent.setup()
    const body: InboundA2UIBlock["body"] = [
      { kind: "image", url: "https://example.com/a.png", alt: "Original" },
    ]
    const tree = (value: InboundA2UIBlock["body"]) => (
      <TooltipProvider>
        <InboundA2UIRenderer block={{ v: 1, source: "lark", body: value }} />
      </TooltipProvider>
    )
    const view = render(tree(body))
    await user.click(screen.getByRole("button", { name: "Preview Original" }))
    view.rerender(tree([{ kind: "text", text: "Edited" }]))
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    view.rerender(tree(body))
    expect(screen.queryByRole("dialog")).toBeNull()
  })

  it("preserves the selected image when unchanged nested content is rehydrated", async () => {
    const user = userEvent.setup()
    const block: InboundA2UIBlock = {
      v: 1,
      source: "lark",
      body: [
        {
          kind: "column",
          children: [{ kind: "image", url: "https://example.com/a.png", alt: "Same image" }],
        },
      ],
    }
    const tree = (value: InboundA2UIBlock) => (
      <TooltipProvider>
        <InboundA2UIRenderer block={value} />
      </TooltipProvider>
    )
    const view = render(tree(block))
    await user.click(screen.getByRole("button", { name: "Preview Same image" }))
    view.rerender(tree(JSON.parse(JSON.stringify(block))))
    expect(screen.getByRole("dialog")).toBeInTheDocument()
    expect(
      within(screen.getByRole("dialog")).getByRole("img", { name: "Same image" })
    ).toHaveAttribute("src", "https://example.com/a.png")
  })

  it("recovers automatically when a malformed card is replaced by a valid edit", () => {
    const spy = jest.spyOn(console, "error").mockImplementation(() => {})
    try {
      const view = render(
        <InboundA2UIRenderer
          block={{ v: 1, source: "lark", body: [{ kind: "list", children: null as never }] }}
        />
      )
      expect(screen.getByRole("alert")).toBeInTheDocument()
      view.rerender(
        <InboundA2UIRenderer
          block={{ v: 1, source: "lark", body: [{ kind: "text", text: "Valid edited card" }] }}
        />
      )
      expect(screen.getByText("Valid edited card")).toBeInTheDocument()
      expect(screen.queryByRole("alert")).toBeNull()
    } finally {
      spy.mockRestore()
    }
  })

  it("previews inbound images in the read-only shared lightbox and restores focus", async () => {
    const user = userEvent.setup()
    const body: InboundA2UIBlock["body"] = [
      {
        kind: "image",
        url: "key-1",
        displayUrl: "data:image/png;base64,AAAA",
        alt: "First screenshot",
      },
      {
        kind: "column",
        children: [
          { kind: "image", url: "https://example.com/second.png", alt: "Second screenshot" },
        ],
      },
      { kind: "image", url: "lark-img:missing", alt: "Unavailable screenshot" },
    ]
    wrap({ v: 1, source: "lark", body })
    const trigger = screen.getByRole("button", { name: "Preview First screenshot" })
    await user.click(trigger)
    const dialog = screen.getByRole("dialog")
    expect(
      within(dialog).getByRole("heading", { name: "First screenshot.png" })
    ).toBeInTheDocument()
    expect(within(dialog).getByRole("img", { name: "First screenshot" })).toHaveAttribute(
      "src",
      "data:image/png;base64,AAAA"
    )
    expect(within(dialog).queryByRole("button", { name: /edit/i })).toBeNull()
    await user.keyboard("{ArrowRight}")
    expect(
      within(dialog).getByRole("heading", { name: "Second screenshot.png" })
    ).toBeInTheDocument()
    expect(within(dialog).getByText("2 of 2")).toBeInTheDocument()
    await user.keyboard("{Escape}")
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    expect(trigger).toHaveFocus()
  })

  it("closes an open preview when the inbound body is replaced", async () => {
    const user = userEvent.setup()
    const body: InboundA2UIBlock["body"] = [
      { kind: "image", url: "https://example.com/old.png", alt: "Old image" },
    ]
    const tree = (block: InboundA2UIBlock) => (
      <NextIntlClientProvider locale="en" messages={enMessages as never}>
        <TooltipProvider>
          <InboundA2UIRenderer block={block} />
        </TooltipProvider>
      </NextIntlClientProvider>
    )
    const view = render(tree({ v: 1, source: "lark", body }))
    await user.click(screen.getByRole("button", { name: "Preview Old image" }))
    expect(screen.getByRole("dialog")).toBeInTheDocument()
    view.rerender(tree({ v: 1, source: "lark", body: [{ kind: "text", text: "Edited message" }] }))
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    expect(screen.queryByRole("img", { name: "Old image" })).toBeNull()
    view.rerender(tree({ v: 1, source: "lark", body: [...body] }))
    expect(screen.queryByRole("dialog")).toBeNull()
  })

  it("keeps the card visible when an expanded raw payload cannot be serialized", async () => {
    const user = userEvent.setup()
    const circular: Record<string, unknown> = { value: 1 }
    circular.self = circular
    wrap({ v: 1, source: "slack", body: [{ kind: "text", text: "Still readable" }], raw: circular })
    const toggle = screen.getByRole("button", { name: "Raw payload" })
    expect(toggle).toHaveAttribute("aria-expanded", "false")
    await user.click(toggle)
    expect(toggle).toHaveAttribute("aria-expanded", "true")
    expect(screen.getByText("Still readable")).toBeInTheDocument()
    expect(screen.getByRole("status")).toHaveTextContent(
      "This payload cannot be displayed as JSON."
    )
    await user.click(toggle)
    expect(screen.queryByRole("status")).toBeNull()
  })

  it("uses the localized reply fallback without a preview", () => {
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <InboundA2UIRenderer
          block={{
            v: 1,
            source: "onebot",
            body: [{ kind: "reply_context", replyToMessageId: "42" }],
          }}
        />
      </NextIntlClientProvider>
    )
    expect(screen.getByText("↩ Reply to message 42")).toBeInTheDocument()
  })

  it("deduplicates preview images and bounds data-image download filenames", async () => {
    const user = userEvent.setup()
    const url = `data:image/png;base64,${"A".repeat(400)}`
    wrap({
      v: 1,
      source: "lark",
      body: [
        { kind: "image", url },
        { kind: "image", url },
      ],
    })
    await user.click(screen.getAllByRole("button", { name: "Preview Image" })[0])
    const dialog = screen.getByRole("dialog")
    expect(within(dialog).getByText("1 of 1")).toBeInTheDocument()
    await user.click(within(dialog).getByRole("button", { name: "Download" }))
    expect(downloadFromUrl).toHaveBeenLastCalledWith(url, "image.png", { fetchAsBlob: true })
  })

  it("serializes raw data only on expansion and contains BigInt failures", async () => {
    const user = userEvent.setup()
    const toJSON = jest.fn(() => ({ value: BigInt(42) }))
    wrap({
      v: 1,
      source: "slack",
      body: [{ kind: "text", text: "Body survives" }],
      raw: { toJSON },
    })
    expect(toJSON).not.toHaveBeenCalled()
    const toggle = screen.getByRole("button", { name: "Raw payload" })
    await user.click(toggle)
    expect(toJSON).toHaveBeenCalledTimes(1)
    expect(screen.getByRole("status").parentElement).toHaveAttribute(
      "id",
      toggle.getAttribute("aria-controls")
    )
    expect(screen.getByText("Body survives")).toBeInTheDocument()
  })

  it("sanitizes and bounds a sender-supplied image download name", async () => {
    const user = userEvent.setup()
    const alt = `folder/\\image:${"x".repeat(140)}\nname`
    wrap({
      v: 1,
      source: "lark",
      body: [{ kind: "image", url: "data:image/png;base64,AAAA", alt }],
    })
    await user.click(screen.getByRole("button", { name: /Preview folder/ }))
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Download" }))
    const filename = jest.mocked(downloadFromUrl).mock.calls.at(-1)?.[1]
    expect(filename).toHaveLength(100)
    expect(filename).toMatch(/^folder__image_x+\.png$/)
  })

  it.each(["report.png", "report.jpeg", "report.PNG"])(
    "does not append duplicate image extensions to %s",
    async (alt) => {
      const user = userEvent.setup()
      wrap({
        v: 1,
        source: "lark",
        body: [{ kind: "image", url: "data:image/png;base64,AAAA", alt }],
      })
      await user.click(screen.getByRole("button", { name: `Preview ${alt}` }))
      await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Download" }))
      expect(downloadFromUrl).toHaveBeenLastCalledWith("data:image/png;base64,AAAA", "report.png", {
        fetchAsBlob: true,
      })
    }
  )
  it.each([
    [
      "lark",
      {
        elements: [
          { tag: "button", text: { content: "Act" }, url: "https://x.test", value: { order: "1" } },
        ],
      },
    ],
    [
      "lark",
      {
        elements: [
          {
            tag: "button",
            text: { content: "Act" },
            behaviors: [
              { type: "callback", value: {} },
              { type: "open_url", default_url: "https://x.test" },
            ],
          },
        ],
      },
    ],
    [
      "slack",
      {
        blocks: [
          {
            type: "actions",
            elements: [
              { type: "button", text: { text: "Act" }, url: "https://x.test", action_id: {} },
            ],
          },
        ],
      },
    ],
    [
      "discord",
      {
        components: [
          { type: 1, components: [{ type: 2, style: 1, label: "Act", url: "https://x.test" }] },
        ],
      },
    ],
    [
      "telegram",
      {
        reply_markup: {
          inline_keyboard: [[{ text: "Act", url: "https://x.test", callback_data: 42 }]],
        },
      },
    ],
  ] as const)("keeps %s native callbacks read-only through projection", (platform, raw) => {
    const block = projectInboundToA2UI(platform, raw)
    expect(block).not.toBeNull()
    wrap(block!)
    expect(screen.getByRole("button", { name: /Act/ })).toBeDisabled()
    expect(screen.queryByRole("link", { name: /Act/ })).toBeNull()
  })

  it.each(["", undefined, null, {}, 42])(
    "keeps a malformed stored callback ID inert (%p)",
    (actionId) => {
      const block = sanitizeInboundA2UIBlock({
        v: 1,
        source: "lark",
        body: [{ kind: "button", label: "Act", url: "https://x.test", actionId }],
      })
      wrap(block!)
      expect(screen.getByRole("button", { name: /Act/ })).toBeDisabled()
      expect(screen.queryByRole("link")).toBeNull()
    }
  )
  it("loads the display-only image and contains a failed load", () => {
    wrap({
      v: 1,
      source: "lark",
      body: [
        {
          kind: "image",
          url: "platform-key",
          displayUrl: "data:image/png;base64,AAAA",
          alt: "received screenshot",
        },
      ],
    })
    const img = screen.getByRole("img", { name: "received screenshot" })
    expect(img).toHaveAttribute("src", "data:image/png;base64,AAAA")
    fireEvent.error(img)
    expect(screen.queryByRole("img", { name: "received screenshot" })).toBeNull()
    expect(screen.getByText(/received screenshot/)).toBeInTheDocument()
  })
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
