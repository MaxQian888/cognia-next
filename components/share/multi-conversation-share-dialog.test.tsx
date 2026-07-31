import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ChatSession } from "@cognia/agent-config-types"

const buildMultiChatSharePayload = jest.fn()

jest.mock("next-intl", () => ({
  useLocale: () => "en",
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

jest.mock("@/lib/share/chat-export", () => ({
  buildMultiChatSharePayload: (...args: unknown[]) => buildMultiChatSharePayload(...args),
}))

jest.mock("@/components/share/share-link-dialog", () => ({
  ShareLinkDialog: ({
    open,
    artifactSummary,
    buildPayload,
  }: {
    open?: boolean
    artifactSummary?: React.ReactNode
    buildPayload: () => Promise<unknown>
  }) =>
    open ? (
      <div>
        {artifactSummary}
        <button
          type="button"
          onClick={() => {
            void buildPayload()
            void buildPayload()
          }}
        >
          build twice
        </button>
      </div>
    ) : null,
}))

import { MultiConversationShareDialog } from "./multi-conversation-share-dialog"

const sessions = [
  { id: "s-1", title: "Alpha" },
  { id: "s-2", title: "Bravo" },
] as ChatSession[]

beforeEach(() => {
  jest.clearAllMocks()
  buildMultiChatSharePayload.mockResolvedValue({
    kind: "chat-animated",
    mime: "text/html",
    data: "<html/>",
    encoding: "utf8",
  })
})

test("shows the selected conversation snapshot in the shared link form", () => {
  render(<MultiConversationShareDialog sessions={sessions} open onOpenChange={jest.fn()} />)

  expect(screen.getByText("Alpha")).toBeInTheDocument()
  expect(screen.getByText("Bravo")).toBeInTheDocument()
  expect(screen.getByLabelText('summary:{"count":2}')).toBeInTheDocument()
})

test("reuses one payload snapshot across preview and create requests", async () => {
  const user = userEvent.setup()
  render(<MultiConversationShareDialog sessions={sessions} open onOpenChange={jest.fn()} />)

  await user.click(screen.getByRole("button", { name: "build twice" }))

  await waitFor(() => expect(buildMultiChatSharePayload).toHaveBeenCalledTimes(1))
  expect(buildMultiChatSharePayload).toHaveBeenCalledWith(
    expect.objectContaining({
      sessions,
      title: 'title:{"count":2}',
      lang: "en",
    })
  )
})
