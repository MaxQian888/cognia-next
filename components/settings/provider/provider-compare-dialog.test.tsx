/** @jest-environment jsdom */

import { fireEvent, render, screen } from "@testing-library/react"
import { ProviderCompareDialog } from "./provider-compare-dialog"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

describe("ProviderCompareDialog", () => {
  const availableProviders = [
    { id: "openai", name: "OpenAI" },
    { id: "anthropic", name: "Anthropic" },
  ]

  it("restores a persisted comparison selection", () => {
    render(
      <ProviderCompareDialog
        open
        onOpenChange={jest.fn()}
        availableProviders={availableProviders}
        initialSelectedProviderIds={["openai"]}
      />
    )

    expect(screen.getByRole("checkbox", { name: "OpenAI" })).toBeChecked()
  })

  it("reports selection changes for persistence", () => {
    const onSelectedProviderIdsChange = jest.fn()
    render(
      <ProviderCompareDialog
        open
        onOpenChange={jest.fn()}
        availableProviders={availableProviders}
        onSelectedProviderIdsChange={onSelectedProviderIdsChange}
      />
    )

    fireEvent.click(screen.getByRole("checkbox", { name: "Anthropic" }))

    expect(onSelectedProviderIdsChange).toHaveBeenCalledWith(["anthropic"])
  })
})
