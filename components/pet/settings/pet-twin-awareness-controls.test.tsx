import { render, screen, fireEvent } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

let twinsValue: { id: string; name: string }[] | undefined = []
const useLiveQuery = jest.fn(() => twinsValue)
jest.mock("dexie-react-hooks", () => ({ useLiveQuery: () => useLiveQuery() }))
const listTwins = jest.fn()
jest.mock("@/lib/db/twins", () => ({ listTwins: () => listTwins() }))

import { PetTwinAwarenessControls } from "./pet-twin-awareness-controls"
import { DEFAULT_PET_SETTINGS, type PetSettings } from "@/types/pet"

beforeEach(() => {
  twinsValue = []
  useLiveQuery.mockClear()
  listTwins.mockClear()
})

describe("PetTwinAwarenessControls", () => {
  it("is off by default and hides the twin picker until enabled", () => {
    const patch = jest.fn()
    render(<PetTwinAwarenessControls pet={DEFAULT_PET_SETTINGS} patch={patch} />)
    expect(document.getElementById("pet-twin-awareness-enabled")).not.toBeNull()
    expect(document.getElementById("pet-twin-awareness-twin")).toBeNull()
  })

  it("toggling on reveals the twin picker", () => {
    const patch = jest.fn()
    render(<PetTwinAwarenessControls pet={DEFAULT_PET_SETTINGS} patch={patch} />)
    fireEvent.click(document.getElementById("pet-twin-awareness-enabled") as HTMLButtonElement)
    expect(patch).toHaveBeenCalledWith({
      twinAwareness: { enabled: true, twinId: null },
    })
  })

  it("shows an empty-state message when the user has no twins", () => {
    twinsValue = []
    const pet: PetSettings = {
      ...DEFAULT_PET_SETTINGS,
      twinAwareness: { enabled: true, twinId: null },
    }
    render(<PetTwinAwarenessControls pet={pet} patch={jest.fn()} />)
    expect(document.getElementById("pet-twin-awareness-twin")).toBeNull()
    expect(screen.getByText(/don't have any twins yet/i)).toBeInTheDocument()
  })

  it("lists twins and patches the selected twinId", async () => {
    const user = userEvent.setup()
    twinsValue = [
      { id: "tw_1", name: "Work" },
      { id: "tw_2", name: "Personal" },
    ]
    const patch = jest.fn()
    const pet: PetSettings = {
      ...DEFAULT_PET_SETTINGS,
      twinAwareness: { enabled: true, twinId: null },
    }
    render(<PetTwinAwarenessControls pet={pet} patch={patch} />)
    const select = screen.getByRole("combobox", { name: /twin/i })
    expect(select).toBeInTheDocument()
    await user.click(select)
    expect(screen.getByRole("option", { name: "Work" })).toBeInTheDocument()
    expect(screen.getByRole("option", { name: "Personal" })).toBeInTheDocument()
    await user.click(screen.getByRole("option", { name: "Personal" }))
    expect(patch).toHaveBeenCalledWith({
      twinAwareness: { enabled: true, twinId: "tw_2" },
    })
  })

  it("shows the privacy note only when enabled", () => {
    const pet: PetSettings = {
      ...DEFAULT_PET_SETTINGS,
      twinAwareness: { enabled: true, twinId: "tw_1" },
    }
    render(<PetTwinAwarenessControls pet={pet} patch={jest.fn()} />)
    expect(screen.getByText(/never reads its sources|never its sources/i)).toBeInTheDocument()
  })
})
