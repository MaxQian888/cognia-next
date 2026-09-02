/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { TemplateDefinitionShareButton } from "./template-definition-share-button"
import { createTemplateDefinition } from "@/lib/templates/contracts"
import type { TemplateDefinitionEnvelope, TemplateJson } from "@/lib/templates/contracts"

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

async function release(
  over: Partial<TemplateDefinitionEnvelope> = {}
): Promise<TemplateDefinitionEnvelope> {
  return createTemplateDefinition({
    id: "skill.review",
    domain: "skill",
    status: "published",
    revision: 1,
    version: "1.0.0",
    metadata: { name: "Review" },
    payload: { name: "Review", content: "Look at the diff" } as TemplateJson,
    inputs: [],
    dependencies: [],
    capabilities: [],
    compatibility: { platforms: ["desktop"] },
    provenance: { source: "user", trust: "unsigned" },
    ...over,
  }) as Promise<TemplateDefinitionEnvelope>
}

describe("TemplateDefinitionShareButton", () => {
  it("shares a clean published release straight through", async () => {
    const user = userEvent.setup()
    render(<TemplateDefinitionShareButton definition={await release()} />)
    await user.click(screen.getByTestId("template-share-button"))
    const dialog = screen.getByTestId("stub-share-dialog")
    expect(dialog.getAttribute("data-kind")).toBe("template-definition")
    expect(dialog.getAttribute("data-payload")).toContain("Look at the diff")
  })

  it("disables the button and names the reason for a draft", async () => {
    render(
      <TemplateDefinitionShareButton
        definition={await release({ status: "draft", version: null })}
      />
    )
    const button = screen.getByTestId("template-share-button")
    expect(button).toBeDisabled()
    expect(button.getAttribute("data-refusal")).toBe("unpublished")
    expect(screen.getByTestId("template-share-refusal")).toHaveTextContent(
      "templateShare.refusal.unpublished"
    )
  })

  it("names a withdrawn release as its own reason, not as a draft", async () => {
    render(<TemplateDefinitionShareButton definition={await release({ status: "yanked" })} />)
    expect(screen.getByTestId("template-share-button").getAttribute("data-refusal")).toBe(
      "withdrawn"
    )
  })

  it("offers only cancel and share-anyway when PII is detected, never a redaction", async () => {
    const user = userEvent.setup()
    render(
      <TemplateDefinitionShareButton
        definition={await release({
          payload: { name: "Review", content: "ping alice@example.com" } as TemplateJson,
        })}
      />
    )
    await user.click(screen.getByTestId("template-share-button"))
    expect(screen.queryByTestId("stub-share-dialog")).not.toBeInTheDocument()
    expect(screen.getByTestId("template-share-original")).toBeInTheDocument()
    // Redaction would break the content hash, so it is deliberately not offered.
    expect(screen.queryByTestId("template-share-redacted")).not.toBeInTheDocument()

    await user.click(screen.getByTestId("template-share-original"))
    expect(screen.getByTestId("stub-share-dialog").getAttribute("data-payload")).toContain(
      "alice@example.com"
    )
  })

  it("cancels the PII confirm without opening the share dialog", async () => {
    const user = userEvent.setup()
    render(
      <TemplateDefinitionShareButton
        definition={await release({
          payload: { name: "Review", content: "ping alice@example.com" } as TemplateJson,
        })}
      />
    )
    await user.click(screen.getByTestId("template-share-button"))
    await user.click(screen.getByTestId("template-share-cancel"))
    expect(screen.queryByTestId("stub-share-dialog")).not.toBeInTheDocument()
  })
})
