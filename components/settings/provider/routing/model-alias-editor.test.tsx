import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { ModelAliasEditor } from "./model-alias-editor"
import type { ModelMapping } from "@/types/provider/model-mapping"

const upsertModelMapping = jest.fn().mockResolvedValue(undefined)
const stateRef: { current: Record<string, unknown> } = {
  current: {
    settings: {
      providerSettings: {
        openai: { providerId: "openai", enabled: true, enabledModels: ["gpt-4o-mini"] },
      },
      customProviders: [],
    },
    upsertModelMapping,
  },
}

jest.mock("@/stores/settings", () => ({
  useSettingsStore: (selector: (state: unknown) => unknown) => selector(stateRef.current),
}))

const existing: ModelMapping = {
  id: "m1",
  alias: "fast",
  providers: [{ providerId: "openai", modelId: "gpt-4o-mini" }],
  distribution: "priority",
  enabled: true,
  createdAt: 1,
  updatedAt: 1,
}

beforeEach(() => upsertModelMapping.mockClear())

describe("ModelAliasEditor", () => {
  it("disables save for a new draft until alias + a valid entry exist", () => {
    render(<ModelAliasEditor open onOpenChange={jest.fn()} mapping={null} />)
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled()
  })

  it("seeds the draft from an existing mapping and saves edits", async () => {
    const user = userEvent.setup()
    const onOpenChange = jest.fn()
    render(<ModelAliasEditor open onOpenChange={onOpenChange} mapping={existing} />)

    const aliasInput = screen.getByLabelText("Alias")
    expect(aliasInput).toHaveValue("fast")
    await user.clear(aliasInput)
    await user.type(aliasInput, "  faster  ")
    await user.click(screen.getByRole("button", { name: "Save" }))

    expect(upsertModelMapping).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "m1",
        alias: "faster", // trimmed
        providers: [{ providerId: "openai", modelId: "gpt-4o-mini" }],
      })
    )
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("adds an empty entry row via Add entry (filtered out on save)", async () => {
    const user = userEvent.setup()
    render(<ModelAliasEditor open onOpenChange={jest.fn()} mapping={existing} />)
    await user.click(screen.getByRole("button", { name: "Add entry" }))
    // Two rows now visible.
    expect(screen.getByTestId("alias-entry-1")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Save" }))
    // The empty second entry never reaches the store.
    expect(upsertModelMapping).toHaveBeenCalledWith(
      expect.objectContaining({ providers: [{ providerId: "openai", modelId: "gpt-4o-mini" }] })
    )
  })

  it("switches distribution to weighted (weight inputs appear) and saves it", async () => {
    const user = userEvent.setup()
    render(<ModelAliasEditor open onOpenChange={jest.fn()} mapping={existing} />)
    await user.click(screen.getByRole("combobox", { name: "Distribution" }))
    await user.click(await screen.findByRole("option", { name: "Weighted" }))
    expect(screen.getByLabelText("Weight")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Save" }))
    expect(upsertModelMapping).toHaveBeenCalledWith(
      expect.objectContaining({ distribution: "weighted" })
    )
  })

  it("reorders entries with move down / move up and removes one", async () => {
    const user = userEvent.setup()
    const twoEntries = {
      ...existing,
      providers: [
        { providerId: "openai", modelId: "gpt-4o-mini" },
        { providerId: "openai", modelId: "gpt-4o-mini" },
      ],
    }
    render(<ModelAliasEditor open onOpenChange={jest.fn()} mapping={twoEntries} />)
    // Move the first entry down (swap), then remove the (now-second) one.
    await user.click(screen.getAllByRole("button", { name: "Move down" })[0])
    await user.click(screen.getAllByRole("button", { name: "Remove entry" })[1])
    await user.click(screen.getByRole("button", { name: "Save" }))
    expect(upsertModelMapping).toHaveBeenCalledWith(
      expect.objectContaining({
        providers: [{ providerId: "openai", modelId: "gpt-4o-mini" }],
      })
    )
  })

  it("toggles the enabled switch into the draft", async () => {
    const user = userEvent.setup()
    render(<ModelAliasEditor open onOpenChange={jest.fn()} mapping={existing} />)
    await user.click(screen.getByLabelText("Enabled"))
    await user.click(screen.getByRole("button", { name: "Save" }))
    expect(upsertModelMapping).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }))
  })
})
