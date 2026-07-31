import { classifyTerminalHostError } from "./host-state"

describe("terminal host state classification", () => {
  it.each([
    ["unpaired device", "unpaired"],
    ["permission_denied: grant revoked", "unauthorized"],
    ["resource_limit: 32 sessions", "resource_limited"],
    ["incompatible terminal protocol", "incompatible"],
    ["reconnecting transport", "reconnecting"],
    ["socket refused", "offline"],
  ] as const)("maps %s to %s", (message, expected) => {
    expect(classifyTerminalHostError(new Error(message))).toBe(expected)
  })
})
