/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

jest.mock("@/lib/claude/model-presets", () => ({
  MODEL_PRESET_VALUES: ["claude-sonnet-4-5", "claude-opus-4-7"],
  PERMISSION_MODE_VALUES: ["default", "acceptEdits", "plan", "bypassPermissions"],
}))

import { CapabilitySection } from "./capability-section"
import { emptyEditorState } from "../preset-editor-state"

describe("CapabilitySection", () => {
  it("renders the system prompt textarea and model/permission/effort selects", () => {
    render(<CapabilitySection state={emptyEditorState()} onPatch={jest.fn()} />)
    expect(screen.getByText("System prompt")).toBeInTheDocument()
    expect(screen.getByText("Model")).toBeInTheDocument()
    expect(screen.getByText("Permission mode")).toBeInTheDocument()
    expect(screen.getByText("Effort")).toBeInTheDocument()
  })

  it("invokes onPatch when system prompt changes", () => {
    const onPatch = jest.fn()
    render(<CapabilitySection state={emptyEditorState()} onPatch={onPatch} />)
    fireEvent.change(screen.getByPlaceholderText("You are…"), {
      target: { value: "You are a code reviewer." },
    })
    expect(onPatch).toHaveBeenCalledWith({ content: "You are a code reviewer." })
  })

  it("invokes onPatch when the custom model input changes", () => {
    const onPatch = jest.fn()
    render(<CapabilitySection state={emptyEditorState()} onPatch={onPatch} />)
    fireEvent.change(screen.getByPlaceholderText("Or paste a model id"), {
      target: { value: "claude-3-opus" },
    })
    expect(onPatch).toHaveBeenCalledWith({ model: "claude-3-opus" })
  })

  it("reflects the current model value in the custom input", () => {
    const state = { ...emptyEditorState(), model: "claude-3-opus" }
    render(<CapabilitySection state={state} onPatch={jest.fn()} />)
    expect(screen.getByPlaceholderText("Or paste a model id")).toHaveValue("claude-3-opus")
  })
})
