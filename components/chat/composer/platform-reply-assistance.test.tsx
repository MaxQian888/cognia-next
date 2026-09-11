/** @jest-environment jsdom */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { PlatformReplyAssistance } from "./platform-reply-assistance"
import type { ChatSession } from "@cognia/agent-config-types"
import { buildUtilityLlmClient } from "@/lib/ai/generation/utility-client"
import { toast } from "sonner"
import { generateReplyDraft } from "@/lib/inbox/ai-reply-draft"

const mockSetInput = jest.fn()
const mockRecent = jest
  .fn()
  .mockResolvedValue([{ role: "user", parts: [{ type: "text", text: "Tomorrow?" }] }])
jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))
jest.mock("@/components/ai-elements/prompt-input", () => ({
  usePromptInputController: () => ({ textInput: { value: "existing", setInput: mockSetInput } }),
}))
jest.mock("@/lib/db/messages", () => ({
  listRecentMessages: (...args: unknown[]) => mockRecent(...args),
}))
jest.mock("@/lib/ai/generation/utility-client", () => ({
  buildUtilityLlmClient: jest.fn(() => ({ complete: jest.fn() })),
}))
jest.mock("@/lib/ai/headless-turn-llm-client", () => ({ buildHeadlessTurnLlmClient: jest.fn() }))
jest.mock("@/lib/inbox/ai-reply-draft", () => ({ generateReplyDraft: jest.fn() }))
jest.mock("@/stores/settings", () => ({ useSettingsStore: { getState: () => ({ settings: {} }) } }))
jest.mock("sonner", () => ({ toast: { error: jest.fn(), info: jest.fn() } }))
const session = { id: "im-session" } as ChatSession

beforeEach(() => {
  jest.clearAllMocks()
  ;(generateReplyDraft as jest.Mock).mockResolvedValue({ kind: "draft", text: "Tomorrow works" })
})

it("keeps the original input until an edited result is explicitly applied", async () => {
  render(<PlatformReplyAssistance session={session} />)
  fireEvent.click(screen.getByRole("button", { name: "aiDraft" }))
  expect(screen.getByRole("textbox", { name: "instructions" })).toHaveValue("existing")
  fireEvent.click(screen.getByRole("button", { name: "generate" }))
  await screen.findByRole("textbox", { name: "preview" })
  expect(mockRecent).toHaveBeenCalledWith("im-session", 30)
  expect(mockSetInput).not.toHaveBeenCalled()
  fireEvent.change(screen.getByRole("textbox", { name: "preview" }), {
    target: { value: "Friday works" },
  })
  fireEvent.click(screen.getByRole("button", { name: "apply" }))
  expect(mockSetInput).toHaveBeenCalledWith("Friday works")
})

it("aborts generation on close and ignores late results", async () => {
  let finish!: (result: unknown) => void
  ;(generateReplyDraft as jest.Mock).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  render(<PlatformReplyAssistance session={session} />)
  fireEvent.click(screen.getByRole("button", { name: "aiDraft" }))
  fireEvent.click(screen.getByRole("button", { name: "generate" }))
  await waitFor(() => expect(generateReplyDraft).toHaveBeenCalled())
  const signal = (generateReplyDraft as jest.Mock).mock.calls[0][0].signal
  fireEvent.click(screen.getByRole("button", { name: "cancel" }))
  expect(signal.aborted).toBe(true)
  await act(async () => finish({ kind: "draft", text: "late" }))
  expect(mockSetInput).not.toHaveBeenCalled()
  expect(screen.queryByRole("textbox", { name: "preview" })).not.toBeInTheDocument()
})

it("preserves input on generation errors and permits retry", async () => {
  ;(generateReplyDraft as jest.Mock).mockRejectedValueOnce(new Error("offline"))
  render(<PlatformReplyAssistance session={session} />)
  fireEvent.click(screen.getByRole("button", { name: "aiDraft" }))
  fireEvent.click(screen.getByRole("button", { name: "generate" }))
  await waitFor(() => expect(screen.getByRole("button", { name: "generate" })).toBeEnabled())
  expect(mockSetInput).not.toHaveBeenCalled()
})

it.each([
  ["pii", "pii"],
  ["empty", "emptyContext"],
  ["no-output", "noOutput"],
])("shows %s without replacing the input", async (reason, label) => {
  ;(generateReplyDraft as jest.Mock).mockResolvedValueOnce({ kind: "skipped", reason })
  render(<PlatformReplyAssistance session={session} />)
  fireEvent.click(screen.getByRole("button", { name: "aiDraft" }))
  fireEvent.change(screen.getByRole("textbox", { name: "instructions" }), {
    target: { value: "Reply briefly" },
  })
  fireEvent.click(screen.getByRole("button", { name: "generate" }))
  await waitFor(() => expect(toast.info).toHaveBeenCalledWith(label))
  expect(mockSetInput).not.toHaveBeenCalled()
})

it("reports unavailable models without losing instructions", async () => {
  ;(buildUtilityLlmClient as jest.Mock).mockReturnValueOnce(null)
  render(<PlatformReplyAssistance session={session} />)
  fireEvent.click(screen.getByRole("button", { name: "aiDraft" }))
  fireEvent.click(screen.getByRole("button", { name: "generate" }))
  await waitFor(() => expect(toast.error).toHaveBeenCalledWith("noModel"))
  expect(screen.getByRole("textbox", { name: "instructions" })).toHaveValue("existing")
})

it("aborts pending history reads when the dialog closes and skips generation", async () => {
  let finish!: (value: unknown[]) => void
  mockRecent.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve
    })
  )
  render(<PlatformReplyAssistance session={session} />)
  fireEvent.click(screen.getByRole("button", { name: "aiDraft" }))
  fireEvent.click(screen.getByRole("button", { name: "generate" }))
  fireEvent.click(screen.getByRole("button", { name: "cancel" }))
  await act(async () => finish([]))
  expect(generateReplyDraft).not.toHaveBeenCalled()
})

it("takes text only, preserves sender names, and excludes system messages", async () => {
  mockRecent.mockResolvedValueOnce([
    { role: "system", parts: [{ type: "text", text: "private system" }] },
    {
      role: "user",
      metadata: { platformMessage: { sender: { displayName: "Alice" } } },
      parts: [
        { type: "file", url: "data:private" },
        { type: "text", text: "hello" },
      ],
    },
  ])
  render(<PlatformReplyAssistance session={session} />)
  fireEvent.click(screen.getByRole("button", { name: "aiDraft" }))
  fireEvent.click(screen.getByRole("button", { name: "generate" }))
  await waitFor(() =>
    expect(generateReplyDraft).toHaveBeenCalledWith(
      expect.objectContaining({ history: [{ role: "Alice", text: "hello" }] })
    )
  )
  fireEvent.click(screen.getByRole("button", { name: "Close" }))
  expect(mockSetInput).not.toHaveBeenCalled()
})
