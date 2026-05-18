/**
 * Inspector tab — focused tests on the Pick affordance added by the
 * ADR-0020 2026-05-18 addendum. The rest of the inspector (tree reading,
 * pattern testing, locator copy) is shared infrastructure not changed by
 * this work; we exercise only what the new code introduces.
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
  },
}))

import "@testing-library/jest-dom"
import { act, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { desktop } from "@/lib/automation/client"
import { InspectorTab } from "./inspector-tab"

const mockedDesktop = desktop as jest.Mocked<typeof desktop>

function mount() {
  return render(
    <NextIntlClientProvider locale="en" messages={{}} timeZone="UTC">
      <InspectorTab />
    </NextIntlClientProvider>
  )
}

const baseCaps = {
  platform: "windows" as const,
  hasUia: true,
  hasInputSim: true,
  hasScreenshot: true,
  hasEvents: false,
}

beforeEach(() => {
  jest.clearAllMocks()
  mockedDesktop.capabilities.mockResolvedValue(baseCaps)
})

afterEach(() => {
  jest.useRealTimers()
})

describe("InspectorTab Pick affordance", () => {
  it("renders the Pick button as enabled when caps.hasUia", async () => {
    mount()
    await waitFor(() => {
      // Button text comes from the i18n key when the locale has no
      // translation — that's intentional; the developer-facing inspector
      // tab is untranslated for now.
      expect(screen.getByText(/pickStart/i)).toBeInTheDocument()
    })
  })

  it("captures cursor position + element after the 3s countdown", async () => {
    jest.useFakeTimers()
    mockedDesktop.cursorPosition.mockResolvedValueOnce({ x: 100, y: 200 })
    mockedDesktop.pickAtPoint.mockResolvedValueOnce({
      elementRef: ["aa"] as unknown as never,
      name: "Picked Target",
      automationId: null,
      controlType: null,
      className: null,
      boundingRect: null,
      isEnabled: true,
      isFocused: false,
      processId: null,
      processName: null,
      windowTitle: null,
      children: null,
    } as never)

    mount()
    await waitFor(() => expect(screen.getByText(/pickStart/i)).toBeInTheDocument())

    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime })
    await user.click(screen.getByText(/pickStart/i))

    // Countdown begins at 3 — first tick (1s) drops it to 2, etc.
    act(() => {
      jest.advanceTimersByTime(1000)
    })
    expect(screen.getByText(/pickCountdown/i)).toBeInTheDocument()

    act(() => {
      jest.advanceTimersByTime(2000)
    })

    await waitFor(() => {
      expect(mockedDesktop.cursorPosition).toHaveBeenCalled()
    })
    await waitFor(() => {
      expect(mockedDesktop.pickAtPoint).toHaveBeenCalledWith({ x: 100, y: 200 })
    })
  })

  it("clicking Pick during countdown cancels the capture", async () => {
    jest.useFakeTimers()
    mount()
    await waitFor(() => expect(screen.getByText(/pickStart/i)).toBeInTheDocument())

    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime })
    await user.click(screen.getByText(/pickStart/i))
    act(() => {
      jest.advanceTimersByTime(1000)
    })
    // Second click while countdown is visible cancels.
    await user.click(screen.getByText(/pickCountdown/i))
    // Continuing to advance must NOT trigger cursorPosition.
    act(() => {
      jest.advanceTimersByTime(5000)
    })
    expect(mockedDesktop.cursorPosition).not.toHaveBeenCalled()
  })
})
