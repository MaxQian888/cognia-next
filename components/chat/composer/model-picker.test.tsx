/**
 * @jest-environment jsdom
 */
import { act, fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { ModelPicker, __testing__ } from "./model-picker"
import { PROVIDERS } from "@cognia/provider-types/provider"
import type { UserProviderSettings, CustomProviderSettings } from "@cognia/provider-types/provider"
import type { ChatSession } from "@cognia/agent-config-types"
import { updateSession } from "@/lib/db/sessions"
import { isTauri } from "@/lib/tauri"
import { useSettingsStore } from "@/stores/settings"
import enMessages from "@/i18n/messages/en.json"
import { ChatScopeProvider } from "@/components/chat/chat-scope-provider"

// The picker persists model switches through the Dexie sessions table —
// irrelevant for trigger-rendering assertions.
jest.mock("@/lib/db/sessions", () => ({
  updateSession: jest.fn(async () => undefined),
}))

const mockedUpdateSession = updateSession as unknown as jest.Mock

// Live-switch deps. Defaults: web mode (isTauri false) so the existing
// rendering tests never trip the live path; the live-switch suite flips it on.
jest.mock("@/lib/tauri", () => {
  const actual = jest.requireActual("@/lib/tauri")
  return { ...actual, isTauri: jest.fn(() => false) }
})
const mockIsTauri = isTauri as jest.MockedFunction<typeof isTauri>
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
        <ModelPicker session={session} />
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
        <ModelPicker session={{ ...session, model: "auto", providerOverride: undefined }} />
      </NextIntlClientProvider>
    )

    fireEvent.click(screen.getByRole("button", { name: /switch model/i }))
    const autoItem = screen
      .getAllByText("Auto")
      .map((element) => element.closest("[cmdk-item]"))
      .find((element) => element !== null)

    expect(autoItem).not.toBeNull()
    const centeredAutoCalls = scrollIntoView.mock.contexts.filter(
      (context, index) =>
        context === autoItem &&
        scrollIntoView.mock.calls[index]?.[0]?.behavior === "auto" &&
        scrollIntoView.mock.calls[index]?.[0]?.block === "center"
    )
    expect(centeredAutoCalls).toHaveLength(1)
  })
})

describe("reasoning effort integration", () => {
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
              effort: { aria: "Thinking level", auto: "Auto" },
              modelPicker: { effortSuffix: "· {effort}" },
            },
          },
          settings: {
            general: {
              effort: { low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
            },
          },
        }}
      >
        <ModelPicker session={session} />
      </NextIntlClientProvider>
    )
  }

  it("shows the selected effort on the model chip and inside the open picker", () => {
    renderPicker(capableSession)

    expect(screen.getByTestId("model-picker-effort")).toHaveTextContent("high")
    fireEvent.click(screen.getByRole("button"))
    expect(screen.getByTestId("effort-selector-section")).toBeInTheDocument()
    expect(screen.getByRole("slider", { name: "Thinking level" })).toHaveAttribute(
      "aria-valuetext",
      "high"
    )
  })

  it("omits effort UI for a model that does not support effort", () => {
    renderPicker({ ...capableSession, model: "claude-sonnet-4-5" })

    expect(screen.queryByTestId("model-picker-effort")).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("button"))
    expect(screen.queryByTestId("effort-selector-section")).not.toBeInTheDocument()
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
        <ModelPicker session={value} />
      </NextIntlClientProvider>
    )

  beforeEach(() => {
    mockedUpdateSession.mockClear()
    mockCloseSession.mockClear()
    mockIsTauri.mockReturnValue(false)
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
    fireEvent.click(screen.getByText("Auto"))
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
    fireEvent.click(screen.getByText("Auto"))

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
    mockIsTauri.mockReturnValue(true)
    mockCloseSession.mockRejectedValueOnce(new Error("already closed"))
    useSettingsStore.setState({ settings: { autoRouting: { enabled: false } } as never, save })
    renderPicker()
    fireEvent.click(screen.getByRole("button"))
    fireEvent.click(screen.getByText("Auto"))

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
        {controls ? (
          <ChatScopeProvider sessionId={session.id} {...controls}>
            <ModelPicker session={session} />
          </ChatScopeProvider>
        ) : (
          <ModelPicker session={session} />
        )}
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
    mockIsTauri.mockReturnValue(true)
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
    mockIsTauri.mockReturnValue(false)
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

  it("skips the live call in web mode", () => {
    mockIsTauri.mockReturnValue(false)
    const target = PROVIDERS.anthropic.models.find((m) => m.id !== anthropicSession.model)?.id
    if (!target) return
    renderPicker(anthropicSession)
    fireEvent.click(screen.getByRole("button"))
    fireEvent.click(screen.getAllByText(target)[0])
    expect(mockSetSessionModel).not.toHaveBeenCalled()
  })
})
