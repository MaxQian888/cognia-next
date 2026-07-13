/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react"

import { CharacterDetailSheet } from "./character-detail-sheet"
import type { Character } from "@cognia/agent-config-types"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

const createCharacterMock = jest.fn(async (_d: unknown) => ({ id: "new-id" }))
const updateCharacterMock = jest.fn(async (_id: string, _d: unknown) => undefined)
const deleteCharacterMock = jest.fn(async (_id: string) => undefined)
jest.mock("@/lib/db/characters", () => ({
  createCharacter: (d: unknown) => createCharacterMock(d),
  updateCharacter: (id: string, d: unknown) => updateCharacterMock(id, d),
  deleteCharacter: (id: string) => deleteCharacterMock(id),
}))

const enqueueMock = jest.fn(async (_e: unknown) => undefined)
jest.mock("@/lib/db/mobile-outbound-queue", () => ({
  enqueue: (e: unknown) => enqueueMock(e),
}))

jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))

const mkChar = (p: Partial<Character> = {}): Character => ({
  id: "c1",
  name: "Tutor",
  avatarColor: "#abc",
  systemPrompt: "You are a tutor.",
  createdAt: 0,
  updatedAt: 0,
  ...p,
})

beforeEach(() => {
  createCharacterMock.mockClear()
  updateCharacterMock.mockClear()
  deleteCharacterMock.mockClear()
  enqueueMock.mockClear()
})

describe("CharacterDetailSheet", () => {
  it("dismisses on Android hardware back (popstate)", () => {
    const onOpenChange = jest.fn()
    render(<CharacterDetailSheet open character={null} onOpenChange={onOpenChange} />)
    fireEvent.popState(window)
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("shows the create title and disables save until name + prompt are set", () => {
    render(<CharacterDetailSheet open character={null} onOpenChange={() => undefined} />)
    expect(screen.getByText("createTitle")).toBeInTheDocument()
    expect(screen.getByTestId("character-save")).toBeDisabled()

    fireEvent.change(screen.getByTestId("character-name"), { target: { value: "New" } })
    expect(screen.getByTestId("character-save")).toBeDisabled()
    fireEvent.change(screen.getByTestId("character-system-prompt"), {
      target: { value: "Be helpful" },
    })
    expect(screen.getByTestId("character-save")).toBeEnabled()
  })

  it("creates a character and enqueues the mirror write", async () => {
    const onOpenChange = jest.fn()
    render(<CharacterDetailSheet open character={null} onOpenChange={onOpenChange} />)
    fireEvent.change(screen.getByTestId("character-name"), { target: { value: "New" } })
    fireEvent.change(screen.getByTestId("character-system-prompt"), {
      target: { value: "Be helpful" },
    })
    fireEvent.click(screen.getByTestId("character-save"))
    await waitFor(() => expect(createCharacterMock).toHaveBeenCalledTimes(1))
    expect(enqueueMock).toHaveBeenCalledWith(
      expect.objectContaining({ command: "character_upsert" })
    )
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("edits an existing character via updateCharacter", async () => {
    render(<CharacterDetailSheet open character={mkChar()} onOpenChange={() => undefined} />)
    expect(screen.getByText("editTitle")).toBeInTheDocument()
    fireEvent.change(screen.getByTestId("character-name"), { target: { value: "Tutor v2" } })
    fireEvent.click(screen.getByTestId("character-save"))
    await waitFor(() => expect(updateCharacterMock).toHaveBeenCalledWith("c1", expect.anything()))
  })

  it("deletes a non-built-in character", async () => {
    const onOpenChange = jest.fn()
    render(<CharacterDetailSheet open character={mkChar()} onOpenChange={onOpenChange} />)
    fireEvent.click(screen.getByTestId("character-delete"))
    await waitFor(() => expect(deleteCharacterMock).toHaveBeenCalledWith("c1"))
    expect(enqueueMock).toHaveBeenCalledWith(
      expect.objectContaining({ command: "character_delete" })
    )
  })

  it("hides the delete button for built-in characters", () => {
    render(
      <CharacterDetailSheet open character={mkChar({ isBuiltIn: true })} onOpenChange={() => undefined} />
    )
    expect(screen.queryByTestId("character-delete")).not.toBeInTheDocument()
  })
})
