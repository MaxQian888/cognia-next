import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { ChatTab } from "./chat-tab"
import { usePetStore } from "@/stores/pet/pet-store"
import { useSettingsStore } from "@/stores/settings"
import { usePetChat } from "@/hooks/pet/use-pet-chat"
import { seedMainChat } from "@/lib/pet/chat/seed-main-chat"
import type { PetProfile } from "@/types/pet"
import type { PetView } from "@/lib/pet/runtime/pet-view"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))
const push = jest.fn()
jest.mock("next/navigation", () => ({ useRouter: () => ({ push }) }))
jest.mock("@/hooks/pet/use-pet-chat", () => ({ usePetChat: jest.fn() }))
jest.mock("@/lib/pet/chat/seed-main-chat", () => ({
  seedMainChat: jest.fn().mockResolvedValue("s1"),
}))

beforeAll(() => {
  Element.prototype.scrollIntoView = jest.fn()
})

const profile = { soul: { name: "Boba" }, level: 1 } as unknown as PetProfile
const view = {} as PetView
const mockedUsePetChat = usePetChat as jest.Mock

function chatState(over: Record<string, unknown> = {}) {
  return {
    turns: [],
    pending: null,
    degradeReason: null,
    inFlight: false,
    send: jest.fn(),
    ...over,
  }
}

function setLlm(enabled: boolean, save = jest.fn()) {
  useSettingsStore.setState({
    settings: { petSettings: { llmSpeak: enabled ? { enabled: true } : undefined } },
    save,
  } as never)
  return save
}

describe("ChatTab", () => {
  beforeEach(() => {
    push.mockClear()
    usePetStore.setState({ oneShotQueue: [] })
    mockedUsePetChat.mockReturnValue(chatState())
  })

  it("shows the enable CTA and turns on llmSpeak when off", async () => {
    const save = setLlm(false)
    const user = userEvent.setup()
    render(<ChatTab profile={profile} view={view} />)

    expect(screen.getByTestId("pet-chat-enable-cta")).toBeInTheDocument()
    await user.click(screen.getByText("chat.enableCta.action"))

    expect(save).toHaveBeenCalledWith({
      petSettings: { llmSpeak: { enabled: true } },
    })
  })

  it("renders the transcript + composer when llmSpeak is on", () => {
    setLlm(true)
    render(<ChatTab profile={profile} view={view} />)
    expect(screen.getByTestId("pet-chat-transcript")).toBeInTheDocument()
    expect(screen.getByTestId("pet-talk-composer")).toBeInTheDocument()
    expect(screen.queryByTestId("pet-chat-enable-cta")).not.toBeInTheDocument()
  })

  it("opens the full chat seeded with the latest user message", async () => {
    setLlm(true)
    mockedUsePetChat.mockReturnValue(
      chatState({ turns: [{ id: 1, at: 1, userText: "explain X", reply: "ok" }] })
    )
    const user = userEvent.setup()
    render(<ChatTab profile={profile} view={view} />)

    await user.click(screen.getByText("chat.openFullChat"))

    expect(seedMainChat).toHaveBeenCalledWith("explain X")
    await screen.findByTestId("pet-chat-transcript")
    expect(push).toHaveBeenCalledWith("/")
  })
})
