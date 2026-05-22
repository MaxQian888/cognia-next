/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

jest.mock("@/lib/ai/agent/external/presets", () => ({
  getAvailablePresets: jest.fn(() => ["claude-code", "codex"]),
  getPresetDisplayInfo: jest.fn((id: string) => ({
    name: id === "claude-code" ? "Claude Code" : "Codex",
    description: "",
    tags: [],
  })),
}))

import { ExternalPresetSection } from "./external-preset-section"
import { emptyEditorState } from "../preset-editor-state"

describe("ExternalPresetSection", () => {
  it("renders the section title (i18n keys returned verbatim from the mock)", () => {
    render(
      <ExternalPresetSection state={emptyEditorState()} onPatch={jest.fn()} defaultOpen={true} />
    )
    expect(screen.getByText("title")).toBeInTheDocument()
    expect(screen.getByText("pickerLabel")).toBeInTheDocument()
  })

  it("renders the inherit option when no preset is selected", () => {
    render(
      <ExternalPresetSection state={emptyEditorState()} onPatch={jest.fn()} defaultOpen={true} />
    )
    // The trigger value reflects the current selection; "inherit" appears
    // inside the closed select trigger via the SelectValue's render path.
    expect(screen.getByText("inherit")).toBeInTheDocument()
  })
})
