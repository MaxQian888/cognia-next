/**
 * Inspector capability gating.
 */

jest.mock("@/lib/tauri", () => ({
  isTauri: jest.fn(() => true),
}))

jest.mock("@/lib/automation/client", () => ({
  desktop: {
    capabilities: jest.fn(),
    listApps: jest.fn(),
    getAppState: jest.fn(),
    queryElements: jest.fn(),
    expandElement: jest.fn(),
    performAction: jest.fn(),
  },
}))

import "@testing-library/jest-dom"
import { render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { desktop } from "@/lib/automation/client"
import type { Capabilities } from "@/lib/automation/types"
import { InspectorTab } from "./inspector-tab"

const mockedDesktop = desktop as jest.Mocked<typeof desktop>

function mount() {
  return render(
    <NextIntlClientProvider locale="en" messages={{}} timeZone="UTC">
      <InspectorTab />
    </NextIntlClientProvider>
  )
}

const baseCaps: Capabilities = {
  platform: "macos",
  hasUia: false,
  hasInputSim: true,
  hasScreenshot: true,
  hasEvents: true,
  hasA11yTree: true,
  monitors: [],
}

beforeEach(() => {
  jest.clearAllMocks()
  mockedDesktop.listApps.mockResolvedValue([])
})

describe("InspectorTab capability gating", () => {
  it("unlocks on macOS AX backends", async () => {
    mockedDesktop.capabilities.mockResolvedValue(baseCaps)
    mount()

    expect(await screen.findByText(/app session/i)).toBeInTheDocument()
  })

  it("unlocks on Windows UIA backends", async () => {
    mockedDesktop.capabilities.mockResolvedValue({
      ...baseCaps,
      platform: "windows",
      hasUia: true,
      hasA11yTree: false,
    })
    mount()

    expect(await screen.findByText(/app session/i)).toBeInTheDocument()
  })

  it("shows the unavailable notice when no accessibility tree exists", async () => {
    mockedDesktop.capabilities.mockResolvedValue({
      ...baseCaps,
      platform: "linux",
      hasA11yTree: false,
    })
    mount()

    expect(await screen.findByText(/doesn't expose an accessibility tree/i)).toBeInTheDocument()
    expect(screen.queryByText(/app session/i)).not.toBeInTheDocument()
  })
})
