/** @jest-environment jsdom */
import { fireEvent, render, screen, waitFor } from "@testing-library/react"

jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))

jest.mock("@/components/providers/ai/provider-icon", () => ({
  ProviderIcon: ({ providerId }: { providerId: string }) => (
    <span data-testid={`icon-${providerId}`} />
  ),
}))

import { ProviderPicker } from "./provider-picker"

// cmdk scrolls the active item into view; jsdom has no layout for it.
beforeAll(() => {
  Element.prototype.scrollIntoView = jest.fn()
})

describe("ProviderPicker", () => {
  it("shows the selected provider's catalog name, not its id", () => {
    render(<ProviderPicker value="openai" onChange={jest.fn()} />)
    expect(screen.getByTestId("onboarding-provider-picker")).toHaveTextContent("OpenAI")
  })

  it("falls back to the raw id for a provider the catalog does not know", () => {
    render(<ProviderPicker value="not-a-provider" onChange={jest.fn()} />)
    expect(screen.getByTestId("onboarding-provider-picker")).toHaveTextContent("not-a-provider")
  })

  it("opens a searchable list covering the whole catalog", async () => {
    render(<ProviderPicker value="anthropic" onChange={jest.fn()} />)
    fireEvent.click(screen.getByTestId("onboarding-provider-picker"))

    await waitFor(() =>
      expect(screen.getByTestId("onboarding-provider-option-openai")).toBeInTheDocument()
    )
    // A local server and a Claude-compatible endpoint are both reachable —
    // the two cases that had no first-run path at all before.
    expect(screen.getByTestId("onboarding-provider-option-ollama")).toBeInTheDocument()
    expect(screen.getByTestId("onboarding-provider-option-kimi-anthropic")).toBeInTheDocument()
  })

  it("reports the picked provider and closes", async () => {
    const onChange = jest.fn()
    render(<ProviderPicker value="anthropic" onChange={onChange} />)
    fireEvent.click(screen.getByTestId("onboarding-provider-picker"))
    await waitFor(() =>
      expect(screen.getByTestId("onboarding-provider-option-google")).toBeInTheDocument()
    )

    fireEvent.click(screen.getByTestId("onboarding-provider-option-google"))
    expect(onChange).toHaveBeenCalledWith("google")
    await waitFor(() =>
      expect(screen.queryByTestId("onboarding-provider-picker-content")).toBeNull()
    )
  })

  it("filters by id as well as name, since people type what they call it", async () => {
    render(<ProviderPicker value="anthropic" onChange={jest.fn()} />)
    fireEvent.click(screen.getByTestId("onboarding-provider-picker"))
    await waitFor(() =>
      expect(screen.getByTestId("onboarding-provider-option-ollama")).toBeInTheDocument()
    )

    // "ollama" is the id; the display name carries it too, but "xai" does not
    // match "Grok" and vice versa — searching both is what makes the 77-row
    // list findable.
    fireEvent.change(screen.getByPlaceholderText("provider.pickerSearch"), {
      target: { value: "xai" },
    })
    await waitFor(() =>
      expect(screen.getByTestId("onboarding-provider-option-xai")).toBeInTheDocument()
    )
    expect(screen.queryByTestId("onboarding-provider-option-ollama")).toBeNull()
  })

  it("locks while a save is in flight", () => {
    render(<ProviderPicker value="anthropic" onChange={jest.fn()} disabled />)
    expect(screen.getByTestId("onboarding-provider-picker")).toBeDisabled()
  })
})
