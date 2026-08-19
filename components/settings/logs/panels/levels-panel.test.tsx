/**
 * Driven against the real `useLogSettingsDraft`, so an edit made here has to
 * survive the same round-trip it does in the section — the panel's job is to
 * write into that draft, and a stubbed draft would prove nothing about it.
 */

const saveAppSettings = jest.fn(async () => undefined)
jest.mock("@/stores/settings", () => ({
  useSettingsStore: (selector: (state: { save: typeof saveAppSettings }) => unknown) =>
    selector({ save: saveAppSettings }),
}))

// The native (Rust) block is Tauri-gated and covered by its own test.
jest.mock("@/components/logging/native-log-levels", () => ({
  NativeLogLevels: () => null,
}))

import { useEffect } from "react"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { useLogSettingsDraft } from "@/hooks/logging/use-log-settings-draft"

import { LogsLevelsPanel } from "./levels-panel"

let draft: ReturnType<typeof useLogSettingsDraft>

function Harness() {
  const value = useLogSettingsDraft()
  // Captured in an effect, not during render: assigning to an outer binding
  // while rendering is a side effect the React compiler lint rejects.
  useEffect(() => {
    draft = value
  })
  return <LogsLevelsPanel draft={value} />
}

beforeEach(() => {
  window.localStorage.clear()
})

describe("LogsLevelsPanel", () => {
  it("shows the current global threshold as a single-line control", async () => {
    render(<Harness />)
    const trigger = screen.getByRole("combobox", { name: /Minimum Level/i })
    // Radix mirrors the whole option into the trigger; the options are
    // two-line, so the trigger renders its own single-line value.
    expect(trigger).toHaveTextContent(/^(Trace|Debug|Info|Warning|Error|Fatal)$/)
  })

  it("offers all six severities with their meaning", async () => {
    const user = userEvent.setup()
    render(<Harness />)

    await user.click(screen.getByRole("combobox", { name: /Minimum Level/i }))

    for (const level of ["Trace", "Debug", "Info", "Warning", "Error", "Fatal"]) {
      expect(screen.getByRole("option", { name: new RegExp(level) })).toBeInTheDocument()
    }
    expect(screen.getByRole("option", { name: /Most verbose/i })).toBeInTheDocument()
  })

  it("writes the chosen threshold into the draft", async () => {
    const user = userEvent.setup()
    render(<Harness />)

    await user.click(screen.getByRole("combobox", { name: /Minimum Level/i }))
    await user.click(screen.getByRole("option", { name: /Fatal/ }))

    expect(draft.config.minLevel).toBe("fatal")
    expect(draft.status).toBe("dirty")
  })

  it("toggles the two enrichment options independently", async () => {
    const user = userEvent.setup()
    render(<Harness />)

    const stack = screen.getByRole("switch", { name: /Include Stack Traces/i })
    const source = screen.getByRole("switch", { name: /Include Source Location/i })
    const sourceBefore = draft.config.includeSource

    await user.click(stack)

    expect(draft.config.includeStackTrace).toBe(false)
    expect(draft.config.includeSource).toBe(sourceBefore)
    expect(source).toBeInTheDocument()
  })

  it("says there are no overrides rather than showing an empty box", () => {
    render(<Harness />)
    expect(screen.getByText("No per-module overrides yet.")).toBeInTheDocument()
  })

  it("refuses to add an override with a blank module", async () => {
    const user = userEvent.setup()
    render(<Harness />)

    const add = screen.getByRole("button", { name: /Add Module/i })
    expect(add).toBeDisabled()

    await user.type(screen.getByLabelText("Module"), "   ")
    expect(add).toBeDisabled()
  })

  it("adds an override, then removes it", async () => {
    const user = userEvent.setup()
    render(<Harness />)

    await user.type(screen.getByLabelText("Module"), "network:lark")
    await user.click(screen.getByRole("button", { name: /Add Module/i }))

    expect(draft.config.perModuleLevels).toEqual({ "network:lark": "debug" })
    // The add form resets so the next override starts from a clean field.
    expect(screen.getByLabelText("Module")).toHaveValue("")

    await user.click(screen.getByRole("button", { name: /Remove network:lark override/i }))
    expect(draft.config.perModuleLevels).toEqual({})
  })

  it("changes the level of an existing override", async () => {
    const user = userEvent.setup()
    render(<Harness />)

    await user.type(screen.getByLabelText("Module"), "network:lark")
    await user.click(screen.getByRole("button", { name: /Add Module/i }))

    await user.click(screen.getByRole("combobox", { name: "network:lark" }))
    await user.click(screen.getByRole("option", { name: /Error/ }))

    expect(draft.config.perModuleLevels).toEqual({ "network:lark": "error" })
  })
})
