/**
 * Consent coverage. The merge of behaviour telemetry and PostHog into one
 * panel exists to make the dependency visible — product analytics only emits
 * while behaviour telemetry is on — so the interlock is the main thing pinned
 * here, alongside the destination validity gate.
 */

const saveAppSettings = jest.fn(async () => undefined)
jest.mock("@/stores/settings", () => ({
  useSettingsStore: (selector: (state: { save: typeof saveAppSettings }) => unknown) =>
    selector({ save: saveAppSettings }),
}))

jest.mock("@/lib/db/behavior-events", () => ({
  exportBehaviorEvents: jest.fn(async () => "[]"),
  clearBehaviorEvents: jest.fn(async () => undefined),
}))

const trackEvent = jest.fn(async () => true)
const trackEventDelivery = jest.fn(async () => ({
  delivered: ["posthog-byo"],
  failed: [] as string[],
}))
jest.mock("@/lib/telemetry/events/track-event", () => ({
  ...jest.requireActual("@/lib/telemetry/events/track-event"),
  trackEvent: (...args: unknown[]) => trackEvent(...(args as [])),
  trackEventDelivery: (...args: unknown[]) => trackEventDelivery(...(args as [])),
}))

import { useEffect } from "react"
import { act, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { clearBehaviorEvents, exportBehaviorEvents } from "@/lib/db/behavior-events"
import { BEHAVIOR_TELEMETRY_CATEGORIES } from "@/lib/telemetry/events/settings"
import { isValidPostHogProject } from "@/lib/telemetry/posthog-product"
import { useLogSettingsDraft } from "@/hooks/logging/use-log-settings-draft"

import { LogsTelemetryPanel } from "./telemetry-panel"

let draft: ReturnType<typeof useLogSettingsDraft>

function Harness() {
  const value = useLogSettingsDraft()
  useEffect(() => {
    draft = value
  })
  return <LogsTelemetryPanel draft={value} />
}

beforeEach(() => {
  window.localStorage.clear()
  // jsdom ships no Blob URL plumbing; the export path is a real browser API.
  URL.createObjectURL = jest.fn(() => "blob:mock")
  URL.revokeObjectURL = jest.fn()
  trackEvent.mockClear()
  trackEventDelivery.mockClear()
  trackEventDelivery.mockResolvedValue({ delivered: ["posthog-byo"], failed: [] })
  ;(exportBehaviorEvents as jest.Mock).mockClear()
  ;(clearBehaviorEvents as jest.Mock).mockClear()
})

describe("isValidPostHogProject", () => {
  it("accepts a public ingestion token on a parseable host", () => {
    expect(isValidPostHogProject("https://us.i.posthog.com", "phc_abc")).toBe(true)
    expect(isValidPostHogProject("http://localhost:8000", "phc_abc")).toBe(true)
  })

  it("rejects anything that is not a phc_ token", () => {
    // A Personal API Key here would be a credential leak, not a misconfig.
    expect(isValidPostHogProject("https://us.i.posthog.com", "phx_abc")).toBe(false)
    expect(isValidPostHogProject("https://us.i.posthog.com", "")).toBe(false)
  })

  it("rejects an unparseable or non-HTTP host", () => {
    expect(isValidPostHogProject("not a url", "phc_abc")).toBe(false)
    expect(isValidPostHogProject("ftp://example.com", "phc_abc")).toBe(false)
    expect(isValidPostHogProject("", "phc_abc")).toBe(false)
  })
})

describe("behaviour telemetry", () => {
  it("ships off, and says so on the block", () => {
    render(<Harness />)
    expect(screen.getByRole("switch", { name: /Share behavior events/i })).not.toBeChecked()
    expect(screen.getByTestId("logs-telemetry-behavior")).toHaveTextContent("Off")
  })

  it("keeps every dependent control inert until the master switch is on", async () => {
    const user = userEvent.setup()
    render(<Harness />)

    expect(screen.getByTestId("behavior-telemetry-local-switch")).toBeDisabled()
    expect(screen.getByTestId("behavior-telemetry-category-chat")).toBeDisabled()

    await user.click(screen.getByTestId("behavior-telemetry-switch"))

    expect(draft.behaviorTelemetry.enabled).toBe(true)
    expect(screen.getByTestId("behavior-telemetry-local-switch")).toBeEnabled()
    expect(screen.getByTestId("behavior-telemetry-category-chat")).toBeEnabled()
  })

  it("keeps the two destinations independent", async () => {
    const user = userEvent.setup()
    render(<Harness />)

    await user.click(screen.getByTestId("behavior-telemetry-switch"))
    await user.click(screen.getByTestId("behavior-telemetry-remote-switch"))

    expect(draft.behaviorTelemetry.destinations.remote).toBe(true)
    expect(draft.behaviorTelemetry.destinations.local).toBe(true)
  })

  it("offers every registered category", () => {
    render(<Harness />)
    for (const category of BEHAVIOR_TELEMETRY_CATEGORIES) {
      expect(screen.getByTestId(`behavior-telemetry-category-${category}`)).toBeInTheDocument()
    }
  })

  it("withdraws consent for one category without touching the others", async () => {
    const user = userEvent.setup()
    render(<Harness />)

    await user.click(screen.getByTestId("behavior-telemetry-switch"))
    await user.click(screen.getByTestId("behavior-telemetry-category-connector"))

    expect(draft.behaviorTelemetry.categories.connector).toBe(false)
    expect(draft.behaviorTelemetry.categories.chat).toBe(true)
  })

  it("ties the local-storage limits to the local destination", async () => {
    const user = userEvent.setup()
    render(<Harness />)

    await user.click(screen.getByTestId("behavior-telemetry-switch"))
    expect(screen.getByLabelText("Maximum local events")).toBeEnabled()

    await user.click(screen.getByTestId("behavior-telemetry-local-switch"))
    // Nothing is stored locally, so a retention bound would be meaningless.
    expect(screen.getByLabelText("Maximum local events")).toBeDisabled()
  })

  it("lets a multi-digit limit be typed, then clamps it on commit", async () => {
    // Clamping per keystroke made this unusable: the floor is three digits, so
    // "5" snapped to 100 and the rest of the number appended to that.
    const user = userEvent.setup()
    render(<Harness />)

    await user.click(screen.getByTestId("behavior-telemetry-switch"))
    const input = screen.getByLabelText("Maximum local events")

    await user.clear(input)
    await user.type(input, "5000")
    expect(input).toHaveValue(5000)
    await user.tab()
    expect(draft.behaviorTelemetry.maxStoredEvents).toBe(5000)
  })

  it("clamps an out-of-range limit at both ends on commit", async () => {
    const user = userEvent.setup()
    render(<Harness />)

    await user.click(screen.getByTestId("behavior-telemetry-switch"))
    const input = screen.getByLabelText("Maximum local events")

    await user.clear(input)
    await user.type(input, "5")
    await user.tab()
    expect(draft.behaviorTelemetry.maxStoredEvents).toBe(100)

    await user.clear(input)
    await user.type(input, "999999")
    await user.tab()
    expect(draft.behaviorTelemetry.maxStoredEvents).toBe(100000)
  })

  it("keeps the committed limit when the field is blanked", async () => {
    const user = userEvent.setup()
    render(<Harness />)

    await user.click(screen.getByTestId("behavior-telemetry-switch"))
    const input = screen.getByLabelText("Maximum local events")
    const before = draft.behaviorTelemetry.maxStoredEvents

    await user.clear(input)
    await user.tab()

    // Blanking a field is not a request to jump to the minimum.
    expect(draft.behaviorTelemetry.maxStoredEvents).toBe(before)
  })

  it("exports and clears the local event store", async () => {
    const user = userEvent.setup()
    render(<Harness />)

    await user.click(screen.getByRole("button", { name: /Export JSON/i }))
    expect(exportBehaviorEvents).toHaveBeenCalledWith("json")

    await user.click(screen.getByRole("button", { name: /Export CSV/i }))
    expect(exportBehaviorEvents).toHaveBeenCalledWith("csv")

    await user.click(screen.getByRole("button", { name: /Clear local events/i }))
    expect(clearBehaviorEvents).toHaveBeenCalled()
  })
})

describe("PostHog", () => {
  it("refuses consent for a destination this build cannot reach", () => {
    render(<Harness />)
    // No managed host/token is compiled in for tests, so accepting consent
    // here would record a promise the app cannot keep.
    expect(screen.getByTestId("posthog-managed-product-switch")).toBeDisabled()
    expect(screen.getByTestId("logs-telemetry-posthog")).toHaveTextContent("Not in this build")
  })

  it("unlocks BYO consent once the host and token are valid", async () => {
    const user = userEvent.setup()
    render(<Harness />)

    expect(screen.getByTestId("posthog-byo-product-switch")).toBeDisabled()

    await user.type(screen.getByLabelText("BYO PostHog host"), "https://us.i.posthog.com")
    await user.type(screen.getByLabelText("BYO project token"), "phc_abc")

    expect(screen.getByTestId("posthog-byo-product-switch")).toBeEnabled()
  })

  it("keeps product analytics and AI observability separately revocable", async () => {
    const user = userEvent.setup()
    render(<Harness />)

    await user.type(screen.getByLabelText("BYO PostHog host"), "https://us.i.posthog.com")
    await user.type(screen.getByLabelText("BYO project token"), "phc_abc")
    await user.click(screen.getByTestId("posthog-byo-ai-switch"))

    expect(draft.transports.posthogConfig.byo.aiObservability).toBe(true)
    expect(draft.transports.posthogConfig.byo.productAnalytics).toBe(false)
  })

  it("refuses a test event while the panel has unsaved edits", async () => {
    const user = userEvent.setup()
    render(<Harness />)

    await user.type(screen.getByLabelText("BYO PostHog host"), "https://us.i.posthog.com")
    await user.click(screen.getByRole("button", { name: /Send test event/i }))

    // A "success" against unsaved edits proves nothing: the runtime
    // destinations are whatever was last saved.
    expect(trackEvent).not.toHaveBeenCalled()
    expect(screen.getByRole("status")).toHaveTextContent("Not sent.")
  })

  it("refuses a test event when no product destination is configured", async () => {
    const user = userEvent.setup()
    render(<Harness />)

    await user.click(screen.getByRole("button", { name: /Send test event/i }))

    expect(trackEvent).not.toHaveBeenCalled()
    expect(screen.getByRole("status")).toHaveTextContent("Not sent.")
  })

  it("reports failure when PostHog rejects the test even if another sink succeeds", async () => {
    const user = userEvent.setup()
    render(<Harness />)

    await user.type(screen.getByLabelText("BYO PostHog host"), "https://us.i.posthog.com")
    await user.type(screen.getByLabelText("BYO project token"), "phc_abc")
    await user.click(screen.getByTestId("posthog-byo-product-switch"))
    await user.click(screen.getByTestId("behavior-telemetry-switch"))
    await act(async () => {
      await draft.save()
    })
    await waitFor(() => expect(draft.status).not.toBe("dirty"))
    trackEventDelivery.mockResolvedValueOnce({
      delivered: ["local"],
      failed: ["posthog-byo"],
    })

    await user.click(screen.getByRole("button", { name: /Send test event/i }))

    expect(trackEventDelivery).toHaveBeenCalledWith("telemetry.posthog.test", {
      source: "settings",
    })
    expect(screen.getByRole("status")).toHaveTextContent("Not sent.")
  })
})
