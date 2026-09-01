/**
 * @jest-environment jsdom
 */
import { renderHook } from "@testing-library/react"

import { useDeviceGrantActions } from "./use-device-grant-actions"

const db = {
  setRemoteControlAllowed: jest.fn(async () => {}),
  setAgentControlAllowed: jest.fn(async () => {}),
  setLockedComputerUseAllowed: jest.fn(async () => {}),
  pausePairedDevice: jest.fn(async () => {}),
  resumePairedDevice: jest.fn(async () => {}),
  revokePairedDevice: jest.fn(async () => {}),
}
const hostCalls: { name: string; args: Record<string, unknown> }[] = []
const terminalToggle = jest.fn(async () => {})
let guardResult: { kind: "allowed" } | { kind: "blocked"; reason: string } = { kind: "allowed" }
const guardCalls: unknown[] = []

jest.mock("@/lib/db/paired-devices", () => ({
  setRemoteControlAllowed: (...a: unknown[]) => db.setRemoteControlAllowed(...(a as [])),
  setAgentControlAllowed: (...a: unknown[]) => db.setAgentControlAllowed(...(a as [])),
  setLockedComputerUseAllowed: (...a: unknown[]) => db.setLockedComputerUseAllowed(...(a as [])),
  pausePairedDevice: (...a: unknown[]) => db.pausePairedDevice(...(a as [])),
  resumePairedDevice: (...a: unknown[]) => db.resumePairedDevice(...(a as [])),
  revokePairedDevice: (...a: unknown[]) => db.revokePairedDevice(...(a as [])),
}))

jest.mock("@/lib/tauri", () => ({
  isTauri: () => true,
  transport: {
    call: async (name: string, args: Record<string, unknown>) => {
      hostCalls.push({ name, args })
    },
  },
}))

jest.mock("@/hooks/use-biometric-guard", () => ({
  useBiometricGuard: () => async (prompt: unknown, action: () => Promise<void>) => {
    guardCalls.push(prompt)
    if (guardResult.kind === "allowed") await action()
    return guardResult
  },
}))

jest.mock("@/hooks/companion/use-remote-terminal-grant", () => ({
  useRemoteTerminalGrantToggle: () => terminalToggle,
}))

jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))

// Settings → Security → "Require biometrics to delete a pairing".
const biometricPolicy: { value: { deletePairing?: boolean } | undefined } = { value: undefined }
jest.mock("@/stores/settings", () => ({
  useSettingsStore: <T,>(selector: (s: { settings: unknown }) => T): T =>
    selector({ settings: { biometricRequiredFor: biometricPolicy.value } }),
}))

function actions(onChanged = jest.fn()) {
  const { result } = renderHook(() => useDeviceGrantActions(onChanged))
  return { actions: result.current, onChanged }
}

beforeEach(() => {
  biometricPolicy.value = undefined
  hostCalls.length = 0
  guardCalls.length = 0
  guardResult = { kind: "allowed" }
  jest.clearAllMocks()
})

describe("enabling is gated, disabling is not", () => {
  /**
   * Granting hands out privilege and goes through the biometric guard;
   * revoking reduces it and applies immediately. Gating the disabling
   * direction would mean a user who cannot pass the biometric cannot take a
   * permission away, which is backwards.
   */
  it("gates granting remote control", async () => {
    const { actions: a } = actions()
    await a.toggleRemoteControl("d1", "Phone", true)
    expect(guardCalls).toHaveLength(1)
    expect(db.setRemoteControlAllowed).toHaveBeenCalledWith("d1", true)
  })

  it("does not gate revoking remote control", async () => {
    const { actions: a } = actions()
    await a.toggleRemoteControl("d1", "Phone", false)
    expect(guardCalls).toHaveLength(0)
    expect(db.setRemoteControlAllowed).toHaveBeenCalledWith("d1", false)
  })

  it("writes nothing when the guard refuses", async () => {
    guardResult = { kind: "blocked", reason: "unavailable" }
    const { actions: a } = actions()
    await a.toggleAgentControl("d1", "Phone", true)
    expect(db.setAgentControlAllowed).not.toHaveBeenCalled()
    expect(hostCalls).toHaveLength(0)
  })
})

describe("every write is a dual write", () => {
  it("writes the mirror and the host for remote control", async () => {
    const { actions: a } = actions()
    await a.toggleRemoteControl("d1", "Phone", true)
    expect(db.setRemoteControlAllowed).toHaveBeenCalledWith("d1", true)
    expect(hostCalls).toContainEqual({
      name: "companion_set_remote_control",
      args: { deviceId: "d1", allowed: true },
    })
  })

  it("writes the mirror and the host for agent control", async () => {
    const { actions: a } = actions()
    await a.toggleAgentControl("d1", "Phone", true)
    expect(hostCalls).toContainEqual({
      name: "companion_set_agent_control",
      args: { deviceId: "d1", allowed: true },
    })
  })
})

describe("Locked Use follows remote control down", () => {
  /**
   * The native lease validator requires both, so leaving the Locked Use bit
   * set behind a withdrawn control grant stores a permission that reads as
   * granted and enforces as denied.
   */
  it("clears Locked Use before clearing remote control", async () => {
    const { actions: a } = actions()
    await a.toggleRemoteControl("d1", "Phone", false)
    expect(db.setLockedComputerUseAllowed).toHaveBeenCalledWith("d1", false)
    expect(hostCalls.map((call) => call.name)).toEqual([
      "companion_set_locked_computer_use",
      "companion_set_remote_control",
    ])
  })
})

describe("lifecycle", () => {
  /**
   * Without the gate an attacker at a momentarily-unlocked desktop could
   * silently disable every paired phone.
   */
  it("gates pause and suspends rather than revokes", async () => {
    const { actions: a } = actions()
    await a.pause("d1", "Phone")
    expect(guardCalls).toHaveLength(1)
    expect(db.pausePairedDevice).toHaveBeenCalledWith("d1")
    expect(hostCalls).toContainEqual({ name: "companion_suspend_device", args: { deviceId: "d1" } })
  })

  /**
   * The distinction Pause exists for. Revoke tears down the signaling
   * registration and the device key, so a device paused through the revoke arm
   * needed re-pairing to come back and Resume could not reach it.
   */
  it("never revokes on pause", async () => {
    const { actions: a } = actions()
    await a.pause("d1", "Phone")
    expect(hostCalls.map((call) => call.name)).not.toContain("companion_revoke_device")
  })

  it("gates resume and lifts the suspension", async () => {
    const { actions: a } = actions()
    await a.resume("d1", "Phone")
    expect(guardCalls).toHaveLength(1)
    expect(db.resumePairedDevice).toHaveBeenCalledWith("d1")
    expect(hostCalls).toContainEqual({
      name: "companion_resume_device",
      args: { deviceId: "d1" },
    })
  })

  it("gates revoke", async () => {
    const { actions: a } = actions()
    await a.revoke("d1", "Phone")
    expect(guardCalls).toHaveLength(1)
    expect(db.revokePairedDevice).toHaveBeenCalledWith("d1")
  })

  it("leaves a cancelled guard silent and unwritten", async () => {
    guardResult = { kind: "blocked", reason: "cancelled" }
    const { actions: a } = actions()
    await a.revoke("d1", "Phone")
    expect(db.revokePairedDevice).not.toHaveBeenCalled()
  })
})

describe("terminal grant", () => {
  /**
   * Shared with the terminal share dialog (ADR-0133) so both surfaces drive
   * the one enforcement point identically, including descriptor provisioning
   * and the rollback when the host call fails.
   */
  it("delegates to the shared toggle rather than reimplementing it", async () => {
    const { actions: a } = actions()
    await a.toggleRemoteTerminal("d1", "pk", "Phone", true)
    expect(terminalToggle).toHaveBeenCalledWith("d1", "pk", "Phone", true)
  })
})

describe("change notification", () => {
  it("tells the caller to refresh after a successful write", async () => {
    const { actions: a, onChanged } = actions()
    await a.toggleRemoteControl("d1", "Phone", true)
    expect(onChanged).toHaveBeenCalled()
  })

  it("does not claim a change when the guard refused", async () => {
    guardResult = { kind: "blocked", reason: "unavailable" }
    const { actions: a, onChanged } = actions()
    await a.toggleRemoteControl("d1", "Phone", true)
    expect(onChanged).not.toHaveBeenCalled()
  })
})

describe("useDeviceGrantActions — Settings → Security → deletePairing", () => {
  // `revoke` used to prompt for biometrics unconditionally, so the settings row
  // governed nothing: the only file that read the flag was the page writing it.
  it("prompts by default (the shipped policy has the row on)", async () => {
    const { actions: a } = actions()
    await a.revoke("d1", "Phone")
    expect(guardCalls).toHaveLength(1)
    expect(db.revokePairedDevice).toHaveBeenCalledWith("d1")
  })

  it("skips the prompt when the row is switched off", async () => {
    biometricPolicy.value = { deletePairing: false }
    const { actions: a } = actions()
    await a.revoke("d1", "Phone")
    expect(guardCalls).toHaveLength(0)
    expect(db.revokePairedDevice).toHaveBeenCalledWith("d1")
  })

  it("still revokes on the host and notifies when the prompt is skipped", async () => {
    biometricPolicy.value = { deletePairing: false }
    const onChanged = jest.fn()
    const { actions: a } = actions(onChanged)
    await a.revoke("d1", "Phone")
    expect(hostCalls).toContainEqual({
      name: "companion_revoke_device",
      args: { deviceId: "d1" },
    })
    expect(onChanged).toHaveBeenCalled()
  })

  it("keeps the capability toggles gated regardless of the row", async () => {
    // Those rows do not exist in the security panel; handing a remote device
    // control of this machine is not a preference it offers to waive.
    biometricPolicy.value = { deletePairing: false }
    const { actions: a } = actions()
    await a.toggleRemoteControl("d1", "Phone", true)
    expect(guardCalls).toHaveLength(1)
  })
})
