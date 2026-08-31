/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import en from "@/i18n/messages/en.json"

jest.mock("@/stores/settings", () => ({
  useSettingsStore: (selector: (state: { settings: { sandboxTier: string } }) => unknown) =>
    selector({ settings: { sandboxTier: "microvm" } }),
}))
jest.mock("@/lib/db/settings", () => ({ saveSettings: jest.fn() }))
jest.mock("@/hooks/sandbox/use-sandbox-runtime-availability", () => ({
  useSandboxRuntimeAvailability: () => ({
    os: { available: true, backend: "mock", detail: "ok", reason: "available" },
    microvm: { available: false, reason: "adapter-missing", requiresWorkspace: true },
  }),
}))

import { SandboxTierCard } from "./sandbox-tier-card"

it("keeps an unavailable persisted tier visible, selected, and disabled with a reason", () => {
  render(
    <NextIntlClientProvider locale="en" messages={en}>
      <SandboxTierCard />
    </NextIntlClientProvider>
  )
  const microvm = screen.getByTestId("tier-microvm")
  expect(microvm).toBeChecked()
  expect(microvm).toBeDisabled()
  expect(screen.getByText(/Enable the E2B Sandbox plugin/)).toBeInTheDocument()
})
