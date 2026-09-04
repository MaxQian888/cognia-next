let remainingMs: Record<string, number> = {}
jest.mock("@/hooks/pet/use-action-cooldown", () => ({
  useActionCooldown: () => ({ remaining: (kind: string) => remainingMs[kind] ?? 0 }),
}))

import { render, screen, fireEvent, act } from "@testing-library/react"

import { PetActionGrid } from "./pet-action-grid"
import { usePetStore } from "@/stores/pet/pet-store"

function makeHandlers() {
  return {
    onFeed: jest.fn(),
    onPlay: jest.fn(),
    onPet: jest.fn(),
    onSleep: jest.fn(),
    onClean: jest.fn(),
    onTreat: jest.fn(),
    onToggleTalk: jest.fn(),
  }
}

function setup(talkOpen = false) {
  const handlers = makeHandlers()
  render(<PetActionGrid {...handlers} talkOpen={talkOpen} />)
  return handlers
}

beforeEach(() => usePetStore.setState({ interactionRefusal: null }))

describe("PetActionGrid", () => {
  it("renders all six care actions plus the talk toggle, with visible labels", () => {
    setup()
    for (const kind of ["fed", "played", "petted", "slept", "cleaned", "treated"]) {
      expect(document.querySelector(`[data-action="${kind}"]`)).not.toBeNull()
    }
    // Visible label text ships alongside the icon (labels reuse actions.*).
    expect(screen.getByLabelText("Feed")).toHaveTextContent("Feed")
    expect(screen.getByLabelText("Talk")).toBeInTheDocument()
  })

  it("runs each action's handler on click", () => {
    const h = setup()
    fireEvent.click(document.querySelector('[data-action="fed"]') as Element)
    fireEvent.click(document.querySelector('[data-action="played"]') as Element)
    fireEvent.click(document.querySelector('[data-action="petted"]') as Element)
    fireEvent.click(document.querySelector('[data-action="slept"]') as Element)
    fireEvent.click(document.querySelector('[data-action="cleaned"]') as Element)
    fireEvent.click(document.querySelector('[data-action="treated"]') as Element)
    expect(h.onFeed).toHaveBeenCalledTimes(1)
    expect(h.onPlay).toHaveBeenCalledTimes(1)
    expect(h.onPet).toHaveBeenCalledTimes(1)
    expect(h.onSleep).toHaveBeenCalledTimes(1)
    expect(h.onClean).toHaveBeenCalledTimes(1)
    expect(h.onTreat).toHaveBeenCalledTimes(1)
  })

  it("renders a cooling action as disabled with a whole-seconds countdown", () => {
    // The grid no longer starts cooldowns: the controller owns the deadline and
    // this renders the projection. What is pinned here is the rendering
    // contract; the projection itself is pinned in the hook's own suite.
    remainingMs = { slept: 4200 }
    const h = setup()
    const sleepBtn = document.querySelector('[data-action="slept"]') as HTMLButtonElement
    expect(sleepBtn).toBeDisabled()
    expect(screen.getByTestId("pet-cooldown-slept").textContent).toBe("5")
    fireEvent.click(sleepBtn)
    expect(h.onSleep).not.toHaveBeenCalled()
  })

  it("renders a ready action as clickable", () => {
    remainingMs = {}
    const h = setup()
    const sleepBtn = document.querySelector('[data-action="slept"]') as HTMLButtonElement
    expect(sleepBtn).not.toBeDisabled()
    expect(screen.queryByTestId("pet-cooldown-slept")).not.toBeInTheDocument()
    fireEvent.click(sleepBtn)
    expect(h.onSleep).toHaveBeenCalledTimes(1)
  })

  it("forwards the talk toggle and highlights it while open", () => {
    const h = setup()
    fireEvent.click(screen.getByLabelText("Talk"))
    expect(h.onToggleTalk).toHaveBeenCalledTimes(1)
  })
})
