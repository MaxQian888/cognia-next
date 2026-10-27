import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { PetMediaPackManager } from "./pet-media-pack-manager"
import {
  importMediaPack,
  extractMediaPackZip,
  MediaPackImportError,
} from "@/lib/pet/media-packs/import"
import { prepareMediaPackForDesktop } from "@/lib/pet/media-packs/prepare"
import { addPetMediaPack, listPetMediaPacks, deletePetMediaPack } from "@/lib/db/pet-media-packs"
import { DEFAULT_PET_SETTINGS } from "@/types/pet"
jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))
jest.mock("dexie-react-hooks", () => ({ useLiveQuery: () => listPetMediaPacks() }))
jest.mock("@/lib/db/pet-media-packs", () => ({
  addPetMediaPack: jest.fn(),
  listPetMediaPacks: jest.fn(),
  deletePetMediaPack: jest.fn(),
}))
jest.mock("@/lib/pet/media-packs/import", () => ({
  ...jest.requireActual("@/lib/pet/media-packs/import"),
  importMediaPack: jest.fn(),
  extractMediaPackZip: jest.fn(),
}))
jest.mock("@/lib/pet/media-packs/prepare", () => ({ prepareMediaPackForDesktop: jest.fn() }))
const asset = {
  id: "mp_whale",
  displayName: "Whale",
  manifest: { clips: { idle: {} } },
  totalBytes: 5,
} as never
beforeEach(() => {
  jest.clearAllMocks()
  jest.mocked(listPetMediaPacks).mockReturnValue([] as never)
  jest.mocked(importMediaPack).mockResolvedValue(asset)
  jest.mocked(prepareMediaPackForDesktop).mockResolvedValue(asset)
  jest.mocked(extractMediaPackZip).mockResolvedValue([])
  jest.mocked(addPetMediaPack).mockResolvedValue(asset)
})
it("imports ZIP through validation, native preparation and durable storage, then selects it", async () => {
  const patch = jest.fn()
  render(<PetMediaPackManager settings={DEFAULT_PET_SETTINGS} onPatch={patch} />)
  const file = new File(["zip"], "whale.zip")
  fireEvent.change(screen.getByLabelText("importZip"), { target: { files: [file] } })
  await waitFor(() =>
    expect(patch).toHaveBeenCalledWith({ skinId: "media", activeMediaPackId: "mp_whale" })
  )
  expect(extractMediaPackZip).toHaveBeenCalledWith(file)
  expect(prepareMediaPackForDesktop).toHaveBeenCalledWith(asset)
  expect(addPetMediaPack).toHaveBeenCalledWith(asset)
  expect(screen.getByText("installed")).toBeVisible()
})
it("preserves folder-relative paths and rejects missing files without persisting", async () => {
  jest.mocked(importMediaPack).mockRejectedValue(new MediaPackImportError("missingFiles"))
  const patch = jest.fn(),
    file = new File(["{}"], "pet-manifest.json")
  Object.defineProperty(file, "webkitRelativePath", { value: "Whale/assets/pet-manifest.json" })
  render(<PetMediaPackManager settings={DEFAULT_PET_SETTINGS} onPatch={patch} />)
  fireEvent.change(screen.getByLabelText("importFolder"), { target: { files: [file] } })
  await screen.findByText("errors.missingFiles")
  expect(importMediaPack).toHaveBeenCalledWith([
    { path: "Whale/assets/pet-manifest.json", blob: file },
  ])
  expect(addPetMediaPack).not.toHaveBeenCalled()
  expect(patch).not.toHaveBeenCalled()
})
it("selects and deletes an installed pack, clearing active selection", async () => {
  jest.mocked(listPetMediaPacks).mockReturnValue([asset] as never)
  const patch = jest.fn(),
    user = userEvent.setup()
  const { rerender } = render(
    <PetMediaPackManager settings={DEFAULT_PET_SETTINGS} onPatch={patch} />
  )
  await user.click(screen.getByRole("button", { name: "activate" }))
  expect(patch).toHaveBeenCalledWith({ skinId: "media", activeMediaPackId: "mp_whale" })
  rerender(
    <PetMediaPackManager
      settings={{ ...DEFAULT_PET_SETTINGS, skinId: "media", activeMediaPackId: "mp_whale" }}
      onPatch={patch}
    />
  )
  await user.click(screen.getByRole("button", { name: "deleteNamed" }))
  await waitFor(() => expect(deletePetMediaPack).toHaveBeenCalledWith("mp_whale"))
  expect(patch).toHaveBeenLastCalledWith({ skinId: "svg", activeMediaPackId: undefined })
})

it("can reactivate a remembered pack and does not change another family when deleting it", async () => {
  jest.mocked(listPetMediaPacks).mockReturnValue([asset] as never)
  const patch = jest.fn(),
    user = userEvent.setup()
  render(
    <PetMediaPackManager
      settings={{ ...DEFAULT_PET_SETTINGS, skinId: "live2d", activeMediaPackId: "mp_whale" }}
      onPatch={patch}
    />
  )
  await user.click(screen.getByRole("button", { name: "activate" }))
  expect(patch).toHaveBeenCalledWith({ skinId: "media", activeMediaPackId: "mp_whale" })
  await user.click(screen.getByRole("button", { name: "deleteNamed" }))
  await waitFor(() => expect(patch).toHaveBeenLastCalledWith({ activeMediaPackId: undefined }))
})
