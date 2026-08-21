/**
 * @jest-environment jsdom
 */
import React from "react"
import { fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { TooltipProvider } from "@/components/ui/tooltip"

import { A2UIGenerationOptions } from "./generation-options"
import { useSettingsStore } from "@/stores/settings"
import { PROVIDERS } from "@cognia/provider-types/provider"
import type { Character } from "@cognia/agent-config-types"
import enMessages from "@/i18n/messages/en.json"

const CHARACTERS: Character[] = [
  { id: "char_1", name: "Builder", isBuiltIn: true } as Character,
  { id: "char_2", name: "Analyst", isBuiltIn: true } as Character,
]

jest.mock("@/lib/data-hooks/context", () => ({
  useCharacters: () => CHARACTERS,
}))

// The real picker is a CommandDialog over the plugin/character registries and
// has its own suite; here we only care that this component opens it and takes
// the pick, so a button stub keeps the assertion on the binding.
jest.mock("@/components/chat/character-picker", () => ({
  CharacterPicker: ({ open, onPick }: { open: boolean; onPick: (c: { id: string }) => void }) =>
    open ? (
      <button data-testid="stub-pick-char_2" onClick={() => onPick({ id: "char_2" })}>
        pick
      </button>
    ) : null,
}))

beforeAll(() => {
  if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false
  if (!Element.prototype.setPointerCapture) Element.prototype.setPointerCapture = () => {}
  if (!Element.prototype.releasePointerCapture) Element.prototype.releasePointerCapture = () => {}
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {}
})

function renderOptions(props: Partial<React.ComponentProps<typeof A2UIGenerationOptions>> = {}) {
  const onChange = jest.fn()
  const utils = render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <TooltipProvider>
        <A2UIGenerationOptions value={{}} onChange={onChange} {...props} />
      </TooltipProvider>
    </NextIntlClientProvider>
  )
  return { ...utils, onChange }
}

describe("A2UIGenerationOptions", () => {
  beforeEach(() => {
    useSettingsStore.setState({
      settings: {
        providerSettings: { anthropic: { enabled: true } },
        customProviders: [],
        defaultModel: PROVIDERS.anthropic.defaultModel,
        defaultProvider: "anthropic",
      },
    } as never)
  })

  it("reads as the default agent until one is chosen", () => {
    renderOptions()
    expect(screen.getByTestId("a2ui-agent-chip")).toHaveTextContent(enMessages.a2ui.defaultAgent)
    // Nothing to clear when nothing is set.
    expect(screen.queryByTestId("a2ui-agent-clear")).not.toBeInTheDocument()
  })

  it("shows the chosen agent's name and reports the pick", () => {
    const { onChange } = renderOptions()
    fireEvent.click(screen.getByTestId("a2ui-agent-chip"))
    fireEvent.click(screen.getByTestId("stub-pick-char_2"))
    expect(onChange).toHaveBeenCalledWith({ characterId: "char_2" })
  })

  it("resolves a stored character id to its name", () => {
    renderOptions({ value: { characterId: "char_1" } })
    expect(screen.getByTestId("a2ui-agent-chip")).toHaveTextContent("Builder")
  })

  it("falls back to the default agent when the stored character no longer exists", () => {
    renderOptions({ value: { characterId: "deleted" } })
    // A deleted character must not pin a ghost the send path cannot resolve.
    expect(screen.getByTestId("a2ui-agent-chip")).toHaveTextContent(enMessages.a2ui.defaultAgent)
    expect(screen.queryByTestId("a2ui-agent-clear")).not.toBeInTheDocument()
  })

  it("clears back to the default agent", () => {
    const { onChange } = renderOptions({ value: { characterId: "char_1", model: "m" } })
    fireEvent.click(screen.getByTestId("a2ui-agent-clear"))
    expect(onChange).toHaveBeenCalledWith({ characterId: undefined, model: "m" })
  })

  it("shows the app default model until one is overridden", () => {
    renderOptions()
    const name = PROVIDERS.anthropic.models.find(
      (m) => m.id === PROVIDERS.anthropic.defaultModel
    )?.name
    expect(screen.getByRole("button", { name: /switch model/i }).textContent).toContain(name)
  })

  it("records both the model and its provider when one is picked", () => {
    const { onChange } = renderOptions()
    fireEvent.click(screen.getByRole("button", { name: /switch model/i }))
    const other = PROVIDERS.anthropic.models.find((m) => m.id !== PROVIDERS.anthropic.defaultModel)!
    fireEvent.click(screen.getByText(other.name))
    // Provider travels with the model: `resolveSendOptions` resolves them as a
    // pair, and a model id alone would be re-homed to the wrong provider.
    expect(onChange).toHaveBeenCalledWith({ model: other.id, provider: "anthropic" })
  })

  it("does not offer the Auto row, which would flip a global setting", () => {
    renderOptions()
    fireEvent.click(screen.getByRole("button", { name: /switch model/i }))
    expect(
      screen.queryByText(enMessages.chat.composer.modelPicker.autoModel)
    ).not.toBeInTheDocument()
  })
})
