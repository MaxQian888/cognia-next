import { fireEvent, render, screen, waitFor } from "@testing-library/react"

const listPetSpritePacks = jest.fn()
const addPetSpritePack = jest.fn()
const deletePetSpritePack = jest.fn()
const validateSpriteV2Import = jest.fn()
const seedMainChat = jest.fn()
const push = jest.fn()

jest.mock("dexie-react-hooks", () => ({ useLiveQuery: () => listPetSpritePacks() }))
jest.mock("@/lib/db/pet-sprite-packs", () => ({
  listPetSpritePacks: () => listPetSpritePacks(),
  addPetSpritePack: (...args: unknown[]) => addPetSpritePack(...args),
  deletePetSpritePack: (...args: unknown[]) => deletePetSpritePack(...args),
}))
jest.mock("@/lib/pet/sprite-v2/import", () => ({
  validateSpriteV2Import: (...args: unknown[]) => validateSpriteV2Import(...args),
}))
jest.mock("@/lib/pet/chat/seed-main-chat", () => ({
  seedMainChat: (...args: unknown[]) => seedMainChat(...args),
}))
jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: { concept?: string }) => {
    if (key === "agentPrompt.instruction") return "Use $hatch-pet."
    if (key === "agentPrompt.concept") return `Pet concept: ${values?.concept}`
    return key
  },
}))
jest.mock("next/navigation", () => ({ useRouter: () => ({ push }) }))
jest.mock("@/lib/platform/detect", () => ({ isTauri: jest.fn(() => true) }))

import { isTauri } from "@/lib/platform/detect"
import { buildHatchPetPrompt, PetSpritePackManager } from "./pet-sprite-pack-manager"

const mockIsTauri = jest.mocked(isTauri)

const promptCopy = {
  defaultConcept: "a friendly custom pet",
  instruction: "Use the $hatch-pet skill.",
  concept: (brief: string) => `Pet concept: ${brief}`,
  qa: "Complete QA.",
  outputFiles: "Report output files.",
  scope: "Do not modify Cognia.",
}

describe("PetSpritePackManager", () => {
  beforeEach(() => {
    listPetSpritePacks.mockReset().mockReturnValue([])
    addPetSpritePack.mockReset()
    deletePetSpritePack.mockReset()
    validateSpriteV2Import.mockReset()
    seedMainChat.mockReset().mockResolvedValue("session-1")
    push.mockReset()
    mockIsTauri.mockReset().mockReturnValue(true)
    Object.defineProperty(globalThis, "createImageBitmap", {
      configurable: true,
      value: jest.fn().mockResolvedValue({ width: 1536, height: 2288, close: jest.fn() }),
    })
  })

  it("builds an explicit hatch-pet task without sending it yet", () => {
    expect(buildHatchPetPrompt("a tiny clay fox", promptCopy)).toContain("$hatch-pet")
    expect(buildHatchPetPrompt("a tiny clay fox", promptCopy)).toContain("a tiny clay fox")
    expect(buildHatchPetPrompt(" ", promptCopy)).toContain("custom pet")
  })

  it("validates and installs a selected manifest plus atlas, then activates it", async () => {
    const patch = jest.fn()
    const manifest = {
      name: "pet.json",
      type: "application/json",
      text: () => Promise.resolve(JSON.stringify({ id: "momo" })),
    } as File
    const atlas = new File(["atlas"], "spritesheet.webp", { type: "image/webp" })
    const payload = { id: "momo", displayName: "Momo", spritesheet: atlas }
    validateSpriteV2Import.mockImplementation(
      async ({
        readImageDimensions,
      }: {
        readImageDimensions: (image: Blob) => Promise<unknown>
      }) => {
        await readImageDimensions(atlas)
        return payload
      }
    )
    addPetSpritePack.mockResolvedValue(payload)

    render(<PetSpritePackManager settings={{} as never} onPatch={patch} />)
    fireEvent.change(screen.getByLabelText("import"), {
      target: { files: [manifest, atlas] },
    })

    await waitFor(() => expect(addPetSpritePack).toHaveBeenCalledWith(payload))
    expect(patch).toHaveBeenCalledWith({ skinId: "sprite-v2", activeSpritePackId: "momo" })
    expect(createImageBitmap).toHaveBeenCalledWith(atlas)
  })

  it("opens a real chat draft for the installed Codex hatch skill", async () => {
    render(<PetSpritePackManager settings={{} as never} onPatch={jest.fn()} />)
    fireEvent.change(screen.getByLabelText("conceptLabel"), {
      target: { value: "a paperclip dragon" },
    })
    fireEvent.click(screen.getByRole("button", { name: "create" }))

    await waitFor(() => expect(seedMainChat).toHaveBeenCalledTimes(1))
    expect(seedMainChat.mock.calls[0][0]).toContain("$hatch-pet")
    expect(seedMainChat.mock.calls[0][0]).toContain("a paperclip dragon")
    expect(push).toHaveBeenCalledWith("/")
  })

  it("rejects an incomplete package before validation", () => {
    render(<PetSpritePackManager settings={{} as never} onPatch={jest.fn()} />)
    fireEvent.change(screen.getByLabelText("import"), {
      target: { files: [new File(["atlas"], "spritesheet.webp", { type: "image/webp" })] },
    })
    expect(screen.getByRole("alert")).toHaveTextContent("invalid")
    expect(validateSpriteV2Import).not.toHaveBeenCalled()
  })

  it("deletes the active pack and restores the built-in skin", async () => {
    const patch = jest.fn()
    listPetSpritePacks.mockReturnValue([
      { id: "momo", displayName: "Momo", description: "Clay fox" },
    ])
    deletePetSpritePack.mockResolvedValue(undefined)
    render(
      <PetSpritePackManager settings={{ activeSpritePackId: "momo" } as never} onPatch={patch} />
    )

    fireEvent.click(screen.getByRole("button", { name: "delete" }))
    await waitFor(() => expect(deletePetSpritePack).toHaveBeenCalledWith("momo"))
    expect(patch).toHaveBeenCalledWith({ skinId: "svg", activeSpritePackId: undefined })
  })

  it("activates an installed inactive pack", () => {
    const patch = jest.fn()
    listPetSpritePacks.mockReturnValue([
      { id: "momo", displayName: "Momo", description: "Clay fox" },
    ])
    render(<PetSpritePackManager settings={{} as never} onPatch={patch} />)
    fireEvent.click(screen.getByRole("button", { name: "activate" }))
    expect(patch).toHaveBeenCalledWith({ skinId: "sprite-v2", activeSpritePackId: "momo" })
  })

  it("keeps the selected skin when deleting an inactive pack", async () => {
    const patch = jest.fn()
    listPetSpritePacks.mockReturnValue([
      { id: "momo", displayName: "Momo", description: "Clay fox" },
    ])
    deletePetSpritePack.mockResolvedValue(undefined)
    render(
      <PetSpritePackManager settings={{ activeSpritePackId: "other" } as never} onPatch={patch} />
    )
    fireEvent.click(screen.getByRole("button", { name: "delete" }))
    await waitFor(() => expect(deletePetSpritePack).toHaveBeenCalledWith("momo"))
    expect(patch).not.toHaveBeenCalled()
  })

  it("hides the local agent launcher outside Tauri", () => {
    mockIsTauri.mockReturnValue(false)
    render(<PetSpritePackManager settings={{} as never} onPatch={jest.fn()} />)
    expect(screen.queryByLabelText("conceptLabel")).toBeNull()
    expect(screen.getByLabelText("import")).toBeInTheDocument()
  })
})
