/**
 * @jest-environment jsdom
 */

import { render, screen, waitFor } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

jest.mock("@/lib/plugin/registries/character-pack-registry", () => ({
  listAllPackCharacters: jest.fn(() => [
    {
      pack: { id: "pack-a", name: "Pack A" },
      character: { localId: "alice", name: "Alice" },
      pluginId: "p1",
    },
  ]),
}))

jest.mock("@/lib/db/characters", () => ({
  listCharacters: jest.fn(() =>
    Promise.resolve([{ id: "char_alpha", name: "Alpha", systemPrompt: "" } as never])
  ),
}))

import { fireEvent } from "@testing-library/react"
import { CharacterSection } from "./character-section"
import { emptyEditorState } from "../preset-editor-state"

describe("CharacterSection", () => {
  it("renders the section title and the inherit option", async () => {
    render(<CharacterSection state={emptyEditorState()} onPatch={jest.fn()} defaultOpen={true} />)
    expect(screen.getByText("title")).toBeInTheDocument()
    await waitFor(() => expect(screen.getByText("inherit")).toBeInTheDocument())
  })

  describe("multiple mode", () => {
    it("renders a checklist and toggling a row emits onPatchMulti with ids", async () => {
      const onPatchMulti = jest.fn()
      render(
        <CharacterSection
          state={emptyEditorState()}
          onPatch={jest.fn()}
          defaultOpen
          multiple
          selectedIds={[]}
          onPatchMulti={onPatchMulti}
        />
      )
      // Two rows arrive after the async catalog load: dexie "Alpha" + pack "Alice".
      await waitFor(() => expect(screen.getByText("Alpha")).toBeInTheDocument())
      const checkboxes = screen.getAllByRole("checkbox")
      expect(checkboxes).toHaveLength(2)
      fireEvent.click(checkboxes[0])
      expect(onPatchMulti).toHaveBeenCalledWith(["char_alpha"])
    })

    it("unchecking a selected row removes it", async () => {
      const onPatchMulti = jest.fn()
      render(
        <CharacterSection
          state={emptyEditorState()}
          onPatch={jest.fn()}
          defaultOpen
          multiple
          selectedIds={["char_alpha"]}
          onPatchMulti={onPatchMulti}
        />
      )
      await waitFor(() => expect(screen.getByText("Alpha")).toBeInTheDocument())
      const checkboxes = screen.getAllByRole("checkbox")
      fireEvent.click(checkboxes[0])
      expect(onPatchMulti).toHaveBeenCalledWith([])
    })
  })
})
