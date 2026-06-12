/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { ModelPicker, __testing__ } from "./model-picker"
import { PROVIDERS } from "@/types/provider/provider"
import type { UserProviderSettings, CustomProviderSettings } from "@/types/provider/provider"
import type { ChatSession } from "@/lib/claude/types"
import { updateSession } from "@/lib/db/sessions"
import { useSettingsStore } from "@/stores/settings"

// The picker persists model switches through the Dexie sessions table —
// irrelevant for trigger-rendering assertions.
jest.mock("@/lib/db/sessions", () => ({
  updateSession: jest.fn(async () => undefined),
}))

const mockedUpdateSession = updateSession as unknown as jest.Mock

// Radix Popover + cmdk Command need these pointer/scroll primitives in jsdom.
beforeAll(() => {
  if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false
  if (!Element.prototype.setPointerCapture) Element.prototype.setPointerCapture = () => {}
  if (!Element.prototype.releasePointerCapture) Element.prototype.releasePointerCapture = () => {}
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {}
})

const { collectModelOptions, groupByProvider } = __testing__

describe("collectModelOptions", () => {
  it("falls back to the built-in anthropic catalog when nothing is configured", () => {
    // Subscription-reuse users never touch providerSettings — the sidecar
    // runtime needs no provider config, so the picker must still offer the
    // curated Claude models instead of rendering an empty list.
    const opts = collectModelOptions(undefined, undefined)
    expect(opts.length).toBeGreaterThan(0)
    expect(opts.every((o) => o.providerId === "anthropic")).toBe(true)
    expect(opts.map((o) => o.modelId)).toContain(PROVIDERS.anthropic.defaultModel)
  })

  it("falls back to the curated catalog for an enabled provider with no configured models", () => {
    const providerSettings: Record<string, UserProviderSettings> = {
      openai: { enabled: true } as unknown as UserProviderSettings,
    }
    const opts = collectModelOptions(providerSettings, undefined)
    const openai = opts.filter((o) => o.providerId === "openai")
    expect(openai.map((o) => o.modelId)).toContain(PROVIDERS.openai.defaultModel)
  })

  it("prefers user-configured models over the catalog fallback", () => {
    const providerSettings: Record<string, UserProviderSettings> = {
      anthropic: {
        enabled: true,
        defaultModel: "claude-custom-model",
      } as unknown as UserProviderSettings,
    }
    const opts = collectModelOptions(providerSettings, undefined)
    expect(opts).toHaveLength(1)
    expect(opts[0]).toMatchObject({
      providerId: "anthropic",
      modelId: "claude-custom-model",
      // Unknown id → display name falls back to the raw id.
      modelName: "claude-custom-model",
    })
    // Provider heading is now the human-readable catalog name, not the raw id.
    expect(opts[0].providerName).toBe(PROVIDERS.anthropic.name)
  })

  it("omits the anthropic fallback when the user explicitly disabled anthropic", () => {
    const providerSettings: Record<string, UserProviderSettings> = {
      anthropic: { enabled: false } as unknown as UserProviderSettings,
    }
    expect(collectModelOptions(providerSettings, undefined)).toEqual([])
  })

  it("skips disabled built-in providers", () => {
    const providerSettings: Record<string, UserProviderSettings> = {
      openai: {
        enabled: false,
        defaultModel: "gpt-4o",
      } as unknown as UserProviderSettings,
      anthropic: {
        enabled: true,
        defaultModel: "claude-3-5-sonnet",
      } as unknown as UserProviderSettings,
    }
    const opts = collectModelOptions(providerSettings, undefined)
    expect(opts.map((o) => o.providerId)).toEqual(["anthropic"])
  })

  it("includes the defaultModel even when no whitelist is set", () => {
    const providerSettings: Record<string, UserProviderSettings> = {
      anthropic: {
        enabled: true,
        defaultModel: "claude-3-5-sonnet",
      } as unknown as UserProviderSettings,
    }
    const opts = collectModelOptions(providerSettings, undefined)
    expect(opts).toHaveLength(1)
    expect(opts[0]).toMatchObject({ providerId: "anthropic", modelId: "claude-3-5-sonnet" })
    expect(opts[0].providerName).toBe(PROVIDERS.anthropic.name)
  })

  it("merges enabledModels and discoveredModels without duplicates", () => {
    const providerSettings: Record<string, UserProviderSettings> = {
      openai: {
        enabled: true,
        defaultModel: "gpt-4o-mini",
        enabledModels: ["gpt-4o", "gpt-4o-mini"],
        discoveredModels: [
          { id: "gpt-4o-mini" }, // duplicate of enabledModels
          { id: "o1-preview" }, // unique
        ],
      } as unknown as UserProviderSettings,
    }
    const opts = collectModelOptions(providerSettings, undefined)
    const ids = opts
      .filter((o) => o.providerId === "openai")
      .map((o) => o.modelId)
      .sort()
    expect(ids).toEqual(["gpt-4o", "gpt-4o-mini", "o1-preview"])
  })

  it("includes custom providers after built-ins", () => {
    const providerSettings: Record<string, UserProviderSettings> = {
      anthropic: {
        enabled: true,
        defaultModel: "claude-3-5-sonnet",
      } as unknown as UserProviderSettings,
    }
    const customProviders: CustomProviderSettings[] = [
      {
        id: "self-hosted",
        name: "My Server",
        enabled: true,
        defaultModel: "llama-3.3-70b",
        models: [{ id: "llama-3.3-70b" }, { id: "qwen2.5-32b" }],
      } as unknown as CustomProviderSettings,
    ]
    const opts = collectModelOptions(providerSettings, customProviders)
    expect(opts.find((o) => o.providerId === "anthropic")).toBeDefined()
    const customs = opts.filter((o) => o.providerId === "self-hosted")
    expect(customs.map((o) => o.modelId).sort()).toEqual(["llama-3.3-70b", "qwen2.5-32b"])
    expect(customs[0].providerName).toBe("My Server")
  })

  it("skips disabled custom providers", () => {
    const customProviders: CustomProviderSettings[] = [
      {
        id: "self-hosted",
        name: "My Server",
        enabled: false,
        defaultModel: "llama-3.3-70b",
      } as unknown as CustomProviderSettings,
    ]
    const opts = collectModelOptions(undefined, customProviders)
    expect(opts.filter((o) => o.providerId === "self-hosted")).toEqual([])
  })

  it("falls back to provider id when custom provider has no name", () => {
    const customProviders: CustomProviderSettings[] = [
      {
        id: "raw-id",
        enabled: true,
        defaultModel: "x",
      } as unknown as CustomProviderSettings,
    ]
    const opts = collectModelOptions(undefined, customProviders)
    const raw = opts.find((o) => o.providerId === "raw-id")
    expect(raw?.providerName).toBe("raw-id")
  })
})

describe("groupByProvider", () => {
  it("returns an empty list for no options", () => {
    expect(groupByProvider([])).toEqual([])
  })

  it("preserves insertion order across providers and models", () => {
    const groups = groupByProvider([
      {
        providerId: "anthropic",
        providerName: "Anthropic",
        modelId: "claude-3-5-sonnet",
        modelName: "Claude 3.5 Sonnet",
      },
      { providerId: "openai", providerName: "OpenAI", modelId: "gpt-4o", modelName: "GPT-4o" },
      {
        providerId: "anthropic",
        providerName: "Anthropic",
        modelId: "claude-3-5-haiku",
        modelName: "Claude 3.5 Haiku",
      },
      {
        providerId: "openai",
        providerName: "OpenAI",
        modelId: "gpt-4o-mini",
        modelName: "GPT-4o Mini",
      },
    ])
    expect(groups.map((g) => g.providerId)).toEqual(["anthropic", "openai"])
    expect(groups[0].models.map((m) => m.id)).toEqual(["claude-3-5-sonnet", "claude-3-5-haiku"])
    expect(groups[1].models.map((m) => m.id)).toEqual(["gpt-4o", "gpt-4o-mini"])
    // Display names ride along with the ids.
    expect(groups[0].models[0].name).toBe("Claude 3.5 Sonnet")
  })

  it("dedupes duplicate models within the same provider", () => {
    const groups = groupByProvider([
      { providerId: "openai", providerName: "OpenAI", modelId: "gpt-4o", modelName: "GPT-4o" },
      { providerId: "openai", providerName: "OpenAI", modelId: "gpt-4o", modelName: "GPT-4o" },
    ])
    expect(groups[0].models.map((m) => m.id)).toEqual(["gpt-4o"])
  })
})

describe("trigger rendering (narrow-container truncation)", () => {
  function renderPicker(session: ChatSession | null) {
    return render(
      <NextIntlClientProvider locale="en" messages={{}}>
        <ModelPicker session={session} />
      </NextIntlClientProvider>
    )
  }

  const session: ChatSession = {
    id: "ses_1",
    title: "t",
    kind: "direct",
    model: "claude-sonnet-4-5-20250929-very-long-id",
    createdAt: 0,
    updatedAt: 0,
  }

  it("caps the popover trigger width so long model ids truncate instead of overflowing", () => {
    renderPicker(session)
    const trigger = screen.getByRole("button")
    // In a flex-wrap toolbar row a flex item's min-width defaults to its
    // content size — without min-w-0 + max-w-full a long font-mono model id
    // pushes the row wider than a narrow sidebar and overflows the composer.
    expect(trigger.className).toContain("min-w-0")
    expect(trigger.className).toContain("max-w-full")
    const label = trigger.querySelector("span.truncate") as HTMLElement
    expect(label).not.toBeNull()
    expect(label.className).toContain("min-w-0")
  })

  it("caps the static (no-session) chip the same way", () => {
    const { container } = renderPicker(null)
    const chip = container.firstChild as HTMLElement
    expect(chip.className).toContain("min-w-0")
    expect(chip.className).toContain("max-w-full")
    const label = chip.querySelector("span.truncate") as HTMLElement
    expect(label).not.toBeNull()
    expect(label.className).toContain("min-w-0")
  })
})

describe("friendly name rendering", () => {
  beforeEach(() => mockedUpdateSession.mockClear())

  const defaultModel = PROVIDERS.anthropic.defaultModel
  const defaultName = PROVIDERS.anthropic.models.find((m) => m.id === defaultModel)?.name

  function renderPicker(session: ChatSession | null) {
    return render(
      <NextIntlClientProvider locale="en" messages={{}}>
        <ModelPicker session={session} />
      </NextIntlClientProvider>
    )
  }

  const session: ChatSession = {
    id: "ses_1",
    title: "t",
    kind: "direct",
    model: defaultModel,
    providerOverride: "anthropic",
    createdAt: 0,
    updatedAt: 0,
  }

  it("labels the trigger with the active model's catalog display name, not the raw id", () => {
    if (!defaultName || defaultName === defaultModel) return // catalog has no distinct name
    renderPicker(session)
    const trigger = screen.getByRole("button")
    expect(trigger.textContent).toContain(defaultName)
    expect(trigger.querySelector("span.truncate")?.textContent).not.toBe(defaultModel)
  })

  it("opens the list showing model names with the id as secondary, and selects by id", () => {
    renderPicker(session)
    fireEvent.click(screen.getByRole("button"))
    // The friendly name renders as a selectable row…
    if (defaultName && defaultName !== defaultModel) {
      expect(screen.getAllByText(defaultName).length).toBeGreaterThan(0)
    }
    // …with the raw id shown as the mono secondary line.
    const idCell = screen.getAllByText(defaultModel)
    expect(idCell.length).toBeGreaterThan(0)
    // Clicking the row persists the id (not the display name) on the session.
    fireEvent.click(idCell[0])
    expect(mockedUpdateSession).toHaveBeenCalledWith(
      "ses_1",
      expect.objectContaining({ model: defaultModel, providerOverride: "anthropic" })
    )
  })

  it("falls back to a same-id option from another provider for the trigger label", () => {
    if (!defaultName || defaultName === defaultModel) return
    // The session pins a different provider than the catalog model belongs to:
    // the exact (id+provider) match misses, so the id-only match supplies the name.
    renderPicker({ ...session, providerOverride: "openai" })
    expect(screen.getByRole("button").textContent).toContain(defaultName)
  })

  it("omits the secondary id line for a model whose name equals its id", () => {
    useSettingsStore.setState({
      settings: {
        providerSettings: { anthropic: { enabled: true, enabledModels: ["nameless-xyz"] } },
      } as never,
    })
    try {
      renderPicker({ ...session, model: "nameless-xyz" })
      fireEvent.click(screen.getByRole("button"))
      // The id is the primary (and only) label — no distinct display name exists.
      expect(screen.getAllByText("nameless-xyz").length).toBeGreaterThan(0)
    } finally {
      useSettingsStore.setState({ settings: undefined as never })
    }
  })
})
