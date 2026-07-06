// ADR-0028 "lite" — WorkspaceConfinementCard unit tests.

import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"

jest.mock("@/lib/db/settings", () => ({ saveSettings: jest.fn().mockResolvedValue(undefined) }))
jest.mock("@/stores/settings", () => ({ useSettingsStore: jest.fn() }))

import { saveSettings } from "@/lib/db/settings"
import { useSettingsStore } from "@/stores/settings"
import { WorkspaceConfinementCard } from "./workspace-confinement-card"

const mockSave = saveSettings as jest.MockedFunction<typeof saveSettings>
const mockStore = useSettingsStore as unknown as jest.Mock

const MESSAGES = {
  settings: {
    sandbox: {
      workspaceConfinement: {
        title: "Workspace confinement",
        description: "Confine built-in file and shell tools to the workspace roots.",
        label: "Confine tools to the workspace",
        note: "On by default. Disabling lets tools write anywhere unconfined.",
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
      <WorkspaceConfinementCard />
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  mockSave.mockClear()
})

describe("WorkspaceConfinementCard", () => {
  it("defaults to ON (confined) when the setting is unset", () => {
    mockSettings(undefined)
    renderCard()
    expect(screen.getByTestId("workspace-confinement-switch")).toBeChecked()
  })

  it("reflects the off state when explicitly disabled", () => {
    mockSettings({ workspaceConfinementEnabled: false })
    renderCard()
    expect(screen.getByTestId("workspace-confinement-switch")).not.toBeChecked()
  })

  it("persists the opt-out to settings on change", async () => {
    mockSettings({ workspaceConfinementEnabled: true })
    renderCard()
    await userEvent.click(screen.getByTestId("workspace-confinement-switch"))
    expect(mockSave).toHaveBeenCalledWith({ workspaceConfinementEnabled: false })
  })

  it("warns that disabling removes confinement", () => {
    mockSettings(undefined)
    renderCard()
    // jest.setup mocks next-intl to resolve the real en.json — assert on its text.
    expect(screen.getByText(/anywhere on this machine/i)).toBeInTheDocument()
  })
})
