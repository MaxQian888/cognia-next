/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

jest.mock("@/lib/plugin/registries/native-anthropic-tool-registry", () => ({
  listNativeAnthropicToolEntries: jest.fn(),
}))

import { listNativeAnthropicToolEntries } from "@/lib/plugin/registries/native-anthropic-tool-registry"
import { NativeToolsSection } from "./native-tools-section"
import { emptyEditorState } from "../preset-editor-state"

function renderSection(initialIds?: string[]) {
  const onPatch = jest.fn()
  const utils = render(
    <NativeToolsSection
      state={{ ...emptyEditorState(), nativeAnthropicToolIds: initialIds }}
      onPatch={onPatch}
      defaultOpen={true}
    />
  )
  return { ...utils, onPatch }
}

describe("NativeToolsSection", () => {
  beforeEach(() => {
    ;(listNativeAnthropicToolEntries as jest.Mock).mockReset()
  })

  it("renders an empty hint when no native tools are registered", () => {
    ;(listNativeAnthropicToolEntries as jest.Mock).mockReturnValue([])
    renderSection()
    expect(screen.getByText("empty")).toBeInTheDocument()
  })

  it("renders each tool with type badge + pluginId badge + permission hint when computer-use", () => {
    ;(listNativeAnthropicToolEntries as jest.Mock).mockReturnValue([
      {
        id: "computer",
        entry: {
          id: "computer",
          name: "Computer Use",
          type: "computer_20251124",
        },
        pluginId: "my-plugin",
      },
    ])
    renderSection()
    expect(screen.getByText("Computer Use")).toBeInTheDocument()
    expect(screen.getByText("computer_20251124")).toBeInTheDocument()
    expect(screen.getByText("my-plugin")).toBeInTheDocument()
    expect(screen.getByText("requiresNativeInputPermission")).toBeInTheDocument()
  })

  it("toggling a row calls onPatch with the updated id list", () => {
    ;(listNativeAnthropicToolEntries as jest.Mock).mockReturnValue([
      { id: "a", entry: { id: "a", name: "A", type: "bash_20250124" }, pluginId: "p" },
    ])
    const { onPatch } = renderSection()
    const checkbox = screen.getByRole("checkbox")
    fireEvent.click(checkbox)
    expect(onPatch).toHaveBeenCalledWith({ nativeAnthropicToolIds: ["a"] })
  })

  it("unchecking the last selected tool patches undefined", () => {
    ;(listNativeAnthropicToolEntries as jest.Mock).mockReturnValue([
      { id: "a", entry: { id: "a", name: "A", type: "bash_20250124" }, pluginId: "p" },
    ])
    const { onPatch } = renderSection(["a"])
    fireEvent.click(screen.getByRole("checkbox"))
    expect(onPatch).toHaveBeenCalledWith({ nativeAnthropicToolIds: undefined })
  })
})
