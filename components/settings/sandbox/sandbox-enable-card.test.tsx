// ADR-0028 Phase 5 — SandboxEnableCard unit tests.

import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"

jest.mock("@/lib/db/settings", () => ({ saveSettings: jest.fn().mockResolvedValue(undefined) }))
jest.mock("@/stores/settings", () => ({ useSettingsStore: jest.fn() }))

import { saveSettings } from "@/lib/db/settings"
import { useSettingsStore } from "@/stores/settings"
import { SandboxEnableCard } from "./sandbox-enable-card"

const mockSave = saveSettings as jest.MockedFunction<typeof saveSettings>
const mockStore = useSettingsStore as unknown as jest.Mock

const MESSAGES = {
  settings: {
    sandbox: {
      enable: {
        title: "Default sandbox",
        description: "Run high-risk tools through the OS sandbox by default.",
        label: "Enable sandbox by default",
        note: "Strict mode: refused when unavailable.",
      },
    },
  },
}

function mockSettings(settings: Record<string, unknown> | undefined) {
  mockStore.mockImplementation((selector: (s: { settings: unknown }) => unknown) =>
    selector({ settings })
  )
}

function renderCard() {
  return render(
    <NextIntlClientProvider locale="en" messages={MESSAGES}>
      <SandboxEnableCard />
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  mockSave.mockClear()
})

describe("SandboxEnableCard", () => {
  it("reflects the off state when sandboxDefaultEnabled is unset", () => {
    mockSettings(undefined)
    renderCard()
    expect(screen.getByTestId("sandbox-default-enabled-switch")).not.toBeChecked()
  })

  it("reflects the on state from settings", () => {
    mockSettings({ sandboxDefaultEnabled: true })
    renderCard()
    expect(screen.getByTestId("sandbox-default-enabled-switch")).toBeChecked()
  })

  it("persists the toggle to settings on change", async () => {
    mockSettings({ sandboxDefaultEnabled: false })
    renderCard()
    await userEvent.click(screen.getByTestId("sandbox-default-enabled-switch"))
    expect(mockSave).toHaveBeenCalledWith({ sandboxDefaultEnabled: true })
  })

  it("shows the strict-mode note", () => {
    mockSettings(undefined)
    renderCard()
    expect(screen.getByText(/strict mode/i)).toBeInTheDocument()
  })
})
