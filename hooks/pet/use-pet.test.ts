import { renderHook } from "@testing-library/react"

jest.mock("dexie-react-hooks", () => ({ useLiveQuery: jest.fn() }))
jest.mock("@/lib/pet/events/pet-event-bus", () => ({ emitPetEvent: jest.fn() }))

import { useLiveQuery } from "dexie-react-hooks"
import { emitPetEvent } from "@/lib/pet/events/pet-event-bus"
import { usePet } from "./use-pet"
import { createDefaultProfile } from "@/lib/pet/defaults"

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
