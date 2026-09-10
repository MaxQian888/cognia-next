import { fireEvent, render, screen } from "@testing-library/react"

import { useChatStore } from "@/stores/chat"
import { ComposerSessionProvider } from "./composer-session-context"
import { ReplyToChip } from "./reply-to-chip"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => `t:${key}`,
}))

beforeEach(() => {
  useChatStore.getState().clear()
  useChatStore.getState().setActiveSession("focused")
})

it("renders nothing until a reply target is staged", () => {
  render(<ReplyToChip />)
  expect(screen.queryByTestId("composer-reply-to-chip")).toBeNull()
})

it("shows the NAMED pane's target and clears exactly that one", () => {
  useChatStore.getState().setReplyTo({ messageId: "a", preview: "focused quote" }, "focused")
  useChatStore.getState().setReplyTo({ messageId: "b", preview: "side quote" }, "side")
  render(
    <ComposerSessionProvider value="side">
      <ReplyToChip bare />
    </ComposerSessionProvider>
  )
  expect(screen.getByTestId("composer-reply-to-chip")).toHaveTextContent("side quote")
  fireEvent.click(screen.getByTestId("composer-reply-to-clear"))
  expect(screen.queryByTestId("composer-reply-to-chip")).toBeNull()
  expect(useChatStore.getState().sessions.focused?.replyTo).toEqual({
    messageId: "a",
    preview: "focused quote",
  })
})

it("uses the placeholder for an empty preview", () => {
  useChatStore.getState().setReplyTo({ messageId: "a", preview: "" }, "focused")
  render(<ReplyToChip />)
  expect(screen.getByTestId("composer-reply-to-chip")).toHaveTextContent("t:emptyPreview")
})
