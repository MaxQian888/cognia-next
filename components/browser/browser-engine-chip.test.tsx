/** @jest-environment jsdom */
import { fireEvent, render, screen } from "@testing-library/react"

import { TooltipProvider } from "@/components/ui/tooltip"

import { BrowserEngineChip } from "./browser-engine-chip"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

function renderChip(engine: "local-chromium" | "embedded") {
  const onSwitch = jest.fn()
  render(
    <TooltipProvider>
      <BrowserEngineChip engine={engine} onSwitch={onSwitch} />
    </TooltipProvider>
  )
  return onSwitch
}

it("names Chromium and offers the lightweight preview", () => {
  const onSwitch = renderChip("local-chromium")
  const chip = screen.getByRole("button", { name: "toLightweight" })
  expect(chip).toHaveTextContent("chromium")
  fireEvent.click(chip)
  expect(onSwitch).toHaveBeenCalledWith("embedded")
})

it("names the lightweight preview and offers Chromium", () => {
  const onSwitch = renderChip("embedded")
  const chip = screen.getByRole("button", { name: "toChromium" })
  expect(chip).toHaveTextContent("lightweight")
  fireEvent.click(chip)
  expect(onSwitch).toHaveBeenCalledWith("local-chromium")
})
