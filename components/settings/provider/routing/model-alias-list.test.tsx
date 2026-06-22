import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { ModelAliasList } from "./model-alias-list"
import type { ModelMapping } from "@cognia/provider-types/model-mapping"

const removeModelMapping = jest.fn().mockResolvedValue(undefined)
const upsertModelMapping = jest.fn().mockResolvedValue(undefined)
const stateRef: { current: Record<string, unknown> } = { current: {} }

jest.mock("@/stores/settings", () => ({
  useSettingsStore: (selector: (state: unknown) => unknown) => selector(stateRef.current),
}))

const mapping = (id: string, alias: string, over: Partial<ModelMapping> = {}): ModelMapping => ({
  id,
  alias,
  providers: [
    { providerId: "groq", modelId: "llama" },
    { providerId: "openai", modelId: "gpt-4o-mini" },
  ],
  distribution: "priority",
  enabled: true,
  createdAt: 1,
  updatedAt: 1,
  ...over,
})

function setSettings(mappings: ModelMapping[]) {
  stateRef.current = {
    settings: { modelMappings: mappings, providerSettings: {}, customProviders: [] },
    removeModelMapping,
    upsertModelMapping,
  }
}

beforeEach(() => {
  removeModelMapping.mockClear()
  upsertModelMapping.mockClear()
})

describe("ModelAliasList", () => {
  it("shows the empty state when no aliases exist", () => {
    setSettings([])
    render(<ModelAliasList />)
    expect(screen.getByText("No aliases yet")).toBeInTheDocument()
  })

  it("renders alias rows with their fallback chain and disabled badge", () => {
    setSettings([mapping("m1", "fast"), mapping("m2", "smart", { enabled: false })])
    render(<ModelAliasList />)
    expect(screen.getByTestId("alias-row-fast")).toBeInTheDocument()
    expect(screen.getAllByText("groq:llama").length).toBeGreaterThan(0)
    expect(screen.getByText("Disabled")).toBeInTheDocument()
  })

  it("deletes an alias through the store action", async () => {
    const user = userEvent.setup()
    setSettings([mapping("m1", "fast")])
    render(<ModelAliasList />)
    await user.click(screen.getByRole("button", { name: "Delete alias" }))
    expect(removeModelMapping).toHaveBeenCalledWith("m1")
  })

  it("opens the editor pre-seeded from the edit button", async () => {
    const user = userEvent.setup()
    setSettings([mapping("m1", "fast")])
    render(<ModelAliasList />)
    await user.click(screen.getByRole("button", { name: "Edit alias" }))
    const dialog = await screen.findByRole("dialog")
    expect(dialog).toBeInTheDocument()
    expect(screen.getByLabelText("Alias")).toHaveValue("fast")
  })

  it("opens the editor dialog from the add button", async () => {
    const user = userEvent.setup()
    setSettings([])
    render(<ModelAliasList />)
    await user.click(screen.getByRole("button", { name: /Add alias/ }))
    expect(await screen.findByRole("dialog")).toBeInTheDocument()
  })
})
