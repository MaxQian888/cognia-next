import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ChatSession } from "@cognia/agent-config-types"

const buildMultiChatShare = jest.fn()
const assertChatShareAccess = jest.fn()
let currentBuildPayload: () => Promise<unknown>

jest.mock("next-intl", () => ({
  useLocale: () => "en",
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

jest.mock("@/lib/share/chat-export", () => ({
  buildMultiChatShare: (...args: unknown[]) => buildMultiChatShare(...args),
  assertChatShareAccess: (...args: unknown[]) => assertChatShareAccess(...args),
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
  }) => {
    currentBuildPayload = buildPayload
    return open ? (
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
    ) : null
  },
}))

import { MultiConversationShareDialog } from "./multi-conversation-share-dialog"

const sessions = [
  { id: "s-1", title: "Alpha" },
  { id: "s-2", title: "Bravo" },
] as ChatSession[]

beforeEach(() => {
  jest.clearAllMocks()
  assertChatShareAccess.mockResolvedValue(undefined)
  buildMultiChatShare.mockResolvedValue({
    payload: { kind: "chat-animated", mime: "text/html", data: "<html/>", encoding: "utf8" },
    attachments: [],
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

  await waitFor(() => expect(buildMultiChatShare).toHaveBeenCalledTimes(1))
  expect(buildMultiChatShare).toHaveBeenCalledWith(
    expect.objectContaining({
      sessions,
      title: 'title:{"count":2}',
      lang: "en",
    })
  )
})

test("rechecks shared export permission before publishing a cached preview", async () => {
  render(<MultiConversationShareDialog sessions={sessions} open onOpenChange={jest.fn()} />)
  await currentBuildPayload()
  assertChatShareAccess.mockRejectedValueOnce(new Error("forbidden"))
  await expect(currentBuildPayload()).rejects.toThrow("forbidden")
  expect(buildMultiChatShare).toHaveBeenCalledTimes(1)
  expect(assertChatShareAccess).toHaveBeenCalledWith(sessions)
})
