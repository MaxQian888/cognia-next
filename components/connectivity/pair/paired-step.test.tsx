/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { PairedStep } from "./paired-step"

const removeHost = jest.fn().mockResolvedValue(undefined)
jest.mock("@/hooks/use-platform", () => ({ usePlatform: () => "mobile" }))
jest.mock("@/lib/accounts/active-account-id", () => ({ DEFAULT_LOCAL_ACCOUNT_ID: "local_acct_a" }))
jest.mock("@/lib/runtime/runtime-target-context", () => ({
  getActiveRuntimeTargetContext: () => ({ accountId: "local_acct_a", targetId: "host-a" }),
}))
jest.mock("@/lib/companion/credential-book", () => ({
  companionCredentialBook: () => ({
    getActive: async () => ({ hostId: "host-a", accountNamespace: "local_acct_a" }),
    list: async () => [{ hostId: "host-a", accountNamespace: "local_acct_a" }],
  }),
}))
jest.mock("@/lib/companion/host-removal", () => ({
  removeCompanionHost: (...args: unknown[]) => removeHost(...args),
}))

jest.mock("@/lib/tauri", () => ({
  isTauri: jest.fn().mockReturnValue(false),
  transport: {
    call: jest.fn(),
    subscribe: jest.fn().mockReturnValue(() => {}),
    constructor: { name: "MockTransport" },
  },
}))

const guardCalls: unknown[] = []
// `null` passes the prompt; a reason makes the guard refuse with that code.
const guardBlock: { reason: string | null } = { reason: null }
jest.mock("@/hooks/use-biometric-guard", () => ({
  useBiometricGuard: () => async (opts: unknown, action: () => Promise<void>) => {
    guardCalls.push(opts)
    if (guardBlock.reason) return { kind: "blocked" as const, reason: guardBlock.reason }
    await action()
    return { kind: "ok" as const }
  },
}))

// Settings → Security → "Require biometrics to sign out".
const biometricPolicy: { value: { signOut?: boolean } | undefined } = { value: undefined }
jest.mock("@/stores/settings", () => ({
  useSettingsStore: <T,>(selector: (s: { settings: unknown }) => T): T =>
    selector({ settings: { biometricRequiredFor: biometricPolicy.value } }),
}))

jest.mock("next-intl", () => ({
  useTranslations: (namespace?: string) => (key: string, vars?: Record<string, unknown>) => {
    // The shared biometric reason labels resolve against the real bundle, so
    // the blocked message is asserted with the words a person actually reads.
    if (namespace === "common.biometricBlocked") {
      const en = jest.requireActual("@/i18n/messages/en.json") as {
        common: { biometricBlocked: Record<string, string> }
      }
      return en.common.biometricBlocked[key] ?? key
    }
    const map: Record<string, string> = {
      transportLabel: "Transport",
      connectedTitle: "Connected",
      connectedSubtitle: "Live link.",
      offlineTitle: "Offline",
      offlineSubtitle: "Couldn't reach the desktop.",
      checkingTitle: "Checking…",
      "health.device": "Device",
      "health.server": "Server",
      "health.lastHeartbeat": "Last heartbeat",
      "health.latency": "Latency",
      "health.live": "Live",
      "health.checking": "Checking",
      "health.offline": "Offline",
      "health.refresh": "Refresh status",
      "health.continueToChat": "Continue to chat",
      "health.noHeartbeat": "—",
      "diagnostics.title": "Diagnostics",
      "diagnostics.subtitle": "Probe the link.",
      "diagnostics.expand": "Show diagnostics",
      "diagnostics.collapse": "Hide diagnostics",
      "diagnostics.testRpc": "Test RPC",
      "diagnostics.testWs": "Test event",
      "diagnostics.rpcResultLabel": "RPC response",
      "diagnostics.wsResultLabel": "Event payload",
      "diagnostics.rpcWaiting": "Tap to send RPC.",
      "diagnostics.wsWaiting": "Tap to subscribe.",
      "signOut.cardTitle": "Disconnect",
      "signOut.cardDescription": "Sign out and re-pair.",
      "signOut.cta": "Sign out",
      signOutTitle: "Sign out",
      signOutReason: "Confirm sign out",
      signOutDescription: "Reconnect requires re-pairing.",
      biometricFailed: `You were not signed out. ${(vars?.reason as string) ?? ""}`,
    }
    return map[key] ?? key
  },
}))

beforeEach(() => {
  window.localStorage.setItem(
    "cognia.companion.config.v1",
    JSON.stringify({
      baseUrl: "http://test:7890",
      devicePrivateKeyJwk: { kty: "EC", crv: "P-256", d: "private" },
      deviceKeyThumbprint: "thumbprint",
      deviceId: "dev-existing",
      serverVersion: "9.9.9",
    })
  )
})

afterEach(() => {
  jest.clearAllMocks()
  window.localStorage.clear()
})

const baseProps = {
  baseUrl: "http://test:7890",
  deviceId: "dev-001",
  serverVersion: "0.1.0",
  onContinue: jest.fn(),
  onAfterSignOut: jest.fn(),
}

describe("<PairedStep />", () => {
  it("renders the connection-health card and transport label", () => {
    render(<PairedStep {...baseProps} />)
    expect(screen.getByTestId("pair-health-card")).toBeInTheDocument()
    expect(screen.getByTestId("pair-status")).toHaveTextContent("dev-001")
    expect(screen.getByTestId("pair-status")).toHaveTextContent("0.1.0")
  })

  it("Continue to chat fires the onContinue callback", () => {
    const onContinue = jest.fn()
    render(<PairedStep {...baseProps} onContinue={onContinue} />)
    fireEvent.click(screen.getByTestId("pair-continue-cta"))
    expect(onContinue).toHaveBeenCalled()
  })

  it("Refresh records latency on a successful RPC", async () => {
    const transportMock = (jest.requireMock("@/lib/tauri") as { transport: { call: jest.Mock } })
      .transport
    transportMock.call.mockResolvedValueOnce({ status: "ok" })
    const user = userEvent.setup()
    render(<PairedStep {...baseProps} />)
    await user.click(screen.getByTestId("pair-refresh"))
    await waitFor(() => expect(transportMock.call).toHaveBeenCalledWith("claude_sidecar_status"))
    await waitFor(() =>
      expect(screen.getByTestId("pair-health-card").getAttribute("data-health")).toBe("live")
    )
  })

  it("Refresh flips to offline when the RPC throws", async () => {
    const transportMock = (jest.requireMock("@/lib/tauri") as { transport: { call: jest.Mock } })
      .transport
    transportMock.call.mockRejectedValueOnce(new Error("backend down"))
    const user = userEvent.setup()
    render(<PairedStep {...baseProps} />)
    await user.click(screen.getByTestId("pair-refresh"))
    await waitFor(() =>
      expect(screen.getByTestId("pair-health-card").getAttribute("data-health")).toBe("offline")
    )
  })

  it("Diagnostics is collapsed by default and reveals smoke buttons when expanded", async () => {
    const user = userEvent.setup()
    render(<PairedStep {...baseProps} />)
    expect(screen.queryByTestId("smoke-call")).not.toBeInTheDocument()
    await user.click(screen.getByTestId("pair-diagnostics-toggle"))
    expect(await screen.findByTestId("smoke-call")).toBeInTheDocument()
    expect(screen.getByTestId("smoke-ws")).toBeInTheDocument()
  })

  it("invokes transport.call when Test RPC is pressed", async () => {
    const transportMock = (jest.requireMock("@/lib/tauri") as { transport: { call: jest.Mock } })
      .transport
    transportMock.call.mockResolvedValueOnce({ status: "ok" })
    const user = userEvent.setup()
    render(<PairedStep {...baseProps} />)
    await user.click(screen.getByTestId("pair-diagnostics-toggle"))
    await user.click(await screen.findByTestId("smoke-call"))
    await waitFor(() => expect(screen.getByTestId("smoke-call-result")).toBeInTheDocument())
    expect(screen.getByTestId("smoke-call-result")).toHaveTextContent('"status": "ok"')
  })

  it("remotely revokes the active Host and notifies onAfterSignOut", async () => {
    const onAfterSignOut = jest.fn()
    const user = userEvent.setup()
    render(<PairedStep {...baseProps} onAfterSignOut={onAfterSignOut} />)
    await user.click(screen.getByTestId("pair-signout"))
    await waitFor(() => expect(onAfterSignOut).toHaveBeenCalled())
    expect(removeHost).toHaveBeenCalledWith({
      accountId: "local_acct_a",
      hostId: "host-a",
      platform: "mobile",
    })
  })
})

describe("<PairedStep /> — Settings → Security → signOut", () => {
  // `useCompanionSignOut` has always honoured this flag; this second sign-out
  // path prompted unconditionally, so the row only governed one of the two
  // surfaces that sign a companion out.
  beforeEach(() => {
    guardCalls.length = 0
    guardBlock.reason = null
    biometricPolicy.value = undefined
  })

  it("explains a blocked prompt in words and does not sign out", async () => {
    guardBlock.reason = "lockout"
    const onAfterSignOut = jest.fn()
    const user = userEvent.setup()
    render(<PairedStep {...baseProps} onAfterSignOut={onAfterSignOut} />)
    await user.click(screen.getByTestId("pair-signout"))
    const error = await screen.findByTestId("pair-signout-error")
    expect(error).toHaveTextContent(
      "You were not signed out. Too many attempts. Unlock your phone, then try again."
    )
    expect(error.textContent).not.toContain("lockout")
    expect(onAfterSignOut).not.toHaveBeenCalled()
    expect(removeHost).not.toHaveBeenCalled()
  })

  it("stays quiet when the person cancels the prompt", async () => {
    guardBlock.reason = "cancelled"
    const onAfterSignOut = jest.fn()
    const user = userEvent.setup()
    render(<PairedStep {...baseProps} onAfterSignOut={onAfterSignOut} />)
    await user.click(screen.getByTestId("pair-signout"))
    await waitFor(() => expect(guardCalls).toHaveLength(1))
    expect(screen.queryByTestId("pair-signout-error")).not.toBeInTheDocument()
    expect(onAfterSignOut).not.toHaveBeenCalled()
  })

  it("prompts by default (the shipped policy has the row on)", async () => {
    const user = userEvent.setup()
    render(<PairedStep {...baseProps} />)
    await user.click(screen.getByTestId("pair-signout"))
    await waitFor(() => expect(removeHost).toHaveBeenCalled())
    expect(guardCalls).toHaveLength(1)
  })

  it("skips the prompt when the row is switched off, and still signs out", async () => {
    biometricPolicy.value = { signOut: false }
    const onAfterSignOut = jest.fn()
    const user = userEvent.setup()
    render(<PairedStep {...baseProps} onAfterSignOut={onAfterSignOut} />)
    await user.click(screen.getByTestId("pair-signout"))
    await waitFor(() => expect(onAfterSignOut).toHaveBeenCalled())
    expect(guardCalls).toHaveLength(0)
    expect(removeHost).toHaveBeenCalled()
  })
})
