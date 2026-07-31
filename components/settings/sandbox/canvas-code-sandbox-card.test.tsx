// ADR-0028 — CanvasCodeSandboxCard unit tests.

import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"

jest.mock("@/lib/db/settings", () => ({ saveSettings: jest.fn().mockResolvedValue(undefined) }))
jest.mock("@/stores/settings", () => ({ useSettingsStore: jest.fn() }))

import { saveSettings } from "@/lib/db/settings"
import { useSettingsStore } from "@/stores/settings"
import { CanvasCodeSandboxCard } from "./canvas-code-sandbox-card"

const mockSave = saveSettings as jest.MockedFunction<typeof saveSettings>
const mockStore = useSettingsStore as unknown as jest.Mock

const MESSAGES = {
  settings: {
    sandbox: {
      canvasSandbox: {
        title: "Canvas code sandbox",
        description: "Run Canvas code through the OS sandbox.",
        label: "Sandbox Canvas code execution",
        note: "On by default. Disabling runs Canvas code unconfined.",
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
      <CanvasCodeSandboxCard />
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  mockSave.mockClear()
})

describe("CanvasCodeSandboxCard", () => {
  it("defaults to ON (confined) when the setting is unset", () => {
    mockSettings(undefined)
    renderCard()
    expect(screen.getByTestId("canvas-code-sandbox-switch")).toBeChecked()
  })

  it("reflects the off state when explicitly disabled", () => {
    mockSettings({ canvasCodeSandboxEnabled: false })
    renderCard()
    expect(screen.getByTestId("canvas-code-sandbox-switch")).not.toBeChecked()
  })

  it("persists the opt-out to settings on change", async () => {
    mockSettings({ canvasCodeSandboxEnabled: true })
    renderCard()
    await userEvent.click(screen.getByTestId("canvas-code-sandbox-switch"))
    expect(mockSave).toHaveBeenCalledWith({ canvasCodeSandboxEnabled: false })
  })

  it("shows the unconfined-on-disable note", () => {
    mockSettings(undefined)
    renderCard()
    expect(screen.getByText(/unconfined/i)).toBeInTheDocument()
  })
})
