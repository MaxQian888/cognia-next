/** @jest-environment jsdom */
// The history is a Dexie live query, which needs an IndexedDB even when the
// reader it runs is an injected seam.
import "fake-indexeddb/auto"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: (namespace: string) => (key: string, values?: Record<string, unknown>) =>
    values ? `${namespace}.${key}:${Object.values(values).join(",")}` : `${namespace}.${key}`,
}))

let tauri = true
jest.mock("@/hooks/platform/use-surface-reach", () => ({
  useSurfaceReach: () =>
    tauri
      ? { available: true, remedy: null }
      : { available: false, block: "needs-desktop-shell", remedy: null },
}))
jest.mock("@/lib/tauri", () => ({
  isTauri: () => tauri,
  transport: { call: jest.fn() },
  localTransport: { call: jest.fn() },
}))
import { localTransport, transport } from "@/lib/tauri"

import { decodeBrowserEnrollmentPayload } from "@cognia/companion-client"

import { getDb } from "@/lib/db/schema"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { putBrowserSubmission } from "@/lib/db/browser-submissions"

import { BrowserCompanionCard, type BrowserEnrollmentIssue } from "./browser-companion-card"

const NOW = 1_700_000_000_000

const ISSUE: BrowserEnrollmentIssue = {
  enrollment: "aaaa.bbbb",
  expiresAtMs: NOW + 5 * 60 * 1_000,
  baseUrl: "http://127.0.0.1:27891",
  tenantId: "tenant-a",
}

function renderCard(overrides: Partial<React.ComponentProps<typeof BrowserCompanionCard>> = {}) {
  return render(
    <BrowserCompanionCard
      loadListener={async () => ({ enabled: true, boundPort: 27891 })}
      createEnrollment={async () => ISSUE}
      copy={async () => undefined}
      now={() => NOW}
      loadHistory={async () => ({ deviceIds: [], total: 0 })}
      clearHistory={async () => 0}
      pruneHistory={async () => 0}
      {...overrides}
    />
  )
}

beforeEach(() => {
  jest.clearAllMocks()
  tauri = true
})

describe("BrowserCompanionCard", () => {
  it("keeps listener reads and enrollment on the local desktop", async () => {
    ;(localTransport.call as jest.Mock).mockImplementation(async (name) =>
      name === "companion_browser_access_get" ? { enabled: true, boundPort: 27891 } : ISSUE
    )
    renderCard({ loadListener: undefined, createEnrollment: undefined })
    const generate = screen.getByRole("button", {
      name: "mobile.companion.browserCompanion.generate",
    })
    await waitFor(() => expect(generate).toBeEnabled())
    fireEvent.click(generate)
    await screen.findByTestId("browser-companion-code")
    expect(localTransport.call).toHaveBeenCalledWith("companion_create_browser_enrollment", {})
    expect(transport.call).not.toHaveBeenCalled()
  })

  it("cannot generate before the listener status is known", async () => {
    let resolve!: (state: { enabled: boolean; boundPort: number }) => void
    const pending = new Promise<{ enabled: boolean; boundPort: number }>((done) => {
      resolve = done
    })
    renderCard({ loadListener: () => pending })
    const button = screen.getByRole("button", {
      name: "mobile.companion.browserCompanion.generate",
    })
    expect(button).toBeDisabled()
    await act(async () => resolve({ enabled: true, boundPort: 27891 }))
    expect(button).toBeEnabled()
  })

  it("expires a code without any parent rerender and clears its timer on unmount", async () => {
    jest.useFakeTimers().setSystemTime(NOW)
    try {
      const { unmount } = renderCard({ now: Date.now })
      await act(async () => {})
      fireEvent.click(
        screen.getByRole("button", { name: "mobile.companion.browserCompanion.generate" })
      )
      await act(async () => {})
      expect(screen.getByTestId("browser-companion-code")).toBeInTheDocument()
      act(() => jest.advanceTimersByTime(5 * 60 * 1000))
      expect(screen.getByTestId("browser-companion-expired")).toBeInTheDocument()
      expect(screen.queryByTestId("browser-companion-code")).not.toBeInTheDocument()
      unmount()
      expect(jest.getTimerCount()).toBe(0)
    } finally {
      jest.useRealTimers()
    }
  })
  /**
   * A phone or a browser tab cannot mint an enrolment code, and used to be
   * shown nothing, which reads as "this build has no such feature". It is
   * told where the feature lives instead.
   */
  it("explains, off the desktop shell, that enrolment lives in the desktop app", () => {
    tauri = false
    renderCard()
    expect(screen.getByTestId("browser-companion-card")).toHaveAttribute(
      "data-reach",
      "needs-desktop-shell"
    )
    expect(screen.getByTestId("browser-companion-desktop-only")).toBeInTheDocument()
    expect(screen.queryByTestId("browser-companion-needs-listener")).not.toBeInTheDocument()
  })

  it("explains, rather than hides, that browser access is off", async () => {
    // A missing button reads as "this build does not have the feature", which
    // is a different answer from "one switch away".
    renderCard({ loadListener: async () => ({ enabled: false, boundPort: null }) })
    await screen.findByTestId("browser-companion-needs-listener")
    expect(
      screen.getByRole("button", { name: "mobile.companion.browserCompanion.generate" })
    ).toBeDisabled()
  })

  it("treats a switched-off Host as off even while its port is still bound", async () => {
    // Turning Browser Access off leaves the listener bound until the server
    // restarts, and the Rust command refuses to mint a code for it. Reading
    // the port alone offered a button that could only fail.
    renderCard({ loadListener: async () => ({ enabled: false, boundPort: 27891 }) })
    await screen.findByTestId("browser-companion-needs-listener")
    expect(
      screen.getByRole("button", { name: "mobile.companion.browserCompanion.generate" })
    ).toBeDisabled()
  })

  it("says a restart is what is missing when access is on but nothing is bound", async () => {
    renderCard({ loadListener: async () => ({ enabled: true, boundPort: null }) })
    expect(await screen.findByTestId("browser-companion-needs-restart")).toHaveTextContent(
      "mobile.companion.browserCompanion.requiresRestart"
    )
    expect(screen.queryByTestId("browser-companion-needs-listener")).toBeNull()
    expect(
      screen.getByRole("button", { name: "mobile.companion.browserCompanion.generate" })
    ).toBeDisabled()
  })

  it("reports an unreadable listener without claiming it is stopped", async () => {
    // Failing open would offer a code that cannot connect.
    renderCard({
      loadListener: async () => {
        throw new Error("nope")
      },
    })
    await screen.findByTestId("browser-companion-listener-error")
    expect(screen.queryByTestId("browser-companion-needs-listener")).not.toBeInTheDocument()
  })

  it("mints a code the extension's own decoder accepts", async () => {
    renderCard()
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "mobile.companion.browserCompanion.generate" })
      ).toBeEnabled()
    )
    fireEvent.click(
      screen.getByRole("button", { name: "mobile.companion.browserCompanion.generate" })
    )
    const code = await screen.findByTestId("browser-companion-code")
    const outcome = decodeBrowserEnrollmentPayload(code.textContent ?? "", NOW)
    expect(outcome.kind).toBe("ok")
    if (outcome.kind !== "ok") return
    // The plaintext loopback plane, not the HTTPS one a tab cannot reach.
    expect(outcome.payload.baseUrl).toBe("http://127.0.0.1:27891")
    expect(outcome.payload.enrollment).toBe("aaaa.bbbb")
  })

  it("shows the remaining lifetime and says so once it is gone", async () => {
    let now = NOW
    const { rerender } = render(
      <BrowserCompanionCard
        loadListener={async () => ({ enabled: true, boundPort: 27891 })}
        createEnrollment={async () => ISSUE}
        copy={async () => undefined}
        now={() => now}
      />
    )
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "mobile.companion.browserCompanion.generate" })
      ).toBeEnabled()
    )
    fireEvent.click(
      screen.getByRole("button", { name: "mobile.companion.browserCompanion.generate" })
    )
    await screen.findByTestId("browser-companion-expiry")

    now = NOW + 6 * 60 * 1_000
    rerender(
      <BrowserCompanionCard
        loadListener={async () => ({ enabled: true, boundPort: 27891 })}
        createEnrollment={async () => ISSUE}
        copy={async () => undefined}
        now={() => now}
      />
    )
    await screen.findByTestId("browser-companion-expired")
    // An expired code is not shown at all — a stale string is worse than none,
    // because it looks copyable.
    expect(screen.queryByTestId("browser-companion-code")).toBeNull()
  })

  it("reports a refused code in the user's language, not Rust's", async () => {
    // The refusals whose remedy is another control are ruled out before the
    // button is enabled. What reaches here is English diagnostics.
    renderCard({
      createEnrollment: async () => {
        throw new Error("browser access is not listening; enable it in Settings")
      },
    })
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "mobile.companion.browserCompanion.generate" })
      ).toBeEnabled()
    )
    fireEvent.click(
      screen.getByRole("button", { name: "mobile.companion.browserCompanion.generate" })
    )
    const error = await screen.findByTestId("browser-companion-error")
    expect(error).toHaveTextContent("mobile.companion.browserCompanion.generateFailed")
    expect(error).not.toHaveTextContent("browser access is not listening")
  })

  it("reports a failed copy rather than claiming success", async () => {
    renderCard({
      copy: async () => {
        throw new Error("denied")
      },
    })
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "mobile.companion.browserCompanion.generate" })
      ).toBeEnabled()
    )
    fireEvent.click(
      screen.getByRole("button", { name: "mobile.companion.browserCompanion.generate" })
    )
    await screen.findByTestId("browser-companion-code")
    fireEvent.click(screen.getByRole("button", { name: /copy/i }))
    await waitFor(() =>
      expect(screen.getByTestId("browser-companion-error")).toHaveTextContent("copyFailed")
    )
  })

  it("confirms a successful copy", async () => {
    renderCard()
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "mobile.companion.browserCompanion.generate" })
      ).toBeEnabled()
    )
    fireEvent.click(
      screen.getByRole("button", { name: "mobile.companion.browserCompanion.generate" })
    )
    await screen.findByTestId("browser-companion-code")
    fireEvent.click(screen.getByRole("button", { name: /copy/i }))
    await screen.findByRole("button", { name: /copied/i })
  })

  it("shows the recorded history even when it is empty", async () => {
    // "Nothing has been sent from a browser" and "this Host keeps no record"
    // are different answers, and a control that appeared only once something
    // existed would collapse them into one.
    renderCard()
    await screen.findByTestId("browser-companion-history")
    expect(screen.getByTestId("browser-companion-history-count")).toHaveTextContent(
      "mobile.companion.browserCompanion.historyCount:0"
    )
    expect(screen.getByTestId("browser-companion-clear-history")).toBeDisabled()
  })

  it("clears every device's rows and re-reads the total", async () => {
    const cleared: string[] = []
    let total = 3
    renderCard({
      loadHistory: async () => ({
        deviceIds: total === 0 ? [] : ["browser-a", "browser-b"],
        total,
      }),
      clearHistory: async (deviceId) => {
        cleared.push(deviceId)
        total = 0
        return 1
      },
    })
    await waitFor(() =>
      expect(screen.getByTestId("browser-companion-history-count")).toHaveTextContent(
        "mobile.companion.browserCompanion.historyCount:3"
      )
    )
    fireEvent.click(screen.getByTestId("browser-companion-clear-history"))
    fireEvent.click(await screen.findByTestId("browser-companion-clear-confirm"))

    // Every device, not just the first: the delete is device-scoped by design,
    // so "clear everything" is a loop over the ids rather than a second,
    // unscoped delete path.
    await waitFor(() => expect(cleared).toEqual(["browser-a", "browser-b"]))
    await waitFor(() =>
      expect(screen.getByTestId("browser-companion-history-count")).toHaveTextContent(
        "mobile.companion.browserCompanion.historyCount:0"
      )
    )
  })

  it("explains a failed clear in its own words, not Dexie's", async () => {
    renderCard({
      loadHistory: async () => ({ deviceIds: ["browser-a"], total: 2 }),
      clearHistory: async () => Promise.reject(new Error("DatabaseClosedError: ...")),
    })
    await waitFor(() => expect(screen.getByTestId("browser-companion-clear-history")).toBeEnabled())
    fireEvent.click(screen.getByTestId("browser-companion-clear-history"))
    fireEvent.click(await screen.findByTestId("browser-companion-clear-confirm"))
    await waitFor(() =>
      expect(screen.getByTestId("browser-companion-error")).toHaveTextContent(
        "mobile.companion.browserCompanion.historyClearFailed"
      )
    )
  })

  it("asks before clearing, and a cancel clears nothing", async () => {
    const cleared: string[] = []
    renderCard({
      loadHistory: async () => ({ deviceIds: ["browser-a"], total: 2 }),
      clearHistory: async (deviceId) => {
        cleared.push(deviceId)
        return 2
      },
    })
    await waitFor(() => expect(screen.getByTestId("browser-companion-clear-history")).toBeEnabled())
    fireEvent.click(screen.getByTestId("browser-companion-clear-history"))
    const dialog = await screen.findByTestId("browser-companion-clear-dialog")
    expect(dialog).toHaveTextContent("mobile.companion.browserCompanion.historyClearConfirmTitle")
    expect(dialog).toHaveTextContent(
      "mobile.companion.browserCompanion.historyClearConfirmDescription:2"
    )
    fireEvent.click(
      screen.getByRole("button", { name: "mobile.companion.browserCompanion.historyClearCancel" })
    )
    await waitFor(() => expect(screen.queryByTestId("browser-companion-clear-dialog")).toBeNull())
    expect(cleared).toEqual([])
  })

  it("applies retention once when it opens", async () => {
    const pruneHistory = jest.fn(async () => 0)
    renderCard({ pruneHistory })
    await screen.findByTestId("browser-companion-history")
    expect(pruneHistory).toHaveBeenCalledTimes(1)
  })

  it("does not render a second link to the device console", async () => {
    // The pairing panel renders `DeviceConsoleLink` right below this card.
    renderCard()
    await screen.findByTestId("browser-companion-history")
    expect(screen.queryByRole("link")).toBeNull()
    expect(screen.getByText("mobile.companion.browserCompanion.pairedHint")).toBeInTheDocument()
  })

  it("hides the control rather than claiming empty when the history cannot be read", async () => {
    renderCard({ loadHistory: async () => Promise.reject(new Error("db closed")) })
    await screen.findByTestId("browser-companion-card")
    await waitFor(() => expect(screen.queryByTestId("browser-companion-history")).toBeNull())
  })
})

describe("BrowserCompanionCard history, against the real table", () => {
  const dbFixture = createDbTestFixture()
  beforeAll(dbFixture.initialize)
  beforeEach(async () => {
    await dbFixture.restore()
    await getDb().browserSubmissions.clear()
  })
  afterAll(dbFixture.dispose)

  it("counts a submission that arrives while the pane is open", async () => {
    // It read the table once on mount, so a page captured from a browser while
    // this pane was showing never appeared until it was closed and reopened.
    render(
      <BrowserCompanionCard
        loadListener={async () => ({ enabled: true, boundPort: 27891 })}
        createEnrollment={async () => ISSUE}
        copy={async () => undefined}
        now={() => NOW}
        pruneHistory={async () => 0}
      />
    )
    await waitFor(() =>
      expect(screen.getByTestId("browser-companion-history-count")).toHaveTextContent(
        "mobile.companion.browserCompanion.historyCount:0"
      )
    )
    await act(async () => {
      await putBrowserSubmission({
        submissionId: "live-1",
        deviceId: "browser-a",
        sessionId: "session-1",
        title: "A guide",
        sourceHost: "example.com",
        captureMode: "selection",
        contentBytes: 1,
        truncated: false,
        status: "queued",
        submittedAt: Date.now(),
        updatedAt: Date.now(),
      })
    })
    await waitFor(() =>
      expect(screen.getByTestId("browser-companion-history-count")).toHaveTextContent(
        "mobile.companion.browserCompanion.historyCount:1"
      )
    )
  })
})
