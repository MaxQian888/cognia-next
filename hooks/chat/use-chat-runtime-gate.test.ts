/**
 * @jest-environment jsdom
 */
import { act, renderHook } from "@testing-library/react"

const platformRef: { current: "web" | "mobile" | "tauri" } = { current: "mobile" }
jest.mock("@/hooks/use-platform", () => ({
  usePlatform: () => platformRef.current,
}))

import { setRuntimeSnapshot } from "@/lib/runtime/runtime-snapshot-store"
import type { RuntimeSnapshot } from "@/lib/runtime/operation-availability"
import type { CompanionRuntimeTarget } from "@/lib/runtime/runtime-target"

import { runtimeAvailabilityMessageKey, useChatRuntimeGate } from "./use-chat-runtime-gate"

const companion = {
  id: "host-1",
  kind: "companion",
  platform: "mobile",
  hostKind: "desktop",
} as unknown as CompanionRuntimeTarget

function snapshot(patch: Partial<RuntimeSnapshot>): RuntimeSnapshot {
  return { target: null, vaultState: "unavailable", connectionState: "offline", ...patch }
}

beforeEach(() => {
  platformRef.current = "mobile"
  act(() => setRuntimeSnapshot(snapshot({})))
})

describe("useChatRuntimeGate", () => {
  it("leaves the composer open on a native execution host", () => {
    const { result } = renderHook(() => useChatRuntimeGate())
    expect(result.current.composerDisabled).toBe(false)
    expect(result.current.availability.state).toBe("available")
    expect(result.current.recovery).toEqual({ kind: "none" })
  })

  it("leaves it open in standalone mode, which has a local executor", () => {
    act(() =>
      setRuntimeSnapshot(snapshot({ target: { id: "s", kind: "standalone", platform: "mobile" } }))
    )
    const { result } = renderHook(() => useChatRuntimeGate())
    expect(result.current.composerDisabled).toBe(false)
  })

  it("closes it for an unpaired companion and routes the fix to pairing", () => {
    act(() => setRuntimeSnapshot(snapshot({ target: companion, vaultState: "unavailable" })))
    const { result } = renderHook(() => useChatRuntimeGate())
    expect(result.current.composerDisabled).toBe(true)
    expect(result.current.availability.state).toBe("requires-pairing")
    expect(result.current.recovery).toEqual({ kind: "route", href: "/pair?mode=add" })
  })

  it("follows the snapshot as the host connection changes", () => {
    act(() =>
      setRuntimeSnapshot(
        snapshot({ target: companion, vaultState: "unlocked", connectionState: "connecting" })
      )
    )
    const { result } = renderHook(() => useChatRuntimeGate())
    expect(result.current.availability.state).toBe("offline")
    expect(result.current.connecting).toBe(true)
    act(() =>
      setRuntimeSnapshot(
        snapshot({
          target: companion,
          vaultState: "unlocked",
          connectionState: "online",
          // `claude_send` is gated on `agent.run` (protocol/companion-commands.json).
          host: { compatible: true, operations: ["claude_send"], grants: ["agent.run"] },
        })
      )
    )
    // The composer re-opens the moment a granted host is back.
    expect(result.current.availability.state).toBe("available")
    expect(result.current.composerDisabled).toBe(false)
    expect(result.current.recovery).toEqual({ kind: "none" })
    expect(result.current.connecting).toBe(false)
  })

  it("closes it for a host that never granted chat, and asks for exactly that grant", () => {
    // Paired and online is not enough: without `agent.run` every send is
    // refused by the host, so the composer says so and routes to the grant.
    act(() =>
      setRuntimeSnapshot(
        snapshot({
          target: companion,
          vaultState: "unlocked",
          connectionState: "online",
          host: { compatible: true, operations: ["claude_send"], grants: ["chat.read"] },
        })
      )
    )
    const { result } = renderHook(() => useChatRuntimeGate())
    expect(result.current.availability.state).toBe("requires-grant")
    expect(result.current.composerDisabled).toBe(true)
    expect(result.current.recovery).toEqual({
      kind: "route",
      href: "/pair?mode=recover&state=requires-grant&requiredGrant=agent.run",
    })
  })

  it("routes desktop recovery to local connection settings", () => {
    platformRef.current = "tauri"
    act(() => setRuntimeSnapshot(snapshot({ target: companion, vaultState: "unavailable" })))
    const { result } = renderHook(() => useChatRuntimeGate())
    expect(result.current.recovery).toEqual({ kind: "local-settings", section: "companion" })
  })
})

describe("runtimeAvailabilityMessageKey", () => {
  it.each([
    ["requires-pairing", "requiresPairing"],
    ["read-only", "readOnly"],
    ["offline", "offline"],
  ] as const)("%s → %s", (state, key) => {
    expect(runtimeAvailabilityMessageKey(state)).toBe(key)
  })
})
