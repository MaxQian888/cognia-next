/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import type { ProviderPreset } from "@/types/subscription"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

// Deterministic template set so the dropdown content is predictable.
jest.mock("@/types/subscription/preset-templates", () => ({
  buildPresetTemplates: (provider: "anthropic" | "codex") => [
    { templateId: "custom", label: "Custom", baseUrl: "", provider },
    {
      templateId: "bedrock",
      label: "AWS Bedrock",
      baseUrl: "https://bedrock.example.com",
      provider,
    },
  ],
}))

let uuidCounter = 0
jest.mock("@/lib/subscription/core/uuidv7", () => ({
  uuidv7: () => `uuid-${++uuidCounter}`,
}))

const saveMock = jest.fn(async (_: ProviderPreset) => undefined)
const removeMock = jest.fn(async (_: string) => undefined)
const setDefaultMock = jest.fn(async (_: string | null) => undefined)

const mockState: { presets: ProviderPreset[]; defaultPresetId: string | null; loading: boolean } = {
  presets: [],
  defaultPresetId: null,
  loading: false,
}

jest.mock("@/lib/subscription/core/hooks", () => ({
  useProviderPresets: () => ({
    presets: mockState.presets,
    defaultPresetId: mockState.defaultPresetId,
    loading: mockState.loading,
    save: (p: ProviderPreset) => saveMock(p),
    remove: (id: string) => removeMock(id),
    setDefault: (id: string | null) => setDefaultMock(id),
  }),
}))

import { PresetPicker } from "./preset-picker"

const PRESET_A: ProviderPreset = {
  id: "a",
  label: "Bedrock Prod",
  baseUrl: "https://a.example.com",
}
const PRESET_B: ProviderPreset = {
  id: "b",
  label: "Azure",
  baseUrl: "https://b.example.com",
  modelMapping: { default: "gpt-4o", fast: "gpt-4o-mini" },
}

beforeEach(() => {
  jest.clearAllMocks()
  uuidCounter = 0
  mockState.presets = [PRESET_A, PRESET_B]
  mockState.defaultPresetId = "a"
  mockState.loading = false
})

describe("PresetPicker library", () => {
  it("lists every preset and badges the default", () => {
    render(<PresetPicker provider="anthropic" />)
    expect(screen.getByText("Bedrock Prod")).toBeInTheDocument()
    expect(screen.getByText("Azure")).toBeInTheDocument()
    // Only the default row shows the default badge.
    const badges = screen.getAllByTestId("selectable-preset-card-badge")
    expect(badges).toHaveLength(1)
    expect(badges[0]).toHaveTextContent("defaultBadge")
  })

  it("shows the inactive card when the library is empty", () => {
    mockState.presets = []
    mockState.defaultPresetId = null
    render(<PresetPicker provider="anthropic" />)
    expect(screen.getByText("noPreset")).toBeInTheDocument()
  })

  it("sets a non-default preset as default", () => {
    render(<PresetPicker provider="anthropic" />)
    fireEvent.click(screen.getByText("setDefault"))
    expect(setDefaultMock).toHaveBeenCalledWith("b")
  })

  it("does not render Set default on the row that is already default", () => {
    render(<PresetPicker provider="anthropic" />)
    // Only one "setDefault" button (for the non-default row B).
    expect(screen.getAllByText("setDefault")).toHaveLength(1)
  })

  it("opens a blank editor from Add preset and round-trips modelMapping", async () => {
    mockState.presets = []
    mockState.defaultPresetId = null
    render(<PresetPicker provider="anthropic" />)
    fireEvent.click(screen.getByText("addPreset"))

    fireEvent.change(screen.getByLabelText("labelField"), { target: { value: "My Relay" } })
    fireEvent.change(screen.getByLabelText("baseUrlField"), {
      target: { value: "https://relay.example.com" },
    })
    fireEvent.change(screen.getByLabelText("defaultModelField"), {
      target: { value: "claude-sonnet" },
    })
    fireEvent.change(screen.getByLabelText("fastModelField"), {
      target: { value: "claude-haiku" },
    })
    fireEvent.click(screen.getByText("save"))

    await waitFor(() => expect(saveMock).toHaveBeenCalled())
    expect(saveMock).toHaveBeenCalledWith({
      id: "uuid-1",
      label: "My Relay",
      baseUrl: "https://relay.example.com",
      extraHeaders: undefined,
      modelMapping: { default: "claude-sonnet", fast: "claude-haiku" },
    })
  })

  it("omits modelMapping entirely when both model inputs are empty", async () => {
    mockState.presets = []
    mockState.defaultPresetId = null
    render(<PresetPicker provider="anthropic" />)
    fireEvent.click(screen.getByText("addPreset"))
    fireEvent.change(screen.getByLabelText("baseUrlField"), {
      target: { value: "https://relay.example.com" },
    })
    fireEvent.click(screen.getByText("save"))
    await waitFor(() => expect(saveMock).toHaveBeenCalled())
    const saved = saveMock.mock.calls[0][0]
    expect(saved).not.toHaveProperty("modelMapping")
  })

  it("prefills baseUrl and stores templateId when picking a non-custom template", async () => {
    mockState.presets = []
    mockState.defaultPresetId = null
    const user = userEvent.setup()
    render(<PresetPicker provider="anthropic" />)

    await user.click(screen.getByText("newFromTemplate"))
    await user.click(await screen.findByText("AWS Bedrock"))

    // Editor opens prefilled with the template's baseUrl + label.
    const baseUrl = screen.getByLabelText("baseUrlField") as HTMLInputElement
    expect(baseUrl.value).toBe("https://bedrock.example.com")

    fireEvent.click(screen.getByText("save"))
    await waitFor(() => expect(saveMock).toHaveBeenCalled())
    expect(saveMock.mock.calls[0][0]).toMatchObject({
      templateId: "bedrock",
      baseUrl: "https://bedrock.example.com",
      label: "AWS Bedrock",
    })
  })

  it("edits an existing preset, preserving its id and modelMapping", async () => {
    render(<PresetPicker provider="anthropic" />)
    // Row B is the second card; click its Edit.
    const azureCard = screen.getByText("Azure").closest("[data-slot='card']") as HTMLElement
    fireEvent.click(within(azureCard).getByText("editPreset"))

    const labelInput = screen.getByLabelText("labelField") as HTMLInputElement
    expect(labelInput.value).toBe("Azure")
    const fast = screen.getByLabelText("fastModelField") as HTMLInputElement
    expect(fast.value).toBe("gpt-4o-mini")

    fireEvent.change(labelInput, { target: { value: "Azure v2" } })
    fireEvent.click(screen.getByText("save"))
    await waitFor(() => expect(saveMock).toHaveBeenCalled())
    expect(saveMock.mock.calls[0][0]).toMatchObject({
      id: "b",
      label: "Azure v2",
      modelMapping: { default: "gpt-4o", fast: "gpt-4o-mini" },
    })
  })

  it("hides the fast model input for codex", () => {
    mockState.presets = []
    mockState.defaultPresetId = null
    render(<PresetPicker provider="codex" />)
    fireEvent.click(screen.getByText("addPreset"))
    expect(screen.getByLabelText("defaultModelField")).toBeInTheDocument()
    expect(screen.queryByLabelText("fastModelField")).not.toBeInTheDocument()
  })

  it("removes a preset only after confirmation", async () => {
    render(<PresetPicker provider="anthropic" />)
    const azureCard = screen.getByText("Azure").closest("[data-slot='card']") as HTMLElement
    fireEvent.click(within(azureCard).getByText("removePreset"))

    expect(screen.getByText("removeConfirmTitle")).toBeInTheDocument()
    // The confirm action button is the last "removePreset" occurrence.
    const all = screen.getAllByText("removePreset")
    fireEvent.click(all[all.length - 1])
    await waitFor(() => expect(removeMock).toHaveBeenCalledWith("b"))
  })

  it("does not remove when the confirmation is cancelled", () => {
    render(<PresetPicker provider="anthropic" />)
    const azureCard = screen.getByText("Azure").closest("[data-slot='card']") as HTMLElement
    fireEvent.click(within(azureCard).getByText("removePreset"))
    fireEvent.click(screen.getByText("cancel"))
    expect(removeMock).not.toHaveBeenCalled()
  })

  it("validates an empty base URL", async () => {
    mockState.presets = []
    mockState.defaultPresetId = null
    render(<PresetPicker provider="anthropic" />)
    fireEvent.click(screen.getByText("addPreset"))
    fireEvent.click(screen.getByText("save"))
    expect(await screen.findByText("validationEmptyBaseUrl")).toBeInTheDocument()
    expect(saveMock).not.toHaveBeenCalled()
  })

  it("shows a loading placeholder", () => {
    mockState.loading = true
    const { container } = render(<PresetPicker provider="anthropic" />)
    expect(container.textContent).toContain("…")
  })
})
