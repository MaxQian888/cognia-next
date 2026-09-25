/** @jest-environment jsdom */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { ChatSession } from "@cognia/agent-config-types"
import { PlatformReplyAssistance } from "./platform-reply-assistance"
import { loadCopilotContext } from "@/lib/reply-copilot/load-context"
import { runCopilot, type CopilotResult } from "@/lib/reply-copilot/run-copilot"
import { buildUtilityLlmClient } from "@/lib/ai/generation/utility-client"

const mockSetInput = jest.fn()
jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))
jest.mock("@/components/ai-elements/prompt-input", () => ({
  usePromptInputController: () => ({ textInput: { value: "existing", setInput: mockSetInput } }),
}))
jest.mock("@/lib/ai/generation/utility-client", () => ({
  buildUtilityLlmClient: jest.fn(() => ({ complete: jest.fn() })),
}))
jest.mock("@/lib/ai/headless-turn-llm-client", () => ({ buildHeadlessTurnLlmClient: jest.fn() }))
jest.mock("@/lib/reply-copilot/load-context", () => ({ loadCopilotContext: jest.fn() }))
jest.mock("@/lib/reply-copilot/run-copilot", () => ({ runCopilot: jest.fn() }))
jest.mock("@/stores/settings", () => ({ useSettingsStore: { getState: () => ({ settings: {} }) } }))
jest.mock("@/components/reply-copilot/copilot-result-card", () => ({
  CopilotResultCard: ({ onFill }: { onFill?: (text: string) => void }) => (
    <button type="button" onClick={() => onFill?.("明早九点前发你")}>
      use-best
    </button>
  ),
}))

const session = { id: "im-session" } as ChatSession
const context = {
  transcript: { turns: [], latestFrom: "other", latestOtherSender: null, isGroup: false },
  knowledge: {
    relationship: "",
    background: "",
    contactId: null,
    contactName: null,
    hasNote: false,
    memoryLines: 0,
    memorySkipped: "disabled",
  },
}
const result: CopilotResult = {
  judge: { kind: "unavailable", reason: "no_provider" },
  drafts: {
    kind: "ok",
    ranked: false,
    candidates: [{ text: "明早九点前发你", probability: null, slot: 0 }],
  },
  variant: "full",
}

beforeEach(() => {
  jest.clearAllMocks()
  ;(loadCopilotContext as jest.Mock).mockResolvedValue(context)
  ;(runCopilot as jest.Mock).mockResolvedValue(result)
})

it("runs the copilot with the typed instructions and fills the composer only on Use", async () => {
  render(<PlatformReplyAssistance session={session} />)
  fireEvent.click(screen.getByRole("button", { name: "dialog.trigger" }))
  expect(screen.getByRole("textbox", { name: "dialog.instructions" })).toHaveValue("existing")
  fireEvent.click(screen.getByRole("button", { name: "dialog.run" }))
  await screen.findByRole("button", { name: "use-best" })
  expect(loadCopilotContext).toHaveBeenCalledWith(session, {})
  expect(runCopilot).toHaveBeenCalledWith(
    expect.objectContaining({ instructions: "existing", transcript: context.transcript })
  )
  expect(buildUtilityLlmClient).toHaveBeenCalledWith(
    expect.objectContaining({ featureId: "im-reply-copilot" })
  )
  expect(mockSetInput).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole("button", { name: "use-best" }))
  expect(mockSetInput).toHaveBeenCalledWith("明早九点前发你")
  expect(screen.queryByRole("button", { name: "use-best" })).not.toBeInTheDocument()
})

it("aborts on close and ignores a late result", async () => {
  let finish!: (value: CopilotResult) => void
  ;(runCopilot as jest.Mock).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  render(<PlatformReplyAssistance session={session} />)
  fireEvent.click(screen.getByRole("button", { name: "dialog.trigger" }))
  fireEvent.click(screen.getByRole("button", { name: "dialog.run" }))
  await waitFor(() => expect(runCopilot).toHaveBeenCalled())
  const signal = (runCopilot as jest.Mock).mock.calls[0][0].signal as AbortSignal
  fireEvent.click(screen.getByRole("button", { name: "dialog.close" }))
  expect(signal.aborted).toBe(true)
  await act(async () => finish(result))
  expect(screen.queryByRole("button", { name: "use-best" })).not.toBeInTheDocument()
  expect(mockSetInput).not.toHaveBeenCalled()
})

it("keeps the input on failure and allows a retry", async () => {
  ;(runCopilot as jest.Mock).mockRejectedValueOnce(new Error("offline"))
  render(<PlatformReplyAssistance session={session} />)
  fireEvent.click(screen.getByRole("button", { name: "dialog.trigger" }))
  fireEvent.click(screen.getByRole("button", { name: "dialog.run" }))
  expect(await screen.findByText("dialog.failed")).toBeInTheDocument()
  expect(mockSetInput).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole("button", { name: "dialog.run" }))
  await screen.findByRole("button", { name: "use-best" })
})

it("respects disabled", () => {
  render(<PlatformReplyAssistance session={session} disabled />)
  expect(screen.getByRole("button", { name: "dialog.trigger" })).toBeDisabled()
})
