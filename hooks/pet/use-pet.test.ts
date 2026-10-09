import { renderHook } from "@testing-library/react"

jest.mock("dexie-react-hooks", () => ({ useLiveQuery: jest.fn() }))
jest.mock("@/lib/pet/events/pet-event-bus", () => ({ emitPetEvent: jest.fn() }))
jest.mock("@/lib/pet/remote/mirror", () => ({ isPetMirrorShell: jest.fn(() => false) }))
jest.mock("@/lib/db/schema", () => {
  const put = jest.fn(async () => undefined)
  const get = jest.fn()
  return { getDb: () => ({ petCharacterBindings: { get, put }, petProfile: { get: jest.fn() } }) }
})

import { useLiveQuery } from "dexie-react-hooks"
import { emitPetEvent } from "@/lib/pet/events/pet-event-bus"
import { usePet } from "./use-pet"
import { createDefaultProfile } from "@/lib/pet/defaults"
import { isPetMirrorShell } from "@/lib/pet/remote/mirror"
import { getDb } from "@/lib/db/schema"

const liveQuery = useLiveQuery as jest.Mock
const emit = emitPetEvent as jest.Mock

beforeEach(() => {
  liveQuery.mockReset()
  emit.mockReset()
})

describe("usePet", () => {
  it("reports loading while the profile is undefined", () => {
    liveQuery.mockReturnValueOnce(undefined).mockReturnValueOnce(undefined)
    const { result } = renderHook(() => usePet())
    expect(result.current.loading).toBe(true)
    expect(result.current.view).toBeUndefined()
  })

  it("derives the view once the profile loads", () => {
    liveQuery.mockReturnValueOnce(createDefaultProfile("acct-1", 0)).mockReturnValueOnce(undefined)
    const { result } = renderHook(() => usePet())
    expect(result.current.loading).toBe(false)
    expect(result.current.view?.bones).toBeDefined()
  })

  it("interaction actions emit user events", () => {
    liveQuery.mockReturnValue(createDefaultProfile("acct-1", 0))
    const { result } = renderHook(() => usePet())
    result.current.feed()
    result.current.play()
    result.current.petStroke()
    result.current.talk()
    result.current.sleep()
    result.current.clean()
    result.current.treat()
    expect(emit.mock.calls.map((c) => c[0].kind)).toEqual([
      "fed",
      "played",
      "petted",
      "talked",
      "slept",
      "cleaned",
      "treated",
    ])
  })
})

describe("usePet legacy binding migration", () => {
  const legacy = { characterId: "c1", live2dModelId: "m1", updatedAt: "2026-01-01T00:00:00.000Z" }

  async function runBindingQuery(): Promise<unknown> {
    liveQuery.mockReturnValue(undefined)
    renderHook(() => usePet("c1"))
    // The second useLiveQuery call is the binding query; run its querier.
    const querier = liveQuery.mock.calls[1][0] as () => Promise<unknown>
    const bindings = getDb().petCharacterBindings as unknown as { get: jest.Mock; put: jest.Mock }
    bindings.get.mockResolvedValueOnce(legacy)
    return querier()
  }

  beforeEach(() => {
    ;(getDb().petCharacterBindings as unknown as { put: jest.Mock }).put.mockClear()
  })

  it("persists the migrated binding on the pet's own store", async () => {
    ;(isPetMirrorShell as jest.Mock).mockReturnValue(false)
    const migrated = (await runBindingQuery()) as { skin?: unknown }
    expect(migrated.skin).toEqual({ skinId: "live2d", modelId: "m1" })
    expect(getDb().petCharacterBindings.put).toHaveBeenCalledTimes(1)
  })

  it("renders the migrated shape but never writes on a companion mirror", async () => {
    ;(isPetMirrorShell as jest.Mock).mockReturnValue(true)
    const migrated = (await runBindingQuery()) as { skin?: unknown }
    expect(migrated.skin).toEqual({ skinId: "live2d", modelId: "m1" })
    expect(getDb().petCharacterBindings.put).not.toHaveBeenCalled()
  })
})
