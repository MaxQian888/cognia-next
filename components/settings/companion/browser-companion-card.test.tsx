/** @jest-environment jsdom */
import { fireEvent, render, screen, waitFor } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: (namespace: string) => (key: string, values?: Record<string, unknown>) =>
    values ? `${namespace}.${key}:${Object.values(values).join(",")}` : `${namespace}.${key}`,
}))

let tauri = true
jest.mock("@/lib/tauri", () => ({
  isTauri: () => tauri,
  transport: { call: jest.fn() },
}))

import { decodeBrowserEnrollmentPayload } from "@cognia/companion-client"

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
      loadListener={async () => ({ boundPort: 27891 })}
      createEnrollment={async () => ISSUE}
      copy={async () => undefined}
      now={() => NOW}
      loadHistory={async () => ({ deviceIds: [], total: 0 })}
      clearHistory={async () => 0}
      {...overrides}
    />
  )
}

beforeEach(() => {
  tauri = true
})

describe("BrowserCompanionCard", () => {
  it("renders nothing off Tauri", () => {
    tauri = false
    const { container } = renderCard()
    expect(container).toBeEmptyDOMElement()
  })

  it("explains, rather than hides, that browser access is off", async () => {
    // A missing button reads as "this build does not have the feature", which
    // is a different answer from "one switch away".
    renderCard({ loadListener: async () => ({ boundPort: null }) })
    await screen.findByTestId("browser-companion-needs-listener")
    expect(
      screen.getByRole("button", { name: "mobile.companion.browserCompanion.generate" })
    ).toBeDisabled()
  })

  it("treats an unreadable listener state as not listening", async () => {
    // Failing open would offer a code that cannot connect.
    renderCard({
      loadListener: async () => {
        throw new Error("nope")
      },
    })
    await screen.findByTestId("browser-companion-needs-listener")
  })

  it("mints a code the extension's own decoder accepts", async () => {
    renderCard()
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
        loadListener={async () => ({ boundPort: 27891 })}
        createEnrollment={async () => ISSUE}
        copy={async () => undefined}
        now={() => now}
      />
    )
    fireEvent.click(
      screen.getByRole("button", { name: "mobile.companion.browserCompanion.generate" })
    )
    await screen.findByTestId("browser-companion-expiry")

    now = NOW + 6 * 60 * 1_000
    rerender(
      <BrowserCompanionCard
        loadListener={async () => ({ boundPort: 27891 })}
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

  it("surfaces the host's own refusal instead of a generic failure", async () => {
    // The remedy for this one is a different control on the same page, so the
    // Rust message is the part the user has to read.
    renderCard({
      createEnrollment: async () => {
        throw new Error("browser access is not listening; enable it in Settings")
      },
    })
    fireEvent.click(
      screen.getByRole("button", { name: "mobile.companion.browserCompanion.generate" })
    )
    const error = await screen.findByTestId("browser-companion-error")
    expect(error).toHaveTextContent("browser access is not listening")
  })

  it("reports a failed copy rather than claiming success", async () => {
    renderCard({
      copy: async () => {
        throw new Error("denied")
      },
    })
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
    await screen.findByTestId("browser-companion-clear-history")
    fireEvent.click(screen.getByTestId("browser-companion-clear-history"))
    await waitFor(() =>
      expect(screen.getByTestId("browser-companion-error")).toHaveTextContent(
        "mobile.companion.browserCompanion.historyClearFailed"
      )
    )
  })

  it("hides the control rather than claiming empty when the history cannot be read", async () => {
    renderCard({ loadHistory: async () => Promise.reject(new Error("db closed")) })
    await screen.findByTestId("browser-companion-card")
    await waitFor(() => expect(screen.queryByTestId("browser-companion-history")).toBeNull())
  })
})
