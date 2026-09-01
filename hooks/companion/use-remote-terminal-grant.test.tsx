/**
 * The remote-terminal grant flow shared by the paired-devices card and the
 * terminal share dialog (ADR-0133). Pins: provision → mirror → host ordering,
 * rollback when the host refuses, the biometric gate on the enabling side,
 * host-first read of grants with the mirror as fallback.
 */

import "fake-indexeddb/auto"
import { act, renderHook, waitFor } from "@testing-library/react"

import companionMessages from "@/i18n/messages/en/mobile/companion.json"
import { transport } from "@/lib/tauri"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import { addPairedDevice, listPairedDevices } from "@/lib/db/paired-devices"
import {
  provisionTerminalHostDescriptor,
  readDeviceGrants,
  setRemoteTerminalRustSide,
  useDeviceGrants,
  useRemoteTerminalGrantToggle,
} from "./use-remote-terminal-grant"

const guardOutcome: { blocked: "cancelled" | "unavailable" | null } = { blocked: null }
jest.mock("@/hooks/use-biometric-guard", () => {
  const actual = jest.requireActual("@/hooks/use-biometric-guard")
  return {
    ...actual,
    useBiometricGuard: () => {
      const real = actual.useBiometricGuard()
      return async (gate: unknown, action: () => Promise<unknown>) =>
        guardOutcome.blocked
          ? { kind: "blocked", reason: guardOutcome.blocked }
          : real(gate, action)
    },
  }
})

const toastMock = { success: jest.fn(), error: jest.fn() }
jest.mock("sonner", () => ({
  toast: {
    success: (...a: unknown[]) => toastMock.success(...a),
    error: (...a: unknown[]) => toastMock.error(...a),
  },
}))

const TAURI_KEY = "__TAURI_INTERNALS__"
function setTauri(on: boolean) {
  if (on) (window as unknown as Record<string, unknown>)[TAURI_KEY] = {}
  else delete (window as unknown as Record<string, unknown>)[TAURI_KEY]
}

const DESCRIPTOR = {
  hostId: "host-1",
  lan: { host: "127.0.0.1", port: 1 },
  fingerprint: "fp",
}

let callSpy: jest.SpiedFunction<typeof transport.call>

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
  setTauri(true)
  guardOutcome.blocked = null
  toastMock.success.mockReset()
  toastMock.error.mockReset()
  callSpy = jest.spyOn(transport, "call")
  callSpy.mockImplementation(async (name: string) => {
    if (name === "terminal_host_service") return { descriptor: DESCRIPTOR } as never
    return undefined as never
  })
  await addPairedDevice({
    deviceId: "dev-a",
    label: "Phone",
    platform: "ios",
    pubkey: "pk-a",
    appVersion: "0.1.0",
    nowMs: Date.now(),
  })
})

afterEach(() => {
  setTauri(false)
  jest.restoreAllMocks()
})

describe("readDeviceGrants / useDeviceGrants", () => {
  it("returns undefined when the host cannot answer, and a map otherwise", async () => {
    setTauri(true)

    callSpy.mockImplementation(async (name: string) => {
      if (name === "companion_list_device_grants") throw new Error("host unreachable")
      return undefined as never
    })
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {})
    expect(await readDeviceGrants()).toBeUndefined()
    expect(warn).toHaveBeenCalledWith("companion_list_device_grants failed", expect.any(Error))

    callSpy.mockImplementation(async (name: string) => {
      if (name === "companion_list_device_grants") return "nope" as never
      return undefined as never
    })
    expect(await readDeviceGrants()).toBeUndefined()

    callSpy.mockImplementation(async (name: string) => {
      if (name === "companion_list_device_grants") {
        return [{ deviceId: "dev-a", control: false, agentControl: false, terminal: true }] as never
      }
      return undefined as never
    })
    const grants = await readDeviceGrants()
    expect(grants?.get("dev-a")?.terminal).toBe(true)

    const { result } = renderHook(() => useDeviceGrants())
    // Generous: the first Dexie open in a suite is slow on a loaded CI box.
    await waitFor(() => expect(result.current.grants?.get("dev-a")?.terminal).toBe(true), {
      timeout: 5_000,
    })
    callSpy.mockImplementation(async (name: string) => {
      if (name === "companion_list_device_grants") {
        return [
          { deviceId: "dev-a", control: false, agentControl: false, terminal: false },
        ] as never
      }
      return undefined as never
    })
    await act(async () => {
      await result.current.refresh()
    })
    expect(result.current.grants?.get("dev-a")?.terminal).toBe(false)
  })
})

describe("provisionTerminalHostDescriptor / setRemoteTerminalRustSide", () => {
  it("throws when the host returns no descriptor", async () => {
    callSpy.mockImplementation(async () => ({}) as never)
    await expect(provisionTerminalHostDescriptor("dev-a", "pk")).rejects.toThrow(/descriptor/)
  })

  /**
   * The fail-open this module used to have. `setRemoteTerminalRustSide` opened
   * with `if (!isTauri()) return`, so on a companion or web shell the caller
   * wrote the Dexie mirror and toasted success while the host kept serving the
   * device. It must reach the transport unconditionally and let the refusal
   * through.
   */
  it("never resolves without reaching the transport", async () => {
    setTauri(false)
    callSpy.mockClear()
    callSpy.mockImplementation(async () => {
      throw Object.assign(new Error("cannot be answered by a paired host"), {
        code: "command_transport_forbidden",
      })
    })
    await expect(setRemoteTerminalRustSide("dev-a", true)).rejects.toThrow()
    expect(callSpy).toHaveBeenCalledWith("companion_set_remote_terminal", {
      deviceId: "dev-a",
      allowed: true,
    })
  })
})

describe("useRemoteTerminalGrantToggle", () => {
  it("enables: provisions the descriptor, mirrors to Dexie, flips the host, then reports", async () => {
    const onChanged = jest.fn()
    const { result } = renderHook(() => useRemoteTerminalGrantToggle(onChanged))
    await act(async () => {
      await result.current("dev-a", "pk-a", "Phone", true)
    })
    const names = callSpy.mock.calls.map((c) => c[0])
    expect(names.indexOf("terminal_host_service")).toBeLessThan(
      names.indexOf("companion_set_remote_terminal")
    )
    expect(callSpy).toHaveBeenCalledWith("companion_set_remote_terminal", {
      deviceId: "dev-a",
      allowed: true,
    })
    const [row] = await listPairedDevices()
    expect(row.allowRemoteTerminal).toBe(true)
    expect(onChanged).toHaveBeenCalledTimes(1)
    expect(toastMock.success).toHaveBeenCalledWith(expect.stringContaining("Phone"))
  })

  it("rolls back the mirror when the host refuses the grant", async () => {
    callSpy.mockImplementation(async (name: string, args?: unknown) => {
      if (name === "terminal_host_service") return { descriptor: DESCRIPTOR } as never
      if (
        name === "companion_set_remote_terminal" &&
        (args as { allowed: boolean }).allowed === true
      ) {
        throw new Error("host says no")
      }
      return undefined as never
    })
    const onChanged = jest.fn()
    const { result } = renderHook(() => useRemoteTerminalGrantToggle(onChanged))
    await act(async () => {
      await result.current("dev-a", "pk-a", "Phone", true)
    })
    const [row] = await listPairedDevices()
    expect(row.allowRemoteTerminal).toBe(false)
    expect(callSpy).toHaveBeenCalledWith("companion_set_remote_terminal", {
      deviceId: "dev-a",
      allowed: false,
    })
    expect(onChanged).not.toHaveBeenCalled()
    expect(toastMock.error).toHaveBeenCalled()
  })

  it("respects the biometric gate: cancelled is silent, other blocks toast", async () => {
    guardOutcome.blocked = "cancelled"
    const { result } = renderHook(() => useRemoteTerminalGrantToggle())
    await act(async () => {
      await result.current("dev-a", "pk-a", "Phone", true)
    })
    expect(callSpy).not.toHaveBeenCalledWith("companion_set_remote_terminal", expect.anything())
    expect(toastMock.error).not.toHaveBeenCalled()

    guardOutcome.blocked = "unavailable"
    await act(async () => {
      await result.current("dev-a", "pk-a", "Phone", true)
    })
    expect(toastMock.error).toHaveBeenCalledTimes(1)
  })

  it("disables without a gate: host first, then mirror, then reports", async () => {
    await getDb().pairedDevices.update("dev-a", { allowRemoteTerminal: true })
    const onChanged = jest.fn()
    const { result } = renderHook(() => useRemoteTerminalGrantToggle(onChanged))
    await act(async () => {
      await result.current("dev-a", "pk-a", "Phone", false)
    })
    expect(callSpy).toHaveBeenCalledWith("companion_set_remote_terminal", {
      deviceId: "dev-a",
      allowed: false,
    })
    const [row] = await listPairedDevices()
    expect(row.allowRemoteTerminal).toBe(false)
    expect(onChanged).toHaveBeenCalledTimes(1)
    expect(toastMock.success).toHaveBeenCalled()
  })

  /**
   * The whole point of the un-fail-open. A shell that cannot reach the host
   * must leave the mirror alone: a mirror reading "off" over a host still
   * serving the device is the one state nobody can recover from by looking.
   */
  it("leaves the mirror untouched and says where to go when the host is unreachable", async () => {
    await getDb().pairedDevices.update("dev-a", { allowRemoteTerminal: true })
    const onChanged = jest.fn()
    callSpy.mockImplementation(async (name: string) => {
      if (name === "companion_set_remote_terminal") {
        throw Object.assign(new Error("cannot be answered by a paired host"), {
          code: "command_transport_forbidden",
        })
      }
      return undefined as never
    })
    const { result } = renderHook(() => useRemoteTerminalGrantToggle(onChanged))
    await act(async () => {
      await result.current("dev-a", "pk-a", "Phone", false)
    })
    const [row] = await listPairedDevices()
    expect(row.allowRemoteTerminal).toBe(true)
    expect(onChanged).not.toHaveBeenCalled()
    expect(toastMock.success).not.toHaveBeenCalled()
    // The harness resolves real messages, so this also pins that `hostOnly`
    // exists in the catalogue — and that the refusal is not the generic
    // "could not be saved", which would send someone to retry a call no retry
    // can reach.
    const shown = toastMock.error.mock.calls.at(0)?.[0] as string
    expect(shown).toBe(companionMessages.remoteTerminal.hostOnly)
    expect(shown).not.toBe(companionMessages.remoteTerminal.operationFailed)
  })
})
