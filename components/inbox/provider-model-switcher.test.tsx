/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import type { AppSettings } from "@cognia/agent-config-types"

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

jest.mock("@/components/ui/tooltip")
jest.mock("@/components/ui/dropdown-menu")

const mockUpsert = jest.fn().mockResolvedValue(undefined)
jest.mock("@/lib/connectors/inbox-writes", () => ({
  mutateConversationOverride: (m: unknown) => mockUpsert(m),
}))

const mockSettingsGet = jest.fn<Promise<AppSettings | undefined>, []>()
jest.mock("@/lib/db/schema", () => ({
  getDb: jest.fn(() => ({
    settings: {
      get: jest.fn(() => mockSettingsGet()),
    },
  })),
}))

let mockSettingsValue: AppSettings | undefined = undefined
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: jest.fn(() => mockSettingsValue),
}))

// ---------------------------------------------------------------------------
// Subject
// ---------------------------------------------------------------------------

import { ProviderModelSwitcher } from "./provider-model-switcher"

beforeEach(() => {
  mockUpsert.mockReset().mockResolvedValue(undefined)
  mockSettingsValue = undefined
  mockSettingsGet.mockReset().mockResolvedValue(undefined)
})

describe("ProviderModelSwitcher", () => {
  it("renders the 'Default' label when no overrides are set", () => {
    render(<ProviderModelSwitcher conversationKey="telegram:tg:1" sessionId="s1" />)
    const trigger = screen.getByTestId("provider-model-switcher-trigger")
    expect(trigger).toBeInTheDocument()
    expect(trigger).toHaveTextContent("Default")
  })

  it("renders 'provider · model' when both overrides are set", () => {
    render(
      <ProviderModelSwitcher
        conversationKey="telegram:tg:1"
        sessionId="s1"
        providerOverride="codex"
        modelOverride="gpt-5"
      />
    )
    expect(screen.getByTestId("provider-model-switcher-trigger")).toHaveTextContent("codex · gpt-5")
  })

  it("lists configured providers + models from app settings", () => {
    // `enabledModels` is the real whitelist field. The fixtures used to say
    // `models`, which does not exist on `UserProviderSettings` — the same
    // invented shape the component itself collected against, so the test
    // agreed with the bug instead of catching it.
    mockSettingsValue = {
      providerSettings: {
        anthropic: {
          enabled: true,
          enabledModels: ["claude-opus-4-7", "claude-sonnet-4-6"],
        },
        openai: { enabled: true, enabledModels: ["gpt-5"] },
        disabled: { enabled: false, enabledModels: ["model-x"] },
      },
      customProviders: [
        { id: "homegrown", enabled: true, name: "Homegrown", customModels: ["lava-1"] },
        { id: "disabled-custom", enabled: false, customModels: ["lava-2"] },
      ],
    } as unknown as AppSettings

    render(<ProviderModelSwitcher conversationKey="telegram:tg:1" sessionId="s1" />)
    fireEvent.click(screen.getByTestId("provider-model-switcher-trigger"))

    expect(
      screen.getByTestId("provider-model-option-anthropic-claude-opus-4-7")
    ).toBeInTheDocument()
    expect(
      screen.getByTestId("provider-model-option-anthropic-claude-sonnet-4-6")
    ).toBeInTheDocument()
    expect(screen.getByTestId("provider-model-option-openai-gpt-5")).toBeInTheDocument()
    expect(screen.getByTestId("provider-model-option-homegrown-lava-1")).toBeInTheDocument()
    // Disabled providers are filtered out.
    expect(screen.queryByTestId("provider-model-option-disabled-model-x")).not.toBeInTheDocument()
    expect(
      screen.queryByTestId("provider-model-option-disabled-custom-lava-2")
    ).not.toBeInTheDocument()
  })

  it("selecting an option relays an upsert mutation with both overrides", async () => {
    mockSettingsValue = {
      providerSettings: {
        codex: { enabled: true, enabledModels: ["gpt-5"] },
      },
    } as unknown as AppSettings
    const onChange = jest.fn()
    render(
      <ProviderModelSwitcher
        conversationKey="telegram:tg:9"
        sessionId="s_abc"
        onChange={onChange}
      />
    )
    fireEvent.click(screen.getByTestId("provider-model-option-codex-gpt-5"))

    await waitFor(() => {
      expect(mockUpsert).toHaveBeenCalledWith({
        kind: "upsert",
        input: {
          conversationKey: "telegram:tg:9",
          sessionId: "s_abc",
          providerOverride: "codex",
          modelOverride: "gpt-5",
        },
      })
    })
    expect(onChange).toHaveBeenCalledWith({
      providerOverride: "codex",
      modelOverride: "gpt-5",
    })
  })

  it("selecting 'clear override' writes undefined to both fields", async () => {
    render(
      <ProviderModelSwitcher
        conversationKey="telegram:tg:1"
        sessionId="s1"
        providerOverride="codex"
        modelOverride="gpt-5"
      />
    )
    fireEvent.click(screen.getByTestId("provider-model-option-default"))

    await waitFor(() => {
      expect(mockUpsert).toHaveBeenCalledWith({
        kind: "upsert",
        input: {
          conversationKey: "telegram:tg:1",
          sessionId: "s1",
          providerOverride: undefined,
          modelOverride: undefined,
        },
      })
    })
  })

  it("shows the empty-state row only when Anthropic is explicitly opted out", () => {
    // An empty `providerSettings` is NOT an empty option list: the sidecar
    // authenticates Anthropic via API key or subscription OAuth and needs no
    // provider config, so a subscription-only user must still get a model
    // list. Opting out takes an explicit `enabled: false`.
    mockSettingsValue = { providerSettings: {} } as unknown as AppSettings
    const { unmount } = render(<ProviderModelSwitcher conversationKey="ck" sessionId="s" />)
    expect(screen.queryByTestId("provider-model-option-empty")).not.toBeInTheDocument()
    unmount()

    mockSettingsValue = {
      providerSettings: { anthropic: { enabled: false } },
    } as unknown as AppSettings
    render(<ProviderModelSwitcher conversationKey="ck" sessionId="s" />)
    expect(screen.getByTestId("provider-model-option-empty")).toBeInTheDocument()
  })

  it("offers every model a provider has, not just its default", () => {
    // The regression: a local collector read `cfg.models`, so each built-in
    // provider contributed exactly one option — its default.
    mockSettingsValue = {
      providerSettings: {
        openai: {
          enabled: true,
          defaultModel: "gpt-4.1",
          enabledModels: ["gpt-5.4", "gpt-5.4-mini"],
          discoveredModels: [{ id: "o4-mini" }],
        },
      },
    } as unknown as AppSettings
    render(<ProviderModelSwitcher conversationKey="ck" sessionId="s" />)
    for (const modelId of ["gpt-4.1", "gpt-5.4", "gpt-5.4-mini", "o4-mini"]) {
      expect(screen.getByTestId(`provider-model-option-openai-${modelId}`)).toBeInTheDocument()
    }
  })

  it("no-ops when the selected option matches the current overrides", async () => {
    mockSettingsValue = {
      providerSettings: { codex: { enabled: true, enabledModels: ["gpt-5"] } },
    } as unknown as AppSettings
    render(
      <ProviderModelSwitcher
        conversationKey="ck"
        sessionId="s"
        providerOverride="codex"
        modelOverride="gpt-5"
      />
    )
    fireEvent.click(screen.getByTestId("provider-model-option-codex-gpt-5"))
    // Even after the click, upsert should not have been called because the
    // selection is a no-op.
    await new Promise((r) => setTimeout(r, 5))
    expect(mockUpsert).not.toHaveBeenCalled()
  })
})
