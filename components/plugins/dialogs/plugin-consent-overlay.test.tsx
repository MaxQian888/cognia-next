import { act, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import enMessages from "@/i18n/messages/en.json"
import { PluginConsentOverlay } from "./plugin-consent-overlay"
import {
  PLUGIN_CONSENT_REQUEST_EVENT,
  getPluginConsentBroker,
  resetPluginConsentBroker,
  type PluginConsentRequestEvent,
} from "@/lib/plugin/security/consent-broker"

function renderOverlay() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <PluginConsentOverlay />
    </NextIntlClientProvider>
  )
}

function fireRequestEvent(detail: PluginConsentRequestEvent) {
  act(() => {
    window.dispatchEvent(new CustomEvent(PLUGIN_CONSENT_REQUEST_EVENT, { detail }))
  })
}

// Silence the jest.setup global consent auto-responder so THIS overlay is the
// sole responder to `plugin:consent-request` events (otherwise both race to
// resolve the same broker request and the overlay assertions become flaky).
const consentFlags = globalThis as { __PLUGIN_CONSENT_AUTO?: "allow" | "deny" | "off" }

beforeEach(() => {
  consentFlags.__PLUGIN_CONSENT_AUTO = "off"
  resetPluginConsentBroker()
})

afterEach(() => {
  resetPluginConsentBroker()
  consentFlags.__PLUGIN_CONSENT_AUTO = "allow"
})

describe("PluginConsentOverlay", () => {
  it("renders nothing when there are no pending prompts", () => {
    const { container } = renderOverlay()
    expect(container.firstChild).toBeNull()
  })

  it("surfaces a freshly fired consent-request event", () => {
    renderOverlay()
    fireRequestEvent({
      requestId: "req-1",
      pluginId: "p1",
      permission: "shell:execute",
      reason: "spawn dev server",
      timeoutMs: 30_000,
    })
    expect(screen.getByText("p1")).toBeInTheDocument()
    expect(screen.getByText("shell:execute")).toBeInTheDocument()
    expect(screen.getByText("spawn dev server")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /Allow once/i })).toBeInTheDocument()
  })

  it("falls back to default reason text when reason is empty", () => {
    renderOverlay()
    fireRequestEvent({
      requestId: "req-2",
      pluginId: "p1",
      permission: "filesystem:write",
      timeoutMs: 30_000,
    })
    expect(screen.getByText(/No reason supplied/i)).toBeInTheDocument()
  })

  it("Allow once dismisses the prompt and resolves the broker as true", async () => {
    const user = userEvent.setup()
    renderOverlay()
    const broker = getPluginConsentBroker()
    const promise = broker.request({
      pluginId: "p1",
      permission: "shell:execute",
      reason: "test",
    })
    // The broker's default emit dispatches the CustomEvent; wait for state.
    await screen.findByRole("button", { name: /Allow once/i })
    await user.click(screen.getByRole("button", { name: /Allow once/i }))
    await expect(promise).resolves.toBe(true)
    expect(screen.queryByRole("button", { name: /Allow once/i })).not.toBeInTheDocument()
    expect(broker.hasSessionGrant("p1", "shell:execute")).toBe(false)
  })

  it("Always allow this session resolves true and persists a session grant", async () => {
    const user = userEvent.setup()
    renderOverlay()
    const broker = getPluginConsentBroker()
    const promise = broker.request({
      pluginId: "p1",
      permission: "filesystem:write",
    })
    await screen.findByRole("button", { name: /Always allow this session/i })
    await user.click(screen.getByRole("button", { name: /Always allow this session/i }))
    await expect(promise).resolves.toBe(true)
    expect(broker.hasSessionGrant("p1", "filesystem:write")).toBe(true)
  })

  it("Reject resolves false without persisting", async () => {
    const user = userEvent.setup()
    renderOverlay()
    const broker = getPluginConsentBroker()
    const promise = broker.request({
      pluginId: "p1",
      permission: "filesystem:write",
    })
    await screen.findByRole("button", { name: /^Reject$/i })
    await user.click(screen.getByRole("button", { name: /^Reject$/i }))
    await expect(promise).resolves.toBe(false)
    expect(broker.hasSessionGrant("p1", "filesystem:write")).toBe(false)
  })

  it("close (X) button rejects the prompt", async () => {
    const user = userEvent.setup()
    renderOverlay()
    const broker = getPluginConsentBroker()
    const promise = broker.request({
      pluginId: "p1",
      permission: "shell:execute",
    })
    await screen.findByRole("button", { name: /Close/i })
    await user.click(screen.getByRole("button", { name: /Close/i }))
    await expect(promise).resolves.toBe(false)
  })

  it("shows a 'more pending' badge when multiple prompts are queued", () => {
    renderOverlay()
    fireRequestEvent({
      requestId: "req-a",
      pluginId: "p1",
      permission: "shell:execute",
      timeoutMs: 30_000,
    })
    fireRequestEvent({
      requestId: "req-b",
      pluginId: "p2",
      permission: "filesystem:write",
      timeoutMs: 30_000,
    })
    expect(screen.getByText(/1 more pending/i)).toBeInTheDocument()
  })

  it("deduplicates duplicate events with the same requestId", () => {
    renderOverlay()
    const ev: PluginConsentRequestEvent = {
      requestId: "req-dup",
      pluginId: "p1",
      permission: "shell:execute",
      timeoutMs: 30_000,
    }
    fireRequestEvent(ev)
    fireRequestEvent(ev)
    // Only one prompt should be visible; no "more pending" suffix.
    expect(screen.queryByText(/more pending/i)).not.toBeInTheDocument()
  })
})
