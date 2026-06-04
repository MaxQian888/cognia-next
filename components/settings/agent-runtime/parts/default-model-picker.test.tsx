import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { DefaultModelPicker, __testing__ } from "./default-model-picker"
import { PROVIDERS } from "@/types/provider/provider"

const save = jest.fn()
type AnySettings = Record<string, unknown>
const stateRef: { current: { settings: AnySettings } } = {
  current: {
    settings: {
      providerSettings: {
        openai: {
          providerId: "openai",
          enabled: true,
          defaultModel: "gpt-4o-mini",
          enabledModels: ["gpt-4o-mini", "gpt-4.1"],
        },
        anthropic: {
          providerId: "anthropic",
          enabled: true,
          defaultModel: "claude-haiku-4-5",
          enabledModels: ["claude-haiku-4-5"],
        },
      },
      customProviders: [],
      defaultModel: "gpt-4o-mini",
      defaultProvider: "openai",
    },
  },
}

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

jest.mock("@/stores/settings", () => ({
  useSettingsStore: (selector: (state: unknown) => unknown) =>
    selector({
      settings: stateRef.current.settings,
      save: (...args: unknown[]) => save(...args),
    }),
}))

describe("__testing__.collectOptions", () => {
  it("flattens enabled providers into provider:model rows", () => {
    const opts = __testing__.collectOptions(
      {
        openai: {
          providerId: "openai",
          enabled: true,
          defaultModel: "gpt-4o-mini",
          enabledModels: ["gpt-4o-mini", "gpt-4.1"],
        } as never,
      },
      []
    )
    expect(opts.map((o) => o.modelId)).toEqual(expect.arrayContaining(["gpt-4o-mini", "gpt-4.1"]))
  })

  it("skips disabled providers", () => {
    const opts = __testing__.collectOptions(
      {
        openai: { providerId: "openai", enabled: false } as never,
      },
      []
    )
    expect(opts.filter((o) => o.providerId === "openai")).toEqual([])
  })

  it("falls back to the built-in anthropic catalog when nothing is configured", () => {
    // Subscription-reuse users never touch providerSettings — anthropic must
    // still be offered because the sidecar runtime needs no provider config.
    const opts = __testing__.collectOptions(undefined, [])
    expect(opts.length).toBeGreaterThan(0)
    expect(opts.every((o) => o.providerId === "anthropic")).toBe(true)
    expect(opts.map((o) => o.modelId)).toContain(PROVIDERS.anthropic.defaultModel)
  })

  it("falls back to the curated catalog for an enabled provider with no configured models", () => {
    const opts = __testing__.collectOptions(
      {
        openai: { providerId: "openai", enabled: true } as never,
      },
      []
    )
    const openai = opts.filter((o) => o.providerId === "openai")
    expect(openai.map((o) => o.modelId)).toContain(PROVIDERS.openai.defaultModel)
  })

  it("omits the anthropic fallback when the user explicitly disabled anthropic", () => {
    const opts = __testing__.collectOptions(
      {
        anthropic: { providerId: "anthropic", enabled: false } as never,
      },
      []
    )
    expect(opts).toEqual([])
  })

  it("includes discovered models and falls back to defaultModel when whitelist is empty", () => {
    const opts = __testing__.collectOptions(
      {
        openai: {
          providerId: "openai",
          enabled: true,
          defaultModel: "gpt-fallback",
          enabledModels: [],
          discoveredModels: [{ id: "discovered-1" }, { id: "" }],
        } as never,
      },
      []
    )
    const ids = opts.map((o) => o.modelId).sort()
    expect(ids).toContain("discovered-1")
    expect(ids).toContain("gpt-fallback")
  })

  it("flattens custom providers and skips disabled ones", () => {
    const opts = __testing__.collectOptions({}, [
      {
        id: "cp1",
        name: "My Provider",
        enabled: true,
        defaultModel: "cp-default",
        models: [{ id: "cp-extra" }, { id: "" }],
      } as never,
      { id: "cp2", enabled: false, name: "Disabled" } as never,
    ])
    const fromCp1 = opts.filter((o) => o.providerId === "cp1")
    expect(fromCp1.map((o) => o.modelId).sort()).toEqual(["cp-default", "cp-extra"])
    expect(opts.find((o) => o.providerId === "cp2")).toBeUndefined()
  })

  it("groupByProvider deduplicates models within the same provider", () => {
    const grouped = __testing__.groupByProvider([
      { providerId: "p", providerName: "P", modelId: "m1" },
      { providerId: "p", providerName: "P", modelId: "m1" },
      { providerId: "p", providerName: "P", modelId: "m2" },
    ])
    expect(grouped).toEqual([{ providerId: "p", providerName: "P", models: ["m1", "m2"] }])
  })
})

describe("DefaultModelPicker", () => {
  beforeEach(() => {
    save.mockClear()
    stateRef.current = {
      settings: {
        providerSettings: {
          openai: {
            providerId: "openai",
            enabled: true,
            defaultModel: "gpt-4o-mini",
            enabledModels: ["gpt-4o-mini", "gpt-4.1"],
          },
        },
        customProviders: [],
        defaultModel: "gpt-4o-mini",
        defaultProvider: "openai",
      },
    }
  })

  it("renders the trigger labelled with the active model", () => {
    render(<DefaultModelPicker />)
    expect(screen.getByRole("button", { name: "modelLabel" })).toBeInTheDocument()
    expect(screen.getByText("gpt-4o-mini")).toBeInTheDocument()
  })

  it("renders 'No default selected' label when settings has no defaultModel", () => {
    stateRef.current = {
      settings: {
        ...stateRef.current.settings,
        defaultModel: undefined as unknown as string,
      },
    }
    render(<DefaultModelPicker />)
    expect(screen.getByText("modelUnset")).toBeInTheDocument()
  })

  it("opening the popover shows model options", async () => {
    const user = userEvent.setup()
    render(<DefaultModelPicker />)
    await user.click(screen.getByRole("button", { name: "modelLabel" }))
    expect(screen.getByText("gpt-4.1")).toBeInTheDocument()
  })

  it("selecting a model persists provider+model via save", async () => {
    const user = userEvent.setup()
    render(<DefaultModelPicker />)
    await user.click(screen.getByRole("button", { name: "modelLabel" }))
    await user.click(screen.getByText("gpt-4.1"))
    expect(save).toHaveBeenCalledWith({
      defaultModel: "gpt-4.1",
      defaultProvider: "openai",
    })
  })

  it("'Clear default' option persists undefined provider+model", async () => {
    const user = userEvent.setup()
    render(<DefaultModelPicker />)
    await user.click(screen.getByRole("button", { name: "modelLabel" }))
    await user.click(screen.getByText("modelClear"))
    expect(save).toHaveBeenCalledWith({
      defaultModel: undefined,
      defaultProvider: undefined,
    })
  })

  it("offers the anthropic catalog when no providers are configured", async () => {
    stateRef.current = {
      settings: {
        providerSettings: {},
        customProviders: [],
        defaultModel: undefined,
        defaultProvider: undefined,
      },
    }
    const user = userEvent.setup()
    render(<DefaultModelPicker />)
    await user.click(screen.getByRole("button", { name: "modelLabel" }))
    expect(screen.getByText(PROVIDERS.anthropic.defaultModel)).toBeInTheDocument()
  })

  it("renders the empty CommandEmpty when every provider is explicitly disabled", async () => {
    stateRef.current = {
      settings: {
        providerSettings: { anthropic: { providerId: "anthropic", enabled: false } },
        customProviders: [],
        defaultModel: undefined,
        defaultProvider: undefined,
      },
    }
    const user = userEvent.setup()
    render(<DefaultModelPicker />)
    await user.click(screen.getByRole("button", { name: "modelLabel" }))
    expect(screen.getByText("modelEmpty")).toBeInTheDocument()
  })
})
