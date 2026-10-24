/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"

import type { PendingOutboundTarget } from "@cognia/agent-config-types"

import { OutboundRecipients } from "./outbound-recipients"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

const chat: PendingOutboundTarget = {
  kind: "conversation",
  channel: "bot-a",
  recipient: "conv:lark:bot-a:oc_1",
}
const person: PendingOutboundTarget = {
  kind: "person",
  channel: "bot-a",
  recipient: "person:bot-a:ou_7",
}
const mail: PendingOutboundTarget = { kind: "mail", channel: "mail", recipient: "mail:a@b.co" }
const site: PendingOutboundTarget = {
  kind: "public",
  channel: "tool:deploy_site",
  recipient: "public:deploy_site",
}
const unnamed: PendingOutboundTarget = { kind: "unknown", channel: "tool:x", recipient: "*" }

describe("<OutboundRecipients />", () => {
  it("names every recipient by kind, id and bot", () => {
    render(<OutboundRecipients targets={[chat, person, mail, site, unnamed]} />)
    expect(screen.getByText("recipientsLabel")).toBeInTheDocument()
    expect(screen.getAllByTestId("outbound-recipient").map((li) => li.textContent)).toEqual([
      'recipientConversation:{"id":"oc_1","channel":"bot-a"}',
      'recipientPerson:{"id":"ou_7","channel":"bot-a"}',
      'recipientMail:{"address":"a@b.co"}',
      'recipientPublic:{"tool":"deploy_site"}',
      "recipientUnknown",
    ])
  })

  it("says a deny fences the recipients only when asked to", () => {
    const { rerender } = render(<OutboundRecipients targets={[chat]} />)
    expect(screen.queryByTestId("outbound-deny-fences")).not.toBeInTheDocument()
    rerender(<OutboundRecipients targets={[chat]} fenceNotice />)
    expect(screen.getByTestId("outbound-deny-fences")).toHaveTextContent("denyFencesNotice")
  })
})
