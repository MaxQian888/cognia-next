import type { HostBrainRefusal } from "@/lib/tauri/companion-contract"

import { hostVersionAdvice, nextHostVersionState, type HostVersionState } from "./host-version"

const APP = 3
const refusal: HostBrainRefusal = {
  reason: "contract_mismatch",
  brain: { version: "0.2.0", contractVersion: 4 },
  server: { version: "0.1.0", contractVersion: 3 },
}
const compatible = { state: "compatible", contractVersion: APP, catalogHash: "h" } as const
const incompatible = (host: number | null) =>
  ({ state: "incompatible", hostContractVersion: host, clientContractVersion: APP }) as const

describe("hostVersionAdvice", () => {
  it("names the side that is behind", () => {
    expect(hostVersionAdvice(compatible, null)).toBe("none")
    expect(hostVersionAdvice(incompatible(2), null)).toBe("update-host")
    // A Host that names no contract predates them.
    expect(hostVersionAdvice(incompatible(null), null)).toBe("update-host")
    expect(hostVersionAdvice(incompatible(4), null)).toBe("update-app")
  })

  it("sends a half-updated Host to an update whatever the contract says", () => {
    expect(hostVersionAdvice(compatible, refusal)).toBe("update-host")
    expect(hostVersionAdvice(incompatible(4), refusal)).toBe("update-host")
  })
})

describe("nextHostVersionState", () => {
  it("records a verdict, and keeps what it knew when the next one is unknown", () => {
    const first = nextHostVersionState(
      undefined,
      { kind: "contract", verdict: incompatible(2) },
      APP,
      10
    )
    expect(first).toEqual({
      advice: "update-host",
      hostContractVersion: 2,
      appContractVersion: APP,
      brainRefusal: null,
      observedAt: 10,
    })
    expect(
      nextHostVersionState(first, { kind: "contract", verdict: { state: "unknown" } }, APP, 20)
    ).toBe(first)
    expect(
      nextHostVersionState(undefined, { kind: "contract", verdict: { state: "unknown" } }, APP, 20)
    ).toBeUndefined()
  })

  it("returns the same object when nothing changed, so the store is not rewritten", () => {
    const first = nextHostVersionState(
      undefined,
      { kind: "contract", verdict: compatible },
      APP,
      10
    )
    expect(nextHostVersionState(first, { kind: "contract", verdict: compatible }, APP, 99)).toBe(
      first
    )
  })

  it("adds and clears a refused brain without losing the contract half", () => {
    const updated = nextHostVersionState(
      undefined,
      { kind: "contract", verdict: compatible },
      APP,
      10
    )
    const broken = nextHostVersionState(
      updated,
      { kind: "brain", refusal },
      APP,
      20
    ) as HostVersionState
    expect(broken).toMatchObject({
      advice: "update-host",
      hostContractVersion: APP,
      brainRefusal: refusal,
    })
    const fixed = nextHostVersionState(broken, { kind: "brain", refusal: null }, APP, 30)
    expect(fixed).toMatchObject({ advice: "none", brainRefusal: null, observedAt: 30 })

    // A newer contract with a later-cleared refusal goes back to "update the app".
    const newer = nextHostVersionState(
      undefined,
      { kind: "contract", verdict: incompatible(4) },
      APP,
      10
    )
    const both = nextHostVersionState(newer, { kind: "brain", refusal }, APP, 20)
    expect(nextHostVersionState(both, { kind: "brain", refusal: null }, APP, 30)).toMatchObject({
      advice: "update-app",
      hostContractVersion: 4,
    })
  })

  it("reports a refused brain heard before any contract verdict, and ignores a clean report", () => {
    expect(nextHostVersionState(undefined, { kind: "brain", refusal }, APP, 5)).toMatchObject({
      advice: "update-host",
      brainRefusal: refusal,
    })
    expect(
      nextHostVersionState(undefined, { kind: "brain", refusal: null }, APP, 5)
    ).toBeUndefined()
  })
})
