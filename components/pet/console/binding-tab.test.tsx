import { act, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

jest.mock("dexie-react-hooks", () => ({ useLiveQuery: jest.fn() }))
jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))
const upsertPetBinding = jest.fn()
const deletePetBinding = jest.fn()
jest.mock("@/lib/db/pet", () => ({
  listPetBindingsWithCharacters: jest.fn(),
  upsertPetBinding: (...a: unknown[]) => upsertPetBinding(...a),
  deletePetBinding: (...a: unknown[]) => deletePetBinding(...a),
}))
jest.mock("@/lib/db/pet-models", () => ({ listPetModels: jest.fn() }))
jest.mock("@/lib/db/pet-sprite-packs", () => ({ listPetSpritePacks: jest.fn() }))

import { useLiveQuery } from "dexie-react-hooks"
import { toast } from "sonner"
import { BindingTab } from "./binding-tab"

const liveQuery = useLiveQuery as jest.Mock

beforeEach(() => {
  liveQuery.mockReset()
  upsertPetBinding.mockReset().mockResolvedValue(undefined)
  deletePetBinding.mockReset().mockResolvedValue(undefined)
  ;(toast.error as jest.Mock).mockClear()
  ;(toast.success as jest.Mock).mockClear()
})

/** Route each live query by the loader it closes over, on every render. */
function mockQueries(
  characters: unknown[] | undefined,
  bindings: unknown[] = [],
  models: unknown[] | undefined = [],
  packs: unknown[] | undefined = []
) {
  liveQuery.mockImplementation((fn: () => unknown) => {
    const src = String(fn)
    if (src.includes("listPetBindingsWithCharacters")) {
      return characters === undefined ? undefined : { characters, bindings }
    }
    if (src.includes("listPetModels")) return models
    return packs
  })
}

describe("BindingTab", () => {
  it("shows a placeholder, not the empty state, while loading", () => {
    mockQueries(undefined)
    render(<BindingTab />)
    expect(screen.getByTestId("pet-binding-loading")).toBeInTheDocument()
    expect(screen.queryByTestId("pet-binding-empty")).toBeNull()
  })

  it("shows an empty state when there are no characters", () => {
    mockQueries([])
    render(<BindingTab />)
    expect(screen.getByTestId("pet-binding-empty")).toBeInTheDocument()
  })

  it("lists characters and writes a binding on species select", async () => {
    const user = userEvent.setup()
    mockQueries([{ id: "c1", name: "Coder" }])
    render(<BindingTab />)
    const select = screen.getByRole("combobox", { name: /species.*coder/i })
    await user.click(select)
    await user.click(screen.getByRole("option", { name: /owl/i }))
    expect(upsertPetBinding).toHaveBeenCalledWith(
      expect.objectContaining({ characterId: "c1", species: "owl" })
    )
  })

  it("clears a binding when 'use global' is chosen", async () => {
    const user = userEvent.setup()
    mockQueries(
      [{ id: "c1", name: "Coder" }],
      [{ characterId: "c1", species: "owl", updatedAt: "" }]
    )
    render(<BindingTab />)
    await user.click(screen.getByRole("combobox", { name: /species.*coder/i }))
    await user.click(screen.getByRole("option", { name: /global/i }))
    expect(deletePetBinding).toHaveBeenCalledWith("c1")
  })

  it("offers SVG, Live2D, and Sprite overrides and preserves the species binding", async () => {
    const user = userEvent.setup()
    mockQueries(
      [{ id: "c1", name: "Coder" }],
      [{ characterId: "c1", species: "owl", updatedAt: "old" }],
      [{ id: "hiyori", name: "Hiyori" }],
      [{ id: "momo", displayName: "Momo" }]
    )
    render(<BindingTab />)

    const skinSelect = screen.getByRole("combobox", { name: /skin.*coder/i })
    await user.click(skinSelect)
    expect(screen.getByRole("option", { name: /Hiyori/i })).toBeInTheDocument()
    expect(screen.getByRole("option", { name: /Momo/i })).toBeInTheDocument()
    await user.click(screen.getByRole("option", { name: /Hiyori/i }))

    expect(upsertPetBinding).toHaveBeenCalledWith(
      expect.objectContaining({
        characterId: "c1",
        species: "owl",
        skin: { skinId: "live2d", modelId: "hiyori" },
      })
    )
  })

  it("clears only the skin override when the character still overrides species", async () => {
    const user = userEvent.setup()
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

    await user.click(screen.getByRole("combobox", { name: /skin.*coder/i }))
    await user.click(screen.getByRole("option", { name: /inherit/i }))
    expect(upsertPetBinding).toHaveBeenCalledWith(
      expect.objectContaining({ characterId: "c1", species: "owl", skin: undefined })
    )
    expect(deletePetBinding).not.toHaveBeenCalled()
  })

  it("asks before clearing a character's whole binding", async () => {
    const user = userEvent.setup()
    mockQueries(
      [{ id: "c1", name: "Coder" }],
      [{ characterId: "c1", species: "owl", updatedAt: "" }]
    )
    render(<BindingTab />)
    await user.click(screen.getByRole("button", { name: /clear/i }))
    expect(deletePetBinding).not.toHaveBeenCalled()
    const dialog = await screen.findByRole("alertdialog")
    expect(dialog).toHaveTextContent("Coder")
    await user.click(screen.getByRole("button", { name: /^clear binding$/i }))
    expect(deletePetBinding).toHaveBeenCalledWith("c1")
    expect(toast.success).toHaveBeenCalled()
  })

  it("reports a failed write instead of swallowing it", async () => {
    const user = userEvent.setup()
    upsertPetBinding.mockRejectedValue(new Error("quota"))
    mockQueries([{ id: "c1", name: "Coder" }])
    render(<BindingTab />)
    await user.click(screen.getByRole("combobox", { name: /species.*coder/i }))
    await user.click(screen.getByRole("option", { name: /owl/i }))
    expect(toast.error).toHaveBeenCalled()
  })

  it("locks a character's controls while its write is in flight", async () => {
    const user = userEvent.setup()
    let finish: () => void = () => {}
    upsertPetBinding.mockImplementation(
      () => new Promise<void>((resolve) => (finish = () => resolve()))
    )
    mockQueries(
      [
        { id: "c1", name: "Coder" },
        { id: "c2", name: "Writer" },
      ],
      [{ characterId: "c1", species: "owl", updatedAt: "" }]
    )
    render(<BindingTab />)
    await user.click(screen.getByRole("combobox", { name: /species.*coder/i }))
    await user.click(screen.getByRole("option", { name: /cat/i }))
    expect(upsertPetBinding).toHaveBeenCalledTimes(1)

    // A second pick before the first lands would race it; every control on
    // the row waits.
    expect(screen.getByRole("combobox", { name: /species.*coder/i })).toBeDisabled()
    // The Base UI combobox marks its input rather than setting `disabled`.
    expect(screen.getByRole("combobox", { name: /skin.*coder/i })).toHaveAttribute("data-disabled")
    expect(screen.getByRole("button", { name: /clear/i })).toBeDisabled()
    // Other characters stay editable.
    expect(screen.getByRole("combobox", { name: /species.*writer/i })).toBeEnabled()

    await act(async () => finish())
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: /species.*coder/i })).toBeEnabled()
    )
    expect(screen.getByRole("combobox", { name: /skin.*coder/i })).not.toHaveAttribute(
      "data-disabled"
    )
    expect(screen.getByRole("button", { name: /clear/i })).toBeEnabled()
  })

  // Remote care (ADR-0219): the phone mirrors bindings but cannot edit them,
  // and a model or pack it does not hold is named by its kind, not as
  // "inherit".
  describe("read-only (remote care)", () => {
    it("states each character's look without any edit control", () => {
      mockQueries(
        [
          { id: "c1", name: "Ada" },
          { id: "c2", name: "Lin" },
        ],
        [
          {
            characterId: "c1",
            species: "cat",
            skin: { skinId: "live2d", modelId: "desk-only" },
            updatedAt: "",
          },
          { characterId: "c2", skin: { skinId: "sprite-v2", packId: "p9" }, updatedAt: "" },
        ]
      )
      render(<BindingTab readOnly />)
      expect(screen.getByTestId("pet-binding")).toHaveAttribute("data-read-only")
      expect(screen.getByTestId("pet-binding-read-only")).toBeInTheDocument()
      expect(screen.queryByRole("combobox")).toBeNull()
      expect(screen.queryByRole("button")).toBeNull()
      const ada = document.querySelector('[data-character="c1"]') as HTMLElement
      expect(ada).toHaveTextContent(/live2d model/i)
      const lin = document.querySelector('[data-character="c2"]') as HTMLElement
      expect(lin).toHaveTextContent(/sprite pack/i)
    })

    it("names a Live2D model this device knows by its name", () => {
      mockQueries(
        [{ id: "c1", name: "Ada" }],
        [{ characterId: "c1", skin: { skinId: "live2d", modelId: "hiyori" }, updatedAt: "" }],
        [{ id: "hiyori", name: "Hiyori" }]
      )
      render(<BindingTab readOnly />)
      const ada = document.querySelector('[data-character="c1"]') as HTMLElement
      expect(ada).toHaveTextContent("Live2D · Hiyori")
      expect(ada).not.toHaveTextContent("Live2D model")
      expect(ada).toHaveTextContent("Use global pet")
    })

    it("names a character with no binding as following the global look", () => {
      mockQueries([{ id: "c1", name: "Ada" }])
      render(<BindingTab readOnly />)
      const ada = document.querySelector('[data-character="c1"]') as HTMLElement
      expect(ada).toHaveTextContent(/inherit/i)
    })
  })
})
