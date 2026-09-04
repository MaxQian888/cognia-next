/**
 * @jest-environment jsdom
 */
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"

import en from "@/i18n/messages/en.json"
import type { AutomationSupervisionSnapshot } from "@/lib/automation/supervision"

const readAutomationSupervision = jest.fn()
const haltAutomation = jest.fn()
let canControl: boolean | "unknown" = true

jest.mock("@/lib/automation/supervision", () => ({
  readAutomationSupervision: (...a: unknown[]) => readAutomationSupervision(...a),
  haltAutomation: (...a: unknown[]) => haltAutomation(...a),
}))

jest.mock("@/hooks/data/use-can-control", () => ({ useCanControl: () => canControl }))

import { HostAutomationPanel } from "./host-automation-panel"

const snapshot = (over: Partial<AutomationSupervisionSnapshot> = {}) =>
  ({
    enabled: true,
    killSwitchEngaged: false,
    defaultTier: "whitelist",
    recent: [],
    counts: { total: 0, allow: 0, deny: 0, consent: 0 },
    readAt: 1_700_000_000_000,
    ...over,
  }) as AutomationSupervisionSnapshot

const row = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  ts: 1_700_000_000_000,
  surface: "computerUse",
  pluginId: null,
  command: "desktop_click",
  processName: null,
  windowTitle: null,
  decision: "allow",
  reason: null,
  durationMs: 3,
  error: null,
  ...over,
})

function renderPanel() {
  return render(
    <NextIntlClientProvider locale="en" messages={en as Record<string, unknown>}>
      <HostAutomationPanel />
    </NextIntlClientProvider>
  )
}

const copy = en.mobile.automation.host

beforeEach(() => {
  jest.clearAllMocks()
  canControl = true
  readAutomationSupervision.mockResolvedValue(snapshot())
  haltAutomation.mockResolvedValue(undefined)
})

describe("HostAutomationPanel", () => {
  it("shows the host engine state and its decision counts", async () => {
    readAutomationSupervision.mockResolvedValue(
      snapshot({ counts: { total: 7, allow: 4, deny: 2, consent: 1 } })
    )
    renderPanel()

    await waitFor(() => expect(screen.getByTestId("host-automation-panel")).toBeInTheDocument())
    expect(screen.getByTestId("host-engine-state")).toHaveTextContent(copy.engineOn)
    expect(screen.getByTestId("host-automation-panel")).toHaveTextContent("7")
    expect(screen.queryByTestId("host-halted")).toBeNull()
  })

  it("marks a halted host", async () => {
    readAutomationSupervision.mockResolvedValue(snapshot({ killSwitchEngaged: true }))
    renderPanel()
    await waitFor(() => expect(screen.getByTestId("host-halted")).toHaveTextContent(copy.halted))
  })

  it("lists recent decisions newest-first as the host returned them", async () => {
    readAutomationSupervision.mockResolvedValue(
      snapshot({
        recent: [
          row("a", { command: "desktop_type" }),
          row("b", { command: "desktop_click", decision: "deny" }),
        ] as AutomationSupervisionSnapshot["recent"],
      })
    )
    renderPanel()

    await waitFor(() => expect(screen.getByTestId("host-recent-list")).toBeInTheDocument())
    const items = screen.getByTestId("host-recent-list").querySelectorAll("li")
    expect(items).toHaveLength(2)
    expect(items[0]).toHaveTextContent("desktop_type")
    expect(items[1]).toHaveTextContent("deny")
  })

  it("says so when there is no host answering", async () => {
    readAutomationSupervision.mockRejectedValue(new Error("no transport"))
    renderPanel()

    await waitFor(() =>
      expect(screen.getByTestId("host-automation-unreachable")).toHaveTextContent(
        copy.unreachableTitle
      )
    )
    expect(screen.queryByTestId("host-halt-button")).toBeNull()
  })

  it("halts the host and re-reads its state", async () => {
    const user = userEvent.setup()
    renderPanel()
    await waitFor(() => expect(screen.getByTestId("host-halt-button")).toBeEnabled())

    await user.click(screen.getByTestId("host-halt-button"))
    await user.click(await screen.findByRole("button", { name: copy.halt }))

    await waitFor(() => expect(haltAutomation).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(readAutomationSupervision).toHaveBeenCalledTimes(2))
  })

  /**
   * Hiding the button would collapse "this device may not do that" into "this
   * does not exist". The reader is one grant away, so say that.
   */
  it("keeps the halt visible but disabled on an observe-only device", async () => {
    canControl = false
    renderPanel()

    await waitFor(() => expect(screen.getByTestId("host-halt-button")).toBeDisabled())
    expect(screen.getByTestId("host-halt-forbidden")).toHaveTextContent(copy.haltForbidden)
  })

  it("treats an unresolved control probe as not-yet-allowed", async () => {
    canControl = "unknown"
    renderPanel()
    await waitFor(() => expect(screen.getByTestId("host-halt-button")).toBeDisabled())
  })
})
