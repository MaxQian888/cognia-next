import { renderHook } from "@testing-library/react"

const useLiveQuery = jest.fn()
const getPetSpritePack = jest.fn()

jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: (...args: unknown[]) => useLiveQuery(...args),
}))
jest.mock("@/lib/db/pet-sprite-packs", () => ({
  getPetSpritePack: (...args: unknown[]) => getPetSpritePack(...args),
}))

import { useActiveSpritePack } from "./use-active-sprite-pack"

describe("useActiveSpritePack", () => {
  beforeEach(() => {
    useLiveQuery.mockReset()
    getPetSpritePack.mockReset()
  })

  it("reactively resolves the configured pack", async () => {
    const row = { id: "momo", displayName: "Momo" }
    useLiveQuery.mockImplementation((query: () => Promise<unknown>) => {
      void query()
      return row
    })

    const { result } = renderHook(() =>
      useActiveSpritePack({ activeSpritePackId: "momo" } as never)
    )

    expect(getPetSpritePack).toHaveBeenCalledWith("momo")
    expect(result.current).toEqual({ packId: "momo", row })
  })

  it("does not query storage without an active id", async () => {
    let resultPromise: Promise<unknown> | undefined
    useLiveQuery.mockImplementation((query: () => Promise<unknown>) => {
      resultPromise = query()
      return undefined
    })
    const { result } = renderHook(() => useActiveSpritePack({} as never))
    await expect(resultPromise).resolves.toBeUndefined()
    expect(getPetSpritePack).not.toHaveBeenCalled()
    expect(result.current).toEqual({ packId: undefined, row: undefined })
  })
})
