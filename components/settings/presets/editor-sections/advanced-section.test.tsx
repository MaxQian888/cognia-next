/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

jest.mock("@/lib/tauri", () => ({
  isTauri: () => false,
}))

jest.mock("@tauri-apps/plugin-dialog", () => ({
  open: jest.fn(),
}))

jest.mock("sonner", () => ({
  toast: { error: jest.fn() },
}))

jest.mock("@/types/agent/agent-mode", () => ({
  BUILT_IN_AGENT_MODES: [
    { id: "default", name: "Default" },
    { id: "ask", name: "Ask" },
  ],
}))

jest.mock("@/stores/agent/custom-mode-store", () => ({
  useCustomModeStore: (selector: (s: { customModes: Record<string, unknown> }) => unknown) =>
    selector({ customModes: {} }),
}))

import { AdvancedSection } from "./advanced-section"
import { emptyEditorState } from "../preset-editor-state"

describe("AdvancedSection", () => {
  it("renders the working dir, agent mode, and flag toggles", () => {
    render(<AdvancedSection state={emptyEditorState()} onPatch={jest.fn()} defaultOpen />)
    expect(screen.getByText("Working directory")).toBeInTheDocument()
    expect(screen.getByText("Agent mode")).toBeInTheDocument()
    expect(screen.getByText("Set as default")).toBeInTheDocument()
    expect(screen.getByText("Favorite")).toBeInTheDocument()
  })

  it("invokes onPatch when working dir input changes", () => {
    const onPatch = jest.fn()
    render(<AdvancedSection state={emptyEditorState()} onPatch={onPatch} defaultOpen />)
    fireEvent.change(screen.getByPlaceholderText("/path/to/project (optional)"), {
      target: { value: "/tmp/project" },
    })
    expect(onPatch).toHaveBeenCalledWith({ workingDir: "/tmp/project" })
  })

  it("offers no pick-directory button where no picker exists", () => {
    // It used to render disabled. The path input beside it is the control on
    // such a shell, so a permanently-dead button only added noise.
    render(<AdvancedSection state={emptyEditorState()} onPatch={jest.fn()} defaultOpen />)
    expect(screen.queryByLabelText("Pick directory")).not.toBeInTheDocument()
  })

  it("invokes onPatch when isDefault toggle changes", () => {
    const onPatch = jest.fn()
    render(<AdvancedSection state={emptyEditorState()} onPatch={onPatch} defaultOpen />)
    const switches = screen.getAllByRole("switch")
    fireEvent.click(switches[0])
    expect(onPatch).toHaveBeenCalledWith({ isDefault: true })
  })

  it("invokes onPatch when isFavorite toggle changes", () => {
    const onPatch = jest.fn()
    render(<AdvancedSection state={emptyEditorState()} onPatch={onPatch} defaultOpen />)
    const switches = screen.getAllByRole("switch")
    fireEvent.click(switches[1])
    expect(onPatch).toHaveBeenCalledWith({ isFavorite: true })
  })

  it("renders content collapsed by default when defaultOpen is not set", () => {
    render(<AdvancedSection state={emptyEditorState()} onPatch={jest.fn()} />)
    expect(screen.queryByText("Working directory")).not.toBeInTheDocument()
  })
})
