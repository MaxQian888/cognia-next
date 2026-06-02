import { render, screen, fireEvent } from "@testing-library/react"

jest.mock("dexie-react-hooks", () => ({ useLiveQuery: jest.fn() }))
jest.mock("@/lib/db/schema", () => ({ getDb: () => ({ characters: { toArray: () => [] } }) }))
const upsertPetBinding = jest.fn()
const deletePetBinding = jest.fn()
jest.mock("@/lib/db/pet", () => ({
  listPetBindings: jest.fn(),
  upsertPetBinding: (...a: unknown[]) => upsertPetBinding(...a),
  deletePetBinding: (...a: unknown[]) => deletePetBinding(...a),
}))

import { useLiveQuery } from "dexie-react-hooks"
import { BindingTab } from "./binding-tab"

const liveQuery = useLiveQuery as jest.Mock

beforeEach(() => {
  upsertPetBinding.mockClear()
  deletePetBinding.mockClear()
})

describe("BindingTab", () => {
  it("shows an empty state when there are no characters", () => {
    liveQuery.mockReturnValueOnce([]).mockReturnValueOnce([])
    render(<BindingTab />)
    expect(screen.getByTestId("pet-binding-empty")).toBeInTheDocument()
  })

  it("lists characters and writes a binding on species select", () => {
    liveQuery.mockReturnValueOnce([{ id: "c1", name: "Coder" }]).mockReturnValueOnce([])
    render(<BindingTab />)
    const select = screen.getByRole("combobox")
    fireEvent.change(select, { target: { value: "owl" } })
    expect(upsertPetBinding).toHaveBeenCalledWith(
      expect.objectContaining({ characterId: "c1", species: "owl" })
    )
  })

  it("clears a binding when 'use global' is chosen", () => {
    liveQuery
      .mockReturnValueOnce([{ id: "c1", name: "Coder" }])
      .mockReturnValueOnce([{ characterId: "c1", species: "owl", updatedAt: "" }])
    render(<BindingTab />)
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "" } })
    expect(deletePetBinding).toHaveBeenCalledWith("c1")
  })
})
