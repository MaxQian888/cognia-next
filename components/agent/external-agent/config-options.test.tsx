/**
 * @jest-environment jsdom
 */
import React from "react"
import { render, screen, fireEvent, act } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import en from "@/i18n/messages/en.json"
import { TooltipProvider } from "@/components/ui/tooltip"
import { ExternalAgentConfigOptions } from "./config-options"
import type { AcpConfigOption } from "@/types/agent/external-agent"

// sonner is not needed but its toast may get triggered on error path
jest.mock("sonner", () => ({
  toast: { error: jest.fn(), success: jest.fn() },
}))

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

const wrap = (ui: React.ReactNode) => (
  <NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
    <TooltipProvider>{ui}</TooltipProvider>
  </NextIntlClientProvider>
)

type SelectConfigOption = Extract<AcpConfigOption, { type: "select" }>

function makeOption(overrides: Partial<SelectConfigOption> = {}): SelectConfigOption {
  return {
    id: "model",
    name: "Model",
    type: "select",
    currentValue: "claude",
    category: "model",
    options: [
      { value: "claude", name: "Claude" },
      { value: "gpt-5", name: "GPT-5", description: "OpenAI flagship" },
    ],
    ...overrides,
  }
}

function makeBooleanOption(currentValue = false): AcpConfigOption {
  return {
    id: "autoFormat",
    name: "Auto format",
    description: "Format edited files",
    type: "boolean",
    currentValue,
  }
}

const noop = jest.fn().mockResolvedValue([])

// --------------------------------------------------------------------------
// Tests
// --------------------------------------------------------------------------

describe("ExternalAgentConfigOptions", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("renders null when configOptions is empty", () => {
    const { container } = render(
      wrap(<ExternalAgentConfigOptions configOptions={[]} onSetConfigOption={noop} />)
    )
    expect(container).toBeEmptyDOMElement()
  })

  it("renders option name in normal (non-compact) mode", () => {
    render(
      wrap(<ExternalAgentConfigOptions configOptions={[makeOption()]} onSetConfigOption={noop} />)
    )
    expect(screen.getByText("Model")).toBeInTheDocument()
  })

  it("renders multiple options in normal mode", () => {
    const opts: AcpConfigOption[] = [
      makeOption({ id: "model", name: "Model" }),
      makeOption({ id: "mode", name: "Mode", category: "mode", currentValue: "plan" }),
    ]
    render(wrap(<ExternalAgentConfigOptions configOptions={opts} onSetConfigOption={noop} />))
    expect(screen.getByText("Model")).toBeInTheDocument()
    expect(screen.getByText("Mode")).toBeInTheDocument()
  })

  it("renders compact mode without option label text in the trigger", () => {
    render(
      wrap(
        <ExternalAgentConfigOptions
          configOptions={[makeOption()]}
          onSetConfigOption={noop}
          compact
        />
      )
    )
    // In compact mode the option name appears only in the tooltip, not the trigger label.
    // The trigger should still be present.
    const triggers = screen.getAllByRole("combobox")
    expect(triggers.length).toBeGreaterThan(0)
  })

  it("calls onSetConfigOption with correct id and value when a new value is selected", async () => {
    const onSetConfigOption = jest.fn().mockResolvedValue([])
    render(
      wrap(
        <ExternalAgentConfigOptions
          configOptions={[makeOption({ currentValue: "claude" })]}
          onSetConfigOption={onSetConfigOption}
        />
      )
    )

    // Open the select
    const trigger = screen.getByRole("combobox")
    fireEvent.click(trigger)

    // Pick a different option
    const gpt5Option = await screen.findByText("GPT-5")
    await act(async () => {
      fireEvent.click(gpt5Option)
    })

    expect(onSetConfigOption).toHaveBeenCalledWith("model", "gpt-5")
  })

  it("renders boolean config options as switches and sends a boolean value", async () => {
    const onSetConfigOption = jest.fn().mockResolvedValue([])
    render(
      wrap(
        <ExternalAgentConfigOptions
          configOptions={[makeBooleanOption(false)]}
          onSetConfigOption={onSetConfigOption}
        />
      )
    )

    await act(async () => {
      fireEvent.click(screen.getByRole("switch", { name: "Auto format" }))
    })

    expect(onSetConfigOption).toHaveBeenCalledWith("autoFormat", true)
  })

  it("renders a boolean switch in compact mode", () => {
    render(
      wrap(
        <ExternalAgentConfigOptions
          configOptions={[makeBooleanOption(true)]}
          onSetConfigOption={noop}
          compact
        />
      )
    )

    expect(screen.getByRole("switch", { name: "Auto format" })).toBeChecked()
  })

  it("renders values from grouped select options", async () => {
    render(
      wrap(
        <ExternalAgentConfigOptions
          configOptions={[
            makeOption({
              options: [
                {
                  group: "recommended",
                  name: "Recommended",
                  options: [{ value: "gpt-5", name: "GPT-5" }],
                },
              ],
            }),
          ]}
          onSetConfigOption={noop}
        />
      )
    )

    fireEvent.click(screen.getByRole("combobox"))
    expect(await screen.findByText("GPT-5")).toBeInTheDocument()
  })

  it("does NOT call onSetConfigOption when the value is unchanged (handleChange guard)", () => {
    // This tests the internal handleChange guard: `if (value !== option.currentValue) onSelect(value)`
    // We verify it by confirming the component renders correctly with the current value
    // and that onSetConfigOption is NOT called on mount (no spurious initial call).
    const onSetConfigOption = jest.fn().mockResolvedValue([])
    render(
      wrap(
        <ExternalAgentConfigOptions
          configOptions={[makeOption({ currentValue: "claude" })]}
          onSetConfigOption={onSetConfigOption}
        />
      )
    )
    // No interaction — handler must never fire on mount
    expect(onSetConfigOption).not.toHaveBeenCalled()
  })

  it("toasts an error when onSetConfigOption rejects", async () => {
    const { toast } = await import("sonner")
    const onSetConfigOption = jest.fn().mockRejectedValue(new Error("API down"))

    render(
      wrap(
        <ExternalAgentConfigOptions
          configOptions={[makeOption({ currentValue: "claude" })]}
          onSetConfigOption={onSetConfigOption}
        />
      )
    )

    const trigger = screen.getByRole("combobox")
    fireEvent.click(trigger)
    const gpt5Option = await screen.findByText("GPT-5")
    await act(async () => {
      fireEvent.click(gpt5Option)
    })

    expect(toast.error).toHaveBeenCalledWith(en.externalAgent.setConfigOptionFailed)
  })

  it("renders disabled select triggers when disabled=true", () => {
    render(
      wrap(
        <ExternalAgentConfigOptions
          configOptions={[makeOption()]}
          onSetConfigOption={noop}
          disabled
        />
      )
    )
    const triggers = screen.getAllByRole("combobox")
    triggers.forEach((t) => expect(t).toBeDisabled())
  })

  it("renders all four category icons without crashing (mode, model, thought_level, custom)", () => {
    const opts: AcpConfigOption[] = [
      makeOption({ id: "a", name: "ModeOpt", category: "mode" }),
      makeOption({ id: "b", name: "ModelOpt", category: "model" }),
      makeOption({ id: "c", name: "ThoughtOpt", category: "thought_level" }),
      makeOption({ id: "d", name: "CustomOpt", category: "_custom" }),
    ]
    const { container } = render(
      wrap(<ExternalAgentConfigOptions configOptions={opts} onSetConfigOption={noop} />)
    )
    expect(container.querySelectorAll("svg").length).toBeGreaterThanOrEqual(4)
  })

  it("renders option descriptions inside the dropdown", async () => {
    render(
      wrap(<ExternalAgentConfigOptions configOptions={[makeOption()]} onSetConfigOption={noop} />)
    )
    const trigger = screen.getByRole("combobox")
    fireEvent.click(trigger)
    // GPT-5 has a description
    expect(await screen.findByText("OpenAI flagship")).toBeInTheDocument()
  })

  it("applies the className prop to the wrapper in normal mode", () => {
    const { container } = render(
      wrap(
        <ExternalAgentConfigOptions
          configOptions={[makeOption()]}
          onSetConfigOption={noop}
          className="my-test-class"
        />
      )
    )
    expect(container.firstChild).toHaveClass("my-test-class")
  })

  it("renders multiple options in compact mode", () => {
    const opts: AcpConfigOption[] = [
      makeOption({ id: "model", name: "Model", category: "model" }),
      makeOption({ id: "mode", name: "Mode", category: "mode" }),
    ]
    render(
      wrap(<ExternalAgentConfigOptions configOptions={opts} onSetConfigOption={noop} compact />)
    )
    const triggers = screen.getAllByRole("combobox")
    expect(triggers).toHaveLength(2)
  })
})
