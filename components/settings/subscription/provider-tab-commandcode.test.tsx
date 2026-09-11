/** @jest-environment jsdom */
import { render, screen } from "@testing-library/react"
let desktop = true
jest.mock("@/lib/tauri", () => ({ isTauri: () => desktop }))
jest.mock("./preset-picker", () => ({
  PresetPicker: ({ provider }: { provider: string }) => <div data-testid={`presets-${provider}`} />,
}))
import { ProviderTabCommandcode } from "./provider-tab-commandcode"

it("provides relay configuration while explaining API plan and quota boundaries", () => {
  desktop = true
  render(<ProviderTabCommandcode />)
  expect(screen.getByTestId("presets-commandcode")).toBeInTheDocument()
  expect(screen.getByText(/No public subscription quota API/)).toBeInTheDocument()
  expect(screen.getByText(/Go plan does not include/)).toBeInTheDocument()
  expect(screen.getByRole("link")).toHaveAttribute("href", "https://commandcode.ai/docs/provider")
})

it("keeps keyring configuration desktop-only", () => {
  desktop = false
  render(<ProviderTabCommandcode />)
  expect(screen.queryByTestId("presets-commandcode")).not.toBeInTheDocument()
  expect(screen.getByText(/desktop app/)).toBeInTheDocument()
})
