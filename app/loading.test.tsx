/**
 * @jest-environment jsdom
 */
import { act, render, screen } from "@testing-library/react"

import {
  __resetBootProgressForTesting,
  beginBootMilestone,
  endBootMilestone,
} from "@/lib/boot/boot-progress"

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
  useTranslations: (namespace: string) => (key: string, values?: Record<string, unknown>) => {
    const full = `${namespace}.${key}`
    const messages: Record<string, string> = {
      "loading.page.description": "Loading your interface, preferences, and recent context",
      "loading.page.progressLabel": "Workspace preparation",
      "loading.page.reload": "Reload app",
      "loading.page.reloadHint": "Taking longer than expected. You can reload and try again.",
      "loading.page.title": "Preparing your workspace",
      "loading.page.stepsLabel": "Startup steps",
      "loading.page.stepOf": `Step ${values?.current} of ${values?.total}`,
      "loading.page.milestones.accounts.label": "Unlocking your account",
      "loading.page.milestones.preferences.label": "Loading your preferences",
      "loading.page.milestones.interface.label": "Starting the interface",
      "loading.page.milestones.workspace.label": "Restoring your workspace",
      "loading.page.milestones.workspace.detail": "Loading the workspace view and its runtimes",
      "loading.page.capabilitiesReady": `${values?.ready} of ${values?.total} runtimes ready`,
      "loading.page.capabilities.core-chat": "Chat",
      "loading.page.platform.web": "Web",
      "loading.page.version": `Version ${values?.version}`,
      "loading.page.milestoneDuration": `${values?.seconds}s`,
      "loading.page.statusActive": "In progress",
      "loading.page.statusDone": "Done",
      "loading.page.statusPending": "Pending",
      "loading.cancel": "Cancel",
      "loading.loading": "Loading…",
      "loading.offline": "You're offline — this will retry once the connection returns",
      "loading.pageLoading": "Loading…",
      "loading.stillWorking": `Still working… (${values?.seconds}s)`,
      "loading.thinking": "Claude is thinking…",
    }
    return messages[full] ?? full
  },
}))

import GlobalLoading from "./loading"

describe("GlobalLoading", () => {
  beforeEach(() => {
    jest.useFakeTimers()
    mockNetwork.connected = true
    __resetBootProgressForTesting()
  })

  afterEach(() => {
    jest.clearAllTimers()
    jest.useRealTimers()
  })

  it("explains what the workspace is preparing and stands for the workspace step", async () => {
    render(await GlobalLoading())

    expect(screen.getByRole("heading", { name: "Preparing your workspace" })).toBeInTheDocument()
    expect(
      screen.getByText("Loading your interface, preferences, and recent context")
    ).toBeInTheDocument()

    // A route transition on its own: only the workspace step is on the list,
    // and the progress is step-based rather than a guessed percentage.
    const progress = screen.getByRole("progressbar", { name: "Workspace preparation" })
    expect(progress).toHaveAttribute("aria-valuenow", "1")
    expect(progress).toHaveAttribute("aria-valuemax", "1")
    expect(progress).toHaveAttribute("aria-valuetext", "Restoring your workspace")
    expect(screen.getByText("Step 1 of 1")).toBeInTheDocument()
    expect(screen.queryByText("Unlocking your account")).not.toBeInTheDocument()
  })

  it("continues the cold-boot timeline when it is the last step of a boot", async () => {
    const now = Date.now()
    beginBootMilestone("accounts", now - 900)
    endBootMilestone("accounts", now - 500)
    beginBootMilestone("preferences", now - 500)
    endBootMilestone("preferences", now - 400)
    beginBootMilestone("interface", now - 400)
    endBootMilestone("interface", now - 300)

    render(await GlobalLoading())

    expect(screen.getByText("Step 4 of 4")).toBeInTheDocument()
    expect(screen.getByText("Unlocking your account")).toBeInTheDocument()
    expect(screen.getByText("0.4s")).toBeInTheDocument()
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "4")
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
