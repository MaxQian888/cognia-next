import { render, screen, fireEvent } from "@testing-library/react"

// Stub the renderer so we don't mount the SVG/live2d skin in this unit test.
jest.mock("../pet-renderer", () => ({
  PetRenderer: ({ size }: { size?: number }) => <div data-testid="pet-preview" data-size={size} />,
}))

import { NurtureTab } from "./nurture-tab"
import { createDefaultProfile } from "@/lib/pet/defaults"
import { computePetView } from "@/lib/pet/runtime/pet-view"
import { usePetStore } from "@/stores/pet/pet-store"
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
  const handlers = {
    onFeed: jest.fn(),
    onPlay: jest.fn(),
    onPet: jest.fn(),
    onTalk: jest.fn(),
    onSleep: jest.fn(),
    onClean: jest.fn(),
    onTreat: jest.fn(),
  }
  render(<NurtureTab profile={profile} view={view} {...handlers} />)
  return handlers
}

beforeEach(() => usePetStore.setState({ actionCooldowns: {} }))

describe("NurtureTab", () => {
  it("renders the stat card, the three need bars, and a hero preview", () => {
    setup()
    expect(screen.getByTestId("pet-nurture-tab")).toBeInTheDocument()
    expect(screen.getByTestId("pet-stat-card")).toBeInTheDocument()
    expect(document.querySelector('[data-need="energy"]')).not.toBeNull()
    expect(document.querySelector('[data-need="mood"]')).not.toBeNull()
    expect(document.querySelector('[data-need="bond"]')).not.toBeNull()
    // A large hero preview alongside the stat-card preview.
    expect(screen.getAllByTestId("pet-preview").some((n) => n.dataset.size === "160")).toBe(true)
  })

  it("wires feed/play/pet directly and toggles the talk composer", () => {
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
    expect(h.onTalk).not.toHaveBeenCalled()
  })

  it("runs the new actions and starts a cooldown that disables the button", () => {
    const h = setup()
    const sleepBtn = document.querySelector('[data-action="slept"]') as HTMLButtonElement
    fireEvent.click(sleepBtn)
    expect(h.onSleep).toHaveBeenCalled()
    // The store now holds a future deadline for "slept" → the button disables.
    expect(usePetStore.getState().actionCooldowns.slept).toBeGreaterThan(Date.now())
    expect(document.querySelector('[data-action="slept"]')).toBeDisabled()

    fireEvent.click(document.querySelector('[data-action="cleaned"]') as HTMLButtonElement)
    expect(h.onClean).toHaveBeenCalled()
    fireEvent.click(document.querySelector('[data-action="treated"]') as HTMLButtonElement)
    expect(h.onTreat).toHaveBeenCalled()
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
})
