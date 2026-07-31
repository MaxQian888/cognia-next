/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen } from "@testing-library/react"
import type { HookGroup } from "@/lib/claude/hooks"
import { HookGroupEditor, validateMatcher } from "./hook-group-editor"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

// The child HookHandlerForm renders the shared CodeMirror `LightCodeEditor` for
// the command field; CM6 measures the DOM and crashes under jsdom. Swap it for a
// plain textarea honouring the same value/onChange(string)/data-testid contract.
jest.mock("@/components/editor/light-code-editor", () => ({
  LightCodeEditor: ({
    value,
    onChange,
    "data-testid": testId,
    "aria-label": ariaLabel,
  }: {
    value: string
    onChange: (next: string) => void
    "data-testid"?: string
    "aria-label"?: string
  }) => (
    <textarea
      data-testid={testId}
      aria-label={ariaLabel}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  ),
}))

describe("validateMatcher", () => {
  it("returns null for empty / undefined / '*'", () => {
    expect(validateMatcher(undefined)).toBeNull()
    expect(validateMatcher("")).toBeNull()
    expect(validateMatcher("   ")).toBeNull()
    expect(validateMatcher("*")).toBeNull()
  })

  it("accepts simple tool name", () => {
    expect(validateMatcher("Bash")).toBeNull()
  })

  it("accepts pipe alternation (regex syntax)", () => {
    expect(validateMatcher("Bash|Write|Edit")).toBeNull()
  })

  it("rejects malformed regex", () => {
    expect(validateMatcher("[unclosed")).not.toBeNull()
  })
})

describe("HookGroupEditor", () => {
  const baseGroup: HookGroup = { matcher: "Bash", hooks: [] }

  function setup(group: Partial<HookGroup> = {}) {
    const value: HookGroup = { ...baseGroup, ...group }
    const onChange = jest.fn()
    const onRemove = jest.fn()
    render(<HookGroupEditor value={value} onChange={onChange} onRemove={onRemove} />)
    return { onChange, onRemove }
  }

  it("renders matcher input populated with the current matcher", () => {
    setup({ matcher: "Edit" })
    expect((screen.getByTestId("group-matcher") as HTMLInputElement).value).toBe("Edit")
  })

  it("typing into the matcher emits the new value (empty string → undefined)", () => {
    const { onChange } = setup({ matcher: "Bash" })
    fireEvent.change(screen.getByTestId("group-matcher"), { target: { value: "" } })
    expect(onChange).toHaveBeenCalledWith({ matcher: undefined, hooks: [] })

    fireEvent.change(screen.getByTestId("group-matcher"), { target: { value: "Write" } })
    expect(onChange).toHaveBeenLastCalledWith({ matcher: "Write", hooks: [] })
  })

  it("shows the regex error banner for malformed matcher", () => {
    setup({ matcher: "[oops" })
    expect(screen.getByTestId("group-matcher-error")).toBeInTheDocument()
  })

  it("hides the error when matcher is valid", () => {
    setup({ matcher: "Bash|Write" })
    expect(screen.queryByTestId("group-matcher-error")).not.toBeInTheDocument()
  })

  it("renders empty-handlers placeholder when hooks list is empty", () => {
    setup({ hooks: [] })
    expect(screen.getByTestId("group-empty-handlers")).toBeInTheDocument()
  })

  it("clicking 'Add handler' appends a default command handler", () => {
    const { onChange } = setup({ hooks: [] })
    fireEvent.click(screen.getByTestId("group-add-handler"))
    expect(onChange).toHaveBeenCalledWith({
      matcher: "Bash",
      hooks: [{ type: "command", command: "" }],
    })
  })

  it("editing a handler bubbles up an updated handlers array (immutable)", () => {
    const { onChange } = setup({
      hooks: [
        { type: "command", command: "x" },
        { type: "command", command: "y" },
      ],
    })
    // First child handler-command — change it.
    const cmdInputs = screen.getAllByTestId("handler-command")
    fireEvent.change(cmdInputs[0], { target: { value: "z" } })
    expect(onChange).toHaveBeenCalledWith({
      matcher: "Bash",
      hooks: [
        { type: "command", command: "z" },
        { type: "command", command: "y" },
      ],
    })
  })

  it("removing a handler drops it by index", () => {
    const { onChange } = setup({
      hooks: [
        { type: "command", command: "first" },
        { type: "command", command: "second" },
      ],
    })
    fireEvent.click(screen.getAllByTestId("handler-remove")[0])
    expect(onChange).toHaveBeenCalledWith({
      matcher: "Bash",
      hooks: [{ type: "command", command: "second" }],
    })
  })

  it("clicking the group's Remove button calls onRemove", () => {
    const { onRemove } = setup({})
    fireEvent.click(screen.getByTestId("group-remove"))
    expect(onRemove).toHaveBeenCalled()
  })
})
