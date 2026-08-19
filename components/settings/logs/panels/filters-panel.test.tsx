/**
 * The sampling half of this panel is where the pre-redesign UI lied: it seeded
 * five rules into the list that the runtime had never applied. The empty state
 * and the explicit preset action are the fix, so both are pinned here.
 */

const saveAppSettings = jest.fn(async () => undefined)
jest.mock("@/stores/settings", () => ({
  useSettingsStore: (selector: (state: { save: typeof saveAppSettings }) => unknown) =>
    selector({ save: saveAppSettings }),
}))

import { useEffect } from "react"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import {
  CONFIG_BOUNDS,
  LOGGING_SAMPLING_STORAGE_KEY,
  RECOMMENDED_SAMPLING_RATES,
} from "@/lib/logging"
import { useLogSettingsDraft } from "@/hooks/logging/use-log-settings-draft"

import { LogsFiltersPanel } from "./filters-panel"

let draft: ReturnType<typeof useLogSettingsDraft>

function Harness() {
  const value = useLogSettingsDraft()
  useEffect(() => {
    draft = value
  })
  return <LogsFiltersPanel draft={value} />
}

beforeEach(() => {
  window.localStorage.clear()
})

describe("redaction", () => {
  it("reports how many rules the default redactor matches", () => {
    render(<Harness />)
    const block = screen.getByTestId("logs-filters-redaction")
    expect(block).toHaveTextContent(/\d+ sensitive key names and \d+ value patterns/)
  })

  it("inerts the depth slider when redaction is off, since it would do nothing", async () => {
    const user = userEvent.setup()
    render(<Harness />)

    await user.click(screen.getByRole("switch", { name: /Enable Redaction/i }))
    expect(draft.config.redaction?.enabled).toBe(false)

    // Radix marks a disabled slider with `data-disabled` rather than the
    // `disabled` attribute `toBeDisabled()` looks for, so assert the marker
    // and, more importantly, that the control no longer moves.
    const slider = screen.getByRole("slider", { name: /Redaction Depth/i })
    expect(slider).toHaveAttribute("data-disabled")

    const before = draft.config.redaction?.maxDepth
    slider.focus()
    await userEvent.keyboard("{ArrowRight}")
    expect(draft.config.redaction?.maxDepth).toBe(before)
  })

  it("writes the depth into the draft", async () => {
    render(<Harness />)
    const slider = screen.getByRole("slider", { name: /Redaction Depth/i })
    const before = draft.config.redaction?.maxDepth ?? 0

    slider.focus()
    await userEvent.keyboard("{ArrowRight}")

    expect(draft.config.redaction?.maxDepth).toBe(before + 1)
  })
})

describe("sampling", () => {
  it("shows an empty list when nothing is configured, and says what that means", () => {
    render(<Harness />)
    expect(screen.getByTestId("logs-sampling-empty")).toHaveTextContent(
      "No sampling rules. Every module logs at 100%."
    )
  })

  it("loads the rules the runtime actually has", () => {
    window.localStorage.setItem(
      LOGGING_SAMPLING_STORAGE_KEY,
      JSON.stringify({ mouse: 0.01, error: 1 })
    )
    render(<Harness />)

    expect(screen.getByTestId("logs-sampling-rule-mouse")).toHaveTextContent("1%")
    expect(screen.getByTestId("logs-sampling-rule-error")).toHaveTextContent("100%")
    expect(screen.queryByTestId("logs-sampling-empty")).not.toBeInTheDocument()
  })

  it("applies the recommended preset only when the user asks for it", async () => {
    const user = userEvent.setup()
    render(<Harness />)

    await user.click(screen.getByTestId("logs-sampling-apply-preset"))

    for (const [prefix, rate] of Object.entries(RECOMMENDED_SAMPLING_RATES)) {
      expect(screen.getByTestId(`logs-sampling-rule-${prefix}`)).toHaveTextContent(
        `${Math.round(rate * 100)}%`
      )
    }
    // Still a draft: nothing reaches the runtime until the section saves.
    expect(window.localStorage.getItem(LOGGING_SAMPLING_STORAGE_KEY)).toBeNull()
  })

  it("hides the preset action once there are rules to overwrite", async () => {
    const user = userEvent.setup()
    render(<Harness />)

    await user.click(screen.getByTestId("logs-sampling-apply-preset"))

    expect(screen.queryByTestId("logs-sampling-apply-preset")).not.toBeInTheDocument()
  })

  it("refuses to add a rule with a blank prefix", async () => {
    const user = userEvent.setup()
    render(<Harness />)

    const add = screen.getByRole("button", { name: /Add Rule/i })
    expect(add).toBeDisabled()

    await user.type(screen.getByLabelText("Module Prefix"), "  ")
    expect(add).toBeDisabled()
  })

  it("adds a rule and resets the form", async () => {
    const user = userEvent.setup()
    render(<Harness />)

    await user.type(screen.getByLabelText("Module Prefix"), "scroll")
    await user.click(screen.getByRole("button", { name: /Add Rule/i }))

    expect(draft.samplingRules).toEqual([{ modulePrefix: "scroll", percentage: 100 }])
    expect(screen.getByLabelText("Module Prefix")).toHaveValue("")
  })

  it("updates an existing prefix instead of appending a duplicate", async () => {
    const user = userEvent.setup()
    render(<Harness />)

    await user.type(screen.getByLabelText("Module Prefix"), "scroll")
    await user.click(screen.getByRole("button", { name: /Add Rule/i }))

    // Exact name: the added rule's own slider is labelled "scroll — Sampling
    // Rate", so a loose matcher finds two.
    const percentage = screen.getByRole("slider", { name: "Sampling Rate" })
    percentage.focus()
    await userEvent.keyboard("{ArrowLeft}")
    await user.type(screen.getByLabelText("Module Prefix"), "scroll")
    await user.click(screen.getByRole("button", { name: /Add Rule/i }))

    expect(draft.samplingRules).toEqual([{ modulePrefix: "scroll", percentage: 99 }])
  })

  it("removes a rule", async () => {
    const user = userEvent.setup()
    render(<Harness />)

    await user.type(screen.getByLabelText("Module Prefix"), "scroll")
    await user.click(screen.getByRole("button", { name: /Add Rule/i }))
    await user.click(screen.getByRole("button", { name: /Remove Rule scroll/i }))

    expect(draft.samplingRules).toEqual([])
    expect(screen.getByTestId("logs-sampling-empty")).toBeInTheDocument()
  })
})

describe("diagnostic throttling", () => {
  it("offers the full range the sanitizer accepts", () => {
    render(<Harness />)
    const slider = screen.getByRole("slider", { name: /Diagnostic Rate Limit/i })
    expect(slider).toHaveAttribute("aria-valuemin", String(CONFIG_BOUNDS.diagnosticRateLimitMs.min))
    expect(slider).toHaveAttribute("aria-valuemax", String(CONFIG_BOUNDS.diagnosticRateLimitMs.max))
  })

  it("writes the rate limit into the draft in milliseconds", async () => {
    render(<Harness />)
    const slider = screen.getByRole("slider", { name: /Diagnostic Rate Limit/i })
    const before = draft.config.diagnosticRateLimitMs

    slider.focus()
    await userEvent.keyboard("{ArrowRight}")

    expect(draft.config.diagnosticRateLimitMs).toBe(before + 250)
  })
})
