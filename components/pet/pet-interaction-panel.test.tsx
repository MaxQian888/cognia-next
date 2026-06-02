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

  it("wires the four interaction actions", () => {
    const h = setup()
    fireEvent.click(screen.getByLabelText(/feed|actions\.feed/i))
    fireEvent.click(screen.getByLabelText(/play|actions\.play/i))
    fireEvent.click(screen.getByLabelText(/pet|actions\.pet/i))
    fireEvent.click(screen.getByLabelText(/talk|actions\.talk/i))
    expect(h.onFeed).toHaveBeenCalled()
    expect(h.onPlay).toHaveBeenCalled()
    expect(h.onPet).toHaveBeenCalled()
    expect(h.onTalk).toHaveBeenCalled()
  })
})
