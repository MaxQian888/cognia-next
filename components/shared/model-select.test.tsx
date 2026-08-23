/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"

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
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <ModelSelect model={ANTHROPIC_MODEL} provider="anthropic" onSelect={jest.fn()} {...props} />
    </NextIntlClientProvider>
  )
}

describe("groupByProvider", () => {
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
