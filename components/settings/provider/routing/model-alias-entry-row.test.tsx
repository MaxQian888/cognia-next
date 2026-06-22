import { fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { ModelAliasEntryRow } from "./model-alias-entry-row"
import type { ModelMappingEntry } from "@cognia/provider-types/model-mapping"

const stateRef: { current: Record<string, unknown> } = {
  current: {
    settings: {
      providerSettings: {
        openai: { providerId: "openai", enabled: true, enabledModels: ["gpt-4o-mini"] },
      },
      customProviders: [],
    },
  },
}

jest.mock("@/stores/settings", () => ({
  useSettingsStore: (selector: (state: unknown) => unknown) => selector(stateRef.current),
}))

const entry: ModelMappingEntry = { providerId: "openai", modelId: "gpt-4o-mini" }

function renderRow(over: Partial<Parameters<typeof ModelAliasEntryRow>[0]> = {}) {
  const props = {
    entry,
    index: 0,
    total: 2,
    showWeight: false,
    onChange: jest.fn(),
    onMove: jest.fn(),
    onRemove: jest.fn(),
    ...over,
  }
  render(<ModelAliasEntryRow {...props} />)
  return props
}

describe("ModelAliasEntryRow", () => {
  it("hides the weight input for priority distribution and shows it for weighted", () => {
    renderRow({ showWeight: false })
    expect(screen.queryByLabelText("Weight")).not.toBeInTheDocument()
  })

  it("propagates weight changes", async () => {
    const user = userEvent.setup()
    const props = renderRow({ showWeight: true })
    await user.type(screen.getByLabelText("Weight"), "3")
    expect(props.onChange).toHaveBeenCalledWith(expect.objectContaining({ weight: 3 }))
  })

  it("edits conditions through the popover", async () => {
    const user = userEvent.setup()
    const props = renderRow()
    await user.click(screen.getByRole("button", { name: "Entry conditions" }))
    await user.type(await screen.findByLabelText("Max price (USD / 1M tokens)"), "5")
    expect(props.onChange).toHaveBeenCalledWith(
      expect.objectContaining({ conditions: expect.objectContaining({ maxCostPer1M: 5 }) })
    )
    fireEvent.change(screen.getByLabelText("Max P50 latency (ms)"), { target: { value: "900" } })
    expect(props.onChange).toHaveBeenCalledWith(
      expect.objectContaining({ conditions: expect.objectContaining({ maxLatencyMs: 900 }) })
    )
  })

  it("maps cleared/invalid numeric input to undefined", async () => {
    const user = userEvent.setup()
    const props = renderRow({
      showWeight: true,
      entry: { ...entry, weight: 2, conditions: { maxCostPer1M: 5 } },
    })
    await user.clear(screen.getByLabelText("Weight"))
    expect(props.onChange).toHaveBeenCalledWith(expect.objectContaining({ weight: undefined }))
    await user.click(screen.getByRole("button", { name: "Entry conditions" }))
    await user.clear(await screen.findByLabelText("Max price (USD / 1M tokens)"))
    expect(props.onChange).toHaveBeenCalledWith(
      expect.objectContaining({ conditions: expect.objectContaining({ maxCostPer1M: undefined }) })
    )
  })

  it("selecting a model through the picker propagates both ids", async () => {
    const user = userEvent.setup()
    const props = renderRow()
    await user.click(screen.getByRole("button", { name: "Provider and model" }))
    await user.click(await screen.findByText("gpt-4o-mini"))
    expect(props.onChange).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: "openai", modelId: "gpt-4o-mini" })
    )
  })

  it("disables move-up at the top and move-down at the bottom", () => {
    renderRow({ index: 0, total: 1 })
    expect(screen.getByRole("button", { name: "Move up" })).toBeDisabled()
    expect(screen.getByRole("button", { name: "Move down" })).toBeDisabled()
  })

  it("fires move and remove callbacks", async () => {
    const user = userEvent.setup()
    const props = renderRow({ index: 1, total: 3 })
    await user.click(screen.getByRole("button", { name: "Move up" }))
    expect(props.onMove).toHaveBeenCalledWith(-1)
    await user.click(screen.getByRole("button", { name: "Move down" }))
    expect(props.onMove).toHaveBeenCalledWith(1)
    await user.click(screen.getByRole("button", { name: "Remove entry" }))
    expect(props.onRemove).toHaveBeenCalled()
  })
})
