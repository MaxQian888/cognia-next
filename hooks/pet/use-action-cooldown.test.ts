/** @jest-environment jsdom */
import "fake-indexeddb/auto"
import { renderHook, waitFor } from "@testing-library/react"
import { useActionCooldown } from "./use-action-cooldown"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import { upsertPetProfile } from "@/lib/db/pet"
import { createDefaultProfile } from "@/lib/pet/defaults"
import { INTERACTION_COOLDOWN_MS } from "@/lib/pet/interaction/gate"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
  await getDb().petProfile.clear()
}, 30_000)

async function seedGate(lastAtByKind: Record<string, number>) {
  await upsertPetProfile({
    ...createDefaultProfile("acct-1", 0),
    interactionGate: { lastAtByKind },
  })
}

describe("useActionCooldown", () => {
  it("reports zero remaining when nothing has been used", async () => {
    await seedGate({})
    const { result } = renderHook(() => useActionCooldown())
    await waitFor(() => expect(result.current.remaining("fed")).toBe(0))
  })

  it("projects the deadline the controller persisted", async () => {
    // The hook no longer starts cooldowns. It reads the one row the controller
    // writes, which is why every surface now agrees.
    await seedGate({ fed: Date.now() })
    const { result } = renderHook(() => useActionCooldown())
    await waitFor(() => expect(result.current.remaining("fed")).toBeGreaterThan(0))
    expect(result.current.remaining("fed")).toBeLessThanOrEqual(INTERACTION_COOLDOWN_MS.fed)
    expect(result.current.remaining("slept")).toBe(0)
  })

  it("clamps an elapsed deadline to zero", async () => {
    await seedGate({ fed: Date.now() - INTERACTION_COOLDOWN_MS.fed - 10 })
    const { result } = renderHook(() => useActionCooldown())
    await waitFor(() => expect(result.current.remaining("fed")).toBe(0))
  })

  it("ignores a malformed stored deadline rather than reporting nonsense", async () => {
    await seedGate({ fed: Number.NaN } as unknown as Record<string, number>)
    const { result } = renderHook(() => useActionCooldown())
    await waitFor(() => expect(result.current.remaining("fed")).toBe(0))
  })
})
