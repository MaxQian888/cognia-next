import type { ReactNode } from "react"
import { act, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { ChatTab } from "./chat-tab"
import { seedMainChat } from "@/lib/pet/chat/seed-main-chat"
import {
  PetConsoleActionsContext,
  type PetConsoleActions,
  type PetConsoleChat,
  type PetConsoleRemote,
} from "./pet-console-actions-context"
import type { PetActionOutcome } from "@/lib/pet/console/outcome-messages"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))
const push = jest.fn()
jest.mock("next/navigation", () => ({ useRouter: () => ({ push }) }))
jest.mock("@/lib/pet/chat/seed-main-chat", () => ({
  seedMainChat: jest.fn().mockResolvedValue("s1"),
}))

beforeAll(() => {
  Element.prototype.scrollIntoView = jest.fn()
})

const OK: PetActionOutcome = { ok: true }

function chat(over: Partial<PetConsoleChat> = {}): PetConsoleChat {
  return {
    enabled: true,
    turns: [],
    pending: null,
    inFlight: false,
    degradeReason: null,
    awaitingReply: false,
    send: jest.fn().mockResolvedValue(OK),
    refresh: jest.fn().mockResolvedValue(OK),
    clear: jest.fn().mockResolvedValue(OK),
    enable: jest.fn().mockResolvedValue(OK),
    ...over,
  }
}

function actions(
  c: PetConsoleChat,
  mode: "local" | "remote" = "local",
  remote: PetConsoleRemote | null = null
): PetConsoleActions {
  return {
    mode,
    capability: (id) => (mode === "remote" && id === "chat.enable" ? "desktop-only" : "available"),
    chat: c,
    remote,
  } as PetConsoleActions
}

function renderTab(value: PetConsoleActions) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <PetConsoleActionsContext.Provider value={value}>{children}</PetConsoleActionsContext.Provider>
  )
  return render(<ChatTab petName="Boba" />, { wrapper })
}

beforeEach(() => push.mockClear())

describe("ChatTab", () => {
  it("shows the enable CTA and turns chat on through the console", async () => {
    const c = chat({ enabled: false })
    const user = userEvent.setup()
    renderTab(actions(c))
    expect(screen.getByTestId("pet-chat-enable-cta")).toBeInTheDocument()
    await user.click(screen.getByText("chat.enableCta.action"))
    expect(c.enable).toHaveBeenCalledTimes(1)
    expect(screen.getByText("chat.enableCta.action").closest("button")).not.toBeDisabled()
  })

  it("renders the transcript + composer when chat is on", () => {
    renderTab(actions(chat()))
    expect(screen.getByTestId("pet-chat-transcript")).toBeInTheDocument()
    expect(screen.getByTestId("pet-talk-composer")).toBeInTheDocument()
    expect(screen.queryByTestId("pet-chat-enable-cta")).not.toBeInTheDocument()
  })

  it("loads the transcript on entry, once", async () => {
    const c = chat()
    const { rerender } = renderTab(actions(c))
    rerender(<ChatTab petName="Boba" />)
    await waitFor(() => expect(c.refresh).toHaveBeenCalledTimes(1))
  })

  it("sends a typed turn through the console", async () => {
    const c = chat()
    const user = userEvent.setup()
    renderTab(actions(c))
    await user.type(screen.getByRole("textbox"), "hello{Enter}")
    expect(c.send).toHaveBeenCalledWith("hello")
  })

  it("opens the full chat seeded with the latest user message", async () => {
    const user = userEvent.setup()
    renderTab(actions(chat({ turns: [{ id: "1", at: 1, userText: "explain X", reply: "ok" }] })))
    await user.click(screen.getByText("chat.openFullChat"))
    expect(seedMainChat).toHaveBeenCalledWith("explain X")
    await waitFor(() => expect(push).toHaveBeenCalledWith("/"))
  })

  it("clears the conversation only after confirming", async () => {
    const c = chat({ turns: [{ id: "1", at: 1, userText: "hi", reply: "yo" }] })
    const user = userEvent.setup()
    renderTab(actions(c))
    await user.click(screen.getByTestId("pet-chat-clear"))
    expect(c.clear).not.toHaveBeenCalled()
    await user.click(screen.getByRole("button", { name: "console.chat.clearConfirm.confirm" }))
    expect(c.clear).toHaveBeenCalledTimes(1)
  })

  it("offers no clear on an empty conversation", () => {
    renderTab(actions(chat()))
    expect(screen.queryByTestId("pet-chat-clear")).toBeNull()
  })

  describe("caring from a paired device (ADR-0219)", () => {
    const remote = (snapshot: unknown): PetConsoleRemote =>
      ({ snapshot, fetchedAt: 1, error: null, connection: "online", retry: jest.fn() }) as never

    it("waits for the desktop's snapshot instead of flashing the CTA", () => {
      renderTab(actions(chat({ enabled: false }), "remote", remote(undefined)))
      expect(screen.getByTestId("pet-chat-loading")).toBeInTheDocument()
      expect(screen.queryByTestId("pet-chat-enable-cta")).toBeNull()
    })

    it("explains that chat is turned on on the desktop, with no button", () => {
      renderTab(actions(chat({ enabled: false }), "remote", remote({})))
      const cta = screen.getByTestId("pet-chat-enable-cta")
      expect(cta).toHaveTextContent("console.remote.chatOff.title")
      expect(screen.queryByRole("button")).toBeNull()
    })

    it("shows a placeholder while the desktop's transcript loads", () => {
      renderTab(actions(chat({ turns: undefined }), "remote", remote({})))
      expect(screen.getByTestId("pet-chat-loading")).toBeInTheDocument()
    })

    it("offers a retry when the transcript could not be loaded", async () => {
      const refresh = jest
        .fn<Promise<PetActionOutcome>, []>()
        .mockResolvedValueOnce({
          ok: false,
          reason: "unreachable",
          message: { key: "outcomes.remote.unreachable" },
        })
        .mockResolvedValue(OK)
      const user = userEvent.setup()
      renderTab(actions(chat({ turns: undefined, refresh }), "remote", remote({})))
      await screen.findByTestId("pet-chat-load-failed")
      await user.click(screen.getByRole("button", { name: "console.remote.band.retry" }))
      expect(refresh).toHaveBeenCalledTimes(2)
      await act(async () => undefined)
    })

    it("says a reply is still on its way", () => {
      renderTab(actions(chat({ pending: "slow", awaitingReply: true }), "remote", remote({})))
      expect(screen.getByTestId("pet-chat-awaiting")).toHaveTextContent(
        "console.remote.chatPending"
      )
    })
  })
})
