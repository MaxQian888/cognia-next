import type { RuntimeSnapshot } from "@/lib/runtime/operation-availability"
import {
  PET_REMOTE_CARE_OPERATION,
  hostAdvertisesPetRemoteCare,
  resolvePetConsoleMode,
  type PetConsoleModeInput,
} from "./console-mode"

const companion = (operations: string[] | null, compatible = true): RuntimeSnapshot => ({
  target: { id: "mobile-companion", kind: "companion", hostKind: "desktop", platform: "mobile" },
  vaultState: "unlocked",
  connectionState: "online",
  ...(operations ? { host: { compatible, operations, grants: ["client.read"] } } : {}),
})

const desktop: RuntimeSnapshot = {
  target: null,
  vaultState: "unavailable",
  connectionState: "online",
}

function input(over: Partial<PetConsoleModeInput> = {}): PetConsoleModeInput {
  return {
    localAvailability: { available: true },
    mirror: false,
    snapshot: desktop,
    activeRemoteHostSupportsPet: false,
    ...over,
  }
}

describe("hostAdvertisesPetRemoteCare", () => {
  it("needs a compatible companion host that lists the snapshot read", () => {
    expect(hostAdvertisesPetRemoteCare(companion([PET_REMOTE_CARE_OPERATION]))).toBe(true)
    expect(hostAdvertisesPetRemoteCare(companion(["git_status"]))).toBe(false)
    expect(hostAdvertisesPetRemoteCare(companion([PET_REMOTE_CARE_OPERATION], false))).toBe(false)
    expect(hostAdvertisesPetRemoteCare(companion(null))).toBe(false)
    expect(hostAdvertisesPetRemoteCare(desktop)).toBe(false)
  })
})

describe("resolvePetConsoleMode", () => {
  it("drives the pet directly in the desktop main window", () => {
    expect(resolvePetConsoleMode(input())).toEqual({ mode: "local" })
  })

  it("cares for the desktop pet remotely from a paired phone", () => {
    expect(
      resolvePetConsoleMode(
        input({
          localAvailability: { available: false, reason: "unsupported-host" },
          mirror: true,
          snapshot: companion(["pet_get", "pet_act"]),
        })
      )
    ).toEqual({ mode: "remote" })
  })

  it("goes remote on a desktop driving a host that advertises the feature", () => {
    expect(
      resolvePetConsoleMode(input({ mirror: true, activeRemoteHostSupportsPet: true }))
    ).toEqual({ mode: "remote" })
  })

  it("asks an unpaired phone or browser to pair", () => {
    for (const snapshot of [
      {
        target: { id: "s", kind: "standalone", platform: "web" },
        vaultState: "unlocked",
        connectionState: "online",
      } as RuntimeSnapshot,
      { target: null, vaultState: "unavailable", connectionState: "offline" } as RuntimeSnapshot,
    ]) {
      expect(
        resolvePetConsoleMode(
          input({
            localAvailability: { available: false, reason: "unsupported-host" },
            mirror: true,
            snapshot,
          })
        )
      ).toEqual({ mode: "unavailable", reason: "unpaired" })
    }
  })

  it("tells a phone paired to an older desktop to update it", () => {
    expect(
      resolvePetConsoleMode(
        input({
          localAvailability: { available: false, reason: "unsupported-host" },
          mirror: true,
          snapshot: companion(["git_status"]),
        })
      )
    ).toEqual({ mode: "unavailable", reason: "host-without-feature" })
  })

  it("waits for the host manifest instead of calling the host outdated", () => {
    expect(
      resolvePetConsoleMode(
        input({
          localAvailability: { available: false, reason: "unsupported-host" },
          mirror: true,
          snapshot: companion(null),
        })
      )
    ).toEqual({ mode: "unavailable", reason: "host-pending" })
  })

  it("keeps the console in the main desktop window", () => {
    expect(
      resolvePetConsoleMode(
        input({ localAvailability: { available: false, reason: "secondary-window" } })
      )
    ).toEqual({ mode: "unavailable", reason: "secondary-window" })
  })

  it("does not show a desktop's own pet over a remote host's mirror", () => {
    expect(resolvePetConsoleMode(input({ mirror: true }))).toEqual({
      mode: "unavailable",
      reason: "host-without-feature",
    })
  })
})
