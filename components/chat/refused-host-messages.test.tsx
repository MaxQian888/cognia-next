import { render, screen } from "@testing-library/react"
import { RefusedHostMessages } from "./refused-host-messages"
import type { StoredMessage } from "@cognia/agent-config-types"

const mockMessages: StoredMessage[] = []
jest.mock("next-intl", () => ({
  useTranslations: (namespace: string) => {
    const t = (key: string, values?: { reason?: string }) =>
      values?.reason ? `${namespace}.${key}: ${values.reason}` : `${namespace}.${key}`
    t.has = (key: string) => key !== "code.unknown.label"
    return t
  },
}))

beforeEach(() => {
  mockMessages.length = 0
})

it("shows the refused text, attachment names and localized reason outside the transcript", () => {
  mockMessages.push({
    id: "m1",
    sessionId: "s1",
    createdAt: 100,
    role: "user",
    parts: [{ type: "text", text: "Keep these words" }],
    metadata: {
      hostState: {
        optimistic: true,
        refusal: { code: "model_access_unavailable", at: 100 },
        attachmentRefs: [{ name: "notes.txt", mediaType: "text/plain", size: 4 }],
      },
    },
  })
  render(<RefusedHostMessages messages={mockMessages} />)
  expect(screen.getByRole("article", { name: "chat.refusedHostMessages.notSent" })).toBeVisible()
  expect(screen.getByText("Keep these words")).toBeVisible()
  expect(screen.getByText("notes.txt")).toBeVisible()
  expect(screen.getByRole("status")).toHaveTextContent(
    "diagnostics.code.modelAccessUnavailable.label"
  )
  expect(screen.getByText("chat.refusedHostMessages.keptLocally")).toBeVisible()
})

it("does not occupy space when there are no local refusals", () => {
  const { container } = render(<RefusedHostMessages messages={[]} />)
  expect(container).toBeEmptyDOMElement()
})
