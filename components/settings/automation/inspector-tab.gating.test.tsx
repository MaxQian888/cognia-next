/**
 * Inspector tab — capability gating (ADR-0020 macOS unlock).
 *
 * Split from `inspector-tab.test.tsx` on purpose: that suite installs fake
 * timers for the Pick countdown, which jams React's act queue for any
 * effect-driven test that runs after it in the same file. These tests need
 * real timers and a clean act queue, so they live in their own module.
 *
 * The behaviour under test: the inspector unlocks on any back-end that exposes
 * an accessibility tree (`hasUia` on Windows UIA, or `hasA11yTree` on the macOS
 * AXAPI / remote cua back-ends), and hides the Windows-only UIA pattern tests
 * where `invoke_pattern` is unsupported.
 */

jest.mock("@/lib/tauri", () => ({
  isTauri: jest.fn(() => true),
}))

jest.mock("@/lib/automation/client", () => ({
  desktop: {
    capabilities: jest.fn(),
    getFocus: jest.fn(),
    readTree: jest.fn(),
    invokePattern: jest.fn(),
    cursorPosition: jest.fn(),
    pickAtPoint: jest.fn(),
    pickSessionStart: jest.fn(() => Promise.resolve()),
    pickSessionCancel: jest.fn(() => Promise.resolve()),
  },
}))

import "@testing-library/jest-dom"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
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

const windowsCaps: Capabilities = {
  platform: "windows",
  hasUia: true,
  hasInputSim: true,
  hasScreenshot: true,
  hasEvents: false,
  hasA11yTree: false,
  monitors: [],
}

// macOS AXAPI back-end: no Windows UIA, but a cross-platform accessibility tree.
const macCaps: Capabilities = {
  ...windowsCaps,
  platform: "macos",
  hasUia: false,
  hasA11yTree: true,
}

// Input-only enigo back-end (e.g. Linux): neither UIA nor an a11y tree.
const noTreeCaps: Capabilities = { ...windowsCaps, platform: "linux", hasUia: false }

const elem = (name: string) => ({
  elementRef: [`r-${name}`],
  name,
  automationId: null,
  controlType: "Button",
  className: null,
  boundingRect: null,
  isEnabled: true,
  isFocused: false,
  processId: 1,
  processName: "App",
  windowTitle: "Win",
  children: null,
})

beforeEach(() => {
  jest.clearAllMocks()
  mockedDesktop.capabilities.mockResolvedValue(windowsCaps)
})

describe("InspectorTab capability gating", () => {
  it("unlocks on macOS a11y-tree backends and shows the a11y-only note", async () => {
    // macOS reports hasUia:false but hasA11yTree:true — the inspector must
    // render its tree UI, not the "unavailable" alert.
    mockedDesktop.capabilities.mockResolvedValue(macCaps)
    mount()
    await waitFor(() => expect(screen.getByText(/pick element/i)).toBeInTheDocument())
    expect(screen.queryByText(/accessibility tree yet/i)).not.toBeInTheDocument()
    expect(screen.getByText(/reads the frontmost window/i)).toBeInTheDocument()
  })

  it("hides UIA pattern tests on a11y-tree-only backends after selecting a row", async () => {
    mockedDesktop.capabilities.mockResolvedValue(macCaps)
    mockedDesktop.getFocus.mockResolvedValue(elem("root") as never)
    mockedDesktop.readTree.mockResolvedValue([elem("Save")] as never)
    mount()
    await waitFor(() => expect(screen.getByText(/pick element/i)).toBeInTheDocument())
    const user = userEvent.setup()
    await user.click(screen.getByRole("button", { name: /refresh/i }))
    // The first row auto-selects, so the details pane renders — but the
    // pattern-test section must stay hidden where invoke_pattern is unsupported.
    await waitFor(() => expect(screen.queryAllByText("Save").length).toBeGreaterThan(0))
    expect(screen.queryByText("Test Patterns")).not.toBeInTheDocument()
  })

  it("shows UIA pattern tests on Windows (hasUia) after selecting a row", async () => {
    // windowsCaps (hasUia:true) is installed by beforeEach.
    mockedDesktop.getFocus.mockResolvedValue(elem("root") as never)
    mockedDesktop.readTree.mockResolvedValue([elem("Save")] as never)
    mount()
    await waitFor(() => expect(screen.getByText(/pick element/i)).toBeInTheDocument())
    const user = userEvent.setup()
    await user.click(screen.getByRole("button", { name: /refresh/i }))
    await waitFor(() => expect(screen.getByText("Test Patterns")).toBeInTheDocument())
  })

  it("shows the unavailable notice when the backend exposes no tree", async () => {
    mockedDesktop.capabilities.mockResolvedValue(noTreeCaps)
    mount()
    await waitFor(() => expect(screen.getByText(/accessibility tree yet/i)).toBeInTheDocument())
    expect(screen.queryByText(/pick element/i)).not.toBeInTheDocument()
  })
})
