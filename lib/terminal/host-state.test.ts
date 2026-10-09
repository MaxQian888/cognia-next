import { classifyTerminalHostError } from "./host-state"

describe("terminal host state classification", () => {
  it.each([
    ["unpaired device", "unpaired"],
    ["permission_denied: grant revoked", "unauthorized"],
    ["resource_limit: 32 sessions", "resource_limited"],
    ["incompatible terminal protocol", "incompatible"],
    ["reconnecting transport", "reconnecting"],
    ["socket refused", "offline"],
    [
      "terminal credential read failed for com.cognia.terminal-host (account desktop-bootstrap): Platform failure: The user name or passphrase you entered is not correct.",
      "credential_unavailable",
    ],
    [
      "terminal_remote_access_disabled: remote terminal access is disabled on this host",
      "remote_access_disabled",
    ],
  ] as const)("maps %s to %s", (message, expected) => {
    expect(classifyTerminalHostError(new Error(message))).toBe(expected)
  })

  // Both refusals are 403s. Reporting the host-wide switch as "this device is
  // not allowed" points an owner device at a grant it already holds, and hides
  // the one control that would actually fix it.
  it("keeps the host-wide switch distinct from a missing device grant", () => {
    expect(
      classifyTerminalHostError(
        new Error("terminal_remote_access_disabled: remote terminal access is disabled")
      )
    ).toBe("remote_access_disabled")
    expect(classifyTerminalHostError(new Error("socket_capability_required"))).not.toBe(
      "remote_access_disabled"
    )
  })

  // A browser sees a rejected WebSocket upgrade as an untyped `error` event
  // with no status, which is why the refusal has to arrive from the ticket
  // response instead.
  it("still reports a bare socket failure as offline", () => {
    expect(classifyTerminalHostError(new Error("terminal LAN connection failed"))).toBe("offline")
  })

  it("classifies native credential error strings without confusing remote grants", () => {
    expect(classifyTerminalHostError("terminal_credential_unavailable: access denied")).toBe(
      "credential_unavailable"
    )
    expect(classifyTerminalHostError("unauthorized remote device")).toBe("unauthorized")
  })
})
