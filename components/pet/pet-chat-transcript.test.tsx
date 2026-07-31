import { render, screen } from "@testing-library/react"

import { PetChatTranscript } from "./pet-chat-transcript"
import type { PetConversationRow } from "@/types/pet"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

beforeAll(() => {
  // jsdom has no layout — stub the auto-scroll.
  Element.prototype.scrollIntoView = jest.fn()
})

const turns: PetConversationRow[] = [
  { id: 1, at: 1, userText: "hi", reply: "hello!" },
  { id: 2, at: 2, userText: "how are you", reply: "great!" },
]

describe("PetChatTranscript", () => {
  it("shows the empty state when there are no turns and nothing pending", () => {
    render(<PetChatTranscript turns={[]} pending={null} inFlight={false} degradeReason={null} />)
    expect(screen.getByText("chat.empty")).toBeInTheDocument()
  })

  it("renders each turn as a user + pet bubble with the pet name", () => {
    render(
      <PetChatTranscript
        turns={turns}
        pending={null}
        inFlight={false}
        degradeReason={null}
        petName="Boba"
      />
    )
    expect(screen.getByText("hi")).toBeInTheDocument()
    expect(screen.getByText("hello!")).toBeInTheDocument()
    expect(screen.getByText("great!")).toBeInTheDocument()
    // pet-name label appears (once per pet bubble)
    expect(screen.getAllByText("Boba").length).toBe(2)
  })

  it("shows the optimistic pending message and a typing indicator", () => {
    render(<PetChatTranscript turns={turns} pending="new question" inFlight degradeReason={null} />)
    expect(screen.getByText("new question")).toBeInTheDocument()
    expect(screen.getByTestId("pet-chat-typing")).toBeInTheDocument()
  })

  it("renders a degrade banner keyed by reason", () => {
    render(<PetChatTranscript turns={turns} pending="oops" inFlight={false} degradeReason="pii" />)
    expect(screen.getByTestId("pet-chat-degrade")).toHaveTextContent("chat.degrade.pii")
  })
})
