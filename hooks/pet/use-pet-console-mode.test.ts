/** @jest-environment jsdom */
import { renderHook } from "@testing-library/react"
import type { RuntimeSnapshot } from "@/lib/runtime/operation-availability"

let mockPlatform = "tauri"
let mockSnapshot: RuntimeSnapshot = {
  target: null,
  vaultState: "unavailable",
  connectionState: "online",
}
let mockHostHasPet = false
let mockActiveHostId: string | null = null
let mockRole = "main"

jest.mock("@/hooks/use-platform", () => ({ usePlatform: () => mockPlatform }))
jest.mock("@/hooks/use-runtime-snapshot", () => ({ useRuntimeSnapshot: () => mockSnapshot }))
jest.mock("@/lib/pet/window-role", () => ({
  ...jest.requireActual("@/lib/pet/window-role"),
  getPetWindowRole: () => mockRole,
}))
jest.mock("@/stores/remote-host/remote-host-store", () => ({
  useActiveHostSupportsFeature: (feature: string, operation: string) => {
    expect([feature, operation]).toEqual(["pet.remote-care", "pet_get"])
    return mockHostHasPet
  },
  useRemoteHostStore: (select: (s: { activeHostId: string | null }) => unknown) =>
    select({ activeHostId: mockActiveHostId }),
}))

import { usePetConsoleMode } from "./use-pet-console-mode"

beforeEach(() => {
  mockPlatform = "tauri"
  mockSnapshot = { target: null, vaultState: "unavailable", connectionState: "online" }
  mockHostHasPet = false
  mockActiveHostId = null
  mockRole = "main"
})

describe("usePetConsoleMode", () => {
  it("runs locally in the desktop main window", () => {
    expect(renderHook(() => usePetConsoleMode()).result.current).toEqual({ mode: "local" })
  })

  it("cares remotely from a phone paired to a desktop that advertises it", () => {
    mockPlatform = "mobile"
    mockSnapshot = {
      target: { id: "m", kind: "companion", hostKind: "desktop", platform: "mobile" },
      vaultState: "unlocked",
      connectionState: "online",
      host: { compatible: true, operations: ["pet_get"], grants: [] },
    }
    expect(renderHook(() => usePetConsoleMode()).result.current).toEqual({ mode: "remote" })
  })

  it("asks an unpaired phone to pair", () => {
    mockPlatform = "mobile"
    expect(renderHook(() => usePetConsoleMode()).result.current).toEqual({
      mode: "unavailable",
      reason: "unpaired",
    })
  })

  it("follows a desktop that drives a remote host to that host's pet", () => {
    mockActiveHostId = "host-1"
    mockHostHasPet = true
    expect(renderHook(() => usePetConsoleMode()).result.current).toEqual({ mode: "remote" })
  })

  it("keeps the console out of the overlay and popup windows", () => {
    mockRole = "overlay"
    expect(renderHook(() => usePetConsoleMode()).result.current).toEqual({
      mode: "unavailable",
      reason: "secondary-window",
    })
  })
})
