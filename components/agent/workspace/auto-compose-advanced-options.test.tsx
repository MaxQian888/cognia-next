/**
 * @jest-environment jsdom
 */

import React from "react"
import { fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import {
  AutoComposeAdvancedOptions,
  DEFAULT_AUTO_COMPOSE_OPTIONS,
  type AutoComposeOptions,
} from "./auto-compose-advanced-options"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

// Render shadcn Select as a native <select> so value changes are drivable.
jest.mock("@/components/ui/select", () => ({
  Select: ({
    value,
    onValueChange,
    children,
  }: {
    value: string
    onValueChange: (v: string) => void
    children: React.ReactNode
  }) =>
    React.createElement(
      "select",
      { value, onChange: (e: { target: { value: string } }) => onValueChange(e.target.value) },
      children
    ),
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: ({ children }: { children: React.ReactNode }) => children,
  SelectItem: ({ value, children }: { value: string; children: React.ReactNode }) =>
    React.createElement("option", { value }, children),
}))

// Render the Slider as a native range input.
jest.mock("@/components/ui/slider", () => ({
  Slider: ({
    value,
    onValueChange,
    ...rest
  }: {
    value: number[]
    onValueChange: (v: number[]) => void
    [k: string]: unknown
  }) =>
    React.createElement("input", {
      type: "range",
      "data-testid": rest["data-testid"],
      value: value?.[0],
      onChange: (e: { target: { value: string } }) => onValueChange([Number(e.target.value)]),
    }),
}))

function setup(overrides: Partial<AutoComposeOptions> = {}) {
  const onChange = jest.fn()
  const options = { ...DEFAULT_AUTO_COMPOSE_OPTIONS, ...overrides }
  render(<AutoComposeAdvancedOptions options={options} onChange={onChange} />)
  return { onChange, options }
}

/** Reveal the collapsed advanced panel so role queries see its content. */
function openPanel() {
  fireEvent.click(screen.getByTestId("auto-compose-advanced-trigger"))
}

describe("AutoComposeAdvancedOptions", () => {
  it("starts collapsed and reveals controls when the trigger is clicked", async () => {
    const user = userEvent.setup()
    setup()
    // Closed Radix Collapsible content is not mounted.
    expect(screen.queryByTestId("auto-compose-max-roster")).not.toBeInTheDocument()
    await user.click(screen.getByTestId("auto-compose-advanced-trigger"))
    expect(screen.getByTestId("auto-compose-max-roster")).toBeVisible()
  })

  it("emits an updated maxRoster from the slider", () => {
    const { onChange } = setup({ maxRoster: 6 })
    openPanel()
    fireEvent.change(screen.getByTestId("auto-compose-max-roster"), { target: { value: "9" } })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ maxRoster: 9 }))
  })

  it("emits a forced execution pattern from the select", () => {
    const { onChange } = setup()
    openPanel()
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "ultracode_orchestration" } })
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ preferredPattern: "ultracode_orchestration" })
    )
  })

  it("offers auto plus every execution pattern", () => {
    setup()
    openPanel()
    const options = screen.getAllByRole("option").map((o) => (o as HTMLOptionElement).value)
    expect(options).toEqual([
      "auto",
      "manager_worker",
      "parallel_specialists",
      "background_handoff",
      "external_handoff",
      "single_agent_recommended",
      "ultracode_orchestration",
    ])
  })

  it("toggles the run options and clarify switch", async () => {
    const user = userEvent.setup()
    const { onChange } = setup({
      requirePlanApproval: false,
      ultracode: false,
      clarifyEnabled: true,
    })
    await user.click(screen.getByTestId("auto-compose-advanced-trigger"))

    await user.click(screen.getByTestId("auto-compose-require-approval"))
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ requirePlanApproval: true }))

    await user.click(screen.getByTestId("auto-compose-ultracode"))
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ ultracode: true }))

    await user.click(screen.getByTestId("auto-compose-clarify-toggle"))
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ clarifyEnabled: false }))
  })

  it("consensus and verify toggles are mutually exclusive", async () => {
    const user = userEvent.setup()
    const { onChange } = setup({ consensusNeeded: false, verificationNeeded: true })
    await user.click(screen.getByTestId("auto-compose-advanced-trigger"))

    // Turning consensus ON also clears verify.
    await user.click(screen.getByTestId("auto-compose-consensus"))
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ consensusNeeded: true, verificationNeeded: false })
    )
  })

  it("turning verify on clears consensus", async () => {
    const user = userEvent.setup()
    const { onChange } = setup({ consensusNeeded: true, verificationNeeded: false })
    await user.click(screen.getByTestId("auto-compose-advanced-trigger"))
    await user.click(screen.getByTestId("auto-compose-verify"))
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ verificationNeeded: true, consensusNeeded: false })
    )
  })
})
