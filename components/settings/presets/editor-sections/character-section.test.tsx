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

import { CharacterSection } from "./character-section"
import { emptyEditorState } from "../preset-editor-state"

describe("CharacterSection", () => {
  it("renders the section title and the inherit option", async () => {
    render(<CharacterSection state={emptyEditorState()} onPatch={jest.fn()} defaultOpen={true} />)
    expect(screen.getByText("title")).toBeInTheDocument()
    await waitFor(() => expect(screen.getByText("inherit")).toBeInTheDocument())
  })
})
