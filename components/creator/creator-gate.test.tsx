/** @jest-environment jsdom */
import { fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"

import { CreatorGate } from "./creator-gate"
import creatorMessages from "@/i18n/messages/en/creator.json"
import { usePluginStore } from "@/stores/plugin-runtime/plugin-store"

function renderGate() {
  return render(
    <NextIntlClientProvider locale="en" messages={{ creator: creatorMessages }}>
      <CreatorGate>
        <div data-testid="workbench">workbench</div>
      </CreatorGate>
    </NextIntlClientProvider>
  )
}

function setDeveloperMode(enabled: boolean) {
  usePluginStore.getState().updatePluginSettings({ developerModeEnabled: enabled })
}

beforeEach(() => setDeveloperMode(false))

describe("CreatorGate", () => {
  it("hides the workbench when developer mode is off", () => {
    renderGate()
    expect(screen.queryByTestId("workbench")).not.toBeInTheDocument()
    expect(screen.getByText(creatorMessages.gate.title)).toBeInTheDocument()
  })

  it("renders the workbench when developer mode is on", () => {
    setDeveloperMode(true)
    renderGate()
    expect(screen.getByTestId("workbench")).toBeInTheDocument()
  })

  // The gate reads the store reactively; a gate that stayed shut after the
  // user enabled developer mode reads as a broken feature.
  it("opens as soon as the user enables developer mode", () => {
    renderGate()
    fireEvent.click(screen.getByRole("button", { name: creatorMessages.gate.enable }))
    expect(screen.getByTestId("workbench")).toBeInTheDocument()
  })

  it("shares the single developer-mode source of truth", () => {
    renderGate()
    fireEvent.click(screen.getByRole("button", { name: creatorMessages.gate.enable }))
    expect(usePluginStore.getState().pluginSettings.developerModeEnabled).toBe(true)
  })
})
