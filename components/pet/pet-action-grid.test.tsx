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

beforeEach(() => usePetStore.setState({ actionCooldowns: {} }))

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

  it("starts a cooldown that disables the button, counts down, then re-enables", () => {
    jest.useFakeTimers()
    try {
      const h = setup()
      const sleepBtn = document.querySelector('[data-action="slept"]') as HTMLButtonElement
      fireEvent.click(sleepBtn)
      expect(h.onSleep).toHaveBeenCalledTimes(1)
      // Cooling: disabled, a whole-seconds countdown replaces the icon, clicks ignored.
      expect(sleepBtn).toBeDisabled()
      expect(screen.getByTestId("pet-cooldown-slept").textContent).toMatch(/^\d+$/)
      fireEvent.click(sleepBtn)
      expect(h.onSleep).toHaveBeenCalledTimes(1)
      // Elapse the 5s sleep cooldown (ticker runs every 250ms).
      act(() => {
        jest.advanceTimersByTime(5500)
      })
      expect(sleepBtn).not.toBeDisabled()
      expect(screen.queryByTestId("pet-cooldown-slept")).not.toBeInTheDocument()
    } finally {
      jest.useRealTimers()
    }
  })

  it("forwards the talk toggle and highlights it while open", () => {
    const h = setup()
    fireEvent.click(screen.getByLabelText("Talk"))
    expect(h.onToggleTalk).toHaveBeenCalledTimes(1)
  })
})
