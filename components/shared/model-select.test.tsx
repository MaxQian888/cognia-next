/**
 * @jest-environment jsdom
 */
import { act, fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { TooltipProvider } from "@/components/ui/tooltip"

import { ModelSelect, groupByProvider, resolveOptionModelName } from "./model-select"
import { useSettingsStore } from "@/stores/settings"
import { PROVIDERS } from "@cognia/provider-types/provider"
import type { ModelOption } from "@/lib/ai/model-options"
import enMessages from "@/i18n/messages/en.json"

// Radix Popover + cmdk Command need these pointer/scroll primitives in jsdom.
beforeAll(() => {
  if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false
  if (!Element.prototype.setPointerCapture) Element.prototype.setPointerCapture = () => {}
  if (!Element.prototype.releasePointerCapture) Element.prototype.releasePointerCapture = () => {}
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {}
})

const useIsMobileMock = jest.fn().mockReturnValue(false)
jest.mock("@/hooks/ui/use-mobile", () => ({
  useIsMobile: () => useIsMobileMock(),
}))

beforeEach(() => {
  useIsMobileMock.mockReset().mockReturnValue(false)
})

const ANTHROPIC_MODEL = PROVIDERS.anthropic.defaultModel
const ANTHROPIC_NAME = PROVIDERS.anthropic.models.find((m) => m.id === ANTHROPIC_MODEL)?.name

function seedSettings() {
  useSettingsStore.setState({
    settings: {
      providerSettings: { anthropic: { enabled: true } },
      customProviders: [],
    },
  } as never)
}

function renderSelect(props: Partial<React.ComponentProps<typeof ModelSelect>> = {}) {
  return render(
    <TooltipProvider>
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <ModelSelect model={ANTHROPIC_MODEL} provider="anthropic" onSelect={jest.fn()} {...props} />
      </NextIntlClientProvider>
    </TooltipProvider>
  )
}

describe("groupByProvider", () => {
  it("renders the provider name once with its refresh action in the same heading", () => {
    const refresh = jest.fn()
    renderSelect({
      leadingGroups: [
        {
          providerId: "pi",
          providerName: "Pi",
          models: [{ id: "m1", name: "Plugin model" }],
          headingAction: <button onClick={refresh}>Refresh models</button>,
        },
      ],
    })
    fireEvent.click(screen.getByRole("button", { name: /switch model/i }))
    expect(screen.getAllByText("Pi")).toHaveLength(1)
    fireEvent.click(screen.getByRole("button", { name: "Refresh models" }))
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(screen.getByText("Plugin model")).toBeInTheDocument()
  })
  const opt = (over: Partial<ModelOption>): ModelOption => ({
    providerId: "anthropic",
    providerName: "Anthropic",
    modelId: "m1",
    modelName: "Model One",
    ...over,
  })

  it("preserves provider and model insertion order", () => {
    const groups = groupByProvider([
      opt({ providerId: "a", providerName: "A", modelId: "a1" }),
      opt({ providerId: "b", providerName: "B", modelId: "b1" }),
      opt({ providerId: "a", providerName: "A", modelId: "a2" }),
    ])
    expect(groups.map((g) => g.providerId)).toEqual(["a", "b"])
    expect(groups[0].models.map((m) => m.id)).toEqual(["a1", "a2"])
  })

  it("dedupes a repeated model within one provider", () => {
    const groups = groupByProvider([opt({ modelId: "m1" }), opt({ modelId: "m1" })])
    expect(groups[0].models).toHaveLength(1)
  })
})

describe("resolveOptionModelName", () => {
  const options: ModelOption[] = [
    { providerId: "a", providerName: "A", modelId: "shared", modelName: "From A" },
    { providerId: "b", providerName: "B", modelId: "shared", modelName: "From B" },
  ]

  it("prefers the option matching both provider and model", () => {
    expect(resolveOptionModelName(options, "shared", "b")).toBe("From B")
  })

  it("falls back to a same-id option from another provider", () => {
    expect(resolveOptionModelName(options, "shared", "unknown")).toBe("From A")
  })

  it("falls back to the raw id when nothing matches", () => {
    expect(resolveOptionModelName(options, "mystery", "a")).toBe("mystery")
  })
})

describe("ModelSelect", () => {
  beforeEach(() => seedSettings())

  it("labels the trigger with the catalog display name", () => {
    renderSelect()
    expect(screen.getByRole("button").textContent).toContain(ANTHROPIC_NAME)
  })

  it("reports the provider alongside the model on selection", () => {
    const onSelect = jest.fn()
    renderSelect({ onSelect })
    fireEvent.click(screen.getByRole("button", { name: /switch model/i }))
    const other = PROVIDERS.anthropic.models.find((m) => m.id !== ANTHROPIC_MODEL)!
    fireEvent.click(screen.getByText(other.name))
    expect(onSelect).toHaveBeenCalledWith({ providerId: "anthropic", modelId: other.id })
  })

  it("hides the Auto routing row unless the surface can honour it", () => {
    renderSelect()
    fireEvent.click(screen.getByRole("button", { name: /switch model/i }))
    expect(
      screen.queryByText(enMessages.chat.composer.modelPicker.autoModel)
    ).not.toBeInTheDocument()
  })

  it("shows and reports the Auto row when a handler is supplied", () => {
    const onSelectAuto = jest.fn()
    renderSelect({ onSelectAuto })
    fireEvent.click(screen.getByRole("button", { name: /switch model/i }))
    fireEvent.click(screen.getByText(enMessages.chat.composer.modelPicker.autoModel))
    expect(onSelectAuto).toHaveBeenCalled()
  })

  it("puts the active tick and the model metadata on the right of the row", () => {
    renderSelect()
    fireEvent.click(screen.getByRole("button", { name: /switch model/i }))
    // The trigger carries the same name, so pick the occurrence inside a row.
    const row = screen
      .getAllByText(ANTHROPIC_NAME!)
      .map((el) => el.closest("[data-slot='command-item']"))
      .find(Boolean)
    expect(row).toBeTruthy()
    const children = Array.from(row!.children)
    // Identity column first, tick last — nothing indents the name off the
    // left edge, and the row's trailing space is where the tick lives.
    expect(children[0]).toHaveTextContent(ANTHROPIC_NAME!)
    expect(children.at(-1)?.tagName.toLowerCase()).toBe("svg")
  })

  it("keeps the trigger shrinkable so long model ids truncate", () => {
    renderSelect({ model: "a-very-long-provider-scoped-model-identifier" })
    const trigger = screen.getByRole("button")
    expect(trigger.className).toContain("min-w-0")
    expect(trigger.className).toContain("max-w-full")
  })
})

describe("ModelSelect placeholder", () => {
  it("names the fallback when no model is set, and yields to a real one", () => {
    seedSettings()
    const { unmount } = renderSelect({ model: "", provider: "", placeholder: "App default" })
    expect(screen.getByRole("button", { name: /switch model/i })).toHaveTextContent("App default")
    unmount()
    renderSelect({ placeholder: "App default" })
    expect(screen.getByRole("button", { name: /switch model/i })).not.toHaveTextContent(
      "App default"
    )
  })
})

describe("ModelSelect shells", () => {
  it("opens an anchored panel carrying the overlay tier on a desktop pane", () => {
    renderSelect({ onSelectAuto: undefined })
    fireEvent.click(screen.getByRole("button", { name: /switch model/i }))
    const panel = screen.getByTestId("model-select-panel")
    expect(panel).toHaveAttribute("data-surface-layer", "overlay")
    expect(screen.queryByTestId("responsive-picker-drawer")).toBeNull()
  })

  it("opens a bottom sheet on a phone instead of a popover into the keyboard", () => {
    useIsMobileMock.mockReturnValue(true)
    renderSelect()
    fireEvent.click(screen.getByRole("button", { name: /switch model/i }))
    expect(screen.getByTestId("model-select-panel")).toBeInTheDocument()
    // Same panel test id, different shell: the drawer branch is what renders.
    expect(screen.getByTestId("model-select-panel").getAttribute("data-slot")).toBe(
      "drawer-content"
    )
    // The models themselves are still there, unchanged. Two matches: the
    // trigger's own label and the row inside the sheet.
    expect(screen.getAllByText(ANTHROPIC_NAME as string).length).toBeGreaterThan(1)
  })
})

it("updates an open picker when a subscription plugin registers and unloads", async () => {
  const { registerPluginSubscriptionProvider, unregisterSubscriptionProvidersByPlugin } =
    await import("@/lib/subscription/core/provider-registry")
  seedSettings()
  useSettingsStore.setState({
    settings: {
      ...useSettingsStore.getState().settings,
      providerSettings: { "picker:api": { providerId: "picker:api", enabled: true } },
    },
  } as never)
  renderSelect()
  fireEvent.click(screen.getByRole("button", { name: /switch model/i }))
  act(() => {
    registerPluginSubscriptionProvider(
      {
        id: "api",
        name: "Picker Plugin",
        baseUrl: "https://example.test/v1",
        protocol: "openai",
        models: ["picker-model"],
      },
      "picker"
    )
  })
  try {
    expect(screen.getByText("picker-model")).toBeInTheDocument()
  } finally {
    act(() => {
      unregisterSubscriptionProvidersByPlugin("picker")
    })
  }
  expect(screen.queryByText("picker-model")).not.toBeInTheDocument()
})

describe("ModelSelect compact label", () => {
  // On a phone the chip holds a few characters, and the full name ellipsized
  // to the vendor word every Anthropic model shares ("Claude S…").
  it("names the model by what tells it apart and drops the chevron", () => {
    seedSettings()
    renderSelect({
      leadingGroups: [
        {
          providerId: "anthropic",
          providerName: "Anthropic",
          models: [{ id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" }],
        },
      ],
      model: "claude-sonnet-4-6",
      compactLabel: true,
    })
    const trigger = screen.getByRole("button", { name: /switch model/i })
    const label = trigger.querySelector("span[title]")
    expect(label).toHaveTextContent(/^Sonnet 4\.6$/)
    expect(label).toHaveAttribute("title", "claude-sonnet-4-6")
    expect(trigger.querySelector("svg.lucide-chevrons-up-down")).toBeNull()
  })

  it("keeps the full name and chevron by default", () => {
    seedSettings()
    renderSelect({
      leadingGroups: [
        {
          providerId: "anthropic",
          providerName: "Anthropic",
          models: [{ id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" }],
        },
      ],
      model: "claude-sonnet-4-6",
    })
    const trigger = screen.getByRole("button", { name: /switch model/i })
    expect(trigger.querySelector("span[title]")).toHaveTextContent(/^Claude Sonnet 4\.6$/)
    expect(trigger.querySelector("svg.lucide-chevrons-up-down")).not.toBeNull()
  })
})

describe("ModelSelect for a surface run by an external agent", () => {
  beforeEach(() => act(seedSettings))

  const kimi = {
    providerId: "cognia:external-agent:eac_1",
    providerName: "Kimi Code",
    models: [
      { id: "kimi-code/kimi-for-coding", name: "K2.8 Preview" },
      { id: "kimi-code/k3", name: "K3" },
    ],
  }

  it("lists only the leading groups when providers are hidden", () => {
    const onSelect = jest.fn()
    renderSelect({
      model: "kimi-code/k3",
      provider: kimi.providerId,
      leadingGroups: [kimi],
      hideProviderGroups: true,
      onSelect,
    })
    fireEvent.click(screen.getByRole("button", { name: /switch model/i }))
    const items = Array.from(document.querySelectorAll('[data-slot="command-item"]'))
    expect(items.map((node) => node.textContent)).toEqual([
      expect.stringContaining("K2.8 Preview"),
      expect.stringContaining("K3"),
    ])
    expect(screen.queryByText(ANTHROPIC_NAME ?? ANTHROPIC_MODEL)).toBeNull()
    fireEvent.click(screen.getByText("K2.8 Preview"))
    expect(onSelect).toHaveBeenCalledWith({
      providerId: kimi.providerId,
      modelId: "kimi-code/kimi-for-coding",
    })
  })

  const piGroup = {
    providerId: "cognia:external-agent:pi",
    providerName: "Pi (native RPC)",
    headingAction: <button type="button">Refresh models</button>,
    models: [
      {
        id: "deepseek/deepseek-flash",
        name: "DeepSeek V4.1 Flash",
        contextLength: 1_000_000,
        supportsVision: true,
        supportsReasoning: true,
      },
      { id: "deepseek/deepseek-v4-pro", name: "DeepSeek V4 Pro", supportsReasoning: true },
    ],
  }

  it("starts the first row right under a heading that carries an action", () => {
    renderSelect({ leadingGroups: [piGroup], hideProviderGroups: true })
    fireEvent.click(screen.getByRole("button", { name: /switch model/i }))
    expect(screen.getByTestId("model-group-heading")).toHaveTextContent("Pi (native RPC)")
    // The group drops its top padding: the heading row already supplies it.
    const group = document.querySelector('[data-slot="command-group"]')
    expect(group).toHaveClass("pt-0")
  })

  it("labels each capability glyph for hover and assistive tech", () => {
    renderSelect({ leadingGroups: [piGroup], hideProviderGroups: true })
    fireEvent.click(screen.getByRole("button", { name: /switch model/i }))
    const [flash, pro] = Array.from(document.querySelectorAll('[data-slot="command-item"]'))
    const vision = flash.querySelector('[aria-label="Vision"]')
    expect(vision).toHaveAttribute("role", "img")
    expect(vision).toHaveAttribute("title", "Vision")
    expect(flash.querySelector('[data-testid="model-context-window"]')).toHaveTextContent("1M")
    expect(pro.querySelector('[aria-label="Vision"]')).toBeNull()
    expect(pro.querySelector('[aria-label="Reasoning"]')).not.toBeNull()
  })

  it("finds models by capability in search", () => {
    renderSelect({ leadingGroups: [piGroup], hideProviderGroups: true })
    fireEvent.click(screen.getByRole("button", { name: /switch model/i }))
    fireEvent.change(screen.getByPlaceholderText(/search models/i), {
      target: { value: "vision" },
    })
    const items = Array.from(document.querySelectorAll('[data-slot="command-item"]'))
    expect(items.map((node) => node.textContent)).toEqual([
      expect.stringContaining("DeepSeek V4.1 Flash"),
    ])
  })

  it("prints a row's id under its name unless the id is a placeholder", () => {
    renderSelect({
      model: "__agent-default__",
      provider: kimi.providerId,
      leadingGroups: [
        {
          ...kimi,
          models: [
            { id: "__agent-default__", name: "Default model", hideId: true },
            { id: "kimi-code/k3", name: "K3" },
          ],
        },
      ],
      hideProviderGroups: true,
    })
    fireEvent.click(screen.getByRole("button", { name: /switch model/i }))
    const [placeholder, named] = Array.from(document.querySelectorAll('[data-slot="command-item"]'))
    expect(placeholder).toHaveTextContent(/^Default model$/)
    expect(named).toHaveTextContent("kimi-code/k3")
  })

  it("explains an empty list through the notice, not a missing-provider message", () => {
    renderSelect({
      model: "",
      provider: kimi.providerId,
      leadingGroups: [],
      hideProviderGroups: true,
      leadingNotice: "Kimi Code's models appear after the first message.",
    })
    fireEvent.click(screen.getByRole("button", { name: /switch model/i }))
    expect(screen.getByText(/appear after the first message/i)).toBeInTheDocument()
    expect(screen.queryByText(/no providers configured/i)).toBeNull()
    expect(document.querySelectorAll('[data-slot="command-item"]')).toHaveLength(0)
  })

  it("labels the trigger with the caller's text, keeping the raw id as its title", () => {
    renderSelect({
      model: "kimi-code/k3",
      provider: kimi.providerId,
      leadingGroups: [kimi],
      hideProviderGroups: true,
      triggerLabel: "K3",
    })
    const trigger = screen.getByRole("button", { name: /switch model/i })
    expect(trigger).toHaveTextContent("K3")
    expect(screen.getByTitle("kimi-code/k3")).toBeInTheDocument()
  })

  it("titles a label-only trigger with the label when no model is known", () => {
    renderSelect({ model: "", provider: kimi.providerId, triggerLabel: "Kimi Code · default" })
    expect(screen.getByRole("button", { name: /switch model/i })).toHaveTextContent(
      "Kimi Code · default"
    )
    expect(screen.getByTitle("Kimi Code · default")).toBeInTheDocument()
  })

  const section = { id: "cognia-gateway", label: "Cognia models", notice: "Applies next message." }

  it("introduces a section's groups once, with its notice", () => {
    const onSelect = jest.fn()
    renderSelect({
      model: "kimi-code/k3",
      provider: kimi.providerId,
      hideProviderGroups: true,
      onSelect,
      leadingGroups: [
        kimi,
        {
          providerId: "cognia:gateway:anthropic",
          providerName: "Anthropic",
          section,
          models: [{ id: "claude-opus-5", name: "Claude Opus 5" }],
        },
        {
          providerId: "cognia:gateway:openai",
          providerName: "OpenAI",
          section,
          models: [{ id: "gpt-5.5", name: "GPT-5.5" }],
        },
      ],
    })
    fireEvent.click(screen.getByRole("button", { name: /switch model/i }))
    expect(screen.getAllByText("Cognia models")).toHaveLength(1)
    expect(screen.getAllByText("Applies next message.")).toHaveLength(1)
    fireEvent.click(screen.getByText("GPT-5.5"))
    expect(onSelect).toHaveBeenCalledWith({
      providerId: "cognia:gateway:openai",
      modelId: "gpt-5.5",
    })
  })

  it("shows an empty section disabled with its reason and no rows", () => {
    renderSelect({
      model: "kimi-code/k3",
      provider: kimi.providerId,
      hideProviderGroups: true,
      leadingGroups: [
        kimi,
        {
          providerId: "cognia:gateway:",
          providerName: "",
          section: { ...section, notice: "Update the paired Host." },
          models: [],
        },
      ],
    })
    fireEvent.click(screen.getByRole("button", { name: /switch model/i }))
    expect(screen.getByText("Cognia models")).toBeInTheDocument()
    expect(screen.getByText("Update the paired Host.")).toBeInTheDocument()
    expect(document.querySelectorAll('[data-slot="command-item"]')).toHaveLength(2)
  })

  it("lists a disabled model with its reason and never reports it", () => {
    const onSelect = jest.fn()
    renderSelect({
      model: "",
      provider: "",
      hideProviderGroups: true,
      onSelect,
      leadingGroups: [
        {
          providerId: "cognia:gateway:openai",
          providerName: "OpenAI",
          models: [
            {
              id: "text-only",
              name: "Text only",
              disabled: true,
              disabledReason: "No tool calling",
            },
          ],
        },
      ],
    })
    fireEvent.click(screen.getByRole("button", { name: /switch model/i }))
    expect(screen.getByText("No tool calling")).toBeInTheDocument()
    const row = document.querySelector('[data-slot="command-item"]') as HTMLElement
    expect(row).toHaveAttribute("data-disabled", "true")
    fireEvent.click(screen.getByText("Text only"))
    expect(onSelect).not.toHaveBeenCalled()
  })

  it("takes the caller's glyph and hover title on the trigger", () => {
    renderSelect({
      model: "claude-opus-5",
      provider: "cognia:gateway:anthropic",
      triggerLabel: "Claude Opus 5",
      triggerIcon: <span data-testid="cognia-glyph" />,
      triggerTitle: "Kimi Code → Anthropic/Claude Opus 5 via Cognia",
    })
    expect(screen.getByTestId("cognia-glyph")).toBeInTheDocument()
    expect(screen.getByTitle("Kimi Code → Anthropic/Claude Opus 5 via Cognia")).toHaveTextContent(
      "Claude Opus 5"
    )
  })
})
