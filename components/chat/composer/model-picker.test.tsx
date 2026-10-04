/**
 * @jest-environment jsdom
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { TooltipProvider } from "@/components/ui/tooltip"
import { NextIntlClientProvider } from "next-intl"
import { ModelPicker, __testing__ } from "./model-picker"
import {
  EMPTY_THINKING_SURFACE,
  externalAgentProviderId,
} from "@/lib/ai/agent/external/session/session-models"
import {
  forgetAgentModelSurface,
  recordReportedAgentModelSurface,
} from "@/lib/ai/agent/external/capability/model-surface-cache"
import { PROVIDERS } from "@cognia/provider-types/provider"
import type { UserProviderSettings, CustomProviderSettings } from "@cognia/provider-types/provider"
import type { ChatSession } from "@cognia/agent-config-types"
import { updateSession } from "@/lib/db/sessions"
import { detectHostProfile } from "@/lib/platform/capabilities"
import { useSettingsStore } from "@/stores/settings"
import { useExternalAgentStore } from "@/stores/agent/external-agent-store"
import enMessages from "@/i18n/messages/en.json"
import { ChatScopeProvider } from "@/components/chat/chat-scope-provider"

// The picker persists model switches through the Dexie sessions table —
// irrelevant for trigger-rendering assertions.
jest.mock("@/lib/db/sessions", () => ({
  updateSession: jest.fn(async () => undefined),
}))

const mockedUpdateSession = updateSession as unknown as jest.Mock

// Live-switch deps. The live path is gated on the HOST PROFILE (a shell that
// has a sidecar of its own or is paired to one), not on the webview kind.
// Defaults: a standalone browser, so the existing rendering tests never trip
// the live path; the live-switch suite picks the profile per test.
jest.mock("@/lib/platform/capabilities", () => {
  const actual = jest.requireActual("@/lib/platform/capabilities")
  return { ...actual, detectHostProfile: jest.fn(() => "web-standalone") }
})
const mockHostProfile = detectHostProfile as jest.MockedFunction<typeof detectHostProfile>
const mockSetSessionModel = jest.fn(async (..._a: unknown[]) => undefined)
const mockCloseSession = jest.fn(async (..._a: unknown[]) => undefined)
jest.mock("@/lib/claude/ipc", () => {
  const actual = jest.requireActual("@/lib/claude/ipc")
  return {
    ...actual,
    setSessionModel: (...a: unknown[]) => mockSetSessionModel(...a),
    closeSession: (...a: unknown[]) => mockCloseSession(...a),
  }
})
jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))
import { toast } from "sonner"

// The agent's own models. Default: a built-in lane, so every existing test in
// this file sees exactly the picker it saw before.
const mockAgentModels: {
  agentId: string | null
  agentName: string | null
  externalSessionId: string | null
  surface: {
    choices: Array<{ modelId: string; name: string }>
    currentModelId: string | null
    write: { kind: string; optionId?: string }
  } | null
  loading: boolean
  status: string
  canRefresh: boolean
  select: jest.Mock
  refresh: jest.Mock
} = {
  agentId: null,
  agentName: null,
  externalSessionId: null,
  surface: null,
  loading: false,
  status: "idle",
  canRefresh: false,
  select: jest.fn(async () => undefined),
  refresh: jest.fn(),
}
jest.mock("@/hooks/agent/use-external-agent-models", () => ({
  useExternalAgentModels: () => mockAgentModels,
}))

// The Cognia models the agent can run on through the gateway. Default: none
// asked (a built-in lane), so the picker shows no Cognia section.
const mockCogniaModels: {
  agentId: string | null
  lane: "local" | "host" | null
  status: string
  providers: Array<{
    providerId: string
    providerName: string
    models: Array<{
      id: string
      name: string
      supportsTools?: boolean
      supportsStreaming?: boolean
    }>
  }>
  reason: string | null
  refresh: jest.Mock
} = { agentId: null, lane: null, status: "idle", providers: [], reason: null, refresh: jest.fn() }
jest.mock("@/hooks/agent/use-cognia-gateway-models", () => ({
  useCogniaGatewayModels: () => mockCogniaModels,
}))

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
        <TooltipProvider>
          <ModelPicker session={session} />
        </TooltipProvider>
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

  it("caps the between-sessions chip the same way", () => {
    const { container } = renderPicker(null)
    const chip = container.firstChild as HTMLElement
    expect(chip.className).toContain("min-w-0")
    expect(chip.className).toContain("max-w-full")
    const label = chip.querySelector("span.truncate") as HTMLElement
    expect(label).not.toBeNull()
    expect(label.className).toContain("min-w-0")
  })

  // The composer row hands this over at its glyph tiers (phone widths).
  it("passes the compact label through: short name, no chevron", () => {
    render(
      <NextIntlClientProvider locale="en" messages={{}}>
        <TooltipProvider>
          <ModelPicker
            session={{ ...session, model: "anthropic/claude-sonnet-4-5" }}
            compactLabel
          />
        </TooltipProvider>
      </NextIntlClientProvider>
    )
    const trigger = screen.getByRole("button")
    expect(trigger.querySelector("span.truncate")).toHaveTextContent(/^sonnet-4-5$/)
    expect(trigger.querySelector("svg.lucide-chevrons-up-down")).toBeNull()
  })

  it("stays a control between sessions instead of becoming a label", () => {
    // It used to render a plain `<span>`: it named the app default, which IS
    // the model the next turn runs on, so there was a real choice on screen
    // and no way to make it. Every click was silently dropped.
    renderPicker(null)
    expect(screen.getByRole("button")).toBeInTheDocument()
  })

  it("opens an anchored popover without a modal dialog overlay", () => {
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <TooltipProvider>
          <ModelPicker session={session} />
        </TooltipProvider>
      </NextIntlClientProvider>
    )

    fireEvent.click(screen.getByRole("button", { name: /switch model/i }))

    expect(document.querySelector('[data-slot="popover-content"]')).toBeInTheDocument()
    expect(document.querySelector('[data-slot="dialog-overlay"]')).not.toBeInTheDocument()
  })
})

describe("friendly name rendering", () => {
  beforeEach(() => mockedUpdateSession.mockClear())

  const defaultModel = PROVIDERS.anthropic.defaultModel
  const defaultName = PROVIDERS.anthropic.models.find((m) => m.id === defaultModel)?.name

  function renderPicker(session: ChatSession | null) {
    return render(
      <NextIntlClientProvider locale="en" messages={{}}>
        <TooltipProvider>
          <ModelPicker session={session} />
        </TooltipProvider>
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

describe("active model positioning", () => {
  const session: ChatSession = {
    id: "ses_positioning",
    title: "t",
    kind: "direct",
    model: "model-twenty",
    providerOverride: "anthropic",
    createdAt: 0,
    updatedAt: 0,
  }

  beforeEach(() => {
    useSettingsStore.setState({
      settings: {
        providerSettings: {
          anthropic: {
            enabled: true,
            defaultModel: "model-one",
            enabledModels: Array.from({ length: 20 }, (_, index) =>
              index === 19 ? "model-twenty" : `model-${index + 1}`
            ),
          },
        },
      } as never,
    })
  })

  afterEach(() => {
    useSettingsStore.setState({ settings: undefined as never })
    jest.restoreAllMocks()
  })

  it("aligns the active model once per open without reacting to manual scrolling", () => {
    const scrollIntoView = jest
      .spyOn(Element.prototype, "scrollIntoView")
      .mockImplementation(() => undefined)

    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <TooltipProvider>
          <ModelPicker session={session} />
        </TooltipProvider>
      </NextIntlClientProvider>
    )

    const trigger = screen.getByRole("button", { name: /switch model/i })
    fireEvent.click(trigger)

    const activeItems = () =>
      screen
        .getAllByText("model-twenty")
        .map((element) => element.closest("[cmdk-item]"))
        .filter((element) => element !== null)
    const activeItem = activeItems()[0]
    expect(activeItem).not.toBeNull()
    const activeCalls = () =>
      scrollIntoView.mock.contexts.filter(
        (context) =>
          context instanceof Element &&
          context.hasAttribute("cmdk-item") &&
          context.textContent?.includes("model-twenty")
      ).length

    expect(activeCalls()).toBe(1)
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "auto", block: "center" })

    fireEvent.scroll(screen.getByRole("listbox"))
    expect(activeCalls()).toBe(1)

    const searchInput = screen.getByPlaceholderText("Search models…")
    fireEvent.change(searchInput, { target: { value: "no matching model" } })
    expect(activeItems()).toHaveLength(0)
    fireEvent.change(searchInput, { target: { value: "" } })
    expect(activeItems()).toHaveLength(1)
    expect(activeCalls()).toBe(1)

    fireEvent.click(trigger)
    fireEvent.click(trigger)
    expect(activeCalls()).toBe(2)
  })

  it("positions the Auto row when Auto is selected", () => {
    const scrollIntoView = jest
      .spyOn(Element.prototype, "scrollIntoView")
      .mockImplementation(() => undefined)

    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <TooltipProvider>
          <ModelPicker session={{ ...session, model: "auto", providerOverride: undefined }} />
        </TooltipProvider>
      </NextIntlClientProvider>
    )

    fireEvent.click(screen.getByRole("button", { name: /switch model/i }))
    const autoItem = screen
      .getAllByText("Auto")
      .map((element) => element.closest("[cmdk-item]"))
      .find((element) => element !== null)

    expect(autoItem).not.toBeNull()
    const centeredAutoCalls = scrollIntoView.mock.contexts.filter((context, index) => {
      const options = scrollIntoView.mock.calls[index]?.[0]
      return (
        context === autoItem &&
        typeof options === "object" &&
        options.behavior === "auto" &&
        options.block === "center"
      )
    })
    expect(centeredAutoCalls).toHaveLength(1)
  })
})

describe("reasoning effort is not restated here", () => {
  // The tier has exactly one composer surface — `./effort-chip`. This picker
  // used to state it twice more (a `· high` qualifier on the trigger and the
  // full selector in the popover footer), which put three labels for one
  // setting within a centimetre of each other on the toolbar.
  const capableSession: ChatSession = {
    id: "ses_effort",
    title: "t",
    kind: "direct",
    model: "claude-sonnet-4-6",
    providerOverride: "anthropic",
    effort: "high",
    createdAt: 0,
    updatedAt: 0,
  }

  function renderPicker(session: ChatSession) {
    return render(
      <NextIntlClientProvider
        locale="en"
        messages={{
          chat: {
            composer: {
              effort: {
                aria: "Thinking level",
                auto: "Auto",
                title: "Effort",
                level: {
                  off: "Auto",
                  low: "Low",
                  medium: "Medium",
                  high: "High",
                  xhigh: "Extra",
                  max: "Max",
                  ultracode: "Ultracode",
                },
              },
              modelPicker: {},
            },
          },
        }}
      >
        <TooltipProvider>
          <ModelPicker session={session} />
        </TooltipProvider>
      </NextIntlClientProvider>
    )
  }

  it("keeps the trigger free of an effort qualifier", () => {
    renderPicker(capableSession)

    expect(screen.queryByTestId("model-picker-effort")).not.toBeInTheDocument()
    expect(screen.getByRole("button").textContent).not.toContain("High")
  })

  it("does not mount the effort selector inside the popover", () => {
    renderPicker(capableSession)

    fireEvent.click(screen.getByRole("button"))
    expect(screen.queryByTestId("effort-selector-section")).not.toBeInTheDocument()
    expect(screen.queryByRole("slider", { name: "Thinking level" })).not.toBeInTheDocument()
  })
})

describe("explicit Auto routing selection", () => {
  const session: ChatSession = {
    id: "ses_1",
    title: "t",
    kind: "direct",
    model: PROVIDERS.anthropic.defaultModel,
    providerOverride: "anthropic",
    createdAt: 0,
    updatedAt: 0,
  }
  const renderPicker = (value: ChatSession = session) =>
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <TooltipProvider>
          <ModelPicker session={value} />
        </TooltipProvider>
      </NextIntlClientProvider>
    )

  beforeEach(() => {
    mockedUpdateSession.mockClear()
    mockCloseSession.mockClear()
    mockHostProfile.mockReturnValue("web-standalone")
  })

  afterEach(() => {
    act(() => useSettingsStore.setState({ settings: undefined as never }))
  })

  it("shows the Auto badge only when the session explicitly selects Auto", () => {
    useSettingsStore.setState({ settings: { autoRouting: { enabled: true } } as never })
    const { container } = renderPicker({
      ...session,
      model: "auto",
      providerOverride: undefined,
    })
    // The badge is the only primary-tinted chip in the trigger.
    expect(container.querySelector(".text-primary")).not.toBeNull()
  })

  it("omits the badge for a concrete model even when Auto is available", () => {
    useSettingsStore.setState({ settings: { autoRouting: { enabled: true } } as never })
    const { container } = renderPicker()
    expect(container.querySelector(".text-primary")).toBeNull()
  })

  it("selecting the Auto row enables routing and stores a session-level selection", () => {
    const save = jest.fn(async () => undefined)
    useSettingsStore.setState({ settings: { autoRouting: { enabled: false } } as never, save })
    renderPicker()
    fireEvent.click(screen.getByRole("button")) // open the popover
    fireEvent.click(screen.getByRole("option", { name: /^Auto/ }))
    expect(save).toHaveBeenCalledWith({
      autoRouting: expect.objectContaining({ enabled: true }),
    })
    expect(mockedUpdateSession).toHaveBeenCalledWith(
      "ses_1",
      expect.objectContaining({ model: "auto", providerOverride: undefined })
    )
  })

  it("starts from the existing default Auto policy when no Auto block is stored", () => {
    const save = jest.fn(async () => undefined)
    useSettingsStore.setState({ settings: {} as never, save })
    renderPicker()
    fireEvent.click(screen.getByRole("button"))
    fireEvent.click(screen.getByRole("option", { name: /^Auto/ }))

    expect(save).toHaveBeenCalledWith({
      autoRouting: expect.objectContaining({
        enabled: true,
        defaultSelection: "manual",
        strategy: "reliability",
      }),
    })
  })

  it("closes the live desktop session after selecting Auto and swallows close failures", () => {
    const save = jest.fn(async () => undefined)
    mockHostProfile.mockReturnValue("desktop")
    mockCloseSession.mockRejectedValueOnce(new Error("already closed"))
    useSettingsStore.setState({ settings: { autoRouting: { enabled: false } } as never, save })
    renderPicker()
    fireEvent.click(screen.getByRole("button"))
    fireEvent.click(screen.getByRole("option", { name: /^Auto/ }))

    expect(mockCloseSession).toHaveBeenCalledWith("ses_1")
    expect(mockedUpdateSession).toHaveBeenCalledWith(
      "ses_1",
      expect.objectContaining({ model: "auto", providerOverride: undefined })
    )
  })

  it("switching to a concrete model leaves Auto available globally", () => {
    const save = jest.fn(async () => undefined)
    useSettingsStore.setState({ settings: { autoRouting: { enabled: true } } as never, save })
    renderPicker()
    fireEvent.click(screen.getByRole("button"))
    const target = PROVIDERS.anthropic.models.find((model) => model.id !== session.model)?.id
    if (!target) return
    fireEvent.click(screen.getAllByText(target)[0])
    expect(save).not.toHaveBeenCalled()
  })
})

describe("live model switch", () => {
  function renderPicker(
    session: ChatSession,
    controls?: { setModel?: (model: string) => Promise<void>; resetRuntime?: () => Promise<void> }
  ) {
    return render(
      <NextIntlClientProvider locale="en" messages={{}}>
        <TooltipProvider>
          {controls ? (
            <ChatScopeProvider sessionId={session.id} {...controls}>
              <ModelPicker session={session} />
            </ChatScopeProvider>
          ) : (
            <ModelPicker session={session} />
          )}
        </TooltipProvider>
      </NextIntlClientProvider>
    )
  }

  const anthropicSession: ChatSession = {
    id: "ses_live",
    title: "t",
    kind: "direct",
    model: PROVIDERS.anthropic.defaultModel,
    providerOverride: "anthropic",
    createdAt: 0,
    updatedAt: 0,
  }

  beforeEach(() => {
    mockedUpdateSession.mockClear()
    mockSetSessionModel.mockClear()
    mockCloseSession.mockClear()
    mockHostProfile.mockReturnValue("desktop")
    // Two enabled built-ins so the list offers an off-provider (openai) row too.
    act(() => {
      useSettingsStore.setState({
        settings: {
          defaultProvider: "anthropic",
          defaultModel: PROVIDERS.anthropic.defaultModel,
          providerSettings: {
            anthropic: { enabled: true },
            openai: { enabled: true },
          },
        } as never,
      })
    })
  })

  afterEach(() => {
    mockHostProfile.mockReturnValue("web-standalone")
    act(() => {
      useSettingsStore.setState({ settings: undefined as never })
    })
  })

  it("drives the live SDK setModel when staying on the Anthropic provider", () => {
    const target = PROVIDERS.anthropic.models.find((m) => m.id !== anthropicSession.model)?.id
    if (!target) return // catalog has a single model — nothing to switch to
    renderPicker(anthropicSession)
    fireEvent.click(screen.getByRole("button"))
    fireEvent.click(screen.getAllByText(target)[0])
    expect(mockedUpdateSession).toHaveBeenCalledWith(
      "ses_live",
      expect.objectContaining({ model: target, providerOverride: "anthropic" })
    )
    expect(mockSetSessionModel).toHaveBeenCalledWith("ses_live", target)
    expect(mockCloseSession).not.toHaveBeenCalled()
  })

  it("uses the pane-owned handle callbacks for model switches and runtime resets", () => {
    const setModel = jest.fn(async () => undefined)
    const resetRuntime = jest.fn(async () => undefined)
    const target = PROVIDERS.anthropic.models.find((m) => m.id !== anthropicSession.model)?.id
    if (!target) return
    renderPicker(anthropicSession, { setModel, resetRuntime })
    fireEvent.click(screen.getByRole("button"))
    fireEvent.click(screen.getAllByText(target)[0])
    expect(setModel).toHaveBeenCalledWith(target)
    expect(mockSetSessionModel).not.toHaveBeenCalled()

    const openAiTarget = PROVIDERS.openai.models[0]?.id
    if (!openAiTarget) return
    fireEvent.click(screen.getByRole("button"))
    fireEvent.click(screen.getAllByText(openAiTarget)[0])
    expect(resetRuntime).toHaveBeenCalledTimes(1)
    expect(mockCloseSession).not.toHaveBeenCalled()
  })

  it("closes the session (no in-place setModel) when changing provider", () => {
    const openaiModel = PROVIDERS.openai.defaultModel
    renderPicker(anthropicSession)
    fireEvent.click(screen.getByRole("button"))
    fireEvent.click(screen.getAllByText(openaiModel)[0])
    expect(mockedUpdateSession).toHaveBeenCalledWith(
      "ses_live",
      expect.objectContaining({ providerOverride: "openai" })
    )
    // Provider change → the live session is on the wrong dispatch path, so we
    // close it (next send re-dispatches on openai) rather than an in-place swap.
    expect(mockSetSessionModel).not.toHaveBeenCalled()
    expect(mockCloseSession).toHaveBeenCalledWith("ses_live")
  })

  it("live-switches (setModel, no close) when changing model within a non-Anthropic provider", () => {
    const openaiSession: ChatSession = {
      ...anthropicSession,
      model: PROVIDERS.openai.defaultModel,
      providerOverride: "openai",
    }
    const target = PROVIDERS.openai.models.find((m) => m.id !== openaiSession.model)?.id
    if (!target) return // single-model catalog — nothing to switch to
    renderPicker(openaiSession)
    fireEvent.click(screen.getByRole("button"))
    fireEvent.click(screen.getAllByText(target)[0])
    expect(mockedUpdateSession).toHaveBeenCalledWith(
      "ses_live",
      expect.objectContaining({ model: target, providerOverride: "openai" })
    )
    // Same provider → in-place live switch on the ai-sdk loop, session kept.
    expect(mockSetSessionModel).toHaveBeenCalledWith("ses_live", target)
    expect(mockCloseSession).not.toHaveBeenCalled()
  })

  it("skips the live call in a standalone browser, which has no sidecar to drive", () => {
    mockHostProfile.mockReturnValue("web-standalone")
    const target = PROVIDERS.anthropic.models.find((m) => m.id !== anthropicSession.model)?.id
    if (!target) return
    renderPicker(anthropicSession)
    fireEvent.click(screen.getByRole("button"))
    fireEvent.click(screen.getAllByText(target)[0])
    expect(mockSetSessionModel).not.toHaveBeenCalled()
  })

  it.each(["mobile-companion", "cloud-companion", "headless"] as const)(
    "drives the live setModel from a %s shell, whose host owns or reaches the sidecar",
    async (profile) => {
      // The regression: `isTauri()` gated this call, so a paired phone wrote
      // the override to the session row and the RUNNING session kept the old
      // model. `claude_session_control` is an execution-target command now,
      // and the picker asks the host profile instead of the webview kind.
      mockHostProfile.mockReturnValue(profile)
      const target = PROVIDERS.anthropic.models.find((m) => m.id !== anthropicSession.model)?.id
      if (!target) return
      renderPicker(anthropicSession)
      fireEvent.click(screen.getByRole("button"))
      fireEvent.click(screen.getAllByText(target)[0])
      expect(mockSetSessionModel).toHaveBeenCalledWith(anthropicSession.id, target)
      expect(mockCloseSession).not.toHaveBeenCalled()
      await waitFor(() => expect(toast.success).toHaveBeenCalled())
    }
  )
})

describe("an external agent's own models", () => {
  const session: ChatSession = {
    id: "ses_ext",
    title: "t",
    kind: "direct",
    model: "claude-sonnet-4-5",
    createdAt: 0,
    updatedAt: 0,
  }

  function renderPicker(s: ChatSession | null = session) {
    return render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <TooltipProvider>
          <ModelPicker session={s} />
        </TooltipProvider>
      </NextIntlClientProvider>
    )
  }

  beforeEach(() => {
    mockedUpdateSession.mockClear()
    mockAgentModels.select.mockClear()
    ;(toast.error as jest.Mock).mockClear()
    mockAgentModels.agentId = "pi-1"
    mockAgentModels.agentName = "Pi"
    mockAgentModels.externalSessionId = "sess-1"
    mockAgentModels.status = "ready"
    mockAgentModels.canRefresh = true
    mockAgentModels.loading = false
    mockAgentModels.surface = {
      choices: [
        { modelId: "anthropic/agent-sonnet", name: "Agent Sonnet" },
        { modelId: "openai/agent-gpt", name: "Agent GPT" },
      ],
      currentModelId: "anthropic/agent-sonnet",
      write: { kind: "config-option", optionId: "model" },
    }
    act(() => {
      useSettingsStore.setState({
        settings: { defaultModel: "claude-sonnet-4-5", defaultProvider: "anthropic" } as never,
      })
    })
  })

  afterEach(() => {
    mockAgentModels.agentId = null
    mockAgentModels.agentName = null
    mockAgentModels.surface = null
    mockAgentModels.status = "idle"
    mockAgentModels.canRefresh = false
    act(() => useSettingsStore.setState({ settings: undefined as never }))
    act(() => useExternalAgentStore.setState({ agents: {}, connectionStatus: {} } as never))
  })

  const commandItems = () =>
    Array.from(document.querySelectorAll('[data-slot="command-item"]')) as HTMLElement[]

  describe("when the agent contributes no models", () => {
    beforeEach(() => {
      mockAgentModels.surface = null
      mockAgentModels.status = "idle"
    })

    it("says the agent is offline rather than showing an unchanged list", () => {
      // Picking an agent and seeing the identical provider list reads as "that
      // did nothing". Offline is one action away from being fixed.
      mockAgentModels.externalSessionId = null
      act(() => {
        useExternalAgentStore.setState({
          agents: { "pi-1": { id: "pi-1", name: "Pi" } },
          connectionStatus: { "pi-1": "disconnected" },
        } as never)
      })
      renderPicker()
      fireEvent.click(screen.getByRole("button", { name: /switch model/i }))
      expect(screen.getByText(/is not connected/i)).toBeInTheDocument()
    })

    it("does not guess at the connection of an agent this client does not hold", () => {
      // A configuration the paired Host owns is not in this client's store.
      mockAgentModels.status = "unsupported"
      renderPicker()
      fireEvent.click(screen.getByRole("button", { name: /switch model/i }))
      expect(screen.queryByText(/is not connected/i)).toBeNull()
      expect(screen.getByText(/Pi reported no models/i)).toBeInTheDocument()
    })

    it("names the agent and its default on the chip, never a Cognia provider model", () => {
      renderPicker()
      const trigger = screen.getByRole("button", { name: /switch model/i })
      expect(trigger).toHaveTextContent("Pi · default")
      expect(trigger).not.toHaveTextContent(/sonnet/i)
    })

    it("names the model this conversation picked before the agent has said", () => {
      renderPicker({
        ...session,
        model: "kimi-code/k3",
        providerOverride: externalAgentProviderId("pi-1"),
      })
      expect(screen.getByRole("button", { name: /switch model/i })).toHaveTextContent(
        "kimi-code/k3"
      )
    })

    // On a phone paired to a headless Host the agent runs there, and this
    // client learns its models from the Host's report after a turn.
    describe("on a paired Host's lane", () => {
      beforeEach(() => {
        mockAgentModels.agentId = "eac_1"
        mockAgentModels.agentName = "Kimi Code"
        mockAgentModels.externalSessionId = null
        mockAgentModels.status = "deferred"
        mockAgentModels.canRefresh = false
      })

      it("says the models arrive after the first message instead of asking forever", () => {
        mockAgentModels.refresh.mockClear()
        renderPicker()
        expect(screen.getByRole("button", { name: /switch model/i })).toHaveTextContent(
          "Kimi Code · default"
        )
        fireEvent.click(screen.getByRole("button", { name: /switch model/i }))
        expect(screen.getByText(/appear after the first message/i)).toBeInTheDocument()
        expect(screen.queryByText(/reading/i)).toBeNull()
        // Asking again has nobody to ask, so there is no control for it.
        expect(screen.queryByRole("button", { name: /refresh models/i })).toBeNull()
        expect(mockAgentModels.refresh).not.toHaveBeenCalled()
        // Only the row for the agent's own default, selected, its id unprinted.
        const items = commandItems()
        expect(items).toHaveLength(1)
        expect(items[0]).toHaveTextContent("Default model")
        expect(items[0]).not.toHaveTextContent("__agent-default__")
        expect(items[0]?.querySelector("svg.opacity-100")).not.toBeNull()
      })
    })

    it("offers refresh before a session exists", () => {
      mockAgentModels.externalSessionId = null
      act(() => {
        useExternalAgentStore.setState({
          agents: { "pi-1": { id: "pi-1", name: "Pi" } },
          connectionStatus: { "pi-1": "connected" },
        } as never)
      })
      renderPicker()
      fireEvent.click(screen.getByRole("button", { name: /switch model/i }))
      expect(screen.getByRole("button", { name: /refresh models/i })).toBeEnabled()
      expect(screen.queryByText(/first turn/i)).not.toBeInTheDocument()
    })

    it("says the agent reported none only when it was actually asked", () => {
      mockAgentModels.externalSessionId = "sess-1"
      mockAgentModels.status = "unsupported"
      act(() => {
        useExternalAgentStore.setState({ connectionStatus: { "pi-1": "connected" } })
      })
      renderPicker()
      fireEvent.click(screen.getByRole("button", { name: /switch model/i }))
      expect(screen.getByText(/reported no models/i)).toBeInTheDocument()
    })

    it("offers no built-in provider model and no Auto routing in place of the agent's own", () => {
      renderPicker()
      fireEvent.click(screen.getByRole("button", { name: /switch model/i }))
      // The agent's own default is the only row: nothing from a provider.
      expect(commandItems().map((node) => node.textContent)).toEqual([
        expect.stringContaining("Default model"),
      ])
      expect(screen.queryByText("Routing")).toBeNull()
      expect(screen.queryByText(/no providers configured/i)).toBeNull()
    })

    it("says it is reading the models while it is", () => {
      mockAgentModels.loading = true
      renderPicker()
      fireEvent.click(screen.getByRole("button", { name: /switch model/i }))
      expect(screen.getByText("Reading Pi's models…")).toBeInTheDocument()
      mockAgentModels.loading = false
    })
  })

  it("re-asks the agent as the list opens, so a session opened since is seen", () => {
    // The agent opens its session on the first turn and no store says so. A
    // picker mounted before that turn resolved `null` once and, with nothing
    // re-running it, reported "nothing open" for the rest of the conversation.
    mockAgentModels.refresh.mockClear()
    renderPicker()
    fireEvent.click(screen.getByRole("button", { name: /switch model/i }))
    expect(mockAgentModels.refresh).toHaveBeenCalled()
  })

  it("refreshes models inside the open list and prevents duplicate refresh while loading", () => {
    const { rerender } = renderPicker()
    fireEvent.click(screen.getByRole("button", { name: /switch model/i }))
    mockAgentModels.refresh.mockClear()
    fireEvent.click(screen.getByRole("button", { name: /refresh models/i }))
    expect(mockAgentModels.refresh).toHaveBeenCalledTimes(1)
    mockAgentModels.loading = true
    rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <TooltipProvider>
          <ModelPicker session={session} />
        </TooltipProvider>
      </NextIntlClientProvider>
    )
    expect(screen.getByRole("button", { name: /refresh models/i })).toBeDisabled()
    mockAgentModels.loading = false
  })

  it("reports model discovery failures with a retry control", () => {
    mockAgentModels.surface = null
    mockAgentModels.status = "error"
    renderPicker()
    fireEvent.click(screen.getByRole("button", { name: /switch model/i }))
    expect(screen.getByText(/could not load models/i)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /refresh models/i })).toBeEnabled()
  })

  it("shows the agent's current model on the trigger, because that is what runs", () => {
    renderPicker()
    expect(screen.getByRole("button", { name: /switch model/i })).toHaveTextContent("Agent Sonnet")
  })

  it("says nothing extra once the agent has actually listed models", () => {
    renderPicker()
    fireEvent.click(screen.getByRole("button", { name: /switch model/i }))
    expect(screen.queryByText(/is not connected/i)).toBeNull()
    expect(screen.queryByText(/reported no models/i)).toBeNull()
  })

  it("lists only the agent's own models, with the one running ticked", () => {
    // Listing the configured providers under the agent offered Claude to Kimi
    // Code, with the provider default ticked as if it were the one running.
    renderPicker()
    fireEvent.click(screen.getByRole("button", { name: /switch model/i }))
    expect(commandItems().map((node) => node.textContent)).toEqual([
      expect.stringContaining("Agent Sonnet"),
      expect.stringContaining("Agent GPT"),
    ])
    expect(screen.queryByText("Routing")).toBeNull()
    // Headed by the agent's name, with its current model ticked.
    expect(screen.getAllByText("Pi").length).toBeGreaterThan(0)
    const [running, other] = commandItems()
    expect(running.querySelector("svg.opacity-100")).not.toBeNull()
    expect(other.querySelector("svg.opacity-100")).toBeNull()
  })

  it("prefers the pending pick over a seeded surface's current model, and says when it applies", () => {
    // A seeded surface (a Host's report, or a catalog before the first turn)
    // only changes with the next turn, so the pick is what will run.
    mockAgentModels.surface = {
      ...mockAgentModels.surface!,
      write: { kind: "session-seed" },
    }
    renderPicker({
      ...session,
      model: "openai/agent-gpt",
      providerOverride: externalAgentProviderId("pi-1"),
    })
    expect(screen.getByRole("button", { name: /switch model/i })).toHaveTextContent("Agent GPT")
    fireEvent.click(screen.getByRole("button", { name: /switch model/i }))
    expect(screen.getByText(/applied on the next message/i)).toBeInTheDocument()
  })

  it("restores the provider list and selection when the conversation leaves the agent", () => {
    const { rerender } = renderPicker({
      ...session,
      model: "claude-opus-4-8",
      providerOverride: "anthropic",
    })
    expect(screen.getByRole("button", { name: /switch model/i })).toHaveTextContent("Agent Sonnet")

    mockAgentModels.agentId = null
    mockAgentModels.surface = null
    rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <TooltipProvider>
          <ModelPicker
            session={{ ...session, model: "claude-opus-4-8", providerOverride: "anthropic" }}
          />
        </TooltipProvider>
      </NextIntlClientProvider>
    )
    const trigger = screen.getByRole("button", { name: /switch model/i })
    expect(trigger).toHaveTextContent(/opus 4\.8/i)
    fireEvent.click(trigger)
    expect(
      commandItems().some((node) => node.textContent?.includes(PROVIDERS.anthropic.defaultModel))
    ).toBe(true)
    expect(screen.getByText("Routing")).toBeInTheDocument()
  })

  it("does not name an agent's model on the built-in lane", () => {
    // The row still holds the Kimi pick (it is replayed if the chat goes back
    // to Kimi), but the built-in turn runs the provider default, so the chip
    // says that.
    mockAgentModels.agentId = null
    mockAgentModels.surface = null
    renderPicker({
      ...session,
      model: "kimi-code/k3",
      providerOverride: externalAgentProviderId("eac_1"),
    })
    const trigger = screen.getByRole("button", { name: /switch model/i })
    expect(trigger).not.toHaveTextContent("kimi-code/k3")
    expect(trigger).toHaveAttribute("aria-label", "Switch model")
  })

  it("persists a welcome-screen plugin model for the first conversation", async () => {
    const previousSave = useSettingsStore.getState().save
    const save = jest.fn().mockResolvedValue(undefined)
    useSettingsStore.setState({ save })
    try {
      renderPicker(null)
      fireEvent.click(screen.getByRole("button", { name: /switch model/i }))
      fireEvent.click(screen.getByText("Agent GPT"))
      // Into the per-agent default `createSession` copies onto the next row,
      // never into the built-in lane's default model.
      await waitFor(() =>
        expect(save).toHaveBeenCalledWith({
          externalAgentModelDefaults: { "pi-1": { kind: "native", modelId: "openai/agent-gpt" } },
        })
      )
    } finally {
      useSettingsStore.setState({ save: previousSave })
    }
  })

  it("routes a pick of an agent model to the agent, not to a session override alone", async () => {
    renderPicker()
    fireEvent.click(screen.getByRole("button", { name: /switch model/i }))
    const target = Array.from(document.querySelectorAll('[data-slot="command-item"]')).find(
      (node) => node.textContent?.includes("Agent GPT")
    ) as HTMLElement
    fireEvent.click(target)

    expect(mockAgentModels.select).toHaveBeenCalledWith("openai/agent-gpt")
    // The id is persisted so `applyModelToSession` replays it on the next
    // session, in the conversation's per-agent column. The built-in lane's
    // `model` / `providerOverride` are never touched by an agent pick.
    await waitFor(() =>
      expect(mockedUpdateSession).toHaveBeenCalledWith("ses_ext", {
        externalAgentModels: { "pi-1": { kind: "native", modelId: "openai/agent-gpt" } },
      })
    )
  })

  it("does not persist a model the agent refused", async () => {
    // The row is replayed by `applyModelToSession` on every session the agent
    // opens, so a rejected id written anyway is re-requested forever while the
    // chip, rolled back, shows the model that is actually running.
    mockAgentModels.select.mockRejectedValueOnce(new Error("Pi rejected the model"))
    renderPicker()
    fireEvent.click(screen.getByRole("button", { name: /switch model/i }))
    const target = Array.from(document.querySelectorAll('[data-slot="command-item"]')).find(
      (node) => node.textContent?.includes("Agent GPT")
    ) as HTMLElement
    fireEvent.click(target)

    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    expect(mockedUpdateSession).not.toHaveBeenCalled()
  })

  it("writes the app default when there is no conversation to override", () => {
    mockAgentModels.agentId = null
    mockAgentModels.surface = null
    const save = jest.fn()
    act(() => useSettingsStore.setState({ save } as never))

    renderPicker(null)
    fireEvent.click(screen.getByRole("button", { name: /switch model/i }))
    const target = Array.from(document.querySelectorAll('[data-slot="command-item"]')).find(
      (node) => node.textContent?.includes(PROVIDERS.anthropic.defaultModel)
    ) as HTMLElement
    fireEvent.click(target)

    expect(save).toHaveBeenCalledWith({
      defaultModel: PROVIDERS.anthropic.defaultModel,
      defaultProvider: "anthropic",
    })
    expect(mockedUpdateSession).not.toHaveBeenCalled()
  })

  describe("Cognia models through the gateway", () => {
    const anthropic = {
      providerId: "anthropic",
      providerName: "Anthropic",
      models: [
        { id: "claude-opus-5", name: "Claude Opus 5", supportsTools: true },
        { id: "claude-text", name: "Claude Text", supportsTools: false },
        { id: "claude-batch", name: "Claude Batch", supportsStreaming: false },
      ],
    }
    const cognia = {
      kind: "cognia" as const,
      binding: { providerId: "anthropic", modelId: "claude-opus-5" },
    }

    beforeEach(() => {
      mockCogniaModels.agentId = "pi-1"
      mockCogniaModels.lane = "local"
      mockCogniaModels.status = "ready"
      mockCogniaModels.providers = [anthropic]
      mockCogniaModels.reason = null
      mockCogniaModels.refresh.mockClear()
    })

    afterEach(() => {
      mockCogniaModels.agentId = null
      mockCogniaModels.lane = null
      mockCogniaModels.status = "idle"
      mockCogniaModels.providers = []
      mockCogniaModels.reason = null
      forgetAgentModelSurface()
    })

    it("lists them in their own section under the agent's own models", () => {
      renderPicker()
      fireEvent.click(screen.getByRole("button", { name: /switch model/i }))
      expect(screen.getByText("Cognia models")).toBeInTheDocument()
      expect(screen.getByText(/applies from the next message/i)).toBeInTheDocument()
      expect(commandItems().map((node) => node.textContent)).toEqual([
        expect.stringContaining("Agent Sonnet"),
        expect.stringContaining("Agent GPT"),
        expect.stringContaining("Claude Opus 5"),
        expect.stringContaining("Claude Text"),
        expect.stringContaining("Claude Batch"),
      ])
    })

    it("disables a model the gateway would refuse, saying why", () => {
      renderPicker()
      fireEvent.click(screen.getByRole("button", { name: /switch model/i }))
      const [, , runnable, noTools, noStreaming] = commandItems()
      expect(runnable).not.toHaveAttribute("data-disabled", "true")
      expect(noTools).toHaveAttribute("data-disabled", "true")
      expect(noTools).toHaveTextContent("No tool calling")
      expect(noStreaming).toHaveAttribute("data-disabled", "true")
      expect(noStreaming).toHaveTextContent("No streaming")
    })

    it("writes a Cognia pick to the conversation's per-agent choice only", async () => {
      renderPicker({ ...session, externalAgentModels: { codex: { kind: "native" } } })
      fireEvent.click(screen.getByRole("button", { name: /switch model/i }))
      fireEvent.click(screen.getByText("Claude Opus 5"))
      await waitFor(() =>
        expect(mockedUpdateSession).toHaveBeenCalledWith("ses_ext", {
          externalAgentModels: { codex: { kind: "native" }, "pi-1": cognia },
        })
      )
      expect(mockAgentModels.select).not.toHaveBeenCalled()
      // The chip names it straight away, with the route on hover.
      const trigger = screen.getByRole("button", { name: /switch model/i })
      expect(trigger).toHaveTextContent("Claude Opus 5")
      expect(screen.getByTitle("Pi → Anthropic/Claude Opus 5 via Cognia")).toBeInTheDocument()
      expect(screen.getByLabelText("Cognia model")).toBeInTheDocument()
    })

    it("writes a Cognia pick made before the conversation exists to the app default", async () => {
      const previousSave = useSettingsStore.getState().save
      const save = jest.fn().mockResolvedValue(undefined)
      useSettingsStore.setState({ save })
      try {
        renderPicker(null)
        fireEvent.click(screen.getByRole("button", { name: /switch model/i }))
        fireEvent.click(screen.getByText("Claude Opus 5"))
        await waitFor(() =>
          expect(save).toHaveBeenCalledWith({ externalAgentModelDefaults: { "pi-1": cognia } })
        )
      } finally {
        useSettingsStore.setState({ save: previousSave })
      }
    })

    it("names a stored Cognia choice on the chip, never the built-in lane's pick", () => {
      renderPicker({
        ...session,
        model: "claude-sonnet-4-5",
        providerOverride: "anthropic",
        externalAgentModels: { "pi-1": cognia },
      })
      const trigger = screen.getByRole("button", { name: /switch model/i })
      expect(trigger).toHaveTextContent("Claude Opus 5")
      fireEvent.click(trigger)
      const opus = commandItems().find((node) => node.textContent?.includes("Claude Opus 5"))
      expect(opus?.querySelector("svg.opacity-100")).not.toBeNull()
    })

    it("offers the agent's last native list while a Cognia model runs, and switches back", async () => {
      // The gateway task is what is open, so the agent itself lists nothing.
      mockAgentModels.surface = null
      mockAgentModels.status = "unsupported"
      recordReportedAgentModelSurface("pi-1", "ses_ext", "native-1", {
        models: {
          choices: [{ modelId: "kimi-k2", name: "Kimi K2" }],
          currentModelId: "kimi-k2",
          write: { kind: "config-option", optionId: "model" },
        },
        thinking: EMPTY_THINKING_SURFACE,
      })
      renderPicker({ ...session, externalAgentModels: { "pi-1": cognia } })
      fireEvent.click(screen.getByRole("button", { name: /switch model/i }))
      expect(screen.getByText(/applied on the next message/i)).toBeInTheDocument()
      fireEvent.click(screen.getByText("Kimi K2"))
      await waitFor(() =>
        expect(mockedUpdateSession).toHaveBeenCalledWith("ses_ext", {
          externalAgentModels: { "pi-1": { kind: "native", modelId: "kimi-k2" } },
        })
      )
      // Nothing live to write to: the next native turn applies it.
      expect(mockAgentModels.select).not.toHaveBeenCalled()
    })

    it("switches a conversation that began on a Cognia model back to the agent's default", async () => {
      // No native turn ever ran, so neither the agent nor this machine has a
      // list of its own models. The default row is the way back.
      mockAgentModels.surface = null
      mockAgentModels.status = "deferred"
      renderPicker({ ...session, externalAgentModels: { "pi-1": cognia } })
      fireEvent.click(screen.getByRole("button", { name: /switch model/i }))
      fireEvent.click(screen.getByText("Default model"))
      await waitFor(() =>
        expect(mockedUpdateSession).toHaveBeenCalledWith("ses_ext", {
          externalAgentModels: { "pi-1": { kind: "native" } },
        })
      )
      expect(mockAgentModels.select).not.toHaveBeenCalled()
      expect(screen.getByRole("button", { name: /switch model/i })).toHaveTextContent(
        "Pi · default"
      )
    })

    it.each([
      ["host-update-required", /update the paired host/i],
      ["unsupported-runtime", /its runtime has no isolated gateway launch/i],
      ["no-eligible-models", /no configured provider can serve pi/i],
      ["account-locked", /account is locked/i],
      ["public-https-required", /public https/i],
    ])("shows the section disabled when the answer is %s", (reason, text) => {
      mockCogniaModels.status = "unavailable"
      mockCogniaModels.reason = reason
      mockCogniaModels.providers = []
      renderPicker()
      fireEvent.click(screen.getByRole("button", { name: /switch model/i }))
      expect(screen.getByText("Cognia models")).toBeInTheDocument()
      expect(screen.getByText(text)).toBeInTheDocument()
      expect(commandItems()).toHaveLength(2)
    })

    it("re-asks the Host for its Cognia models as the list opens", () => {
      mockCogniaModels.lane = "host"
      mockAgentModels.canRefresh = false
      renderPicker()
      fireEvent.click(screen.getByRole("button", { name: /switch model/i }))
      expect(mockCogniaModels.refresh).toHaveBeenCalled()
    })
  })
})
