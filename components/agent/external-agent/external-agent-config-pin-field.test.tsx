/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import en from "@/i18n/messages/en.json"
import { ExternalAgentConfigPinField } from "./external-agent-config-pin-field"

type StoredConfig = {
  id: string
  name: string
  enabled: boolean
  metadata?: Record<string, unknown>
  createdAt: string
}

let mockAgents: Record<string, StoredConfig> = {}
jest.mock("@/stores/agent/external-agent-store", () => ({
  useExternalAgentStore: (selector: (s: unknown) => unknown) => selector({ agents: mockAgents }),
}))
jest.mock("@/lib/ai/agent/external/config/presets", () => ({
  getPresetDisplayInfo: (id: string) => (id === "codex" ? { name: "Codex" } : null),
}))

function stored(
  id: string,
  name: string,
  preset: string,
  createdAt: string,
  enabled = true
): StoredConfig {
  return { id, name, enabled, metadata: { preset }, createdAt }
}

function renderField(props: Partial<Parameters<typeof ExternalAgentConfigPinField>[0]> = {}) {
  const onChange = jest.fn()
  const view = render(
    <NextIntlClientProvider locale="en" messages={en}>
      <ExternalAgentConfigPinField
        presetId="codex"
        value={undefined}
        onChange={onChange}
        {...props}
      />
    </NextIntlClientProvider>
  )
  return { onChange, ...view }
}

beforeEach(() => {
  mockAgents = {
    lenient: stored("lenient", "Codex lenient", "codex", "2026-02-01T00:00:00Z"),
    strict: stored("strict", "Codex strict", "codex-app-server", "2025-02-01T00:00:00Z"),
    off: stored("off", "Codex old", "codex", "2024-01-01T00:00:00Z", false),
    gemini: stored("gemini", "Gemini", "gemini-cli", "2020-01-01T00:00:00Z"),
  }
})

describe("ExternalAgentConfigPinField", () => {
  it("renders nothing without a preset", () => {
    const { container } = renderField({ presetId: undefined })
    expect(container).toBeEmptyDOMElement()
  })

  it("defaults to any config and lists the preset family in selection order", async () => {
    const user = userEvent.setup()
    renderField()
    const trigger = screen.getByTestId("external-agent-config-pin")
    expect(trigger).toHaveTextContent("Any Codex config")
    expect(screen.getByText(/Pin one of your saved configs/)).toBeInTheDocument()

    await user.click(trigger)
    const options = await screen.findAllByRole("option")
    expect(options.map((o) => o.textContent)).toEqual([
      "Any Codex config",
      "Codex strict",
      "Codex lenient",
      "Codex old (disabled)",
    ])
    // A disabled config cannot be newly pinned.
    expect(options[3]).toHaveAttribute("aria-disabled", "true")
  })

  it("pins the picked config", async () => {
    const user = userEvent.setup()
    const { onChange } = renderField()
    await user.click(screen.getByTestId("external-agent-config-pin"))
    await user.click(await screen.findByRole("option", { name: "Codex strict" }))
    expect(onChange).toHaveBeenCalledWith("strict")
  })

  it("clears the pin when the user picks any config", async () => {
    const user = userEvent.setup()
    const { onChange } = renderField({ value: "strict" })
    const trigger = screen.getByTestId("external-agent-config-pin")
    expect(trigger).toHaveTextContent("Codex strict")
    await user.click(trigger)
    await user.click(await screen.findByRole("option", { name: "Any Codex config" }))
    expect(onChange).toHaveBeenCalledWith(undefined)
  })

  it("warns when the pinned config is disabled", () => {
    renderField({ value: "off" })
    expect(screen.getByTestId("external-agent-config-pin")).toHaveTextContent(
      "Codex old (disabled)"
    )
    expect(screen.getByTestId("external-agent-config-pin-problem")).toHaveTextContent(
      /pinned config is disabled/
    )
  })

  it("keeps a deleted pin visible and warns that runs fail", () => {
    renderField({ value: "deleted" })
    expect(screen.getByTestId("external-agent-config-pin")).toHaveTextContent("Missing config")
    expect(screen.getByTestId("external-agent-config-pin-problem")).toHaveTextContent(
      /no longer exists/
    )
  })

  it("flags a pin whose config moved to another preset", () => {
    renderField({ value: "gemini" })
    expect(screen.getByTestId("external-agent-config-pin")).toHaveTextContent(
      "Gemini (different preset)"
    )
    expect(screen.getByTestId("external-agent-config-pin-problem")).toHaveTextContent(
      /no longer uses this preset/
    )
  })

  it("says so when the user has no config of the preset yet", () => {
    renderField({ presetId: "cursor-cli", presetLabel: "Cursor" })
    expect(screen.getByText(/no saved Cursor configs yet/)).toBeInTheDocument()
  })

  it("hides the label and hint in compact mode", () => {
    renderField({ compact: true })
    expect(screen.queryByText("Agent config")).not.toBeInTheDocument()
    expect(screen.queryByText(/Pin one of your saved configs/)).not.toBeInTheDocument()
  })
})
