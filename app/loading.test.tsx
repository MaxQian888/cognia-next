/**
 * @jest-environment jsdom
 */
import { act, render, screen } from "@testing-library/react"

const mockNetwork = { connected: true, connectionType: "wifi" as const }

jest.mock("@/hooks/use-network-status", () => ({
  useNetworkStatus: () => ({ loading: false, status: mockNetwork }),
}))

jest.mock("next-intl/server", () => ({
  getTranslations: async () => (key: string) => {
    const messages: Record<string, string> = {
      description: "Loading your interface, preferences, and recent context",
      title: "Preparing your workspace",
    }
    return messages[key] ?? key
  },
}))

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) => {
    const messages: Record<string, string> = {
      "page.description": "Loading your interface, preferences, and recent context",
      "page.progressLabel": "Workspace preparation",
      "page.reload": "Reload app",
      "page.reloadHint": "Taking longer than expected. You can reload and try again.",
      "page.stages.finalizing": "Finishing setup",
      "page.stages.interface": "Starting the interface",
      "page.stages.workspace": "Restoring your workspace",
      "page.title": "Preparing your workspace",
      cancel: "Cancel",
      loading: "Loading…",
      offline: "You're offline — this will retry once the connection returns",
      pageLoading: "Loading…",
      stillWorking: `Still working… (${values?.seconds}s)`,
      thinking: "Claude is thinking…",
    }
    return messages[key] ?? key
  },
}))

import GlobalLoading from "./loading"

describe("GlobalLoading", () => {
  beforeEach(() => {
    jest.useFakeTimers()
    mockNetwork.connected = true
  })

  afterEach(() => {
    jest.clearAllTimers()
    jest.useRealTimers()
  })

  it("explains what the workspace is preparing and exposes indeterminate progress", async () => {
    render(await GlobalLoading())

    expect(screen.getByRole("heading", { name: "Preparing your workspace" })).toBeInTheDocument()
    expect(
      screen.getByText("Loading your interface, preferences, and recent context")
    ).toBeInTheDocument()
    expect(screen.getByRole("status")).toHaveTextContent("Starting the interface")

    const progress = screen.getByRole("progressbar", { name: "Workspace preparation" })
    expect(progress).not.toHaveAttribute("aria-valuenow")
    expect(progress).toHaveAttribute("aria-valuetext", "Starting the interface")

    act(() => {
      jest.advanceTimersByTime(2000)
    })
    expect(screen.getByRole("status")).toHaveTextContent("Restoring your workspace")
  })

  it("reassures on a prolonged wait and offers a reload escape", async () => {
    render(await GlobalLoading())

    act(() => {
      jest.advanceTimersByTime(5000)
    })
    expect(screen.getByRole("status")).toHaveTextContent("Still working… (5s)")
    expect(screen.queryByRole("button", { name: "Reload app" })).not.toBeInTheDocument()

    act(() => {
      jest.advanceTimersByTime(10000)
    })
    expect(
      screen.getByText("Taking longer than expected. You can reload and try again.")
    ).toBeVisible()
    expect(screen.getByRole("button", { name: "Reload app" })).toBeEnabled()
  })

  it("explains a prolonged offline wait instead of implying unknown progress", async () => {
    mockNetwork.connected = false
    render(await GlobalLoading())

    act(() => {
      jest.advanceTimersByTime(5000)
    })

    expect(screen.getByRole("status")).toHaveTextContent(
      "You're offline — this will retry once the connection returns"
    )
  })
})
