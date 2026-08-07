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
jest.mock("@/lib/db/pet-models", () => ({ listPetModels: jest.fn() }))
jest.mock("@/lib/db/pet-sprite-packs", () => ({ listPetSpritePacks: jest.fn() }))

import { useLiveQuery } from "dexie-react-hooks"
import { BindingTab } from "./binding-tab"

const liveQuery = useLiveQuery as jest.Mock

beforeEach(() => {
  liveQuery.mockReset()
  upsertPetBinding.mockClear()
  deletePetBinding.mockClear()
})

function mockQueries(
  characters: unknown[],
  bindings: unknown[] = [],
  models: unknown[] = [],
  packs: unknown[] = []
) {
  liveQuery
    .mockReturnValueOnce(characters)
    .mockReturnValueOnce(bindings)
    .mockReturnValueOnce(models)
    .mockReturnValueOnce(packs)
}

describe("BindingTab", () => {
  it("shows an empty state when there are no characters", () => {
    mockQueries([])
    render(<BindingTab />)
    expect(screen.getByTestId("pet-binding-empty")).toBeInTheDocument()
  })

  it("lists characters and writes a binding on species select", () => {
    mockQueries([{ id: "c1", name: "Coder" }])
    render(<BindingTab />)
    const select = screen.getByRole("combobox", { name: /species.*coder/i })
    fireEvent.change(select, { target: { value: "owl" } })
    expect(upsertPetBinding).toHaveBeenCalledWith(
      expect.objectContaining({ characterId: "c1", species: "owl" })
    )
  })

  it("clears a binding when 'use global' is chosen", () => {
    mockQueries(
      [{ id: "c1", name: "Coder" }],
      [{ characterId: "c1", species: "owl", updatedAt: "" }]
    )
    render(<BindingTab />)
    fireEvent.change(screen.getByRole("combobox", { name: /species.*coder/i }), {
      target: { value: "" },
    })
    expect(deletePetBinding).toHaveBeenCalledWith("c1")
  })

  it("offers SVG, Live2D, and Sprite overrides and preserves the species binding", () => {
    mockQueries(
      [{ id: "c1", name: "Coder" }],
      [{ characterId: "c1", species: "owl", updatedAt: "old" }],
      [{ id: "hiyori", name: "Hiyori" }],
      [{ id: "momo", displayName: "Momo" }]
    )
    render(<BindingTab />)

    const skinSelect = screen.getByRole("combobox", { name: /skin.*coder/i })
    expect(skinSelect).toHaveTextContent("Hiyori")
    expect(skinSelect).toHaveTextContent("Momo")
    fireEvent.change(skinSelect, { target: { value: "live2d:hiyori" } })

    expect(upsertPetBinding).toHaveBeenCalledWith(
      expect.objectContaining({
        characterId: "c1",
        species: "owl",
        skin: { skinId: "live2d", modelId: "hiyori" },
      })
    )
  })

  it("clears only the skin override when the character still overrides species", () => {
    mockQueries(
      [{ id: "c1", name: "Coder" }],
      [
        {
          characterId: "c1",
          species: "owl",
          skin: { skinId: "sprite-v2", packId: "momo" },
          updatedAt: "old",
        },
      ],
      [],
      [{ id: "momo", displayName: "Momo" }]
    )
    render(<BindingTab />)

    fireEvent.change(screen.getByRole("combobox", { name: /skin.*coder/i }), {
      target: { value: "" },
    })
    expect(upsertPetBinding).toHaveBeenCalledWith(
      expect.objectContaining({ characterId: "c1", species: "owl", skin: undefined })
    )
    expect(deletePetBinding).not.toHaveBeenCalled()
  })
})
