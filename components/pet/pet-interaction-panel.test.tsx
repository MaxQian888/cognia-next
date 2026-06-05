import { render, screen, fireEvent } from "@testing-library/react"
import { PetInteractionPanel } from "./pet-interaction-panel"
import { createDefaultProfile } from "@/lib/pet/defaults"
import { computePetView } from "@/lib/pet/runtime/pet-view"
import type { PetProfile } from "@/types/pet"

function setup() {
  const profile: PetProfile = {
    ...createDefaultProfile("acct-1", 0),
    soul: { name: "Boba", personality: "x", hatchDate: "" },
    stage: "baby",
    xp: 150,
    level: 2,
  }
  const view = computePetView(profile, null, 0)
  const handlers = { onFeed: jest.fn(), onPlay: jest.fn(), onPet: jest.fn(), onTalk: jest.fn() }
  render(<PetInteractionPanel profile={profile} view={view} {...handlers} />)
  return handlers
}

describe("PetInteractionPanel", () => {
  it("renders the stat card and the three need bars", () => {
    setup()
    expect(screen.getByTestId("pet-stat-card")).toBeInTheDocument()
    expect(document.querySelector('[data-need="energy"]')).not.toBeNull()
    expect(document.querySelector('[data-need="mood"]')).not.toBeNull()
    expect(document.querySelector('[data-need="bond"]')).not.toBeNull()
  })

  it("wires feed/play/pet directly; talk toggles the composer", () => {
    const h = setup()
    fireEvent.click(screen.getByLabelText(/feed|actions\.feed/i))
    fireEvent.click(screen.getByLabelText(/play|actions\.play/i))
    fireEvent.click(screen.getByLabelText(/^pet$|actions\.pet/i))
    expect(h.onFeed).toHaveBeenCalled()
    expect(h.onPlay).toHaveBeenCalled()
    expect(h.onPet).toHaveBeenCalled()

    expect(screen.queryByTestId("pet-talk-composer")).not.toBeInTheDocument()
    fireEvent.click(screen.getByLabelText(/talk|actions\.talk/i))
    expect(screen.getByTestId("pet-talk-composer")).toBeInTheDocument()
    // Toggling talk alone never emits the event.
    expect(h.onTalk).not.toHaveBeenCalled()
  })

  it("submits typed talk text and clears the input", () => {
    const h = setup()
    fireEvent.click(screen.getByLabelText(/talk|actions\.talk/i))
    const input = screen.getByPlaceholderText("Say something to your pet…")
    fireEvent.change(input, { target: { value: "  hi Boba  " } })
    fireEvent.keyDown(input, { key: "Enter" })
    expect(h.onTalk).toHaveBeenCalledWith("hi Boba")
    expect(input).toHaveValue("")
  })

  it("submits bare talk (no text) as undefined via the send button", () => {
    const h = setup()
    fireEvent.click(screen.getByLabelText(/talk|actions\.talk/i))
    fireEvent.click(screen.getByLabelText("Send"))
    expect(h.onTalk).toHaveBeenCalledWith(undefined)
  })
})
