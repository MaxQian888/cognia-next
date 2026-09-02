/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { ChatTemplateShareButton } from "./chat-template-share-button"
import type { ShareableChatTemplate } from "@/lib/share/chat-template"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

jest.mock("@/components/share/share-link-dialog", () => ({
  ShareLinkDialog: ({
    open,
    buildPayload,
  }: {
    open: boolean
    buildPayload: () => { data: string; kind: string }
  }) =>
    open ? (
      <div
        data-testid="stub-share-dialog"
        data-kind={buildPayload().kind}
        data-payload={buildPayload().data}
      />
    ) : null,
}))

function template(over: Partial<ShareableChatTemplate> = {}): ShareableChatTemplate {
  return {
    name: "Bug report",
    body: "Report {{area}}",
    params: [{ id: "area", label: "Area", required: true, kind: "string" }],
    ...over,
  }
}

describe("ChatTemplateShareButton", () => {
  it("shares a clean template straight through", async () => {
    const user = userEvent.setup()
    render(<ChatTemplateShareButton template={template()} />)
    await user.click(screen.getByTestId("chat-template-share-button"))
    const dialog = screen.getByTestId("stub-share-dialog")
    expect(dialog.getAttribute("data-kind")).toBe("chat-template")
    expect(dialog.getAttribute("data-payload")).toContain("Report {{area}}")
  })

  it("demotes the launch spec before the payload is even previewed", async () => {
    const user = userEvent.setup()
    render(
      <ChatTemplateShareButton
        template={template({
          launchSpec: {
            model: "opus",
            permissionMode: "bypassPermissions",
            allowedTools: ["Bash"],
          },
        })}
      />
    )
    await user.click(screen.getByTestId("chat-template-share-button"))
    const payload = screen.getByTestId("stub-share-dialog").getAttribute("data-payload") ?? ""
    expect(payload).toContain("opus")
    expect(payload).not.toContain("bypassPermissions")
    expect(payload).not.toContain("Bash")
  })

  it("offers the full three-answer PII gate and can redact", async () => {
    const user = userEvent.setup()
    render(<ChatTemplateShareButton template={template({ body: "mail alice@example.com" })} />)
    await user.click(screen.getByTestId("chat-template-share-button"))
    expect(screen.queryByTestId("stub-share-dialog")).not.toBeInTheDocument()

    await user.click(screen.getByTestId("chat-template-share-redacted"))
    const payload = screen.getByTestId("stub-share-dialog").getAttribute("data-payload") ?? ""
    expect(payload).not.toContain("alice@example.com")
    expect(payload).toContain("<EMAIL_001>")
  })

  it("can share the original when the user overrides the warning", async () => {
    const user = userEvent.setup()
    render(<ChatTemplateShareButton template={template({ body: "mail alice@example.com" })} />)
    await user.click(screen.getByTestId("chat-template-share-button"))
    await user.click(screen.getByTestId("chat-template-share-original"))
    expect(screen.getByTestId("stub-share-dialog").getAttribute("data-payload")).toContain(
      "alice@example.com"
    )
  })

  it("cancels without opening the share dialog", async () => {
    const user = userEvent.setup()
    render(<ChatTemplateShareButton template={template({ body: "mail alice@example.com" })} />)
    await user.click(screen.getByTestId("chat-template-share-button"))
    await user.click(screen.getByTestId("chat-template-share-cancel"))
    expect(screen.queryByTestId("stub-share-dialog")).not.toBeInTheDocument()
  })
})
